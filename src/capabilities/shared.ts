import {
  ApiResponseError,
  ApiUnreachableError,
  ArtifactAuthenticationError,
  ArtifactOperationError,
  ClientAuthenticationError,
  EmptyMethodSourceError,
  InputPreparationError,
  InvalidLocalSourceError,
  MissingMainStuffError,
  PIPELEX_STORAGE_SCHEME,
  PipelexApiClient,
  PipelineRequestError,
  RejectedAssetError,
  RunLifecycleUnavailableError,
  ScopeUnavailableError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
  collectArtifacts,
} from "@pipelex/sdk";
import type { MthdsFileItem, PipelexApiClientOptions } from "@pipelex/sdk";
import { z } from "zod";

import { BARE_APP_INFO } from "./client-identification.js";
import type { AppInfoSource } from "./client-identification.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";
import type { ToolNames } from "./tool-names.js";

// The Makefile's console dev banner (CONSOLE_DEV_ENV) prints this same URL as "the server default" — keep the two in step.
export const DEFAULT_API_URL = "https://api.pipelex.com";

/**
 * The submitted-files shape every capability shares on its MCP input. Each
 * item is one of two arms: inline contents (`{ content, uri? }`) or a file
 * path (`{ path }`, resolved from disk by the local workshop deployment only —
 * the hosted console rejects it instructively at request validation). The
 * arms are deliberately non-strict with first-match semantics: a pathological
 * item carrying both keys parses as the content arm and `path` is ignored.
 *
 * The API routes spell the provenance label differently (`uri` on
 * `/v1/validate`, `source` on the `/v1/build/*` envelope); the MCP surface
 * always says `uri` and each capability adapts at its own boundary.
 */
export const filesInputSchema = z
  .array(
    z.union([
      z.object({
        content: z.string().describe("The full .mthds file contents."),
        uri: z.string().nullable().optional().describe("Optional provenance URI for diagnostics."),
      }),
      z.object({
        path: z
          .string()
          .describe(
            "Filesystem path to a .mthds file, resolved relative to this server's working directory.",
          ),
      }),
    ]),
  )
  .describe(
    "One or more submitted MTHDS files forming the method closure. Each item is either inline contents ({ content, uri? }) or a file path ({ path }).",
  );

/** A submitted file resolved to its contents — what the capabilities consume. */
export interface SubmittedFile {
  content: string;
  uri?: string | null;
}

/** The path arm of the submitted-files union. */
export interface SubmittedFilePath {
  path: string;
}

/** What the MCP surface accepts per files item — see {@link filesInputSchema}. */
export type SubmittedFileInput = SubmittedFile | SubmittedFilePath;

/**
 * Outcome of resolving one `{ path }` item. Resolvers report failures as
 * values (never throw): every failure is an `input_domain` no-verdict at
 * `files[i].path`, so the resolver supplies only the message and hint — the
 * class, locator, and retryable verdict are fixed by
 * {@link resolveSubmittedFiles}.
 */
export type FileResolution =
  | { ok: true; content: string }
  | { ok: false; message: string; hint: string };

/**
 * The seam the shells fill: the local workshop provides a filesystem-backed
 * resolver; the hosted console provides none, which turns every `{ path }`
 * item into an instructive rejection.
 */
export interface FileResolver {
  resolve(path: string): Promise<FileResolution>;
}

export interface ResolvedFiles {
  files: SubmittedFile[];
  errors: ToolError[];
}

/**
 * Resolve the submitted-files union into plain `{ content, uri? }` items,
 * ahead of the request-shape checks ({@link validateMethodSelectorRequest}).
 * `{ path }` items go through the resolver
 * when one is provided; a resolved item carries `uri` = the submitted path,
 * so diagnostics locate to files the agent can open. Without a resolver a
 * `{ path }` item is rejected instructively — the hosted deployment cannot
 * read files, and the rejection names the local workshop that can. `files` is
 * only meaningful when `errors` is empty.
 */
export async function resolveSubmittedFiles(
  files: SubmittedFileInput[],
  resolver?: FileResolver,
): Promise<ResolvedFiles> {
  const resolved: SubmittedFile[] = [];
  const errors: ToolError[] = [];

  for (const [index, file] of files.entries()) {
    // First-match union semantics: a pathological { content, path } item is
    // the content arm, and its path is ignored.
    if ("content" in file) {
      resolved.push(file);
      continue;
    }

    if (file.path.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `files[${index}].path`,
        message: "File path must not be empty.",
        // Extension-neutral: this routine serves every files-taking argument,
        // and `mthds_save_method`'s `python` arm reads `.py`. Naming `.mthds`
        // here told that caller to submit the one thing the argument refuses.
        hint: "Submit a file path, or inline the contents as { content, uri? }.",
        retryable: false,
      });
      continue;
    }

    if (resolver === undefined) {
      errors.push({
        class: "input_domain",
        location: `files[${index}].path`,
        message: "This deployment cannot read files from disk; submit the file contents instead.",
        hint: "Resubmit this item as { content, uri? } with the file contents inline, or use the local workshop server (npx @pipelex/mcp), which resolves paths.",
        retryable: false,
      });
      continue;
    }

    const resolution = await resolver.resolve(file.path);
    if (resolution.ok) {
      resolved.push({ content: resolution.content, uri: file.path });
    } else {
      errors.push({
        class: "input_domain",
        location: `files[${index}].path`,
        message: resolution.message,
        hint: resolution.hint,
        retryable: false,
      });
    }
  }

  return { files: resolved, errors };
}

export const errorClassSchema = z.enum(["input_domain", "config", "runtime"]);

export type ErrorClass = z.infer<typeof errorClassSchema>;

/**
 * Refinement of {@link ErrorClass} for a condition whose class is settled but
 * whose *cause* the class cannot name. Today the only member is `paywall`: a
 * 402 is deliberately `config` (the deployment cannot make this call as
 * credentialed), yet the class alone would have every headline blame
 * connectivity for what is a billing limit. Adding a member here is how a new
 * such cause gets a headline — never by re-classifying it.
 */
export const errorKindSchema = z.enum(["paywall"]);

export type ErrorKind = z.infer<typeof errorKindSchema>;

export const toolErrorSchema = z.object({
  class: errorClassSchema,
  kind: errorKindSchema
    .optional()
    .describe(
      "Refines `class` when the class alone cannot name the cause. `paywall`: the organization's plan does not cover the call.",
    ),
  location: z.string().optional(),
  message: z.string(),
  hint: z.string().optional(),
  retryable: z
    .boolean()
    .describe("True when retrying the same call may succeed; false for permanent conditions."),
});

export interface ToolError {
  class: ErrorClass;
  /**
   * Set where the concrete SDK error / HTTP status is still known
   * ({@link classifyError}), for the same reason `retryable` is: `class` is
   * the machine contract and must stay coarse, but a paywall and an
   * unreachable API are both `config` and read nothing alike to a human. A
   * machine consumer still branches on `class`; `kind` is what lets it — and
   * the summary headline — tell the two apart without sniffing the message.
   */
  kind?: ErrorKind;
  location?: string;
  message: string;
  hint?: string;
  /**
   * Whether retrying the same call may succeed. Decided where the concrete
   * SDK error / HTTP status is still known ({@link classifyError}): the
   * `class`+`location` pair alone is too coarse — an unreachable API and a
   * permanently missing run lifecycle both classify as `config` at
   * `PIPELEX_BASE_URL`, yet only the former is worth retrying.
   */
  retryable: boolean;
}

/**
 * A capability's no-verdict headlines: one per {@link ErrorClass}, plus one for
 * every {@link ErrorKind}. Declaring the kind headlines is **mandatory** — that
 * is the point of the type. A capability that forgot one would silently print
 * the connectivity headline for a billing refusal, which is the defect this
 * shape exists to make unrepresentable: the miss is a type error, not something
 * a reviewer has to catch.
 */
export type ErrorSummaries = Record<ErrorClass, string> & Record<ErrorKind, string>;

