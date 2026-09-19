import path from "node:path";

import { ArtifactAuthenticationError, PipelexApiClient, collectArtifacts } from "@pipelex/sdk";
import type {
  ArtifactItemError,
  ArtifactScope,
  DownloadArtifactsRequest,
  DownloadArtifactsResult,
  DownloadedArtifact,
  RunResultState,
  RunStatus,
} from "@pipelex/sdk";
import { z } from "zod";

import { RUN_RESULTS_ERROR_OPTIONS, runStatusSchema } from "./run.js";
import {
  buildApiConfig,
  classifyError,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateRunIdRequest,
} from "./shared.js";
import type {
  AuthErrorTexture,
  ClassifyErrorOptions,
  ErrorClass,
  ErrorSummaries,
  ToolError,
} from "./shared.js";
import { resolveSaveDir } from "./workspace-boundary.js";

/**
 * `mthds_download_artifacts` — the workshop's download counterpart to its
 * upload path. `mthds_prepare_inputs` pushes local files INTO Pipelex storage;
 * this brings a run's produced files back OUT, onto the user's disk, under the
 * server's working directory — which is where the user is.
 *
 * It is keyed on the run id, the durable handle the whole run family already
 * uses, rather than on a list of storage URIs. The walk, the fresh links, the
 * filenames, the never-overwrite rule and the download bounds are the SDK's
 * artifact stack (`collectArtifacts` / `downloadArtifacts`, which resolves
 * through `resolveArtifacts`), so this capability owns only what is the
 * workshop's: the tool envelope, the `dir` containment against the working
 * directory, the deployment gate, the plain-http policy, the classification
 * of every failure into `ToolError`s, and the prose summary. See SPEC.md →
 * Artifact Download Scope for why this is a companion tool and not an option
 * on `mthds_run_results`.
 */

/**
 * The scope this tool walks: always the run's main output. The tool takes no
 * `scope` input; the value is named here, rather than left to the SDK's
 * default, so the empty-walk check and the download agree on what was walked.
 */
export const DOWNLOAD_SCOPE: ArtifactScope = "main_stuff";

/**
 * The explicit override of the plain-http rule. Unset, a plain `http:`
 * download link is accepted exactly when `PIPELEX_BASE_URL` is itself `http:`
 * (the local compose stack, whose object store mints plain-http links);
 * `true` / `1` accepts one from any deployment, `false` / `0` refuses one from
 * every deployment. Any other value refuses, so a typo fails closed.
 */
export const ALLOW_HTTP_ENV = "PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP";

export const mthdsDownloadArtifactsInputSchema = {
  run_id: z
    .string()
    .describe("The durable run id returned by mthds_run — the run whose produced files to save."),
  dir: z
    .string()
    .optional()
    .describe(
      "Directory to save into, relative to the server's working directory (created if missing; it must stay inside that directory — no absolute paths, no `..`). Omit to save into the working directory itself.",
    ),
};

const savedArtifactSchema = z.object({
  uri: z.string().describe("The pipelex-storage:// reference found in the run's main output."),
  path: z
    .string()
    .optional()
    .describe("Where the file was saved, relative to the server's working directory — on success."),
  content_type: z
    .string()
    .nullable()
    .optional()
    .describe("The platform's content type for the stored object; null when it has none."),
  size: z.number().optional().describe("Bytes written."),
  error: toolErrorSchema.optional().describe("Present when this file could not be saved."),
});

const artifactsStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  run_id: z.string().optional(),
  state: z
    .enum(["running", "completed", "failed"])
    .optional()
    .describe(
      'The run lookup outcome, as mthds_run_results reports it: "running" (nothing to save yet), "completed" (files saved below), "failed" (a failed run produces no files).',
    ),
  retry_after_seconds: z
    .number()
    .nullable()
    .optional()
    .describe('State "running" only — check again after this many seconds.'),
  run_status: runStatusSchema
    .optional()
    .describe('State "failed" only — the terminal lifecycle status.'),
  failure_message: z.string().optional().describe('State "failed" only.'),
  scope: z
    .enum(["main_stuff", "working_memory"])
    .optional()
    .describe(
      'State "completed" only — which of the run\'s outputs was walked for stored-file references. Always "main_stuff", the run\'s main output: artifacts.length is the count of references found there.',
    ),
  artifacts: z
    .array(savedArtifactSchema)
    .optional()
    .describe(
      'State "completed" only — one entry per stored file the main output references, in discovery order.',
    ),
  saved_paths: z
    .array(z.string())
    .optional()
    .describe(
      'State "completed" only — the paths that were saved, relative to the server\'s working directory.',
    ),
  all_saved: z
    .boolean()
    .optional()
    .describe(
      'State "completed" only — true when every referenced file was saved (vacuously true when the output references none).',
    ),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsDownloadArtifactsOutputSchema = artifactsStructuredContentSchema;

