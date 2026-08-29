import { promises as fs } from "node:fs";
import path from "node:path";

import { PipelexApiClient } from "@pipelex/sdk";
import type { ResolvedStorageUrl, RunResultState, RunStatus } from "@pipelex/sdk";
import { z } from "zod";

import { httpArtifactDownloader } from "./artifact-download.js";
import type { ArtifactDownloader } from "./artifact-download.js";
import { RUN_RESULTS_ERROR_OPTIONS, runStatusSchema } from "./run.js";
import {
  PIPELEX_STORAGE_SCHEME,
  buildApiConfig,
  classifyError,
  collectStorageUris,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateRunIdRequest,
} from "./shared.js";
import type {
  AuthErrorTexture,
  ClassifyErrorOptions,
  ErrorSummaries,
  ToolError,
} from "./shared.js";

/**
 * `mthds_download_artifacts` — the workshop's download counterpart to its
 * upload path. `mthds_prepare_inputs` pushes local files INTO Pipelex storage;
 * this brings a run's produced files back OUT, onto the user's disk, under the
 * server's working directory — which is where the user is.
 *
 * It is keyed on the run id, the durable handle the whole run family already
 * uses, rather than on a list of storage URIs: the agent never has to copy
 * references out of a bounded result, and every `pipelex-storage://` reference
 * in the run's FULL main output is found and resolved to a FRESH presigned link
 * through the API (`resolveStorageUrl`), so the hour-long life of the
 * `public_url` embedded in the results never matters — days later the same
 * call still works. See SPEC.md → Artifact Download Scope for why this is a
 * companion tool and not an option on `mthds_run_results`.
 */

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
  content_type: z.string().nullable().optional().describe("The stored object's content type."),
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
  resolveStorageUrl(input: { uri: string }): Promise<ResolvedStorageUrl>;
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
  /** The download boundary; the real http downloader unless a test injects one. */
  downloader?: ArtifactDownloader;
  /** Deployment-specific auth-failure texture; default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildArtifactsContext(env = process.env): ArtifactsContext {
  return buildApiConfig(env);
}

/**
 * Classify options for the per-artifact `POST /v1/resolve-storage-url` leg.
 * Both request-domain arms locate at the artifact's own entry: the URI came
 * out of the run's output, so a rejection is about that reference, not about
 * anything the caller typed.
 */
export function resolveStorageUrlErrorOptions(index: number): ClassifyErrorOptions {
  const location = `artifacts[${index}].uri`;
  return {
    route: "/v1/resolve-storage-url",
    badRequest: {
      location,
      hint: "The API rejected this storage reference as found in the run output; it may belong to another organization than the API key's.",
    },
    notFound: {
      location,
      hint: "No stored object answers to this reference — it may have been deleted, or belong to another organization. If PIPELEX_BASE_URL points at a deployment without /v1/resolve-storage-url, use the hosted Pipelex API.",
    },
  };
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
  const uris = collectStorageUris(state.result.main_stuff);
  if (uris.length === 0) {
    return completedResult(runId, [], context.saveRoot);
  }

  const target = await resolveSaveDir(context.saveRoot, input.dir);
  if (!target.ok) {
    return errorResult("No artifacts were saved: the target directory is invalid.", [target.error]);
  }

  const downloader = context.downloader ?? httpArtifactDownloader;
  const artifacts: SavedArtifactEntry[] = [];

  // Sequential rather than concurrent: each download streams to disk on its
  // own, and one-at-a-time keeps the collision suffixes deterministic.
  for (const [index, uri] of uris.entries()) {
    artifacts.push(await saveOne(uri, index, target.dir, target.root, client, downloader, context));
  }

  return completedResult(runId, artifacts, target.root);
}

async function saveOne(
  uri: string,
  index: number,
  dir: string,
  root: string,
  client: ArtifactClient,
  downloader: ArtifactDownloader,
  context: ArtifactsContext,
): Promise<SavedArtifactEntry> {
  let resolved: ResolvedStorageUrl;
  try {
    resolved = await client.resolveStorageUrl({ uri });
  } catch (err) {
    return {
      uri,
      error: classifyError(err, {
        ...resolveStorageUrlErrorOptions(index),
        auth: context.authError,
      }),
    };
  }

  const contentType = resolved.content_type ?? null;
  const baseName = artifactFilename(uri, contentType, index);
  const download = await downloader.download(resolved.url, dir, baseName);
  if (!download.ok) {
    return {
      uri,
      content_type: contentType,
      error: { ...download.failure, location: `artifacts[${index}].uri` },
    };
  }

  return {
    uri,
    path: path.relative(root, download.saved.path),
    content_type: contentType,
    size: download.saved.size,
  };
}

// ── the save directory ──────────────────────────────────────────────

type SaveDirResolution = { ok: true; root: string; dir: string } | { ok: false; error: ToolError };