/**
 * Pick a capability's headline for one {@link ToolError}. `kind` is checked
 * ahead of `class` because it is the refinement: a 402 is `config` by contract,
 * so consulting the class map first would print "the Pipelex API is unreachable
 * or misconfigured" for a plan limit and send the agent to debug the base URL.
 */
export function summaryForToolError(error: ToolError, summaries: ErrorSummaries): string {
  return error.kind === undefined ? summaries[error.class] : summaries[error.kind];
}

/** One MCP `content` item — the human/LLM-readable text stream. */
export type ContentText = { type: "text"; text: string };

/**
 * One MCP `image` content item — base64 bytes the host puts in front of the
 * model as a picture. `_meta.uri` is the storage reference the bytes came
 * from, so a programmatic consumer can correlate a block with the `main_stuff`
 * value that produced it; it is the tool result's own `_meta` channel, so the
 * model never pays for it.
 *
 * **No `annotations`, ever.** The MCP standard's `annotations` hint (audience,
 * priority) is optional and looks harmless, but the host probe found that Codex
 * refuses an annotated image block outright with `Unexpected response type`,
 * against a control proving the identical block without them is accepted. See
 * `wip/mcp-image-results/host-probe.md`.
 */
export type ContentImage = {
  type: "image";
  data: string;
  mimeType: string;
  _meta: { uri: string };
};

/**
 * Compose a tool result's `content` text stream. On success (no `errors`) the
 * summary is the whole stream. On a no-verdict error, each {@link ToolError}'s
 * locator, message, and hint are appended as a Markdown list under the summary
 * headline.
 *
 * Without this, the instructive detail every capability writes into
 * `errors[]` (e.g. the hosted `{ path }` rejection naming the local workshop)
 * would live *only* in `structuredContent.errors` — the machine contract — and
 * never reach the agent, which reads `content`. The summary alone is a terse
 * headline ("… request input is invalid."), leaving the agent to guess the
 * cause. Surfacing message + hint here keeps the human/LLM-readable stream
 * actually actionable (the workspace "format follows consumer" rule), while
 * `structuredContent.errors` stays the untouched contract.
 */
export function toolResultContent(summary: string, errors?: ToolError[]): [ContentText] {
  if (errors === undefined || errors.length === 0) {
    return [{ type: "text", text: summary }];
  }
  const details = errors.map(formatToolError).join("\n");
  return [{ type: "text", text: `${summary}\n\n${details}` }];
}

function formatToolError(error: ToolError): string {
  const locator = error.location === undefined ? "" : `\`${error.location}\` — `;
  const message = asOneLine(error.message);
  const hint = error.hint === undefined ? "" : `\n  *Hint: ${asOneLine(error.hint)}*`;
  return `- ${locator}${message}${hint}`;
}

/**
 * Collapse internal whitespace runs (including newlines) to single spaces so a
 * message/hint stays a single Markdown list bullet. An embedded blank line would
 * otherwise terminate the list item early — reachable via a crafted path (a
 * filename may legally contain newlines and still end in `.mthds`), SDK-thrown
 * error text, or a stored catalog name/description. The raw one-liners we
 * normally emit are unaffected.
 */
export function asOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The env-derived API coordinates every capability context starts from. */
export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  /**
   * Who is calling, for the `User-Agent` (`./client-identification.ts`). Set by
   * the shell — `patchLocalApiContexts` in `../local/tools.ts`,
   * `patchHostedApiContexts` in `../hosted/tools.ts` — never by the env: the
   * workshop reads its host from the MCP handshake and the console from each
   * request, so it is a function called when a client is constructed. Absent, a
   * client still names itself `pipelex-mcp/<version>` (`BARE_APP_INFO`).
   */
  appInfo?: AppInfoSource;
}

/**
 * What a shell may override on every capability context that talks to the API.
 * Each shell's tool table applies it to its own context set, since that table
 * is where the list of contexts lives.
 */
export interface ApiContextPatch {
  apiKey?: string;
  authError?: AuthErrorTexture;
  appInfo?: AppInfoSource;
}

/**
 * THE one place this server constructs a Pipelex API client. Every client is
 * given the caller's `appInfo`, so every request it sends carries the
 * `pipelex-mcp/<version> (<mode>; host=<host>)` `User-Agent` and the platform
 * attributes it to the `mcp` surface. The `pipelex/sdk-client-factory` lint rule
 * (`eslint-rules/pipelex-api-boundary.mjs`) refuses `new PipelexApiClient(…)` —
 * or any other `…ApiClient` — anywhere else, and `pipelex/no-raw-fetch` refuses
 * a bare `fetch` outside the files that fetch third-party links.
 *
 * `clientClass` lets a capability pick a subclass (`SizeGuardedPipelexApiClient`)
 * without constructing it itself. The client is built per tool call, which is
 * what makes the lazy `appInfo` possible: by then the workshop has completed its
 * handshake and the console holds the request.
 */
export function createPipelexApiClient<T extends PipelexApiClient = PipelexApiClient>(
  config: ApiConfig,
  clientClass?: new (options: PipelexApiClientOptions) => T,
): T {
  const options: PipelexApiClientOptions = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    appInfo: config.appInfo?.() ?? BARE_APP_INFO,
  };
  const Client =
    clientClass ?? (PipelexApiClient as unknown as new (options: PipelexApiClientOptions) => T);
  return new Client(options);
}

interface ApiEnv {
  PIPELEX_BASE_URL?: string;
  PIPELEX_API_KEY?: string;
}

export function buildApiConfig(env: ApiEnv = process.env): ApiConfig {
  return {
    baseUrl: env.PIPELEX_BASE_URL || DEFAULT_API_URL,
    apiKey: env.PIPELEX_API_KEY || undefined,
  };
}

/**
 * The bundle blueprint's declared `main_pipe`, qualified by the blueprint's
 * `domain` when it is authored bare — the fallback pipe both the validate
 * capability and the console's input walk (`console-inputs.ts`) consult behind
 * the runner's own `default_pipe_ref`.
 *
 * Every read is defensive: `bundle_blueprint` is opaque transport (its schema
 * is the runtime's, not this server's), so a blueprint that is not an object,
 * a non-string `main_pipe` and a non-string `domain` are all "the blueprint
 * declares none" rather than something to guess at.
 *
 * **A `main_pipe` that already carries a domain is returned untouched**, which
 * is the rule `@pipelex/sdk`'s own `readBlueprintMainPipeRef` applies and which
 * this repo used to get wrong by always prefixing: a cross-domain
 * `main_pipe = "other.shout"` became `demo.other.shout`, a ref that keys
 * neither `pipe_io_contracts` nor `input_form`, so the signature silently went
 * missing instead of being found. Only reachable on a runner old enough to
 * serve no `default_pipe_ref`, which is why it went unseen.
 *
 * **Both members are trimmed before use**, which is not cosmetic: the SDK reads
 * them through its own `nonEmptyString`, and `mthds_prepare_inputs` mirrors the
 * SDK's pipe selection on the console while delegating to it on the workshop.
 * Without the trim a padded `main_pipe` keyed nothing here and `domain.main`
 * there, so one method prepared on one shell and was refused on the other —
 * the one outcome `selectPipeRef` says this tool cannot have. Nothing upstream
 * strips it: `pipelex`'s `DomainBlueprint.main_pipe` is a bare `str` with no
 * validator, so a padded TOML value reaches the wire intact.
 */
export function blueprintMainPipeRefOf(blueprint: unknown): string | undefined {
  if (blueprint === null || typeof blueprint !== "object" || Array.isArray(blueprint)) {
    return undefined;
  }
  const record = blueprint as Record<string, unknown>;
  const mainPipe = trimmedNonEmpty(record.main_pipe);
  if (mainPipe === undefined) {
    return undefined;
  }
  if (mainPipe.includes(".")) {
    return mainPipe;
  }
  const domain = trimmedNonEmpty(record.domain);
  return domain === undefined ? undefined : `${domain}.${mainPipe}`;
}