export interface MthdsDownloadArtifactsInput {
  run_id: string;
  dir?: string;
}

export interface SavedArtifactEntry {
  uri: string;
  path?: string;
  content_type?: string | null;
  size?: number;
  error?: ToolError;
}

export interface ArtifactsStructuredContent {
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";
  retry_after_seconds?: number | null;
  run_status?: RunStatus;
  failure_message?: string;
  scope?: ArtifactScope;
  artifacts?: SavedArtifactEntry[];
  saved_paths?: string[];
  all_saved?: boolean;
  errors?: ToolError[];
}

export interface ArtifactsResult {
  structuredContent: ArtifactsStructuredContent;
  summary: string;
}

/** The slice of `PipelexApiClient` this capability calls (test seam). */
export interface ArtifactClient {
  getRunResult(runId: string): Promise<RunResultState>;
  downloadArtifacts(request: DownloadArtifactsRequest): Promise<DownloadArtifactsResult>;
}

export interface ArtifactsContext {
  baseUrl: string;
  apiKey?: string;
  client?: ArtifactClient;
  /**
   * The directory downloads land under — the workshop's working directory,
   * absolute. Absent on a deployment that cannot write files; the tool then
   * refuses (fail-closed) rather than picking a directory of its own. Only the
   * workshop registers the tool, so that branch is a guard, not a served
   * posture.
   */
  saveRoot?: string;
  /**
   * The explicit plain-http override, read from {@link ALLOW_HTTP_ENV}. Absent,
   * {@link allowsPlainHttp} derives the answer from `baseUrl`'s scheme.
   */
  allowHttp?: boolean;
  /** Deployment-specific auth-failure texture; default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

interface ArtifactsEnv {
  PIPELEX_BASE_URL?: string;
  PIPELEX_API_KEY?: string;
  [ALLOW_HTTP_ENV]?: string;
}

export function buildArtifactsContext(env: ArtifactsEnv = process.env): ArtifactsContext {
  const allowHttp = parseAllowHttpOverride(env[ALLOW_HTTP_ENV]);
  return { ...buildApiConfig(env), ...(allowHttp === undefined ? {} : { allowHttp }) };
}

/**
 * Read {@link ALLOW_HTTP_ENV}: `undefined` when unset or blank (derive from
 * the base URL), otherwise the override. An unrecognized value refuses rather
 * than falling back to the derivation, so a misspelled override can only ever
 * make the tool stricter.
 */
export function parseAllowHttpOverride(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return undefined;
  return normalized === "true" || normalized === "1";
}

/**
 * Whether a plain `http:` download link is fetched: the explicit override when
 * one is set, otherwise exactly when the configured API is itself plain http —
 * the local compose stack, whose object store mints plain-http presigned links.
 * A deployment reached over https gets https links, so a plain-http one there
 * is refused rather than followed silently. A malformed base URL refuses; the
 * client constructor then reports it as the config error it is.
 */
export function allowsPlainHttp(context: Pick<ArtifactsContext, "baseUrl" | "allowHttp">): boolean {
  if (context.allowHttp !== undefined) return context.allowHttp;
  try {
    return new URL(context.baseUrl).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Classify options for the SDK's download leg, whose only request is the bulk
 * resolve route. Its whole-request refusals are about the caller or the
 * deployment, never about the caller's input: a 400 is a key acting for no
 * organization and a 422 a request this server built, a 404 a deployment
 * without the route (the default `config` arm names it), a 5xx the platform
 * failing to sign. A 401/403 never reaches these options — the SDK raises it
 * as `ArtifactAuthenticationError`, which `classifyError` maps to the auth arm.
 * Per-reference refusals are values on the verdict's items, classified by
 * {@link itemToolError}.
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

// Constructed inside the caught block (mirroring the sibling capabilities): the
// SDK constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
function artifactClient(context: ArtifactsContext): ArtifactClient {
  return (
    context.client ??
    new PipelexApiClient({
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    })
  );
}

export function validateArtifactsRequest(input: MthdsDownloadArtifactsInput): ToolError[] {
  const errors = validateRunIdRequest(input.run_id);

  if (input.dir !== undefined) {
    if (input.dir.trim() === "") {
      errors.push({
        class: "input_domain",
        location: "dir",
        message: "dir must not be empty when supplied.",
        hint: "Pass a directory relative to the server's working directory, or omit dir to save into the working directory itself.",
        retryable: false,
      });
    } else if (path.isAbsolute(input.dir)) {
      errors.push({
        class: "input_domain",
        location: "dir",
        message: "dir must be relative to the server's working directory, not absolute.",
        hint: "Files are saved under the directory the host started this server in. Pass a relative directory such as `assets` or `out/run-1`.",
        retryable: false,
      });
    }
  }

  return errors;
}

export async function downloadMthdsArtifacts(
  input: MthdsDownloadArtifactsInput,
  context: ArtifactsContext = buildArtifactsContext(),
): Promise<ArtifactsResult> {
  const requestErrors = validateArtifactsRequest(input);
  if (requestErrors.length > 0) {
    return errorResult("No artifacts were saved: request input is invalid.", requestErrors);
  }

  if (context.saveRoot === undefined) {
    return errorResult("No artifacts were saved: this deployment cannot write files to disk.", [
      {
        class: "config",
        location: "deployment",
        message: "This deployment has no working directory to save files into.",
        hint: "Use the local workshop server (npx @pipelex/mcp), which saves run artifacts under the directory it was started in. On the hosted console, open the run on app.pipelex.com to download its files.",
        retryable: false,
      },
    ]);
  }

  // The run is read here rather than by the SDK's run_id arm, so a run that is
  // still running, failed, or references nothing touches no directory: the
  // target is created only once there is something to save in it.
  let client: ArtifactClient;
  let state: RunResultState;
  try {
    client = artifactClient(context);
    state = await client.getRunResult(input.run_id);
  } catch (err) {
    const error = classifyError(err, { ...RUN_RESULTS_ERROR_OPTIONS, auth: context.authError });
    return errorResult(summaryForToolError(error, ERROR_SUMMARIES), [error]);
  }

  switch (state.state) {
    case "running":
      return runningResult(state.pipeline_run_id, state.retry_after_seconds);
    case "failed":
      return failedResult(state.pipeline_run_id, state.status, state.message);
    case "completed":
      break;
  }

  // The SDK guarantees a non-null main_stuff on a completed run (it throws
  // MissingMainStuffError otherwise); reaching here without one is a contract
  // violation, surfaced as a runtime no-verdict like mthds_run_results does.
  // Checked before the walk, which would read a null output as "no files".
  if (state.result.main_stuff == null) {
    return errorResult("No artifacts were saved: the Pipelex API returned a malformed report.", [
      {
        class: "runtime",
        message: "Completed run results did not include main_stuff.",
        hint: "The API responded but its report was missing required fields; inspect the run on the platform.",
        retryable: false,
      },
    ]);
  }

  const runId = state.pipeline_run_id;
  if (collectArtifacts(state.result.main_stuff).length === 0) {
    return completedResult(runId, DOWNLOAD_SCOPE, [], context.saveRoot);
  }

  const target = await resolveSaveDir(context.saveRoot, input.dir, "dir");
  if (!target.ok) {
    return errorResult("No artifacts were saved: the target directory is invalid.", [target.error]);
  }

  let verdict: DownloadArtifactsResult;
  try {
    verdict = await client.downloadArtifacts({
      results: state.result,
      dir: target.dir,
      scope: DOWNLOAD_SCOPE,
      allowHttp: allowsPlainHttp(context),
    });
  } catch (err) {
    const error = classifyError(err, { ...BULK_RESOLVE_ERROR_OPTIONS, auth: context.authError });
    return errorResult(downloadRefusalSummary(error, err, target.root), [error]);
  }

  return completedResult(
    runId,
    verdict.scope,
    verdict.artifacts.map((item, index) => projectItem(item, index, target.root)),
    target.root,
  );
}

/**
 * The headline of a download the SDK could not produce a verdict for. A
 * credential refused part-way through leaves the files saved before it on
 * disk, and the SDK hands them back on the error: they are real, so the prose
 * names them even though the result is a no-verdict error.
 */
function downloadRefusalSummary(error: ToolError, err: unknown, root: string): string {
  const summary = summaryForToolError(error, ERROR_SUMMARIES);
  if (!(err instanceof ArtifactAuthenticationError) || err.verdict.saved_paths.length === 0) {
    return summary;
  }
  const saved = err.verdict.saved_paths.map((absolute) => `- \`${path.relative(root, absolute)}\``);
  return `${summary}\n\nBefore the refusal, ${saved.length} file(s) were saved under \`${root}\`:\n${saved.join("\n")}`;
}

// ── the verdict's items ─────────────────────────────────────────────

/** One SDK verdict entry, with its path made relative and its error classified. */
function projectItem(item: DownloadedArtifact, index: number, root: string): SavedArtifactEntry {
  if (item.error === null) {
    return {
      uri: item.uri,
      path: path.relative(root, item.path),
      content_type: item.content_type,
      size: item.size,
    };
  }
  return {
    uri: item.uri,
    content_type: item.content_type,
    error: itemToolError(item.error, index),
  };
}

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
 * How each per-item code the SDK's verdict carries reads as a `ToolError`. The
 * codes are the SDK's closed vocabulary: the resolve route's per-reference
 * refusals, the fetch boundary's, and the download's own. A vanished or
 * oversized object is a permanent `input_domain` refusal; a store or network
 * fault is a retryable `runtime` one, since every call mints fresh links.
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

/** A code the SDK adds later reads as an unnamed fault, which stays retryable. */
const UNKNOWN_ITEM_ERROR: ItemErrorTexture = {
  class: "runtime",
  hint: "Inspect the MCP server logs.",
  retryable: true,
};

/** Classify one per-item error, located at the artifact's own entry. */
export function itemToolError(error: ArtifactItemError, index: number): ToolError {
  const texture = ITEM_ERROR_TEXTURES[error.code] ?? UNKNOWN_ITEM_ERROR;
  return {
    class: texture.class,
    location: `artifacts[${index}].uri`,
    message: texture.message ?? error.detail,
    hint: texture.hint,
    retryable: texture.retryable,
  };
}

// ── projections ─────────────────────────────────────────────────────

/** Mirrors the SDK's base poll interval, like mthds_run_results. */
const DEFAULT_RETRY_SECONDS = 2;

function runningResult(runId: string, retryAfterSeconds: number | null): ArtifactsResult {
  const seconds = retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "running",
      retry_after_seconds: retryAfterSeconds,
    },
    summary: `Run \`${runId}\` has no result yet — it is still running, so there is nothing to save. Check again in ~${seconds}s with \`mthds_run_status\`, then call this tool once it is COMPLETED.`,
  };
}

function failedResult(runId: string, status: RunStatus, message: string): ArtifactsResult {
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "failed",
      run_status: status,
      failure_message: message,
    },
    summary: [
      "# No artifacts",
      `Run \`${runId}\` ended ${status}: ${message}`,
      "A failed run produces no files to save.",
    ].join("\n\n"),
  };
}