/**
 * Turn the optional relative `dir` into an absolute, existing directory inside
 * the working directory, on REAL paths (symlinks followed) — the write-side
 * mirror of the read resolver's containment rule. The lexical check refuses a
 * `..` escape before anything touches the filesystem; the real-path check on
 * the deepest existing ancestor refuses a symlink inside the workspace that
 * points out of it BEFORE `mkdir` could create directories at its target; a
 * final real-path check on the created directory closes the window between
 * the two. Failures are `input_domain` at `dir` — the caller's value is what
 * escaped.
 */
export async function resolveSaveDir(
  saveRoot: string,
  dir: string | undefined,
): Promise<SaveDirResolution> {
  let root: string;
  try {
    root = await fs.realpath(saveRoot);
  } catch (err) {
    return {
      ok: false,
      error: {
        class: "config",
        location: "deployment",
        message: `Could not resolve the server's working directory: ${errorMessage(err)}`,
        hint: `The local workshop saves files under its working directory (${saveRoot}), which must exist.`,
        retryable: false,
      },
    };
  }

  if (dir === undefined) {
    return { ok: true, root, dir: root };
  }

  const target = path.resolve(root, dir);
  if (!isInside(root, target)) {
    return { ok: false, error: escapeError(dir, root) };
  }

  // Walk up to the deepest EXISTING ancestor and check where it really lives:
  // `mkdir -p root/link/sub` with `link` pointing outside the workspace would
  // otherwise create `sub` at the link's target.
  let probe = target;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isInside(root, real)) {
        return { ok: false, error: escapeError(dir, root) };
      }
      break;
    } catch (err) {
      if (!isMissingPathError(err)) {
        return { ok: false, error: unusableDirError(dir, err) };
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        return { ok: false, error: escapeError(dir, root) };
      }
      probe = parent;
    }
  }

  let real: string;
  try {
    await fs.mkdir(target, { recursive: true });
    real = await fs.realpath(target);
    if (!(await fs.stat(real)).isDirectory()) {
      return {
        ok: false,
        error: {
          class: "input_domain",
          location: "dir",
          message: `dir is not a directory: ${dir}`,
          hint: "Pass a directory (existing or new) relative to the server's working directory.",
          retryable: false,
        },
      };
    }
  } catch (err) {
    return { ok: false, error: unusableDirError(dir, err) };
  }

  if (!isInside(root, real)) {
    return { ok: false, error: escapeError(dir, root) };
  }

  return { ok: true, root, dir: real };
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function escapeError(dir: string, root: string): ToolError {
  return {
    class: "input_domain",
    location: "dir",
    message: `dir resolves outside the server's working directory: ${dir}`,
    hint: `Files are only saved inside the directory the host started this server in (${root}). Pass a relative directory that stays inside it, or omit dir.`,
    retryable: false,
  };
}

function unusableDirError(dir: string, err: unknown): ToolError {
  return {
    class: "input_domain",
    location: "dir",
    message: `Could not use dir ${dir}: ${errorMessage(err)}`,
    hint: "Check that the directory (or the path to create it) is writable and not a file.",
    retryable: false,
  };
}

// ENOENT: the path (or a component) does not exist. ENOTDIR: a component that
// should be a directory is not one — the target equally does not exist there.
function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── the filename ────────────────────────────────────────────────────

/** Longest filename this tool writes, extension included. */
const MAX_FILENAME_LENGTH = 128;

/**
 * The extension to add when the storage key has none and the stored object's
 * content type is one of the artifact types a run produces. Deliberately
 * short: an unknown type simply gets no extension, never a guessed one.
 */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
};

/**
 * The bare filename a storage reference is saved under: the last segment of
 * the storage key, reduced to a conservative character set so it can never
 * name anything but a regular file directly inside the target directory. Path
 * separators are the split point, so no traversal survives; leading dots are
 * stripped, so no hidden file and no `..`; everything outside
 * `[A-Za-z0-9._-]` becomes `_`; an empty result falls back to a numbered
 * `artifact-N`. Length is capped with the extension preserved, and an
 * extension is added from the content type when the key carries none.
 */
export function artifactFilename(
  uri: string,
  contentType: string | null | undefined,
  index: number,
): string {
  const key = uri.startsWith(PIPELEX_STORAGE_SCHEME)
    ? uri.slice(PIPELEX_STORAGE_SCHEME.length)
    : uri;
  const segment =
    (key.split(/[?#]/)[0] ?? "")
      .split(/[\\/]/)
      .filter((part) => part !== "")
      .pop() ?? "";

  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape sequence is kept as typed; sanitization handles it.
  }

  let name = decoded
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");

  if (name === "") {
    name = `artifact-${index + 1}`;
  }

  if (name.length > MAX_FILENAME_LENGTH) {
    const ext = path.extname(name);
    name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }

  if (path.extname(name) === "") {
    const ext =
      contentType == null
        ? undefined
        : EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0]!.trim().toLowerCase()];
    if (ext !== undefined) {
      name += ext;
    }
  }

  return name;
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
