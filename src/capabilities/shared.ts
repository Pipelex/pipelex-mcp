import {
  ApiResponseError,
  ApiUnreachableError,
  ArtifactAuthenticationError,
  ArtifactOperationError,
  EmptyMethodSourceError,
  InputPreparationError,
  InvalidLocalSourceError,
  MissingMainStuffError,
  PIPELEX_STORAGE_SCHEME,
  PipelexApiClient,
  PipelexRequestError,
  PipelineRequestError,
  RejectedAssetError,
  RunLifecycleUnavailableError,
  ScopeUnavailableError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
  collectArtifacts,
  errorVerdictOf,
} from "@pipelex/sdk";
import type { ErrorDomain, ErrorVerdict, PipelexApiClientOptions } from "@pipelex/sdk";
import { z } from "zod";

import { BARE_APP_INFO } from "./client-identification.js";
import type { AppInfoSource } from "./client-identification.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";

export const DEFAULT_API_URL = "https://api.pipelex.com";

/**
 * The submitted-files shape every capability shares on its MCP input. Each
 * item is one of two arms: inline contents (`{ content, uri? }`) or a file
 * path (`{ path }`, resolved from disk through the context's resolver). The
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
 * The seam the workshop fills with a filesystem-backed resolver
 * (`localFileResolver` in its `src/files.ts`). A context built without one —
 * the core's own `build…Context`, as the live suite uses — turns every
 * `{ path }` item into an instructive rejection.
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
 * `{ path }` item is rejected instructively, the rejection naming the local
 * workshop that resolves paths. `files` is only meaningful when `errors` is
 * empty.
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

/**
 * The largest inputs file `inputs_path` reads: 1 MiB. Inputs ride the JSON
 * body of `POST /v1/start` or `POST /v1/pipe-io`; a set past this size is an
 * asset in disguise and belongs in a file input, uploaded by
 * `mthds_prepare_inputs`, rather than in the run's inputs.
 */
export const MAX_INPUTS_FILE_BYTES = 1024 * 1024;

/**
 * `inputs_path`, the file arm of a run's inputs: the same schema on
 * `mthds_run` and `mthds_prepare_inputs`. A separate argument rather than a
 * `{ path }` shape inside `inputs`, because an inputs map may legitimately
 * declare an input named `path`.
 */
export const inputsPathSchema = z
  .string()
  .optional()
  .describe(
    "Path to a .json file holding the inputs as one JSON object, resolved relative to this server's working directory and read only inside it. Use it instead of inputs for a large or machine-produced inputs set, so it never passes through the conversation. Mutually exclusive with inputs. The loaded object is used exactly as inline inputs would be.",
  );

/** The two ways a caller supplies a run's inputs, before the file arm is read. */
export interface InputsSource {
  inputs?: Record<string, unknown>;
  inputs_path?: string;
}

export interface ResolvedInputs {
  /** The inputs to send: the inline object, the loaded file, or absent when neither was supplied. */
  inputs?: Record<string, unknown>;
  errors: ToolError[];
}

/**
 * Settle `inputs` / `inputs_path` into the one inputs object the capability
 * sends, ahead of the request-shape checks, as {@link resolveSubmittedFiles}
 * does for `files`. Both supplied is refused at `inputs_path`; `required`
 * refuses neither at `inputs`. The file arm reads through the context's
 * `.json` resolver — the workshop's `localFileResolver`, under the same
 * extension and working-directory gates as a `{ path }` item — and a context
 * without one, as the core's own `build…Context` builds, refuses it, as it
 * refuses a `{ path }` item. The file must hold one JSON object.
 */