/** A trimmed non-empty string, or `undefined` — the SDK's `nonEmptyString` rule. */
function trimmedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A plain object, or `undefined` — the one narrowing step every artifact check starts from. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A non-empty record — the test for whether a per-pipe artifact map is worth
 * shipping to a view at all. The view looks pipes up in it, so an empty map can
 * drive nothing, and a runner that ignored the `views` token returns nothing
 * rather than an empty map. Shared by `mthds_validate`, which gates the input
 * form's artifacts on it, and by `mthds_run_results`, which gates the run's.
 */
export function hasArtifactEntries(artifact: unknown): boolean {
  const map = asRecord(artifact);
  return map !== undefined && Object.keys(map).length > 0;
}

/** The shared `<address>[@<tag>]` grammar sentence, reused by schema descriptions and hints. */
export const METHOD_REF_GRAMMAR =
  "github.com/<owner>/<repo>[/<selector>][@<tag>], e.g. github.com/Pipelex/methods/documents@v0.1.0";

/**
 * The selectors a method-taking request may carry beside its (already
 * resolved) inline files. `undefined` means "not supplied"; a supplied-but-
 * blank value is rejected loudly rather than treated as absent.
 */
export interface MethodSelectors {
  method_ref?: string;
  method_id?: string;
}

/**
 * The two uniform combination rules of the addressing contract (SPEC.md →
 * Method Selectors):
 *
 * - `"one_selector"` — the tooling tools (`mthds_validate`,
 *   `mthds_inputs_template`, `mthds_prepare_inputs`, `mthds_codegen`): exactly one of files /
 *   `method_ref` / `method_id`. Stateless operations have no Run row, so
 *   "linkage" has no referent and an extra selector could only be ignored —
 *   the worst contract of the three.
 * - `"run_source"` — `mthds_run`: inline files win and `method_id` beside them
 *   demotes to run-history linkage (legal pair), while `method_ref` is a
 *   complete run source of its own and pairs with nothing.
 */
export type SelectorRule = "one_selector" | "run_source";

/**
 * Request-shape checks for every method-taking tool: at least one method
 * selector must be supplied, blank selectors are rejected at their own field,
 * and the illegal pairings for the given {@link SelectorRule} are rejected
 * before anything reaches the wire (mirroring the API's own 422s). Selector
 * format beyond non-blank stays server-owned (the `run_id` stance).
 *
 * Every method-taking tool exposes all three selectors, so the teaching text is
 * unconditional. It was not always: `mthds_prepare_inputs` withheld
 * `method_ref` while the SDK's `prepareInputs` took inline files only, and this
 * function took an `acceptsMethodRef` flag to keep the "no selector" message
 * honest for it. The flag went out with the exception rather than surviving as
 * a parameter with one reachable value.
 */
export function validateMethodSelectorRequest(
  files: SubmittedFile[],
  selectors: MethodSelectors,
  options: { rule: SelectorRule },
): ToolError[] {
  const errors: ToolError[] = [];

  if (selectors.method_ref !== undefined && selectors.method_ref.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "method_ref",
      message: "method_ref must not be empty when supplied.",
      hint: `Pass a published method's address — ${METHOD_REF_GRAMMAR} — or submit files or a method_id instead.`,
      retryable: false,
    });
  }

  if (selectors.method_id !== undefined && selectors.method_id.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "method_id",
      message: "method_id must not be empty when supplied.",
      hint: "Pass the catalog id (mt_…) of a registered method, or submit files instead.",
      retryable: false,
    });
  }

  if (
    files.length === 0 &&
    selectors.method_ref === undefined &&
    selectors.method_id === undefined
  ) {
    errors.push({
      class: "input_domain",
      location: "files",
      message: "Provide MTHDS files, a method_ref address, or a method_id.",
      hint: `Submit files as [{ content, uri? }], a published method's address (${METHOD_REF_GRAMMAR}) as method_ref, or the catalog id (mt_…) of a registered method as method_id.`,
      retryable: false,
    });
  }

  errors.push(...validateSelectorExclusivity(files, selectors, options.rule));
  errors.push(...validateFileItems(files));
  return errors;
}

/**
 * Request-shape checks for a tool that names its method by reference only —
 * the console's `pipelex_show_method` and `pipelex_run`, which take no files:
 * exactly one of `method_id` / `method_ref`, neither blank. It is the
 * `one_selector` rule of {@link validateMethodSelectorRequest} with the files
 * arm gone, and its teaching text names only the two forms such a tool takes,
 * since telling a caller to "submit files" to a tool with no `files` argument
 * sends it after a parameter that does not exist.
 */
export function validateMethodReferenceRequest(selectors: MethodSelectors): ToolError[] {
  const errors: ToolError[] = [];

  if (selectors.method_ref !== undefined && selectors.method_ref.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "method_ref",
      message: "method_ref must not be empty when supplied.",
      hint: `Pass a published method's address — ${METHOD_REF_GRAMMAR} — or a saved method's catalog id (mt_…) as method_id instead.`,
      retryable: false,
    });
  }

  if (selectors.method_id !== undefined && selectors.method_id.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "method_id",
      message: "method_id must not be empty when supplied.",
      hint: "Pass the catalog id (mt_…) of a saved method, or a published method's address as method_ref instead.",
      retryable: false,
    });
  }

  if (selectors.method_ref === undefined && selectors.method_id === undefined) {
    errors.push({
      class: "input_domain",
      location: "method_id",
      message: "Provide a method_id or a method_ref.",
      hint: `Pass the catalog id (mt_…) of a saved method as method_id, or a published method's address (${METHOD_REF_GRAMMAR}) as method_ref.`,
      retryable: false,
    });
  }

  errors.push(...validateSelectorExclusivity([], selectors, "one_selector"));
  return errors;
}

/**
 * The illegal pairings per {@link SelectorRule}. Evaluated only on validly
 * supplied selectors (a blank one already earned its own error above), and
 * emitting one error per illegal pair so a three-selector request teaches both
 * offenses instead of one.
 */
function validateSelectorExclusivity(
  files: SubmittedFile[],
  selectors: MethodSelectors,
  rule: SelectorRule,
): ToolError[] {
  const errors: ToolError[] = [];
  const hasFiles = files.length > 0;
  const hasRef = selectors.method_ref !== undefined && selectors.method_ref.trim() !== "";
  const hasId = selectors.method_id !== undefined && selectors.method_id.trim() !== "";

  if (hasFiles && hasRef) {
    errors.push({
      class: "input_domain",
      location: "method_ref",
      message:
        "files and method_ref are mutually exclusive — submit the files or the address, never both.",
      hint: "An address is a complete method source resolved server-side; drop method_ref to operate on the submitted files, or drop files to operate on the published package.",
      retryable: false,
    });
  }

  if (hasRef && hasId) {
    errors.push({
      class: "input_domain",
      location: "method_id",
      message:
        rule === "run_source"
          ? "method_ref and method_id are mutually exclusive — an address run carries its own provenance and takes no linkage id."
          : "method_ref and method_id are mutually exclusive — select the method by exactly one of them.",
      hint: "Drop one of the two selectors.",
      retryable: false,
    });
  }

  if (rule === "one_selector" && hasFiles && hasId) {
    errors.push({
      class: "input_domain",
      location: "method_id",
      message:
        "files and method_id are mutually exclusive on this tool — submit the files or the catalog id, never both.",
      hint: "This operation is stateless, so there is no run-history linkage for an extra id to feed; drop method_id to operate on the submitted files, or drop files to operate on the registered method.",
      retryable: false,
    });
  }

  return errors;
}

function validateFileItems(files: SubmittedFile[]): ToolError[] {
  const errors: ToolError[] = [];

  for (const [index, file] of files.entries()) {
    if (file.content.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `files[${index}].content`,
        message: "File content must not be empty.",
        hint: "Submit the full .mthds file contents.",
        retryable: false,
      });
    }

    if (file.uri !== undefined && file.uri !== null && file.uri.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `files[${index}].uri`,
        message: "File uri must not be empty when supplied.",
        hint: "Omit uri for inline content or provide a stable path or URI.",
        retryable: false,
      });
    }
  }

  return errors;
}

