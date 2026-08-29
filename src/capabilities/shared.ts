import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  EmptyMethodSourceError,
  InputPreparationError,
  InvalidLocalSourceError,
  MissingMainStuffError,
  PipelineRequestError,
  RejectedAssetError,
  RunLifecycleUnavailableError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "@pipelex/sdk";
import type { MthdsFileItem } from "@pipelex/sdk";
import { z } from "zod";

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
            "Filesystem path to a .mthds file, resolved by the local workshop server relative to its working directory. The hosted deployment cannot read files and rejects this form.",
          ),
      }),
    ]),
  )
  .describe(
    "One or more submitted MTHDS files forming the method closure. Each item is either inline contents ({ content, uri? }) or a file path ({ path }, local workshop only).",
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
        hint: "Submit the path of a .mthds file, or inline the contents as { content, uri? }.",
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
 * A tool that does not expose `method_ref` (`mthds_prepare_inputs`) simply
 * never passes one; the "no selector" teaching text adapts to which selectors
 * the caller's schema actually carries via `acceptsMethodRef`.
 */
export function validateMethodSelectorRequest(
  files: SubmittedFile[],
  selectors: MethodSelectors,
  options: { rule: SelectorRule; acceptsMethodRef?: boolean },
): ToolError[] {
  const errors: ToolError[] = [];
  const acceptsMethodRef = options.acceptsMethodRef !== false;

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
      message: acceptsMethodRef
        ? "Provide MTHDS files, a method_ref address, or a method_id."
        : "Provide MTHDS files or a method_id.",
      hint: acceptsMethodRef
        ? `Submit files as [{ content, uri? }], a published method's address (${METHOD_REF_GRAMMAR}) as method_ref, or the catalog id (mt_…) of a registered method as method_id.`
        : "Submit files as [{ content, uri? }], or pass the catalog id (mt_…) of a registered method as method_id.",
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

/** The scheme of a Pipelex storage reference, as the runtime and the SDK spell it. */
export const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";

/**
 * Every `pipelex-storage://` reference inside a JSON-shaped value, in discovery
 * order and deduplicated. This is how a run's produced files are found: the
 * runtime serializes an image or document output as content carrying its
 * storage reference in `url` (beside an expiring presigned `public_url`), and
 * the scheme is unambiguous, so a walk for scheme-prefixed strings is a
 * contract, not a heuristic. Shared by `mthds_run_results` (to say the files
 * exist) and `mthds_download_artifacts` (to save them).
 */
export function collectStorageUris(value: unknown): string[] {
  const found = new Set<string>();
  walkStorageUris(value, found);
  return [...found];
}

function walkStorageUris(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith(PIPELEX_STORAGE_SCHEME) && value.length > PIPELEX_STORAGE_SCHEME.length) {
      found.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkStorageUris(item, found);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      walkStorageUris(entry, found);
    }
  }
}

/** Request-shape check on a run id (format stays server-owned). */
export function validateRunIdRequest(runId: string): ToolError[] {
  if (runId.trim() === "") {
    return [
      {
        class: "input_domain",
        location: "run_id",
        message: "run_id must not be empty.",
        hint: "Pass the durable run id returned by mthds_run.",
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

  // The base class: the method signature did not resolve (invalid closure), or
  // a caller value at a file position was malformed/unsupported. All are
  // request-domain problems; locate at the route's bad-request field (pipe_ref
  // for the prepare route).
  if (err instanceof InputPreparationError) {
    const inputBadRequest = options.badRequest ?? DEFAULT_BAD_REQUEST;
    return {
      class: "input_domain",
      ...(inputBadRequest.location === undefined ? {} : { location: inputBadRequest.location }),
      message: err.message,
      hint: inputBadRequest.hint,
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
 * `getMethod` + parse under the hood), shared by the two capabilities whose
 * surfaces the platform's tooling `method_id` selector deliberately excludes
 * (`mthds_inputs_template` over `/v1/build/inputs`, `mthds_prepare_inputs`
 * over the SDK's client-side `prepareInputs` walk) — `mthds_validate` no
 * longer uses it, its `method_id` being a server pass-through. Unlike
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
 * is the SDK's own documented pattern) behind the id-only paths of the two
 * tools whose surfaces the hosted `method_id` selector deliberately excludes:
 * `mthds_inputs_template` (the build routes take no `method_id`) and
 * `mthds_prepare_inputs` (a client-side signature walk with no server leg).
 * `mthds_validate` forwards its selectors server-side and does not use this.
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