export async function resolveInputsSource(
  source: InputsSource,
  resolver: FileResolver | undefined,
  options: { required: boolean },
): Promise<ResolvedInputs> {
  const refuse = (location: string, message: string, hint: string): ResolvedInputs => ({
    errors: [{ class: "input_domain", location, message, hint, retryable: false }],
  });

  if (source.inputs_path === undefined) {
    if (source.inputs === undefined && options.required) {
      return refuse(
        "inputs",
        "Supply the filled inputs, as inputs or as inputs_path.",
        "Pass the filled template as inputs, or the path of a .json file holding it as inputs_path. An empty object {} is accepted.",
      );
    }
    return { ...(source.inputs === undefined ? {} : { inputs: source.inputs }), errors: [] };
  }

  if (source.inputs !== undefined) {
    return refuse(
      "inputs_path",
      "Supply inputs or inputs_path, not both.",
      "Drop inputs to read the inputs from the file, or drop inputs_path to send the inline object.",
    );
  }

  if (source.inputs_path.trim() === "") {
    return refuse(
      "inputs_path",
      "inputs_path must not be empty when supplied.",
      "Pass the path of a .json file, or pass the inputs inline as inputs.",
    );
  }

  if (resolver === undefined) {
    return refuse(
      "inputs_path",
      "This deployment cannot read files from disk; pass the inputs inline.",
      "Pass the inputs inline as inputs, or use the local workshop server (npx @pipelex/mcp), which reads inputs_path.",
    );
  }

  const resolution = await resolver.resolve(source.inputs_path);
  if (!resolution.ok) {
    return refuse("inputs_path", resolution.message, resolution.hint);
  }

  let parsed: unknown;
  try {
    // Some Windows editors and PowerShell write UTF-8 with a byte-order mark, which JSON.parse refuses.
    parsed = JSON.parse(resolution.content.replace(/^\uFEFF/, ""));
  } catch (err) {
    return refuse(
      "inputs_path",
      `File is not valid JSON: ${source.inputs_path} (${err instanceof Error ? err.message : String(err)}).`,
      "Fix the file so it holds one JSON object, the filled inputs template, or pass the inputs inline as inputs.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const found = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    return refuse(
      "inputs_path",
      `File does not hold a JSON object: ${source.inputs_path} holds ${found}.`,
      "The file must hold one JSON object mapping each input name to its value, as the filled inputs template does.",
    );
  }

  return { inputs: parsed as Record<string, unknown>, errors: [] };
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
   * Whether retrying the same call may succeed. For a failure the SDK raised it
   * is the SDK's own verdict ({@link classifyError}): the `class`+`location`
   * pair alone is too coarse — an unreachable API and a permanently missing run
   * lifecycle both classify as `config` at `PIPELEX_BASE_URL`, yet only the
   * former is worth retrying.
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
 * against a control proving the identical block without them is accepted
 * (L-260920-fc66db).
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
 * `errors[]` (e.g. an unreadable `{ path }` naming the file it could not open)
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
   * the workshop through `patchLocalApiContexts` in its `src/tools.ts`, never
   * by the env: the workshop reads its host from the MCP handshake, so it is a
   * function called when a client is constructed. Absent, a client still names
   * itself `pipelex-mcp` (`BARE_APP_INFO`).
   */
  appInfo?: AppInfoSource;
}

/**
 * What the workshop may override on every capability context that talks to
 * the API. Its tool table applies it to the whole context set, since that
 * table is where the list of contexts lives.
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
 * handshake.
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
 * `domain` when it is authored bare — the fallback pipe the validate
 * capability consults behind the runner's own `default_pipe_ref`.
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
 * them through its own `nonEmptyString`, so without the trim a padded
 * `main_pipe` keyed nothing here and `domain.main` there, and the signature
 * named a different pipe from the one the SDK selects. Nothing upstream
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
export function validateRunIdRequest(runId: string): ToolError[] {
  if (runId.trim() === "") {
    return [
      {
        class: "input_domain",
        location: "run_id",
        message: "run_id must not be empty.",
        hint: `Pass the durable run id returned by ${WORKSHOP_TOOL_NAMES.run}.`,
        retryable: false,
      },
    ];
  }
  return [];
}

/**
 * Route-specific texture for {@link classifyError}. Who can fix a failure and
 * whether a retry can help are the SDK's verdict, which every error it throws
 * carries; what differs per capability is the texture: the locator and hint of
 * a 400/422 rejection, the route named in the 404 hint, and the few refusals a
 * route knows more about than its status says.
 */
