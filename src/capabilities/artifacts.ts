import path from "node:path";

import { ArtifactAuthenticationError, PipelexApiClient, collectArtifacts } from "@pipelex/sdk";
import type {
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
  BULK_RESOLVE_ERROR_OPTIONS,
  allowsPlainHttp,
  buildArtifactFetchConfig,
  classifyError,
  itemToolError,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateRunIdRequest,
} from "./shared.js";
import type { AuthErrorTexture, ErrorSummaries, ToolError } from "./shared.js";
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
      'One entry per stored file the main output references, in discovery order — on state "completed", and on a credential refused part-way through a download, where it carries the files saved before the refusal.',
    ),
  saved_paths: z
    .array(z.string())
    .optional()
    .describe(
      "The paths that were saved, relative to the server's working directory — present wherever artifacts is.",
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
   * The explicit plain-http override, read from `ALLOW_HTTP_ENV` in
   * `shared.ts`. Absent, `allowsPlainHttp` derives the answer from `baseUrl`'s
   * scheme.
   */
  allowHttp?: boolean;
  /** Deployment-specific auth-failure texture; default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildArtifactsContext(env = process.env): ArtifactsContext {
  return buildArtifactFetchConfig(env);
}

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

/**
 * Whether `dir` climbs out of the working directory on its own text. The real
 * containment check is `resolveSaveDir`'s — real paths, symlinks followed —
 * and it runs only once there is something to save; this lexical half runs on
 * every call, so a run whose output references no file still refuses an
 * escaping `dir` rather than reporting the save as fine.
 */
function escapesLexically(dir: string): boolean {
  const normalized = path.normalize(dir);
  return normalized === ".." || normalized.startsWith(`..${path.sep}`);
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
    } else if (escapesLexically(input.dir)) {
      errors.push({
        class: "input_domain",
        location: "dir",
        message: `dir resolves outside the server's working directory: ${input.dir}`,
        hint: "Files stay inside the directory the host started this server in. Pass a relative directory that stays inside it.",
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
    return refusedResult(error, err, target.root);
  }

  return completedResult(
    runId,
    verdict.scope,
    verdict.artifacts.map((item, index) => projectItem(item, index, target.root)),
    target.root,
  );
}

/**
 * A download the SDK could not produce a verdict for. A credential refused
 * part-way through leaves the files saved before it on disk, and the SDK hands
 * them back on the error: those files are real, so they ride the structured
 * result as well as the prose. `state` and `all_saved` stay absent — no
 * verdict was produced, and a consumer branching on `status` must not read one
 * here — but `artifacts` and `saved_paths` let it find what is already on its
 * disk instead of parsing the summary for it, and calling again would not
 * overwrite those files, it would write suffixed copies beside them.
 */
function refusedResult(error: ToolError, err: unknown, root: string): ArtifactsResult {
  const summary = summaryForToolError(error, ERROR_SUMMARIES);
  if (!(err instanceof ArtifactAuthenticationError)) return errorResult(summary, [error]);

  const artifacts = err.verdict.artifacts.map((item, index) => projectItem(item, index, root));
  const savedPaths = artifacts.flatMap((item) => (item.path === undefined ? [] : [item.path]));
  if (savedPaths.length === 0) return errorResult(summary, [error]);

  const lines = savedPaths.map((saved) => `- \`${saved}\``);
  return {
    structuredContent: { status: "error", errors: [error], artifacts, saved_paths: savedPaths },
    summary: `${summary}\n\nBefore the refusal, ${savedPaths.length} file(s) were saved under \`${root}\`:\n${lines.join("\n")}`,
  };
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
    error: itemToolError(item.error, `artifacts[${index}].uri`),
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
