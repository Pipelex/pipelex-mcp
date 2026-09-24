import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { ArtifactAuthenticationError, collectArtifacts } from "@pipelex/sdk";
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
  createPipelexApiClient,
  itemToolError,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateRunIdRequest,
} from "./shared.js";
import type { ApiConfig, AuthErrorTexture, ErrorSummaries, ToolError } from "./shared.js";
import { errorMessage, resolveSaveDir } from "./workspace-boundary.js";

/**
 * `mthds_download_artifacts` — the workshop's way to save a completed run to
 * disk, and its download counterpart to the upload path. `mthds_prepare_inputs`
 * pushes local files INTO Pipelex storage; this brings a run back OUT, onto the
 * user's disk, under the server's working directory — which is where the user
 * is: the main output itself as `main_stuff.json`, and every file the output
 * references.
 *
 * It is keyed on the run id, the durable handle the whole run family already
 * uses, rather than on a list of storage URIs. The walk, the fresh links, the
 * filenames, the never-overwrite rule and the download bounds of the produced
 * files are the SDK's artifact stack (`collectArtifacts` /
 * `downloadArtifacts`, which resolves through `resolveArtifacts`), so this
 * capability owns only what is the workshop's: the tool envelope, the output
 * file, the `dir` default and its containment against the working directory,
 * the deployment gate, the plain-http policy, the classification of every
 * failure into `ToolError`s, and the prose summary. The output file is the one
 * thing it writes itself, under the same never-overwrite rule the SDK applies
 * to the files beside it. See SPEC.md → Artifact Download Scope for why this is
 * a companion tool and not an option on `mthds_run_results`.
 */

/**
 * The scope this tool walks: always the run's main output. The tool takes no
 * `scope` input; the value is named here, rather than left to the SDK's
 * default, so the empty-walk check and the download agree on what was walked.
 */
export const DOWNLOAD_SCOPE: ArtifactScope = "main_stuff";

/**
 * The file every completed save writes first: the run's main output, verbatim.
 * The name is the one `pipelex run --save-main-stuff` writes and the one the
 * hosted platform stores the same artifact under.
 */
export const OUTPUT_FILENAME = "main_stuff.json";

/** Where a save lands when the caller names no `dir`: one folder per run, under this one. */
export const DEFAULT_RUNS_DIR = "runs";

/**
 * How many suffixed names the output write tries before giving up — the SDK's
 * own bound for the files beside it (`openUniqueFile`), restated because that
 * helper is internal to the SDK.
 */
const MAX_OUTPUT_NAME_ATTEMPTS = 10_000;