/** Request-shape check on a run id (format stays server-owned). */
export function validateRunIdRequest(
  runId: string,
  names: ToolNames = WORKSHOP_TOOL_NAMES,
): ToolError[] {
  if (runId.trim() === "") {
    return [
      {
        class: "input_domain",
        location: "run_id",
        message: "run_id must not be empty.",
        hint: `Pass the durable run id returned by ${names.run}.`,
        retryable: false,
      },
    ];
  }
  return [];
}

/**
 * Route-specific texture for {@link classifyError}. The classification itself
 * (which HTTP status or SDK error maps to which `ErrorClass`) is shared; only
 * the locator and hint of a 400/422 rejection and the route named in the 404
 * hint differ per capability.
 */
export interface ClassifyErrorOptions {
  /** The API route the capability calls, named in the 404 hint. */
  route?: string;
  /** Locator + hint for a 400/422 no-verdict rejection. */
  badRequest?: {
    /** Override the default input_domain classification for route-level 400/422 responses. */
    class?: ErrorClass;
    location?: string;
    hint: string;
  };
  /**
   * Per-route 404 override. By default a 404 means the route itself is
   * missing (`config` — wrong base URL). Routes keyed by a resource id (the
   * run routes) set this so a 404 classifies as `input_domain` ("no run with
   * this id") instead. The SDK separates the missing-route case up front by
   * throwing `RunLifecycleUnavailableError`, so an `ApiResponseError` 404 on
   * those routes really is an unknown id.
   */
  notFound?: {
    location?: string;
    hint: string;
  };
  /**
   * The request field that named the method on this route — `files`,
   * `method_ref` or `method_id`, picked per request shape like
   * {@link badRequest}'s locator.
   *
   * It exists for the **execution-locus gate**, the one refusal whose fault is
   * the method the caller named rather than the credential they sent. The gate
   * is the runner's, so which field named the method is the only thing the
   * arm cannot know for itself, and hardcoding `method_ref` would be wrong on
   * `/v1/start`, which applies the gate to a submitted bundle and to a stored
   * method's injected source as well as to a fetched package.
   *
   * Left unset on the two routes the gate cannot reach at all:
   * `/v1/build/inputs` and `/v1/codegen` resolve an address through
   * `fetch_method_mthds_files`, which takes only the `.mthds` files and loads
   * no Python, so no execution locus is ever decided there. An arm that fires
   * with this unset reports no location rather than a wrong one.
   *
   * It IS set on every shape of a gated route, including `/v1/validate`'s
   * files shape, where the gate happens to be unreachable today because inline
   * contents travel as `mthds_contents` and carry no `.py`. That is the
   * route's current wiring rather than a rule, and a locator costs nothing to
   * keep right.
   */
  methodLocation?: string;
  /**
   * Per-route 501 override. A 501 on a method-taking route is the reserved
   * registry form of `method_ref` (any non-address reference) — the caller's
   * own selector, not a server fault — so selector-shaped requests set this to
   * classify it `input_domain` at `method_ref` with the address-grammar hint.
   * Routes that never send a `method_ref` leave it unset and keep the generic
   * unexpected-status arm.
   */
  notImplemented?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route 413 override. A route that refuses a declared size before any
   * bytes move (`/v1/upload/grant` answers `413 payload_too_large` for a size
   * over the upload cap) sets this so the refusal is `input_domain` at the
   * size the caller declared, with the server's own message naming the limit.
   * Routes that never declare a size leave it unset and keep the generic
   * unexpected-status arm.
   */
  tooLarge?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route 5xx hint override. Use it when a route is known to report
   * request-caused failures as a generic server error (the hosted `/v1/start`
   * answers 503 "Failed to start pipeline" for an invalid bundle), so the
   * agent gets a recovery pointer instead of "inspect server logs".
   */
  serverError?: {
    hint: string;
  };
  /**
   * Per-deployment texture for auth failures (`ClientAuthenticationError`,
   * HTTP 401/403). The default wording points at the `PIPELEX_API_KEY` env
   * var — right for the workshop, where the caller owns the process env. The
   * hosted console overrides it per request (`src/hosted/contexts.ts`): its
   * callers cannot touch the server env and authenticate by signing in, so
   * they must be pointed at reconnecting the connector instead. Capabilities
   * thread it from their context's `authError` field.
   */
  auth?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route hint override for a 403 specifically. The generic 401/403 arm
   * says "check your credential", which is right for a rejected key or an
   * expired session and wrong for a route a deployment gates beyond
   * authentication — the hosted `/v1/codegen` sits behind a feature flag as
   * well as a plan, so a caller whose credential is perfectly valid can still
   * be refused. A route that knows this composes the deployment's auth wording
   * with the gate's; the locator stays the auth one. A 401 never reads it.
   */
  forbidden?: {
    hint: string;
  };
  /**
   * Per-route texture for the **input-preparation family's base error** — the
   * SDK's `InputPreparationError` raised client-side, before any request, when
   * the signature does not resolve, `pipe_ref` is unqualified or unknown, or the
   * closure settles no single default pipe. Defaults to {@link badRequest}, but
   * the two are not the same question and `mthds_prepare_inputs` separates them:
   * its `badRequest` follows the request's SELECTOR shape, because a real 400/422
   * from the route is about the selector the caller typed, while a client-side
   * signature failure is always about the pipe, whatever named the method. Without
   * this, a by-address request with a bad `pipe_ref` reported the address as the
   * problem.
   */
  preparation?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route texture for {@link MissingInputFormError} — the deployment served
   * a report with no usable `input_form` descriptor. Classified `config`, not
   * `input_domain`: no request the caller can write works around it, so
   * reporting it against one of their fields sent them editing a request that
   * was never the problem. Defaults to `PIPELEX_BASE_URL`, the knob that
   * actually selects the deployment.
   */
  missingDescriptor?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route texture for {@link UnresolvableClosureError} — the method's own
   * bundle did not validate, so no signature could be read from it. It locates
   * at whatever NAMED the method (the files, the address, the id) and never at
   * `pipe_ref`, which is why it is separate from {@link preparation}: that
   * texture answers "which pipe?", and this one answers "which method?".
   * Defaults to {@link badRequest}, whose locator already follows the selector.
   */
  closure?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route texture for a refused or unreadable asset on the upload leg.
   * `location` covers both arms (`RejectedAssetError` /
   * `InvalidLocalSourceError`) and defaults to `inputs` — right for
   * `mthds_prepare_inputs`, whose assets are values inside the filled inputs;
   * wrong for `mthds_upload_attachments`, whose assets are located per item.
   * `hint` covers the size-refusal arm only, so a route can name the real
   * upload ceiling; an unreadable local path keeps its own path-readability
   * hint either way.
   */
  asset?: {
    location?: string;
    hint?: string;
  };
}

/** The per-deployment auth-failure texture a capability context can carry. */
export type AuthErrorTexture = NonNullable<ClassifyErrorOptions["auth"]>;

const DEFAULT_BAD_REQUEST: NonNullable<ClassifyErrorOptions["badRequest"]> = {
  location: "files",
  hint: "Check the submitted file contents and provenance fields.",
};

/** The env-var auth wording a 401/403 carries when no deployment texture overrides it. */
export const DEFAULT_AUTH_HINT = "Check PIPELEX_API_KEY for the configured API.";

/**
 * The deployment served a validation report with no usable `input_form`
 * descriptor. Derives from the SDK's `InputPreparationError` so a caller
 * catching the family still catches it, but {@link classifyError} pulls it out
 * ahead of the base arm: it is a deployment fault, not a request the caller can
 * repair.
 */
export class MissingInputFormError extends InputPreparationError {
  constructor(message: string) {
    super(message);
    this.name = "MissingInputFormError";
  }
}

/**
 * The method's own closure did not validate, so no signature could be read.
 * Separated from the preparation family for the locator alone: left in it, a
 * caller who named a broken published package by `method_ref` was told to fix
 * their `pipe_ref` — a field they had left empty, on a bundle they do not own.
 */