/**
 * Verdict discipline, consistent with `mthds_upload_attachments`: once the
 * per-file walk has run the result is PRODUCED (`status: "ok"`, `state:
 * "completed"`), discriminated on `all_saved`. Partial success is a produced
 * verdict, not an error: the files that landed are on disk and useful, and a
 * sibling's failure must not hide them.
 */
export function completedResult(
  runId: string,
  scope: ArtifactScope,
  artifacts: SavedArtifactEntry[],
  root: string,
): ArtifactsResult {
  const savedPaths = artifacts
    .map((item) => item.path)
    .filter((item): item is string => item !== undefined);

  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "completed",
      scope,
      artifacts,
      saved_paths: savedPaths,
      all_saved: savedPaths.length === artifacts.length,
    },
    summary: completedSummary(runId, artifacts, savedPaths.length, root),
  };
}

// The saved paths are deliberately repeated in the prose (the
// mthds_inputs_template pattern): they are the small payload the agent must
// report to the user, and some hosts read prose more reliably than structured
// fields. Per-file failures ride here too — they are not in the top-level
// errors[], so this is the only place the agent reads them.
function completedSummary(
  runId: string,
  artifacts: SavedArtifactEntry[],
  saved: number,
  root: string,
): string {
  if (artifacts.length === 0) {
    return [
      "# No artifacts",
      `Run \`${runId}\` completed, but its main output references no stored files (no \`pipelex-storage://\` reference), so there is nothing to save. The output itself is available through \`mthds_run_results\`.`,
    ].join("\n\n");
  }

  const parts = ["# Artifacts saved"];
  parts.push(
    saved === artifacts.length
      ? `Saved ${saved} file(s) from run \`${runId}\` under \`${root}\`. Existing files are never overwritten — a name collision gets a numeric suffix.`
      : `Saved ${saved} of ${artifacts.length} file(s) from run \`${runId}\` under \`${root}\`. The saved ones are listed with their paths; the failures follow.`,
  );

  const lines = artifacts.map((item) => {
    if (item.path !== undefined) {
      const type = item.content_type == null ? "" : `${item.content_type}, `;
      const size = item.size === undefined ? "" : formatBytes(item.size);
      const detail = type === "" && size === "" ? "" : ` (${type}${size})`;
      return `- \`${item.path}\`${detail} ← \`${item.uri}\``;
    }
    const hint = item.error?.hint === undefined ? "" : ` *Hint: ${item.error.hint}*`;
    return `- \`${item.uri}\` — failed: ${item.error?.message ?? "unknown failure"}${hint}`;
  });
  parts.push(lines.join("\n"));

  return parts.join("\n\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "Artifacts could not be saved: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Artifacts were not saved: the Pipelex API rejected the request.",
  runtime: "Artifacts could not be saved: the Pipelex API returned an error.",
  paywall:
    "Artifacts could not be saved: the organization's Pipelex plan does not cover this call.",
};

function errorResult(summary: string, errors: ToolError[]): ArtifactsResult {
  return {
    structuredContent: { status: "error", errors },
    summary,
  };
}

export function artifactsToolResult(result: ArtifactsResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
  };
}