export const mthdsDownloadArtifactsInputSchema = {
  run_id: z
    .string()
    .describe("The durable run id returned by mthds_run — the run to save to disk."),
  dir: z
    .string()
    .optional()
    .describe(
      'Directory to save into, relative to the server\'s working directory (created if missing; it must stay inside that directory — no absolute paths, no `..`). Omit to save into `runs/<run_id>`, one folder per run; pass "." to save into the working directory itself.',
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

const savedOutputSchema = z.object({
  path: z
    .string()
    .describe(
      "Where main_stuff.json was written, relative to the server's working directory. It holds the run's full main output exactly as the API returned it — read it from there rather than retyping it.",
    ),
  size: z.number().describe("Bytes written."),
});

const artifactsStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  run_id: z.string().optional(),
  state: z
    .enum(["running", "completed", "failed"])
    .optional()
    .describe(
      'The run lookup outcome, as mthds_run_results reports it: "running" (nothing to save yet), "completed" (saved below), "failed" (a failed run produces nothing to save).',
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
  output: savedOutputSchema
    .optional()
    .describe(
      'The run\'s main output, saved as main_stuff.json — on state "completed", and on a credential refused part-way through a download, since it is written first.',
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
      "Every file that was saved, relative to the server's working directory: main_stuff.json first, then the saved artifacts — present wherever artifacts is.",
    ),
  all_saved: z
    .boolean()
    .optional()
    .describe(
      'State "completed" only — true when the output and every referenced file were saved.',
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

/** Where the output file landed, relative to the working directory, and its size. */
export interface SavedOutput {
  path: string;
  size: number;
}

export interface ArtifactsStructuredContent {
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";
  retry_after_seconds?: number | null;
  run_status?: RunStatus;
  failure_message?: string;
  scope?: ArtifactScope;
  output?: SavedOutput;
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

export interface ArtifactsContext extends ApiConfig {
  client?: ArtifactClient;
  /**
   * The directory saves land under — the workshop's working directory,
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
  return context.client ?? createPipelexApiClient(context);
}

/**
 * Whether `dir` climbs out of the working directory on its own text. The real
 * containment check is `resolveSaveDir`'s — real paths, symlinks followed —
 * and it runs only once the run has completed; this lexical half runs on every
 * call, so a run that is still running refuses an escaping `dir` too rather
 * than answering that there is nothing to save yet.
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
        hint: 'Pass a directory relative to the server\'s working directory, "." for the working directory itself, or omit dir to save into runs/<run_id>.',
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

/**
 * The folder a run is saved into when the caller names none: `runs/<run id>`.
 * The segment is built from the run id the API ANSWERED, never from the
 * caller's argument, and reduced to a conservative character set on top of
 * that — though `resolveSaveDir`'s containment is what holds the boundary, so
 * this is hygiene, not the defence. `undefined` when nothing usable is left.
 */
export function defaultRunDir(runId: string): string | undefined {
  const segment = runId.replace(/[^A-Za-z0-9_-]/g, "");
  return segment === "" ? undefined : path.join(DEFAULT_RUNS_DIR, segment);
}

export async function downloadMthdsArtifacts(
  input: MthdsDownloadArtifactsInput,
  context: ArtifactsContext = buildArtifactsContext(),
): Promise<ArtifactsResult> {
  const requestErrors = validateArtifactsRequest(input);
  if (requestErrors.length > 0) {
    return errorResult("Nothing was saved: request input is invalid.", requestErrors);
  }

  if (context.saveRoot === undefined) {
    return errorResult("Nothing was saved: this deployment cannot write files to disk.", [
      {
        class: "config",
        location: "deployment",
        message: "This deployment has no working directory to save files into.",
        hint: "Use the local workshop server (npx @pipelex/mcp), which saves runs under the directory it was started in. On the hosted console, open the run on app.pipelex.com to download its files.",
        retryable: false,
      },
    ]);
  }

  // The run is read here rather than by the SDK's run_id arm, so a run that is
  // still running or has failed never touches the disk: the target is created
  // only once there is a completed output to save in it.
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
  // Checked before anything is written, since there would be no output to save.
  const mainStuff = state.result.main_stuff;
  if (mainStuff == null) {
    return errorResult("Nothing was saved: the Pipelex API returned a malformed report.", [
      {
        class: "runtime",
        message: "Completed run results did not include main_stuff.",
        hint: "The API responded but its report was missing required fields; inspect the run on the platform.",
        retryable: false,
      },
    ]);
  }

  const runId = state.pipeline_run_id;
  const dir = input.dir ?? defaultRunDir(runId);
  if (dir === undefined) {
    return errorResult("Nothing was saved: the run id cannot name a directory.", [
      {
        class: "runtime",
        location: "run_id",
        message: `The Pipelex API answered a run id that cannot name a directory: ${runId}`,
        hint: "Pass dir to choose where the run is saved.",
        retryable: false,
      },
    ]);
  }

  const target = await resolveSaveDir(context.saveRoot, dir, "dir");
  if (!target.ok) {
    return errorResult("Nothing was saved: the target directory is invalid.", [target.error]);
  }

  // The output goes first, so it always takes its own name: a stored file
  // whose name would collide with it is the one the SDK suffixes. A directory
  // that cannot take one small JSON file will not take the downloads either,
  // so a failure here stops the save before anything is fetched.
  const written = await writeOutputFile(target.dir, mainStuff, dir);
  if (!written.ok) {
    return errorResult("Nothing was saved: the run's output could not be written.", [
      written.error,
    ]);
  }
  const output: SavedOutput = {
    path: path.relative(target.root, written.path),
    size: written.size,
  };

  if (collectArtifacts(mainStuff).length === 0) {
    return completedResult(runId, DOWNLOAD_SCOPE, output, [], target.root);
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
    return refusedResult(error, err, output, target.root);
  }

  return completedResult(
    runId,
    verdict.scope,
    output,
    verdict.artifacts.map((item, index) => projectItem(item, index, target.root)),
    target.root,
  );
}

// ── the output file ─────────────────────────────────────────────────

type OutputWrite = { ok: true; path: string; size: number } | { ok: false; error: ToolError };

/**
 * Write the run's main output into `dir` as `main_stuff.json`, formatted for a
 * person and otherwise exactly as the API returned it — the storage references
 * and their expiring links included, since the file is a record of the run and
 * the verdict is what maps each reference to its saved file.
 *
 * The rule is the download tool's own: never overwrite. The file is created
 * exclusively (`wx`) and a taken name gets a numeric suffix
 * (`main_stuff-1.json`), exactly as the SDK treats the files saved beside it,
 * so saving the same run twice into one folder adds copies rather than
 * replacing anything. A write that fails removes the file it created. Never
 * throws: every failure is an `input_domain` refusal at `dir`, the texture
 * `resolveSaveDir` gives an unusable directory.
 */
async function writeOutputFile(
  dir: string,
  mainStuff: unknown,
  requestedDir: string,
): Promise<OutputWrite> {
  const bytes = Buffer.from(`${JSON.stringify(mainStuff, null, 2)}\n`, "utf8");
  const ext = path.extname(OUTPUT_FILENAME);
  const stem = path.basename(OUTPUT_FILENAME, ext);

  for (let attempt = 0; attempt < MAX_OUTPUT_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, attempt === 0 ? OUTPUT_FILENAME : `${stem}-${attempt}${ext}`);
    let handle: FileHandle;
    try {
      handle = await fs.open(candidate, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      return { ok: false, error: outputWriteError(requestedDir, err) };
    }
    try {
      await handle.writeFile(bytes);
      await handle.close();
      return { ok: true, path: candidate, size: bytes.byteLength };
    } catch (err) {
      await handle.close().catch(() => undefined);
      await fs.unlink(candidate).catch(() => undefined);
      return { ok: false, error: outputWriteError(requestedDir, err) };
    }
  }

  return {
    ok: false,
    error: outputWriteError(
      requestedDir,
      new Error(`no free name for ${OUTPUT_FILENAME} after ${MAX_OUTPUT_NAME_ATTEMPTS} attempts`),
    ),
  };
}

function outputWriteError(dir: string, err: unknown): ToolError {
  return {
    class: "input_domain",
    location: "dir",
    message: `Could not write ${OUTPUT_FILENAME} in ${dir}: ${errorMessage(err)}`,
    hint: "Check that the directory is writable and has room, or pass another dir.",
    retryable: false,
  };
}

/**
 * A download the SDK could not produce a verdict for. The output file was
 * written before the download began, and a credential refused part-way through
 * leaves the files saved before it on disk too — the SDK hands them back on
 * the error. Everything on disk is real, so it rides the structured result as
 * well as the prose. `state` and `all_saved` stay absent — no verdict was
 * produced, and a consumer branching on `status` must not read one here — but
 * `output`, `artifacts` and `saved_paths` let it find what is already on its
 * disk instead of parsing the summary for it, and calling again would not
 * overwrite those files, it would write suffixed copies beside them.
 */
function refusedResult(
  error: ToolError,
  err: unknown,
  output: SavedOutput,
  root: string,
): ArtifactsResult {
  const summary = summaryForToolError(error, FILES_ERROR_SUMMARIES);
  const artifacts =
    err instanceof ArtifactAuthenticationError
      ? err.verdict.artifacts.map((item, index) => projectItem(item, index, root))
      : undefined;
  const savedArtifacts = (artifacts ?? []).flatMap((item) =>
    item.path === undefined ? [] : [item.path],
  );
  const savedPaths = [output.path, ...savedArtifacts];

  const lines = savedPaths.map((saved) => `- \`${saved}\``);
  return {
    structuredContent: {
      status: "error",
      errors: [error],
      output,
      ...(artifacts === undefined ? {} : { artifacts }),
      saved_paths: savedPaths,
    },
    summary: `${summary}\n\nBefore the failure, the run's main output and ${savedArtifacts.length} file(s) were saved under \`${root}\`:\n${lines.join("\n")}`,
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
      "# Nothing saved",
      `Run \`${runId}\` ended ${status}: ${message}`,
      "A failed run produces no output and no files to save.",
    ].join("\n\n"),
  };
}

/**
 * Verdict discipline, consistent with `mthds_upload_attachments`: once the
 * per-file walk has run the result is PRODUCED (`status: "ok"`, `state:
 * "completed"`), discriminated on `all_saved`. Partial success is a produced
 * verdict, not an error: the output and the files that landed are on disk and
 * useful, and a sibling's failure must not hide them. The output itself is
 * always saved by the time a verdict exists — a failed output write is a
 * no-verdict refusal — so `all_saved` turns on the files alone.
 */
function completedResult(
  runId: string,
  scope: ArtifactScope,
  output: SavedOutput,
  artifacts: SavedArtifactEntry[],
  root: string,
): ArtifactsResult {
  const savedArtifacts = artifacts
    .map((item) => item.path)
    .filter((item): item is string => item !== undefined);

  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "completed",
      scope,
      output,
      artifacts,
      saved_paths: [output.path, ...savedArtifacts],
      all_saved: savedArtifacts.length === artifacts.length,
    },
    summary: completedSummary(runId, output, artifacts, savedArtifacts.length, root),
  };
}

// The saved paths are deliberately repeated in the prose (the
// mthds_inputs_template pattern): they are the small payload the agent must
// report to the user, and some hosts read prose more reliably than structured
// fields. Per-file failures ride here too — they are not in the top-level
// errors[], so this is the only place the agent reads them.
function completedSummary(
  runId: string,
  output: SavedOutput,
  artifacts: SavedArtifactEntry[],
  saved: number,
  root: string,
): string {
  const outputLine = `- \`${output.path}\` (the main output, ${formatBytes(output.size)})`;
  const readIt =
    "It holds the output exactly as the API returned it: read it from the file rather than retyping it.";

  if (artifacts.length === 0) {
    return [
      "# Run saved",
      `Saved the main output of run \`${runId}\` under \`${root}\`. It references no stored files (no \`pipelex-storage://\` reference), so that is the whole run.`,
      outputLine,
      readIt,
    ].join("\n\n");
  }

  const parts = ["# Run saved"];
  parts.push(
    saved === artifacts.length
      ? `Saved run \`${runId}\` under \`${root}\`: its main output and ${saved} file(s). Existing files are never overwritten — a name collision gets a numeric suffix.`
      : `Saved run \`${runId}\` under \`${root}\`: its main output and ${saved} of ${artifacts.length} file(s). The saved ones are listed with their paths; the failures follow.`,
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
  parts.push([outputLine, ...lines].join("\n"));
  parts.push(readIt);

  return parts.join("\n\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "The run could not be saved: the Pipelex API is unreachable or misconfigured.",
  input_domain: "The run was not saved: the Pipelex API rejected the request.",
  runtime: "The run could not be saved: the Pipelex API returned an error.",
  paywall: "The run could not be saved: the organization's Pipelex plan does not cover this call.",
};

/**
 * The headlines of a download that failed after the output was written: the
 * run is partly on disk, so "the run could not be saved" would contradict the
 * list of saved paths that follows it.
 */
const FILES_ERROR_SUMMARIES: ErrorSummaries = {
  config: "The run's files could not be saved: the Pipelex API is unreachable or misconfigured.",
  input_domain: "The run's files were not saved: the Pipelex API rejected the request.",
  runtime: "The run's files could not be saved: the Pipelex API returned an error.",
  paywall:
    "The run's files could not be saved: the organization's Pipelex plan does not cover this call.",
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