export class UnresolvableClosureError extends InputPreparationError {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvableClosureError";
  }
}

export function classifyError(err: unknown, options: ClassifyErrorOptions = {}): ToolError {
  if (err instanceof ApiUnreachableError) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: err.message,
      hint: "Start pipelex-api locally or set PIPELEX_BASE_URL to a reachable host-only API base URL.",
      retryable: true,
    };
  }

  if (err instanceof ClientAuthenticationError) {
    return {
      class: "config",
      location: options.auth?.location ?? "PIPELEX_API_KEY",
      message: err.message,
      hint: options.auth?.hint ?? "Check the API key for the configured Pipelex API.",
      retryable: false,
    };
  }

  if (err instanceof ApiResponseError) {
    return classifyApiResponseError(err, options);
  }

  // The SDK raises this when the configured base URL serves the protocol
  // routes but not the durable run lifecycle (a bare pipelex-api runner).
  if (err instanceof RunLifecycleUnavailableError) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: err.message,
      hint: "Durable runs need the hosted Pipelex API; point PIPELEX_BASE_URL at a deployment serving /v1/runs/* (a bare pipelex-api runner does not).",
      retryable: false,
    };
  }

  // A completed run that delivers no main output is a reachable contract
  // violation — the API answered, but its report is malformed.
  if (err instanceof MissingMainStuffError) {
    return {
      class: "runtime",
      message: err.message,
      hint: "The API reported the run completed but delivered no main output; inspect the run on the platform.",
      retryable: false,
    };
  }

  // ── Input-preparation family (mthds_prepare_inputs) ──
  // Every one of these derives from PipelineRequestError, so they MUST be
  // classified here, ahead of the generic PipelineRequestError arm below
  // (mirroring how EmptyMethodSourceError is caught in fetchMethodFiles).
  // Ordered most-specific first: subclasses before the InputPreparationError
  // base.

  // Normally caught in fetchMethodFiles before reaching classifyError; mapped
  // defensively so a stray one still locates at method_id, not pipe_ref.
  if (err instanceof EmptyMethodSourceError) {
    return {
      class: "input_domain",
      location: "method_id",
      message: err.message,
      hint: "The stored method has no MTHDS source yet. Add MTHDS content to it, or submit files instead.",
      retryable: false,
    };
  }

  // The upload ceiling's local refusal (`upload-ceiling.ts`) is thrown from
  // inside the client's `upload()`, and the SDK's `uploadFile` wraps anything
  // `upload()` throws that is neither an API response nor an unreachable host in
  // an `UploadTransportError`. So the refusal arrives as that error's cause, and
  // the transport arm below would call an oversize file retryable.
  if (err instanceof UploadTransportError && err.cause instanceof RejectedAssetError) {
    return classifyError(err.cause, options);
  }

  // A missing/unreadable local path or an asset the storage service refused
  // (413): the caller's input value is the problem.
  if (err instanceof InvalidLocalSourceError || err instanceof RejectedAssetError) {
    return {
      class: "input_domain",
      location: options.asset?.location ?? "inputs",
      message: err.message,
      hint:
        err instanceof RejectedAssetError
          ? (options.asset?.hint ??
            "Pipelex storage refused the asset (too large). Shrink the file, or reference it by an http(s) URL instead.")
          : "Check the file path is correct and readable, or reference the asset by an http(s) URL / pipelex-storage:// URI instead.",
      retryable: false,
    };
  }

  // The configured deployment has no upload route (a bare pipelex-api runner):
  // an environment/config problem, not the caller's request.
  if (err instanceof UnsupportedUploadCapabilityError) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: err.message,
      hint: "The configured Pipelex deployment has no /v1/upload route. Point PIPELEX_BASE_URL at the hosted Pipelex API, or pass assets as http(s) URLs / pipelex-storage:// references.",
      retryable: false,
    };
  }

  if (err instanceof UploadAuthenticationError) {
    return {
      class: "config",
      location: options.auth?.location ?? "PIPELEX_API_KEY",
      message: err.message,
      hint: options.auth?.hint ?? "Check the API key for the configured Pipelex API.",
      retryable: false,
    };
  }

  // A network/server fault reaching the upload route stays retryable.
  if (err instanceof UploadTransportError) {
    return {
      class: "runtime",
      message: err.message,
      hint: "The upload could not reach Pipelex storage; retry, and inspect the API if it persists.",
      retryable: true,
    };
  }

  // Two subclasses first, because both derive from InputPreparationError and
  // the base arm below would otherwise swallow them — which is exactly what it
  // used to do, reporting each against the caller's `pipe_ref`.

  // The deployment served no usable descriptor. A `config` condition: the
  // message and the hint used to contradict each other, one naming the
  // deployment and the other telling the caller to qualify a pipe.
  if (err instanceof MissingInputFormError) {
    const texture = options.missingDescriptor;
    return {
      class: "config",
      location: texture?.location ?? "PIPELEX_BASE_URL",
      message: err.message,
      hint:
        texture?.hint ??
        "Point the API at a deployment that serves the input-form descriptor (pipelex-api >= 0.18.0).",
      retryable: false,
    };
  }

  // The closure itself is broken — a question about whatever named the method,
  // so it takes the selector's own locator rather than the pipe's.
  if (err instanceof UnresolvableClosureError) {
    const texture = options.closure ?? options.badRequest ?? DEFAULT_BAD_REQUEST;
    return {
      class: "input_domain",
      ...(texture.location === undefined ? {} : { location: texture.location }),
      message: err.message,
      hint: texture.hint,
      retryable: false,
    };
  }

  // The base class: an unqualified or unknown pipe_ref, no single default pipe,
  // or a caller value at a file position that was malformed/unsupported. All are
  // request-domain problems, and all are raised CLIENT-SIDE — so they locate at
  // `preparation`,
  // which a route separates from `badRequest` when its 400/422 is about a
  // different field. `badRequest` remains the fallback for a route that has no
  // such distinction to draw.
  if (err instanceof InputPreparationError) {
    const texture = options.preparation ?? options.badRequest ?? DEFAULT_BAD_REQUEST;
    return {
      class: "input_domain",
      ...(texture.location === undefined ? {} : { location: texture.location }),
      message: err.message,
      hint: texture.hint,
      retryable: false,
    };
  }

  // ── Artifact family (mthds_download_artifacts) ──
  // The SDK's artifact operations throw only when no verdict can be produced;
  // per-reference failures are values on the verdict. These derive from
  // PipelineRequestError too, so they MUST be classified here, ahead of the
  // generic arm below. Most-specific first: subclasses before the base.

  // The resolve route refused the credential (401/403) — the auth arm, like
  // UploadAuthenticationError on the upload leg.
  if (err instanceof ArtifactAuthenticationError) {
    return {
      class: "config",
      location: options.auth?.location ?? "PIPELEX_API_KEY",
      message: err.message,
      hint: options.auth?.hint ?? DEFAULT_AUTH_HINT,
      retryable: false,
    };
  }

  // The scope walked carries no artifact on a completed run: the API answered,
  // but its report is malformed — the MissingMainStuffError reading.
  if (err instanceof ScopeUnavailableError) {
    return {
      class: "runtime",
      message: err.message,
      hint: "The API reported the run completed but its results carry no output to walk for files; inspect the run on the platform.",
      retryable: false,
    };
  }

  // The base class: a malformed bulk-resolve answer or a directory the download
  // could not use after containment approved it. Neither is the caller's input.
  if (err instanceof ArtifactOperationError) {
    return {
      class: "runtime",
      message: err.message,
      hint: "The download could not proceed; inspect the MCP server logs and the API.",
      retryable: false,
    };
  }

  if (err instanceof PipelineRequestError) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: err.message,
      hint: "Check PIPELEX_BASE_URL and the submitted request.",
      retryable: false,
    };
  }

  // Unknown faults stay retryable: for the poll loops, wrongly stopping a
  // live follow is worse than one more read against a fault we can't name.
  if (err instanceof Error) {
    return {
      class: "runtime",
      message: err.message,
      hint: "Inspect the MCP server logs and local pipelex-api logs.",
      retryable: true,
    };
  }

  return {
    class: "runtime",
    message: "Unknown failure.",
    hint: "Inspect the MCP server logs and local pipelex-api logs.",
    retryable: true,
  };
}