export interface ClassifyErrorOptions {
  /** The API route the capability calls, named in the 404 hint. */
  route?: string;
  /** Locator + hint for a 400/422 no-verdict rejection. */
  badRequest?: {
    /**
     * Overrides the SDK's class for the route's 400/422, which it reads as the
     * caller's request (`input`). A route sets it when it knows its refusal is
     * about something no tool argument changes: a request this server built
     * itself, or a key that acts for no organization.
     */
    class?: ErrorClass;
    location?: string;
    hint: string;
  };
  /**
   * Per-route 404 texture, for a route keyed by something the caller named: a
   * run id, a method id, an address. It applies to a 404 the SDK reads as the
   * caller's (`input`), which is one that names what was not found — the
   * runner's `MethodPackageNotFoundError`, the platform's `not_found` code. A
   * bare 404, which is how a runner answers a route it does not serve, keeps
   * the missing-route `config` arm, and so does every 404 on a route without
   * this texture. The run routes see no bare 404 at all: the SDK throws
   * `RunLifecycleUnavailableError` for it up front.
   */
  notFound?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route texture for `409 method_update_conflict`: the method's draft
   * moved since the token the call sent, so nothing was written or published.
   * The locator is the field that carried the token, which differs per route
   * (`expected_updated_at` on the save, `expected_draft_updated_at` on the
   * publish). Unset, the arm locates at `expected_updated_at` with a generic
   * hint.
   */
  conflict?: {
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
   * `/v1/codegen` leaves it unset: it resolves an address through
   * `fetch_method_mthds_files`, which takes only the `.mthds` files and loads
   * no Python, so no execution locus is ever decided there. An arm that fires
   * with this unset reports no location rather than a wrong one. `/v1/pipe-io`
   * fetches the same way, and its callers set it all the same, since a locator
   * costs nothing to keep right.
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
   * classify it `input_domain` at `method_ref` with the address-grammar hint,
   * overriding the SDK's `config`. Routes that never send a `method_ref` leave
   * it unset and keep the SDK's verdict.
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
   * Per-deployment texture for auth failures (HTTP 401/403, and the upload and
   * artifact families' authentication errors). The default wording points at the `PIPELEX_API_KEY` env
   * var — right for the workshop, where the caller owns the process env. A
   * deployment whose callers authenticate some other way overrides it, and
   * capabilities thread it from their context's `authError` field; the
   * workshop never sets it.
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
   * Per-route texture for `POST /v1/pipe-io` refusing a pipe selection — the
   * typed `422`s {@link isPipeSelectionRefusal} recognizes: a `pipe_ref` that
   * names no pipe, a method with no entry pipe, or several. Each is a question
   * about the pipe whatever named the method, so it takes its own locator
   * rather than {@link badRequest}'s, which follows the selector. Set by a
   * capability that forwards the caller's pipe selection to the route and
   * lets the route refuse it (`mthds_inputs_template`); the SDK's input walk
   * turns the same refusals into an `InputPreparationError` before they get
   * here. Unset, the refusal keeps the generic 400/422 arm.
   */
  selection?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route texture for a refused or unreadable asset on the upload leg.
   * `location` covers both arms (`RejectedAssetError` /
   * `InvalidLocalSourceError`) and defaults to `inputs` — right for
   * `mthds_prepare_inputs`, whose assets are values inside the filled inputs.
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
 * The `error_type`s of the `422`s `POST /v1/pipe-io` refuses a pipe selection
 * with, in the input domain: a `pipe_ref` that names no pipe, or no entry pipe
 * (`EntryPipeNotFoundError`), and a code matching several pipes, or several
 * entry pipes (`EntryPipeAmbiguousError`). Each is a question about the pipe,
 * where every other `422` of the route is about the request or the method.
 * `@pipelex/sdk`'s own input walk branches on the same pair.
 */
const PIPE_SELECTION_ERROR_TYPES: ReadonlySet<string> = new Set([
  "EntryPipeNotFoundError",
  "EntryPipeAmbiguousError",
]);

/** Whether `err` is the pipe I/O route refusing a pipe selection (see {@link PIPE_SELECTION_ERROR_TYPES}). */
function isPipeSelectionRefusal(err: unknown): err is ApiResponseError {
  return (
    err instanceof ApiResponseError &&
    err.status === 422 &&
    err.errorType !== undefined &&
    PIPE_SELECTION_ERROR_TYPES.has(err.errorType)
  );
}

/**
 * This server's class for each error domain the SDK decides. The two say the
 * same thing — who can fix the failure — and differ only in the name of the
 * caller's own class, which this server's contract fixed first.
 */
const CLASS_OF_DOMAIN: Readonly<Record<ErrorDomain, ErrorClass>> = {
  input: "input_domain",
  config: "config",
  runtime: "runtime",
};

/** The half of a {@link ToolError} that says who can fix it and whether a retry can help. */
type ToolVerdict = Pick<ToolError, "class" | "retryable">;

/** The half a capability words: where, what, and what to do. */
interface ToolTexture {
  kind?: ErrorKind;
  location?: string;
  message: string;
  hint?: string;
}

/** An SDK verdict in this server's terms. */
function toolVerdictOf(verdict: ErrorVerdict): ToolVerdict {
  return { class: CLASS_OF_DOMAIN[verdict.errorDomain], retryable: verdict.retryable };
}

/** A verdict and a texture, as one {@link ToolError}, keeping the shape's field order. */
function toolError(verdict: ToolVerdict, texture: ToolTexture): ToolError {
  return {
    class: verdict.class,
    ...(texture.kind === undefined ? {} : { kind: texture.kind }),
    ...(texture.location === undefined ? {} : { location: texture.location }),
    message: texture.message,
    ...(texture.hint === undefined ? {} : { hint: texture.hint }),
    retryable: verdict.retryable,
  };
}

/**
 * Classify a failure as a {@link ToolError}.
 *
 * **The verdict is the SDK's.** Every error `@pipelex/sdk` throws carries
 * `errorDomain`, who can fix it, and `retryable`, whether asking again can
 * succeed, decided from the server's own members when it sent them and from
 * the SDK's reading of the status otherwise. This function maps the domain
 * onto this server's class and takes `retryable` as it comes. What it adds is
 * this server's own: the wording, the locator a tool's caller can act on, the
 * hint and the `kind`. A few arms override the SDK's class on purpose — a
 * rejected credential, the execution-locus gate's refusals, a route's 400 that
 * no argument fixes, the reserved registry form of `method_ref`, a 404 on a
 * route that names no resource — and each says why where it does. Callers
 * override `retryable` the same way for a write that may already have
 * happened: `classifyStartError` (`run.ts`) for a run's start and
 * `notRetryableCreate` (`catalog-write.ts`) for a method's create.
 *
 * A failure that is not the SDK's keeps this server's reading: a bare
 * `PipelineRequestError` from `mthds` is `config`, and a fault nothing names is
 * retryable `runtime`, since wrongly stopping a live follow is worse than one
 * more read.
 */
export function classifyError(err: unknown, options: ClassifyErrorOptions = {}): ToolError {
  if (err instanceof ApiResponseError) return classifyApiResponseError(err, options);
  if (err instanceof UploadTransportError) return classifyUploadTransportError(err, options);
  if (err instanceof PipelexRequestError) {
    return toolError(toolVerdictOf(err), sdkErrorTexture(err, options));
  }

  // An error carrying a verdict without being this copy's class: a consumer's
  // own subclass, or `mthds`'s `ApiResponseError` when the runner sent both members.
  const carried = errorVerdictOf(err);
  if (carried !== undefined && err instanceof Error) {
    const verdict = toolVerdictOf(carried);
    return toolError(verdict, genericTexture(verdict, err.message));
  }

  if (err instanceof PipelineRequestError) {
    const verdict: ToolVerdict = { class: "config", retryable: false };
    return toolError(verdict, genericTexture(verdict, err.message));
  }

  return toolError(
    { class: "runtime", retryable: true },
    {
      message: err instanceof Error ? err.message : "Unknown failure.",
      hint: "Inspect the MCP server logs and local pipelex-api logs.",
    },
  );
}

/**
 * The texture of an SDK error other than a refused request or a wrapped upload
 * failure, by its class. Ordered most specific first: each family's subclasses
 * before its base.
 */
function sdkErrorTexture(err: PipelexRequestError, options: ClassifyErrorOptions): ToolTexture {
  const message = err.message;

  if (err instanceof ApiUnreachableError) {
    // The SDK's own request timeout reached an API that took the request and
    // did not answer in time; the SDK reads it as `runtime`, and no base URL
    // fixes it.
    if (err.code === "ABORT_TIMEOUT") {
      return {
        message,
        hint: "The Pipelex API took the request but did not answer in time; try again, and inspect the API if it persists.",
      };
    }
    return {
      location: "PIPELEX_BASE_URL",
      message,
      hint: "Start pipelex-api locally or set PIPELEX_BASE_URL to a reachable host-only API base URL.",
    };
  }

  // The configured base URL serves the protocol routes but not the durable run
  // lifecycle (a bare pipelex-api runner).
  if (err instanceof RunLifecycleUnavailableError) {
    return {
      location: "PIPELEX_BASE_URL",
      message,
      hint: "Durable runs need the hosted Pipelex API; point PIPELEX_BASE_URL at a deployment serving /v1/runs/* (a bare pipelex-api runner does not).",
    };
  }

  // A completed run that delivers no main output: the API answered, but its
  // report is malformed.
  if (err instanceof MissingMainStuffError) {
    return {
      message,
      hint: "The API reported the run completed but delivered no main output; inspect the run on the platform.",
    };
  }

  // ── Input-preparation family (mthds_prepare_inputs) ──

  // Normally caught by its caller (`mthds_get_method` composes its own
  // refusal); mapped defensively so a stray one still locates at method_id,
  // not pipe_ref.
  if (err instanceof EmptyMethodSourceError) {
    return {
      location: "method_id",
      message,
      hint: "The stored method has no MTHDS source yet. Add MTHDS content to it, or submit files instead.",
    };
  }

  // A missing/unreadable local path or an asset the storage service refused
  // (413): the caller's input value is the problem.
  if (err instanceof InvalidLocalSourceError || err instanceof RejectedAssetError) {
    return {
      location: options.asset?.location ?? "inputs",
      message,
      hint:
        err instanceof RejectedAssetError
          ? (options.asset?.hint ??
            "Pipelex storage refused the asset (too large). Shrink the file, or reference it by an http(s) URL instead.")
          : "Check the file path is correct and readable, or reference the asset by an http(s) URL / pipelex-storage:// URI instead.",
    };
  }

  // The configured deployment has no upload route (a bare pipelex-api runner).
  if (err instanceof UnsupportedUploadCapabilityError) {
    return {
      location: "PIPELEX_BASE_URL",
      message,
      hint: "The configured Pipelex deployment has no /v1/upload route. Point PIPELEX_BASE_URL at the hosted Pipelex API, or pass assets as http(s) URLs / pipelex-storage:// references.",
    };
  }

  if (err instanceof UploadAuthenticationError) {
    return {
      location: options.auth?.location ?? "PIPELEX_API_KEY",
      message,
      hint: options.auth?.hint ?? "Check the API key for the configured Pipelex API.",
    };
  }

  // The base class: an unqualified or unknown pipe_ref, no single default pipe,
  // or a caller value at a file position that was malformed/unsupported, all
  // raised CLIENT-SIDE — so they locate at `preparation`, which a route
  // separates from `badRequest` when its 400/422 is about a different field.
  // The one the SDK reads as anything but the caller's, an input walk whose
  // answer it could not read, gets no such locator.
  if (err instanceof InputPreparationError) {
    if (err.errorDomain !== "input") {
      return {
        message,
        hint: "The Pipelex API's answer to the input walk could not be read; inspect the API.",
      };
    }
    const texture = options.preparation ?? options.badRequest ?? DEFAULT_BAD_REQUEST;
    return {
      ...(texture.location === undefined ? {} : { location: texture.location }),
      message,
      hint: texture.hint,
    };
  }

  // ── Artifact family (mthds_download_artifacts) ──
  // The SDK's artifact operations throw only when no verdict can be produced;
  // per-reference failures are values on the verdict.

  // The resolve route refused the credential (401/403) — the auth arm, like
  // UploadAuthenticationError on the upload leg.
  if (err instanceof ArtifactAuthenticationError) {
    return {
      location: options.auth?.location ?? "PIPELEX_API_KEY",
      message,
      hint: options.auth?.hint ?? DEFAULT_AUTH_HINT,
    };
  }

  // The scope walked carries no artifact on a completed run: the API answered,
  // but its report is malformed — the MissingMainStuffError reading.
  if (err instanceof ScopeUnavailableError) {
    return {
      message,
      hint: "The API reported the run completed but its results carry no output to walk for files; inspect the run on the platform.",
    };
  }

  // The base class: a malformed bulk-resolve answer or a directory the download
  // could not use after containment approved it. Neither is the caller's input.
  if (err instanceof ArtifactOperationError) {
    return {
      message,
      hint: "The download could not proceed; inspect the MCP server logs and the API.",
    };
  }

  // The rest — an argument the SDK refused before sending anything, paging
  // that never ends, a run still going or failed — read by their verdict.
  return genericTexture(toolVerdictOf(err), message);
}

/** The texture of an error this server has no wording of its own for, by its class. */
function genericTexture(verdict: ToolVerdict, message: string): ToolTexture {
  switch (verdict.class) {
    case "config":
      return {
        location: "PIPELEX_BASE_URL",
        message,
        hint: "Check PIPELEX_BASE_URL and the submitted request.",
      };
    case "input_domain":
      return {
        message,
        hint: "The request was refused before it was sent; check the submitted arguments.",
      };
    case "runtime":
      return { message, hint: "Inspect the MCP server logs and the Pipelex API." };
  }
}

/**
 * An `UploadTransportError`: the SDK's `uploadFile` wraps what the client's
 * `upload()` throws when it is neither a credential nor a size refusal, and the
 * wrapper takes its cause's verdict. Where the cause is a fault this server
 * words, the cause is classified instead, so the texture says what happened:
 * the upload ceiling's local refusal (`upload-ceiling.ts`, thrown from inside
 * `upload()`), a plan limit, an unreachable API.
 */
function classifyUploadTransportError(
  err: UploadTransportError,
  options: ClassifyErrorOptions,
): ToolError {
  const cause = err.cause;
  if (
    cause instanceof RejectedAssetError ||
    cause instanceof ApiUnreachableError ||
    (cause instanceof ApiResponseError && cause.status === 402)
  ) {
    return classifyError(cause, options);
  }
  const verdict = toolVerdictOf(err);
  if (verdict.retryable) {
    return toolError(verdict, {
      message: err.message,
      hint: "The upload could not reach Pipelex storage; retry, and inspect the API if it persists.",
    });
  }
  return toolError(verdict, {
    ...(verdict.class === "input_domain" ? { location: options.asset?.location ?? "inputs" } : {}),
    message: err.message,
    hint: "Pipelex storage refused the upload, and the same file meets the same answer; the message says why.",
  });
}

function classifyApiResponseError(err: ApiResponseError, options: ClassifyErrorOptions): ToolError {
  const message = err.serverMessage ?? err.message;
  const verdict = toolVerdictOf(err);
  const badRequest = options.badRequest ?? DEFAULT_BAD_REQUEST;
  const route = options.route ?? "the Pipelex API";

  // Ahead of the generic 400/422 arm, whose locator follows the selector: a
  // refused pipe selection is about the pipe, and the route's `detail` names
  // the candidates where there are some.
  if (options.selection !== undefined && isPipeSelectionRefusal(err)) {
    return toolError(verdict, {
      location: options.selection.location,
      message,
      hint: options.selection.hint,
    });
  }

  if (err.status === 400 || err.status === 422) {
    // A route whose 400/422 no tool argument fixes declares its class, which
    // overrides the SDK's reading of a refused request as the caller's own.
    return toolError(
      { ...verdict, class: badRequest.class ?? verdict.class },
      { location: badRequest.location, message, hint: badRequest.hint },
    );
  }

  // The execution-locus gate's two refusals, each a 403 whose `error_type`
  // names the policy: a fetched package declaring in-process Python structure
  // classes, and a method shipping custom Python (`.py`) on a deployment that
  // is not sandbox-hosted. Both are about the method, not the credential, so
  // both override the SDK's class to `input_domain`: the runner sends the
  // second with `error_domain: input` but the first with no domain at all
  // (L-261007-31dea6), and the SDK's own reading of a bare 403 is
  // `config`. They must be caught ahead of the generic 401/403 arm, whose
  // texture sends a caller whose credential is perfectly good to go and mint a
  // new key. The second is a property of the PAIR — the method and the
  // deployment — and the method is not malformed: the very same method runs on
  // a sandbox-hosted deployment, which is where PipeFunc Python belongs.
  if (err.status === 403 && err.errorType === "MethodStructuresRefusedError") {
    return toolError(
      { ...verdict, class: "input_domain" },
      {
        location: "method_ref",
        message,
        hint: "Hosted execution accepts MTHDS concepts and sandboxed PipeFuncs, not in-process Python — the referenced package declares Python structure classes. Express its types as MTHDS concepts, or run it on a self-hosted OSS runner.",
      },
    );
  }

  if (err.status === 403 && err.errorType === "CustomCodeRequiresSandbox") {
    return toolError(
      { ...verdict, class: "input_domain" },
      {
        location: options.methodLocation,
        message,
        hint: "This deployment is not sandbox-hosted, so it refuses a method that ships custom Python (.py) — the credential is not the problem. Run the method on a sandbox-hosted deployment, or name one whose pipes are all MTHDS.",
      },
    );
  }

  if (err.status === 401 || err.status === 403) {
    // Overrides the SDK's class: a rejected credential is `config` here,
    // whatever the server tagged it. The runner tags its own 401 and 403
    // `input` (L-261007-8dffe5), the request carrying the credential, while
    // this server's credential is its environment, which no tool argument
    // changes, and the SDK's own reading of both statuses is `config`.
    return toolError(
      { ...verdict, class: "config" },
      {
        location: options.auth?.location ?? "PIPELEX_API_KEY",
        message,
        hint:
          err.status === 403 && options.forbidden !== undefined
            ? options.forbidden.hint
            : (options.auth?.hint ?? DEFAULT_AUTH_HINT),
      },
    );
  }

  // A saved method's versions and draft, refused for a reason the platform
  // names in its `code`. Each is about the method the caller named, and each
  // would otherwise fall through to the generic arm as "HTTP 409", which says
  // nothing a caller can act on. The class is pinned to `input_domain`, which
  // is also the SDK's fallback for every one of them: the caller changes the
  // selector, the token or the timing, never the environment.
  if (err.status === 409) {
    const arm = methodConflictTexture(err.code, options);
    if (arm !== undefined) {
      return toolError({ ...verdict, class: "input_domain" }, { ...arm, message });
    }
  }

  // Paywall: the platform reports a plan limit as 402 SubscriptionRequiredError.
  // Branch on the HTTP status only — its problem `code` is "forbidden" and must
  // never be sniffed. The class stays the SDK's `config` (the call cannot be
  // made as credentialed), and `kind` is what carries the cause into each
  // capability's headline — see {@link summaryForToolError}.
  if (err.status === 402) {
    return toolError(verdict, {
      kind: "paywall",
      message,
      hint: "The organization's plan does not cover this call. Review the plan and billing for the API key's organization on app.pipelex.com.",
    });
  }

  if (err.status === 404) {
    // `mt_…@<n>`, or a version read, naming a version the method never
    // published. Ahead of the route's `notFound`, whose hint says the METHOD is
    // unknown, which is the one thing this answer rules out.
    if (err.code === "method_version_not_found") {
      return toolError(
        { ...verdict, class: "input_domain" },
        {
          location: "method_id",
          message,
          hint: `The method exists but has no published version with this number. ${WORKSHOP_TOOL_NAMES.getMethod} with its bare id reports its latest published version; address the draft as mt_…@draft.`,
        },
      );
    }
    if (options.notFound !== undefined && verdict.class === "input_domain") {
      return toolError(verdict, {
        location: options.notFound.location,
        message,
        hint: options.notFound.hint,
      });
    }
    // Overrides the SDK's class where it differs: a bare 404, and any 404 on
    // a route that names no resource, is the deployment not serving the route.
    // The platform renders a path it does not serve with the code `not_found`,
    // which the SDK reads as a named miss, so a route without a `notFound`
    // texture would otherwise tell the caller to fix a request it cannot.
    return toolError(
      { ...verdict, class: "config" },
      {
        location: "PIPELEX_BASE_URL",
        message,
        hint: `Check that PIPELEX_BASE_URL points to a host serving ${route}.`,
      },
    );
  }

  // The reserved registry form of `method_ref`, classified only on routes that
  // declared the texture (selector-shaped requests). The runner tags it
  // `config`, a capability it does not serve; it is overridden to the caller's
  // class because the caller's own argument chose that form, and an address
  // works. Elsewhere a 501 keeps the SDK's verdict and the server-error arm.
  if (err.status === 501 && options.notImplemented) {
    return toolError(
      { ...verdict, class: "input_domain" },
      {
        location: options.notImplemented.location,
        message,
        hint: options.notImplemented.hint,
      },
    );
  }

  if (err.status === 413 && options.tooLarge) {
    return toolError(verdict, {
      location: options.tooLarge.location,
      message,
      hint: options.tooLarge.hint,
    });
  }

  // A throttle or a request that timed out on its way in: refused for its
  // timing, not its content, so the same call may pass a moment later.
  if (err.status === 429 || err.status === 408) {
    return toolError(verdict, {
      message,
      hint:
        err.status === 429
          ? "The Pipelex API is limiting requests; try again in a moment."
          : "The request timed out before the Pipelex API received it; try again.",
    });
  }

  if (err.status === 501) {
    return toolError(verdict, {
      location: "PIPELEX_BASE_URL",
      message,
      hint: `The deployment PIPELEX_BASE_URL points at does not implement ${route}.`,
    });
  }

  if (err.status >= 500) {
    return toolError(verdict, {
      message,
      hint:
        options.serverError?.hint ??
        "The Pipelex API returned a server error; inspect pipelex-api logs.",
    });
  }

  return toolError(verdict, { message, hint: `The Pipelex API returned HTTP ${err.status}.` });
}

/**
 * The texture of a `409` about a saved method, by the platform's `code`, or
 * `undefined` for a `409` this server has no wording of its own for.
 *
 * - `method_not_published`: a bare id names the latest published version, and
 *   the method has none yet. The way forward is its draft, `mt_…@draft`, or a
 *   publish, which only the user asks for.
 * - `method_update_conflict`: the draft moved since the token the call sent,
 *   so nothing was written or published. The route says which field carried
 *   the token ({@link ClassifyErrorOptions.conflict}).
 * - `method_being_deleted`: the method's erasure has started.
 */
function methodConflictTexture(
  code: string | undefined,
  options: ClassifyErrorOptions,
): Omit<ToolTexture, "message"> | undefined {
  switch (code) {
    case "method_not_published":
      return {
        location: "method_id",
        hint: `The method has a draft and no published version yet, and a bare id names the latest published version. Address its draft as mt_…@draft, or publish it with ${WORKSHOP_TOOL_NAMES.publishMethod} — only when the user asks for a publish.`,
      };
    case "method_update_conflict":
      return {
        location: options.conflict?.location ?? "expected_updated_at",
        hint:
          options.conflict?.hint ??
          `The method's draft changed since the token this call sent — somebody saved it, and the webapp saves as it edits. Read it with ${WORKSHOP_TOOL_NAMES.getMethod}, then decide with the user what to keep.`,
      };
    case "method_being_deleted":
      return {
        location: "method_id",
        hint: "The method is being deleted, so nothing was read or written. Its id stops resolving once the erasure finishes.",
      };
    default:
      return undefined;
  }
}

// ── the artifact fetch boundary, shared by the two tools that cross it ──

/**
 * The explicit override of the plain-http rule, read by every capability that
 * fetches a stored artifact — `mthds_download_artifacts` and
 * `mthds_show_images`. Unset, a plain `http:` link is accepted
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
 * capabilities need it, and neither imports the other.
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
 * A thrown `ArtifactFetchError` carries the SDK's own verdict, and this table
 * deliberately does not take it: the SDK's says whether fetching the same link
 * again can succeed, while a retry here is a new call of the tool, which mints
 * a fresh link. That is why a store's refusal, final for the link, reads as
 * retryable here.
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
 * (L-260920-fc66db) established that a host bills an
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
