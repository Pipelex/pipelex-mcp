import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  ArtifactAuthenticationError,
  DEFAULT_ARTIFACT_MAX_BYTES,
  DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES,
  buildProblem,
  collectArtifacts,
} from "@pipelex/sdk";
import type {
  ArtifactItemError,
  ArtifactScope,
  DownloadArtifactsRequest,
  DownloadArtifactsResult,
  DownloadedArtifact,
  GetRunResultOptions,
  Problem,
  RunRead,
  RunResultArtifact,
  RunResultState,
  RunStatus,
} from "@pipelex/sdk";
import { z } from "zod";

import { runErrorSchema } from "./run-failure.js";
import { failedArmSummary, readFailedRun, runErrorOfFailedArm, runStatusSchema } from "./run.js";
import type { FailedRunState } from "./run.js";
import {
  allowsPlainHttp,
  argumentProblem,
  asOneLine,
  buildArtifactFetchConfig,
  createPipelexApiClient,
  faultsProblem,
  fetchItemProblem,
  problemLine,
  problemOf,
  problemSchema,
  problemSummary,
  toolResultContent,
  validateRunIdRequest,
} from "./shared.js";
import type { ApiConfig, ApiNotes } from "./shared.js";
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
 * the deployment gate, the plain-http policy, the download limits, the
 * problem each failure reports, and the prose summary. The output file is the one
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
 * The result artifacts this tool's results read asks for, and nothing else:
 * `main_stuff`, which it writes as the output file, and the artifact the
 * download walks, which is `DOWNLOAD_SCOPE`. Both are `main_stuff` today, so
 * the read carries the main output alone, never the graph, the I/O artifacts,
 * the working memory or the usage records.
 */
export const DOWNLOAD_RESULT_ARTIFACTS: readonly RunResultArtifact[] = [
  ...new Set<RunResultArtifact>(["main_stuff", DOWNLOAD_SCOPE]),
];

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

/**
 * How many of a reference's paths an entry lists. The SDK answers one path per
 * occurrence, so an output that repeats one stored reference — every page of
 * a split document pointing back at its source — would grow the verdict with
 * every repetition, and the verdict is model-facing while the output it
 * describes was written to disk precisely to stay out of the context. The
 * first path is always kept, since it named the file; the rest are counted in
 * `found_at_omitted`, and `main_stuff.json` holds every one of them.
 */
export const MAX_FOUND_AT_PATHS = 8;

/**
 * The most bytes one saved file may hold, and the most one call writes in
 * all: the SDK's own defaults, passed explicitly so that the limit a refused
 * file's problem names is the one this call applied.
 */
export const DOWNLOAD_MAX_FILE_BYTES = DEFAULT_ARTIFACT_MAX_BYTES;
export const DOWNLOAD_MAX_TOTAL_BYTES = DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES;

export const mthdsDownloadArtifactsInputSchema = {
  run_id: z
    .string()
    .describe("The durable run id returned by mthds_run — the run to save to disk."),
  dir: z
    .string()
    .optional()
    .describe(
      "Directory to save into, relative to the server's working directory (created if missing, and then given a .gitignore of * so neither git nor a method folder above takes the run's files for its own; it must stay inside that directory — no absolute paths, no `..`). Omit to save into `runs/<run_id>`, one folder per run; pass \".\" to save into the working directory itself.",
    ),
};