/** The slice of `PipelexApiClient` the by-id fetch leg calls (test seam). */
export interface MethodFetchClient {
  getMethodClosure(methodId: string): Promise<MthdsFileItem[]>;
}

/**
 * Classify options for the by-id expansion leg (`getMethodClosure`, itself a
 * `getMethod` + parse under the hood), used by the one capability whose
 * surface the platform's tooling `method_id` selector deliberately excludes:
 * `mthds_inputs_template`, over `/v1/build/inputs`. Every other method-taking
 * tool forwards `method_id` server-side — `mthds_prepare_inputs` since
 * `@pipelex/sdk` 0.17.0 gave `prepareInputs` all three selectors. Unlike
 * `/v1/start`, the SDK does not intercept a missing-route 404 on
 * `/v1/methods/{id}` (no `RunLifecycleUnavailableError` equivalent), so a
 * bare-runner base URL and a genuinely unknown method read the same here —
 * the `notFound` hint covers both causes.
 */
export const METHOD_FETCH_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/methods/{id}",
  badRequest: {
    location: "method_id",
    hint: "Check the method_id as the catalog returned it. If the error mentions organization context, the API key's org binding is the issue — mint a key in the right organization.",
  },
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. Check the id as the catalog returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss. If PIPELEX_BASE_URL points at a bare pipelex-api runner, the catalog routes do not exist there — use the hosted Pipelex API.",
  },
};

/**
 * `reason` lets callers pick their own headline text for the two failure
 * shapes without this shared leg hardcoding either one: `"fetch"` is a
 * classified SDK/HTTP failure (pair with each capability's own
 * `summaryForError`); `"no_source"` is the stored method having no MTHDS
 * content yet (a caller-composed headline, since only the caller's verb
 * — "validated", "projected" — makes it read naturally).
 */
export type MethodFetchResult =
  | { ok: true; files: SubmittedFile[] }
  | { ok: false; reason: "fetch" | "no_source"; error: ToolError };

/**
 * Resolve a stored method's current closure and forward it as submitted files,
 * each labeled with the method id as provenance (`uri`) — the SDK-canonical
 * by-id expansion (`buildInputs({ files: await getMethodClosure(methodId) })`
 * is the SDK's own documented pattern) behind the id-only path of the one tool
 * whose surface the hosted `method_id` selector deliberately excludes:
 * `mthds_inputs_template` (the build routes take no `method_id`). Every other
 * method-taking tool forwards its selectors server-side and does not use this.
 * `getMethodClosure` (the SDK's canonical fetch-and-parse over `getMethod` +
 * `methodSourceToContents`) already labels each file's `source` with the
 * method id; the MCP surface spells provenance `uri`, so we relabel.
 * `getClient` is a factory, not a pre-built client, so a malformed-base-URL
 * throw from the SDK constructor happens inside this function's own try block
 * and classifies as a `config` `ToolError` instead of escaping uncaught
 * (mirrors `run.ts`'s `runClient` call-inline pattern). The no-source hint is
 * the only thing that differs per caller (what the caller was trying to do
 * with the method).
 */
export async function fetchMethodFiles(
  getClient: () => MethodFetchClient,
  methodId: string,
  options: { authError?: AuthErrorTexture; noSourceHint: string },
): Promise<MethodFetchResult> {
  let closure: MthdsFileItem[];
  try {
    closure = await getClient().getMethodClosure(methodId);
  } catch (err) {
    // A real, in-org method whose stored source parses to nothing throws
    // EmptyMethodSourceError (the empty-closure check the MCP used to run by
    // hand, now folded into getMethodClosure). Map it to the same
    // input_domain@method_id no-verdict, tagged `no_source` so the caller can
    // compose its own headline. It derives from PipelineRequestError, so it
    // MUST be caught ahead of classifyError, which would otherwise call it a
    // config fault.
    if (err instanceof EmptyMethodSourceError) {
      return {
        ok: false,
        reason: "no_source",
        error: {
          class: "input_domain",
          location: "method_id",
          message: "The stored method has no MTHDS source yet.",
          hint: options.noSourceHint,
          retryable: false,
        },
      };
    }
    return {
      ok: false,
      reason: "fetch",
      error: classifyError(err, { ...METHOD_FETCH_ERROR_OPTIONS, auth: options.authError }),
    };
  }

  return { ok: true, files: closure.map((item) => ({ content: item.content, uri: methodId })) };
}

function classifyApiResponseError(err: ApiResponseError, options: ClassifyErrorOptions): ToolError {
  const message = err.serverMessage ?? err.message;
  const badRequest = options.badRequest ?? DEFAULT_BAD_REQUEST;
  const route = options.route ?? "the Pipelex API";

  if (err.status === 400 || err.status === 422) {
    return {
      class: badRequest.class ?? "input_domain",
      ...(badRequest.location === undefined ? {} : { location: badRequest.location }),
      message,
      hint: badRequest.hint,
      retryable: false,
    };
  }

  // A fetched package that declares in-process Python structure classes is
  // refused with a 403 whose `error_type` names the policy — a caller-input
  // condition, not an auth failure, so it must be caught ahead of the generic
  // 401/403 arm (which would send the caller to debug their API key).
  // Branching on `errorType` is the runner's declared contract: each
  // MethodRefError subclass keeps its class name as the distinct error_type
  // for callers to branch on.
  if (err.status === 403 && err.errorType === "MethodStructuresRefusedError") {
    return {
      class: "input_domain",
      location: "method_ref",
      message,
      hint: "Hosted execution accepts MTHDS concepts and sandboxed PipeFuncs, not in-process Python — the referenced package declares Python structure classes. Express its types as MTHDS concepts, or run it on a self-hosted OSS runner.",
      retryable: false,
    };
  }

  // The execution-locus gate's other refusal, and the one that reads worst
  // when it is missed: a method shipping custom Python (`.py`) is refused by a
  // deployment that is not sandbox-hosted, because running it would import
  // caller-supplied code into the runner's own process. Unlike the structures
  // refusal above this one is a property of the PAIR — the method and the
  // deployment — and the method is not malformed: the very same method runs on
  // a sandbox-hosted deployment, which is where PipeFunc Python belongs. The
  // class is still `input_domain`, by this repo's own test for it: a request
  // the caller can write does work around it (a Python-free method), which is
  // exactly what `missingDescriptor` is `config` for failing. The runner reads
  // it the same way — `raise_forbidden` tags this refusal `error_domain:
  // input` (`pipelex-api/api/errors.py`) — though the SDK surfaces no
  // `error_domain`, which is why the branch is on `errorType`. What must not
  // happen is the generic 401/403 arm, which told a caller whose credential is
  // perfectly good to go and mint a new key.
  if (err.status === 403 && err.errorType === "CustomCodeRequiresSandbox") {
    return {
      class: "input_domain",
      ...(options.methodLocation === undefined ? {} : { location: options.methodLocation }),
      message,
      hint: "This deployment is not sandbox-hosted, so it refuses a method that ships custom Python (.py) — the credential is not the problem. Run the method on a sandbox-hosted deployment, or name one whose pipes are all MTHDS.",
      retryable: false,
    };
  }

  if (err.status === 401 || err.status === 403) {
    return {
      class: "config",
      location: options.auth?.location ?? "PIPELEX_API_KEY",
      message,
      hint:
        err.status === 403 && options.forbidden !== undefined
          ? options.forbidden.hint
          : (options.auth?.hint ?? DEFAULT_AUTH_HINT),
      retryable: false,
    };
  }

  // Paywall: the platform reports a plan limit as 402 SubscriptionRequiredError.
  // Branch on the HTTP status only — its problem `code` is "forbidden" and must
  // never be sniffed. The class stays `config` (the settled contract: the call
  // cannot be made as credentialed), and `kind` is what carries the cause into
  // each capability's headline — see {@link summaryForToolError}.
  if (err.status === 402) {
    return {
      class: "config",
      kind: "paywall",
      message,
      hint: "The organization's plan does not cover this call. Review the plan and billing for the API key's organization on app.pipelex.com.",
      retryable: false,
    };
  }

  if (err.status === 404) {
    if (options.notFound) {
      return {
        class: "input_domain",
        ...(options.notFound.location === undefined ? {} : { location: options.notFound.location }),
        message,
        hint: options.notFound.hint,
        retryable: false,
      };
    }
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message,
      hint: `Check that PIPELEX_BASE_URL points to a host serving ${route}.`,
      retryable: false,
    };
  }

  // The reserved registry form of `method_ref` — the caller's own selector,
  // classified only on routes that declared the texture (selector-shaped
  // requests); elsewhere a 501 keeps the generic unexpected-status arm below.
  if (err.status === 501 && options.notImplemented) {
    return {
      class: "input_domain",
      ...(options.notImplemented.location === undefined
        ? {}
        : { location: options.notImplemented.location }),
      message,
      hint: options.notImplemented.hint,
      retryable: false,
    };
  }

  if (err.status === 413 && options.tooLarge) {
    return {
      class: "input_domain",
      ...(options.tooLarge.location === undefined ? {} : { location: options.tooLarge.location }),
      message,
      hint: options.tooLarge.hint,
      retryable: false,
    };
  }

  if (err.status >= 500) {
    return {
      class: "runtime",
      message,
      hint:
        options.serverError?.hint ??
        "The Pipelex API returned a server error; inspect pipelex-api logs.",
      retryable: true,
    };
  }

  return {
    class: "runtime",
    message,
    hint: `The Pipelex API returned HTTP ${err.status}.`,
    retryable: false,
  };
}

// ── the artifact fetch boundary, shared by the two tools that cross it ──

/**
 * The explicit override of the plain-http rule, read by every capability that
 * fetches a stored artifact — `mthds_download_artifacts` on the workshop and
 * `mthds_show_images` on both shells. Unset, a plain `http:` link is accepted
 * exactly when `PIPELEX_BASE_URL` is itself `http:` (the local compose stack,
 * whose object store mints plain-http links); `true` / `1` accepts one from any
 * deployment, `false` / `0` refuses one from every deployment. Any other value
 * refuses, so a typo fails closed.
 */
export const ALLOW_HTTP_ENV = "PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP";

/**
 * Read {@link ALLOW_HTTP_ENV}: `undefined` when unset or blank (derive from
 * the base URL), otherwise the override. An unrecognized value refuses rather
 * than falling back to the derivation, so a misspelled override can only ever
 * make the fetch stricter.
 */
export function parseAllowHttpOverride(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return undefined;
  return normalized === "true" || normalized === "1";
}

/** The env-derived coordinates plus the plain-http override, for a fetching capability. */
export interface ArtifactFetchConfig extends ApiConfig {
  allowHttp?: boolean;
}

interface ArtifactFetchEnv extends ApiEnv {
  [ALLOW_HTTP_ENV]?: string;
}

export function buildArtifactFetchConfig(env: ArtifactFetchEnv = process.env): ArtifactFetchConfig {
  const allowHttp = parseAllowHttpOverride(env[ALLOW_HTTP_ENV]);
  return { ...buildApiConfig(env), ...(allowHttp === undefined ? {} : { allowHttp }) };
}

/**
 * Whether a plain `http:` download link is fetched: the explicit override when
 * one is set, otherwise exactly when the configured API is itself plain http —
 * the local compose stack, whose object store mints plain-http presigned links.
 * A deployment reached over https gets https links, so a plain-http one there
 * is refused rather than followed silently. A malformed base URL refuses; the
 * client constructor then reports it as the config error it is.
 */
export function allowsPlainHttp(context: ArtifactFetchConfig): boolean {
  if (context.allowHttp !== undefined) return context.allowHttp;
  try {
    return new URL(context.baseUrl).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Classify options for the bulk resolve route, the one request both fetching
 * capabilities make on the caller's behalf. Its whole-request refusals are
 * about the caller or the deployment, never about the caller's input: a 400 is
 * a key acting for no organization and a 422 a request this server built, a 404
 * a deployment without the route (the default `config` arm names it), a 5xx the
 * platform failing to sign. A 401/403 never reaches these options — the SDK
 * raises it as `ArtifactAuthenticationError`, which {@link classifyError} maps
 * to the auth arm. Per-reference refusals are values on the verdict's items,
 * classified by {@link itemToolError}.
 */
export const BULK_RESOLVE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/resolve-storage-url/bulk",
  badRequest: {
    class: "config",
    hint: "The API refused to resolve this run's stored files as a whole. If the message names an organization, the API key acts for none: use a key minted in the run's organization.",
  },
  serverError: {
    hint: "The platform could not sign download links for this run's stored files; retrying this tool resolves them again.",
  },
};

const RESOLVE_AGAIN_HINT =
  "The download link is minted fresh on every call, so retrying this tool resolves a new one.";

interface ItemErrorTexture {
  class: ErrorClass;
  hint: string;
  retryable: boolean;
  /** Replaces the SDK's `detail` where that sentence speaks to an SDK caller, not to the agent. */
  message?: string;
}

/**
 * How each per-reference code the SDK carries reads as a `ToolError`. The codes
 * are the SDK's closed vocabulary, shared by the download verdict's
 * `ArtifactItemError.code` and by the thrown `ArtifactFetchError.code`: the
 * resolve route's per-reference refusals, the fetch boundary's, and the
 * download's own. A vanished or oversized object is a permanent `input_domain`
 * refusal; a store or network fault is a retryable `runtime` one, since every
 * call mints fresh links.
 *
 * It lives here rather than in `artifacts.ts` because both fetching
 * capabilities need it, and the image-display capability — which both shells
 * register, as `mthds_show_images` and `pipelex_show_images` — must not import
 * the workshop-only download tool to get it.
 */
const ITEM_ERROR_TEXTURES: Record<string, ItemErrorTexture> = {
  invalid_storage_uri: {
    class: "input_domain",
    hint: "The API rejected this storage reference as found in the run output.",
    retryable: false,
  },
  forbidden: {
    class: "input_domain",
    hint: "The reference belongs to another organization than the API key's. Use a key minted in the run's organization.",
    retryable: false,
  },
  unsupported_url: {
    class: "runtime",
    hint: "The configured deployment's storage resolved to a link this server does not fetch — not http(s), or carrying credentials. A deployment backed by local-filesystem storage hands out file:// links, which cannot be fetched here.",
    retryable: false,
  },
  plain_http_refused: {
    class: "config",
    message:
      "The platform resolved this reference to a plain http link, which this server refuses.",
    hint: `A plain http link is accepted only when PIPELEX_BASE_URL is itself http (the local stack). Set ${ALLOW_HTTP_ENV}=true to accept one from this deployment anyway.`,
    retryable: false,
  },
  redirect_refused: {
    class: "runtime",
    hint: "A presigned object link should answer directly. Inspect the configured deployment's storage.",
    retryable: false,
  },
  store_refused: { class: "runtime", hint: RESOLVE_AGAIN_HINT, retryable: true },
  not_found: {
    class: "input_domain",
    hint: "The object behind this storage reference is gone; re-run the method to produce it again.",
    retryable: false,
  },
  store_error: { class: "runtime", hint: RESOLVE_AGAIN_HINT, retryable: true },
  too_large: {
    class: "input_domain",
    hint: "The limit is an accident guard against filling the disk. Fetch the file another way — its presigned public_url in mthds_run_results works for about an hour.",
    retryable: false,
  },
  timeout: { class: "runtime", hint: RESOLVE_AGAIN_HINT, retryable: true },
  network: { class: "runtime", hint: RESOLVE_AGAIN_HINT, retryable: true },
  resolve_failed: { class: "runtime", hint: RESOLVE_AGAIN_HINT, retryable: true },
  total_limit_exceeded: {
    class: "input_domain",
    hint: "The call's total byte limit is an accident guard against filling the disk. The files listed as saved are on disk; fetch this one through its presigned public_url in mthds_run_results, which works for about an hour.",
    retryable: false,
  },
  write_failed: {
    class: "runtime",
    hint: "Check that the target directory under the server's working directory is writable.",
    retryable: false,
  },
  aborted: {
    class: "runtime",
    hint: "The download stopped before this file was saved; call the tool again.",
    retryable: true,
  },
};

/**
 * The wire's `detail`, when it really is one. It is typed by the SDK and, like
 * the code beside it, relayed verbatim from the bulk resolve route without
 * validation — and `message` is required on the tools' own error schemas, so a
 * missing one would fail the result and turn a single file's failure into a
 * failed call, which is the failure the code's own lookup was hardened against.
 */
function wireDetail(detail: string): string | undefined {
  const value: unknown = detail;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** What a per-reference failure reads as when the route named no detail for it. */
function unnamedItemFailure(code: string): string {
  const named: unknown = code;
  const suffix = typeof named === "string" && named.trim() !== "" ? ` (${named})` : "";
  return `This file could not be read, and the API gave no reason${suffix}.`;
}

/** A code the SDK adds later reads as an unnamed fault, which stays retryable. */
const UNKNOWN_ITEM_ERROR: ItemErrorTexture = {
  class: "runtime",
  hint: "Inspect the MCP server logs.",
  retryable: true,
};

/**
 * Classify one per-reference error, located at the caller's own entry —
 * `artifacts[i].uri` on the download tool, `images[i].uri` on the image tool,
 * which is why the locator is a parameter rather than a constant here. The
 * `{ code, detail }` shape is the SDK's `ArtifactItemError`; a thrown
 * `ArtifactFetchError` is adapted to it by its caller, since the two carry the
 * same closed `code` vocabulary.
 *
 * The code comes verbatim off the bulk resolve route's wire, so the table is
 * read by own key only: a code of `constructor` or `toString` would otherwise
 * find `Object.prototype`'s member instead of falling back, and produce a
 * `ToolError` with no `class` — failing the tool's own schema and turning one
 * file's failure into a failed call.
 */
export function itemToolError(
  error: { code: string; detail: string },
  location: string,
): ToolError {
  const texture = Object.hasOwn(ITEM_ERROR_TEXTURES, error.code)
    ? ITEM_ERROR_TEXTURES[error.code]
    : UNKNOWN_ITEM_ERROR;
  return {
    class: texture.class,
    location,
    message: texture.message ?? wireDetail(error.detail) ?? unnamedItemFailure(error.code),
    hint: texture.hint,
    retryable: texture.retryable,
  };
}

// ── the image-inlining boundary (mthds_show_images) ─────────────────

/**
 * The per-image byte cap. NOT a cost control: the host probe
 * (`wip/mcp-image-results/host-probe.md`) established that a host bills an
 * image block at the model's native vision price, derived from its pixel
 * dimensions, and that its base64 size costs nothing. This is a transport
 * guard and a point of diminishing returns — Claude Code's stdio transport
 * carried an 8 MiB PNG and died on a 12 MiB one with `Connection closed`,
 * and above roughly a megabyte every host measured re-encodes the image to a
 * fraction of what was sent, so bytes past that buy nothing.
 */
/**
 * Directories a misaimed `output_dir` would otherwise drag in wholesale.
 *
 * Shared by the two walks that descend a user's directory — the codegen
 * writer's orphan walk and the catalog pull's unmanaged-source walk — because
 * they ask the same question of the same kind of tree, and a set that lived in
 * one of them was a set the other silently did without.
 */
export const PRUNED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "__pycache__",
]);