const savedArtifactSchema = z.object({
  uri: z.string().describe("The pipelex-storage:// reference found in the run's main output."),
  found_at: z
    .array(z.string())
    .describe(
      'Every path in main_stuff.json at which the reference sits, $-rooted and in walk order ($.rooms[3].staged_photo.url, $["a key"].url) — the first one named the file. Bounded — see found_at_omitted.',
    ),
  found_at_omitted: z
    .number()
    .optional()
    .describe(
      "Present when the reference sits at more paths than found_at lists: how many were left out. main_stuff.json holds them all.",
    ),
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
  error: problemSchema
    .optional()
    .describe("Present when this file could not be saved: why, as a problem."),
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
  run_error: runErrorSchema
    .optional()
    .describe(
      'State "failed" only, when the run stored one — the run\'s own problem, as mthds_run_results carries it.',
    ),
  scope: z
    .enum(["main_stuff", "working_memory"])
    .optional()
    .describe(
      'State "completed" only — which of the run\'s outputs was walked for stored-file references. Always "main_stuff", the run\'s main output: artifacts.length is the count of references found there.',
    ),
  output: savedOutputSchema
    .optional()
    .describe(
      'The run\'s main output, saved as main_stuff.json — on state "completed", and on any refusal of the file download, since it is written first.',
    ),
  artifacts: z
    .array(savedArtifactSchema)
    .optional()
    .describe(
      'One entry per stored file the main output references, in discovery order — on state "completed", and on a credential refused after some files were saved, where it carries them.',
    ),
  saved_paths: z
    .array(z.string())
    .optional()
    .describe(
      "Every file that was saved, relative to the server's working directory: main_stuff.json first, then the saved artifacts — present wherever output is.",
    ),
  all_saved: z
    .boolean()
    .optional()
    .describe(
      'State "completed" only — true when the output and every referenced file were saved.',
    ),
  problem: problemSchema
    .optional()
    .describe(
      'status "error" only: why no verdict could be produced. A refusal of the file download comes with output and saved_paths, since the output was written first.',
    ),
});

export const mthdsDownloadArtifactsOutputSchema = artifactsStructuredContentSchema;

export interface MthdsDownloadArtifactsInput {
  run_id: string;
  dir?: string;
}

export interface SavedArtifactEntry {
  uri: string;
  /** Every `$`-rooted path in the main output where the reference sits; the first named the file. */
  found_at: string[];
  /** How many further paths `found_at` leaves out; absent when it lists them all. */
  found_at_omitted?: number;
  path?: string;
  content_type?: string | null;
  size?: number;
  error?: Problem;
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
  /** State "failed" only, when the run stored one: the run's own problem. */
  run_error?: Problem;
  scope?: ArtifactScope;
  output?: SavedOutput;
  artifacts?: SavedArtifactEntry[];
  saved_paths?: string[];
  all_saved?: boolean;
  /** Status "error" only. */
  problem?: Problem;
}

export interface ArtifactsResult {
  structuredContent: ArtifactsStructuredContent;
  summary: string;
}

/** The slice of `PipelexApiClient` this capability calls (test seam). */
export interface ArtifactClient {
  getRunResult(runId: string, options?: GetRunResultOptions): Promise<RunResultState>;
  /** Read once after a failed results arm, for when the run ended and its problem (`readFailedRun`). */
  getRunStatus(runId: string, options?: { signal?: AbortSignal }): Promise<RunRead>;
  downloadArtifacts(request: DownloadArtifactsRequest): Promise<DownloadArtifactsResult>;
}

export interface ArtifactsContext extends ApiConfig {
  client?: ArtifactClient;
  /**
   * The directory saves land under — the workshop's working directory,
   * absolute. Absent, as on a context the core builds alone, the tool refuses
   * (fail-closed) rather than picking a directory of its own. The workshop
   * always sets it, so that branch is a guard, not a served posture.
   */
  saveRoot?: string;
  /**
   * The explicit plain-http override, read from `ALLOW_HTTP_ENV` in
   * `shared.ts`. Absent, `allowsPlainHttp` derives the answer from `baseUrl`'s
   * scheme.
   */
  allowHttp?: boolean;
  /** Where the key and the base URL came from, said beside a problem they may be the fix of. */
  apiNotes?: ApiNotes;
}

export function buildArtifactsContext(env = process.env): ArtifactsContext {
  return buildArtifactFetchConfig(env);
}

// Constructed inside the caught block (mirroring the sibling capabilities): the
// SDK constructor throws PipelineRequestError on a malformed base URL, and that
// must become the problem it carries, not reject the MCP handler.
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

export function validateArtifactsRequest(input: MthdsDownloadArtifactsInput): Problem[] {
  const errors = validateRunIdRequest(input.run_id);

  if (input.dir !== undefined) {
    if (input.dir.trim() === "") {
      errors.push(
        argumentProblem(
          "dir",
          "empty",
          "dir must not be empty when supplied.",
          'Pass a directory relative to the server\'s working directory, "." for the working directory itself, or omit dir to save into runs/<run_id>.',
        ),
      );
    } else if (path.isAbsolute(input.dir)) {
      errors.push(
        argumentProblem(
          "dir",
          "absolute",
          "dir must be relative to the server's working directory, not absolute.",
          "Files are saved under the directory the host started this server in. Pass a relative directory such as `assets` or `out/run-1`.",
        ),
      );
    } else if (escapesLexically(input.dir)) {
      errors.push(
        argumentProblem(
          "dir",
          "outside_workspace",
          `dir resolves outside the server's working directory: ${input.dir}`,
          "Files stay inside the directory the host started this server in. Pass a relative directory that stays inside it.",
        ),
      );
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
  const faults = validateArtifactsRequest(input);
  if (faults.length > 0) {
    return errorResult(faultsProblem(faults), context.apiNotes);
  }

  if (context.saveRoot === undefined) {
    return errorResult(
      buildProblem(
        "client.not_configured",
        { setting: "working_directory" },
        {
          extra: {
            message:
              "This deployment has no working directory to save files into, so nothing was saved. Use the local workshop server (npx @pipelex/mcp), which saves runs under the directory it was started in. On the hosted console, open the run on app.pipelex.com to download its files.",
          },
        },
      ),
      context.apiNotes,
    );
  }

  // The run is read here rather than by the SDK's run_id arm, so a run that is
  // still running or has failed never touches the disk: the target is created
  // only once there is a completed output to save in it.
  let client: ArtifactClient;
  let state: RunResultState;
  try {
    client = artifactClient(context);
    state = await client.getRunResult(input.run_id, { artifacts: DOWNLOAD_RESULT_ARTIFACTS });
  } catch (err) {
    return errorResult(problemOf(err), context.apiNotes);
  }

  switch (state.state) {
    case "running":
      return runningResult(state.pipeline_run_id, state.retry_after_seconds);
    case "failed":
      return failedResult(state, await readFailedRun(client, state.pipeline_run_id));
    case "completed":
      break;
  }

  // The SDK guarantees a non-null main_stuff on a completed run (it throws
  // MissingMainStuffError otherwise); reaching here without one is a contract
  // violation, which the SDK itself reads as an answer it could not read.
  // Checked before anything is written, since there would be no output to save.
  const mainStuff = state.result.main_stuff;
  if (mainStuff == null) {
    return errorResult(
      buildProblem(
        "client.response_unreadable",
        { status: 200 },
        {
          extra: {
            message:
              "Completed run results did not include main_stuff, so nothing was saved; inspect the run on the platform.",
          },
        },
      ),
      context.apiNotes,
    );
  }

  // A run id that leaves nothing to name a folder after is the API's answer,
  // but the fix is the caller's: naming the folder itself.
  const runId = state.pipeline_run_id;
  const dir = input.dir ?? defaultRunDir(runId);
  if (dir === undefined) {
    return errorResult(
      argumentProblem(
        "dir",
        "required",
        `The Pipelex API answered a run id that cannot name a directory: ${runId}`,
        "Pass dir to choose where the run is saved.",
      ),
      context.apiNotes,
    );
  }

  const target = await resolveSaveDir(context.saveRoot, dir, "dir");
  if (!target.ok) {
    return errorResult(target.problem, context.apiNotes);
  }

  // A dir the caller names gets the mark on the directory the run lands in,
  // and only when this call created it; the default location gets it on the
  // topmost directory created there, `runs/` the first time.
  let marked: string | undefined;
  if (target.created !== undefined) {
    const markedDir = input.dir === undefined ? target.created : target.dir;
    const failure = await markGenerated(markedDir, path.relative(target.root, markedDir));
    if (failure !== undefined) {
      await removeCreatedDirectories(target.dir, target.created);
      return errorResult(failure, context.apiNotes);
    }
    marked = path.relative(target.root, markedDir);
  }

  // The output goes first, so it always takes its own name: a stored file
  // whose name would collide with it is the one the SDK suffixes. A directory
  // that cannot take one small JSON file will not take the downloads either,
  // so a failure here stops the save before anything is fetched.
  const written = await writeOutputFile(target.dir, mainStuff, dir);
  if (!written.ok) {
    return errorResult(written.problem, context.apiNotes);
  }
  const output: SavedOutput = {
    path: path.relative(target.root, written.path),
    size: written.size,
  };

  if (collectArtifacts(mainStuff).length === 0) {
    return withMarkNote(completedResult(runId, DOWNLOAD_SCOPE, output, [], target.root), marked);
  }

  let verdict: DownloadArtifactsResult;
  try {
    verdict = await client.downloadArtifacts({
      results: state.result,
      dir: target.dir,
      scope: DOWNLOAD_SCOPE,
      allowHttp: allowsPlainHttp(context),
      maxBytes: DOWNLOAD_MAX_FILE_BYTES,
      maxTotalBytes: DOWNLOAD_MAX_TOTAL_BYTES,
    });
  } catch (err) {
    return withMarkNote(
      refusedResult(problemOf(err), err, output, target.root, dir, context.apiNotes),
      marked,
    );
  }

  return withMarkNote(
    completedResult(
      runId,
      verdict.scope,
      output,
      verdict.artifacts.map((item) => projectItem(item, target.root, dir)),
      target.root,
    ),
    marked,
  );
}

// ── the generated-directory mark ────────────────────────────────────

/** What a directory this tool creates holds first: a `.gitignore` excluding everything in it, itself included. */
export const GENERATED_DIRECTORY_GITIGNORE = "*\n";

/**
 * Mark `dir` as generated: a `.gitignore` holding `*`. A run saved beside a
 * method lands inside the method's folder, and the folder's membership rule
 * reads the `.gitignore` files inside it, so the mark keeps the run's files
 * out of the method that folder holds — and out of git — without the rule
 * knowing `runs/` by name.
 *
 * The caller passes a directory this call created, never one it found: the
 * directory the run lands in for a `dir` the caller names, the topmost one
 * created for the default location. An existing `.gitignore` is never
 * overwritten (`wx`), so a directory the user made stays theirs to mark.
 * Returns a `client.write_failed` at `dir` when the file cannot be written,
 * as the output file's failure is, since a directory that cannot take two
 * bytes will not take the run either. `shown` is `dir` relative to the
 * working directory, which the problem names.
 */
async function markGenerated(dir: string, shown: string): Promise<Problem | undefined> {
  try {
    await fs.writeFile(path.join(dir, ".gitignore"), GENERATED_DIRECTORY_GITIGNORE, {
      flag: "wx",
    });
    return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    return writeFailedProblem(
      path.join(shown, ".gitignore"),
      systemReason(err),
      `Could not write .gitignore in ${shown}, the directory this call created: ${errorMessage(err)}`,
    );
  }
}

/** Why a local write failed, in one identifier: its system code, when it has one. */
function systemReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "failed";
}

/**
 * A file this tool writes itself that could not be written: `client.write_failed`
 * at `dir`, naming the file relative to the working directory, with this
 * server's sentence and what to do as its `message`.
 */
function writeFailedProblem(file: string, reason: string, message: string): Problem {
  return buildProblem(
    "client.write_failed",
    { path: file, reason },
    {
      location: { field: "dir" },
      extra: {
        message: asOneLine(
          `${message} Check that the directory is writable and has room, or pass another dir.`,
        ),
      },
    },
  );
}

/**
 * Undo the directories a save created when it could not mark them: from
 * `dir` up to `created` inclusive, each removed only while empty, so a retry
 * creates them again and marks them rather than finding them unmarked and
 * leaving them so. Best effort: a directory that is not empty, or will not
 * go, stops the climb and stays.
 */
async function removeCreatedDirectories(dir: string, created: string): Promise<void> {
  let current = dir;
  for (;;) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    if (current === created) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** The summary line naming the directory the save marked as generated, when it marked one. */
function withMarkNote(result: ArtifactsResult, marked: string | undefined): ArtifactsResult {
  if (marked === undefined) return result;
  return {
    ...result,
    summary: `${result.summary}\n\nCreated \`${marked}\` and gave it a \`.gitignore\` of \`*\`, so git and a method folder above it leave the run's files out.`,
  };
}

// ── the output file ─────────────────────────────────────────────────

type OutputWrite = { ok: true; path: string; size: number } | { ok: false; problem: Problem };

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
 * throws: every failure is a `client.write_failed` at `dir`, the problem
 * `resolveSaveDir` gives a directory that cannot be used.
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
      return { ok: false, problem: outputWriteError(requestedDir, candidate, err) };
    }
    try {
      await handle.writeFile(bytes);
      await handle.close();
      return { ok: true, path: candidate, size: bytes.byteLength };
    } catch (err) {
      await handle.close().catch(() => undefined);
      await fs.unlink(candidate).catch(() => undefined);
      return { ok: false, problem: outputWriteError(requestedDir, candidate, err) };
    }
  }

  return {
    ok: false,
    problem: writeFailedProblem(
      path.join(requestedDir, OUTPUT_FILENAME),
      "no_free_name",
      `Could not write ${OUTPUT_FILENAME} in ${requestedDir}: no free name for it after ${MAX_OUTPUT_NAME_ATTEMPTS} attempts.`,
    ),
  };
}