export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * The total bytes one `mthds_show_images` call inlines. Chosen so a whole tool
 * result stays well under the JSON-RPC message size that killed the probe's
 * 12 MiB rung while its 8 MiB rung passed.
 */
export const INLINE_IMAGES_BUDGET = 6 * 1024 * 1024;

/**
 * How many candidates one call may *attempt* — so one call makes at most this
 * many network exchanges whatever the run produced, and buys at most this much
 * permanent context (about eight thousand tokens at the worst per-picture price
 * the probe observed, and far less in practice).
 */
export const MAX_INLINE_IMAGES = 6;

/**
 * How many image candidates one tool result may ENUMERATE — the bound on the
 * inventory itself, as distinct from {@link MAX_INLINE_IMAGES}, which bounds
 * how many are fetched.
 *
 * The two tools that publish the inventory were both unbounded: a completed
 * run walks its FULL output for candidates (deliberately — a reference pruned
 * out of the bounded `main_stuff` is still a real picture), so a method
 * emitting a large `Image[]` put an arbitrarily long list of references into
 * model-facing `structuredContent`, outside the `MAIN_STUFF_CAP` discipline
 * the output beside it obeys. `mthds_show_images` compounded it, emitting one
 * entry and one prose line per candidate however few it fetched.
 *
 * Generous against the cap that matters: a caller can only fetch six per call,
 * so this is about being able to SEE what a run produced and page through it
 * by naming references, not about fetching. A run with more than this many
 * pictures reports the remainder as a count.
 */
export const MAX_IMAGE_CANDIDATE_ENTRIES = 32;

/**
 * The response content types that may be emitted as an MCP image block. The
 * object store answers with the type the runtime stored, which is the
 * authority — the resolve route's `content_type` is only a guess from the
 * reference's extension. No SVG: it is not a model-accepted image type, and it
 * is a script-bearing document in a renderer.
 */
export const INLINE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type InlineImageMimeType = (typeof INLINE_IMAGE_MIME_TYPES)[number];

/**
 * The storage-key extensions that make a reference an image *candidate* — a
 * free prefilter over the key alone, never a verdict. Keep it in step with the
 * SDK's `artifactFilename` extension table, which is what decides the key a
 * produced file is stored under. A key with no extension at all is a candidate
 * too: the runtime does store such keys, and only the fetched response's
 * content type can settle them.
 */
export const INLINE_IMAGE_KEY_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

/** One stored reference that might be an image, as the prefilter found it. */
export interface ImageCandidate {
  /** The `pipelex-storage://` reference, exactly as it appears in the run output. */
  uri: string;
  /** The reference's storage key — everything after the scheme. */
  key: string;
}

/** The storage key of a reference: everything after `pipelex-storage://`. */
export function storageKeyOf(uri: string): string {
  return uri.startsWith(PIPELEX_STORAGE_SCHEME) ? uri.slice(PIPELEX_STORAGE_SCHEME.length) : uri;
}

/**
 * Whether a storage key looks like an image: a known image extension, or no
 * extension at all on the key's last segment. Case-insensitive, and anything
 * after a `?` or `#` is ignored — a key is not a URL, but a stored one has been
 * seen to carry a query-looking tail.
 */
export function looksLikeImageKey(key: string): boolean {
  const name = key.split(/[?#]/, 1)[0].split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true; // no extension (a leading dot is not one either)
  const extension = name.slice(dot).toLowerCase();
  return (INLINE_IMAGE_KEY_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * Every stored reference in a run's main output that passes the key prefilter,
 * in the SDK's discovery order. Pure — `collectArtifacts` is an in-memory walk,
 * so this costs no network call and is safe on every completed result.
 */
export function imageCandidatesOf(mainStuff: unknown): ImageCandidate[] {
  const seen = new Set<string>();
  return collectArtifacts(mainStuff)
    .filter((uri) => {
      // One reference is one picture, however many times the output names it.
      // An output that carries the same stored file in two places would
      // otherwise be fetched twice, billed twice, and shown twice — and, since
      // `indices` are positions in this list, would give the same picture two
      // positions.
      if (seen.has(uri)) return false;
      seen.add(uri);
      return true;
    })
    .map((uri) => ({ uri, key: storageKeyOf(uri) }))
    .filter((candidate) => looksLikeImageKey(candidate.key));
}