/** The output file at `candidate` could not be written: the problem names it under `dir`, the caller's own. */
function outputWriteError(dir: string, candidate: string, err: unknown): Problem {
  return writeFailedProblem(
    path.join(dir, path.basename(candidate)),
    systemReason(err),
    `Could not write ${OUTPUT_FILENAME} in ${dir}: ${errorMessage(err)}`,
  );
}

/**
 * A download the SDK could not produce a verdict for. The output file was
 * written before the download began, so EVERY refusal here carries `output`
 * and `saved_paths`. A credential refused part-way through leaves the files
 * saved before it on disk too, and the SDK hands them back on the error: only
 * then does `artifacts` ride, carrying them. A credential refused before any
 * file was saved hands back a verdict of nothing but `aborted` items, whose
 * per-item "call the tool again" would contradict the refusal's own
 * not-retryable problem, so it is left out. `state` and `all_saved` stay absent —
 * no verdict was produced, and a consumer branching on `status` must not read
 * one here — but what is on disk rides the structured result as well as the
 * prose, so a consumer finds it without parsing the summary; calling again
 * would not overwrite those files, it would write suffixed copies beside them.
 */
function refusedResult(
  problem: Problem,
  err: unknown,
  output: SavedOutput,
  root: string,
  dir: string,
  notes: ApiNotes | undefined,
): ArtifactsResult {
  const refused =
    err instanceof ArtifactAuthenticationError
      ? err.verdict.artifacts.map((item) => projectItem(item, root, dir))
      : [];
  const savedArtifacts = refused.flatMap((item) => (item.path === undefined ? [] : [item.path]));
  const savedPaths = [output.path, ...savedArtifacts];

  const saved =
    savedArtifacts.length === 0
      ? `Before the failure, the run's main output was saved as \`${output.path}\`.`
      : `Before the failure, the run's main output and ${savedArtifacts.length} file(s) were saved under \`${root}\`:\n${savedPaths.map((entry) => `- \`${entry}\``).join("\n")}`;
  return {
    structuredContent: {
      status: "error",
      problem,
      output,
      ...(savedArtifacts.length === 0 ? {} : { artifacts: refused }),
      saved_paths: savedPaths,
    },
    summary: `${problemSummary(problem, notes)}\n\n${saved}`,
  };
}

// ── the verdict's items ─────────────────────────────────────────────

/** One SDK verdict entry, with its path made relative and its error read as a problem. */
function projectItem(item: DownloadedArtifact, root: string, dir: string): SavedArtifactEntry {
  if (item.error === null) {
    return {
      uri: item.uri,
      ...boundFoundAt(item.found_at),
      path: path.relative(root, item.path),
      content_type: item.content_type,
      size: item.size,
    };
  }
  return {
    uri: item.uri,
    ...boundFoundAt(item.found_at),
    content_type: item.content_type,
    error: itemProblem(item.error, item.uri, dir),
  };
}

/**
 * The problem of one file the download could not save. The fetch boundary's
 * codes and the resolve route's are the SDK's to read (`fetchItemProblem`).
 * The download's own codes the SDK reads as `runtime.unexpected`, so they are
 * read here into the core codes they are: a file past a limit this call
 * passed, a file that could not be written under `dir`, a download stopped
 * before it, and a resolve that failed for the whole chunk. The item's
 * sentence is the `message` either way.
 */
function itemProblem(error: ArtifactItemError, uri: string, dir: string): Problem {
  const options = { extra: { message: error.detail } };
  switch (error.code) {
    case "too_large":
      return buildProblem(
        "client.download_limit_exceeded",
        { limit: DOWNLOAD_MAX_FILE_BYTES },
        options,
      );
    case "total_limit_exceeded":
      return buildProblem(
        "client.download_limit_exceeded",
        { limit: DOWNLOAD_MAX_TOTAL_BYTES },
        options,
      );
    case "write_failed":
      // Node words a failed write after its system code (`EACCES: permission
      // denied, open …`), and the SDK quotes that sentence as the detail.
      return buildProblem(
        "client.write_failed",
        { path: dir, reason: /\b(E[A-Z]{2,})\b/.exec(error.detail)?.[1] ?? "failed" },
        { ...options, location: { field: "dir" } },
      );
    case "aborted":
      return buildProblem("client.aborted", {}, options);
    case "resolve_failed":
      return buildProblem("runtime.unavailable", {}, options);
    default:
      return fetchItemProblem(error, uri);
  }
}

/** The first {@link MAX_FOUND_AT_PATHS} paths, and a count of the rest when there are any. */
function boundFoundAt(
  foundAt: readonly string[],
): Pick<SavedArtifactEntry, "found_at" | "found_at_omitted"> {
  const omitted = foundAt.length - MAX_FOUND_AT_PATHS;
  return omitted > 0
    ? { found_at: foundAt.slice(0, MAX_FOUND_AT_PATHS), found_at_omitted: omitted }
    : { found_at: [...foundAt] };
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

/**
 * A run that ended without success: its own problem, from the failed arm or,
 * when the arm carries none, from the status read that followed it, as
 * `mthds_run_results` reads it.
 */
function failedResult(state: FailedRunState, failedRead: RunRead | undefined): ArtifactsResult {
  const runId = state.pipeline_run_id;
  const runError = runErrorOfFailedArm(state, failedRead);
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "failed",
      run_status: state.status,
      ...(runError === undefined ? {} : { run_error: runError }),
    },
    summary: [
      "# Nothing saved",
      failedArmSummary(state, runError, failedRead),
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
// fields. Per-file failures ride here too, each its problem on one line.
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
      return `- \`${item.path}\`${detail} ← ${fieldOf(item)}`;
    }
    const failure = item.error === undefined ? "unknown failure" : problemLine(item.error);
    return `- ${fieldOf(item)} (\`${item.uri}\`) — failed: ${failure}`;
  });
  parts.push([outputLine, ...lines].join("\n"));
  parts.push(readIt);

  return parts.join("\n\n");
}

/**
 * The field a file fills, as the summary names it: the first path, which is
 * the one its name came from, and a count of any others — the output can
 * repeat one reference, and the file on disk is one copy either way.
 */
function fieldOf(item: SavedArtifactEntry): string {
  const [first, ...others] = item.found_at;
  if (first === undefined) return `\`${item.uri}\``;
  const more = others.length + (item.found_at_omitted ?? 0);
  return more === 0 ? `\`${first}\`` : `\`${first}\` (and ${more} more)`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function errorResult(problem: Problem, notes: ApiNotes | undefined): ArtifactsResult {
  return {
    structuredContent: { status: "error", problem },
    summary: problemSummary(problem, notes),
  };
}

export function artifactsToolResult(result: ArtifactsResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary),
    isError: result.structuredContent.status === "error",
  };
}
