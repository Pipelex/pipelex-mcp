import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

import { CodegenLockError, isStampableArtifactPath, runCodegenCheck } from "@pipelex/sdk";
import type { CodegenDrift, CodegenTreeFile } from "@pipelex/sdk";

import type { ToolError } from "./shared.js";
import {
  checkDeepestExistingAncestor,
  errorMessage,
  isInsideRoot,
  isMissingPathError,
  resolveSaveDir,
} from "./workspace-boundary.js";

/**
 * The generated-tree writer behind `mthds_codegen`'s `output_dir` — the
 * workshop's second write path, and deliberately NOT the first one's policy.
 *
 * `mthds_download_artifacts` never overwrites: its filenames come from a
 * storage key it sanitizes, so a collision means two different files and the
 * safe move is a numeric suffix. This writer is the inverse: its paths come
 * from the engine, the lock hashes them, and regeneration MUST land on the
 * same names — so it overwrites, but only files it can prove are its own
 * (they carry a codegen stamp), and it writes the whole tree or refuses
 * before creating anything. The two share {@link resolveSaveDir}'s
 * containment and nothing above it.
 *
 * Every failure is a returned value, never a throw — the capability turns it
 * into a `ToolError` on the tool result.
 */

// ── the ownership predicate (a mirror of the SDK's internal one) ─────

/**
 * A one-function mirror of `@pipelex/sdk`'s internal `hasStamp`, whose source
 * of truth is `pipelex/pipelex/codegen/stamp.py`. The SDK exports
 * `runCodegenCheck`, `isStampableArtifactPath` and `STAMPABLE_ARTIFACT_SUFFIXES`
 * but keeps the marker and the comment-prefix table private, and this writer
 * needs the predicate BEFORE it writes — the check answers "does this tree
 * agree with its lock", not "may I overwrite this file". Kept to one function
 * so the swap is one line once the SDK exports it.
 */
const STAMP_BEGIN_MARKER = ">>> pipelex-codegen-stamp >>>";
const COMMENT_PREFIX_BY_SUFFIX: Record<string, string> = { ".py": "#", ".ts": "//" };

export function hasCodegenStamp(filePath: string, text: string): boolean {
  const prefix = COMMENT_PREFIX_BY_SUFFIX[path.extname(filePath).toLowerCase()];
  return prefix !== undefined && text.startsWith(`${prefix} ${STAMP_BEGIN_MARKER}`);
}

/**
 * The lock's ownership test. The engine writes
 * `# codegen.lock — generated artifact set (Pipelex codegen). Do not edit by
 * hand.` (`pipelex/pipelex/codegen/lock.py`, `_LOCK_HEADER`), but everything
 * after the filename token is prose the SDK's TOML reader ignores entirely —
 * its `LOCK_KEYS` are `lock_version`, `crate_fingerprint`, `engine_version`
 * and `artifacts`. Pinning the full sentence would therefore make a reworded
 * header turn every regeneration into a "foreign file" refusal on a file this
 * tool wrote itself. The prefix carries the comment marker and the filename
 * token, which is all the discrimination this test needs.
 */
const LOCK_OWNERSHIP_PREFIX = "# codegen.lock";

export function isCodegenLock(text: string): boolean {
  return text.startsWith(LOCK_OWNERSHIP_PREFIX);
}

// ── walk bounds ─────────────────────────────────────────────────────

/**
 * `output_dir: "."` is legal — {@link isInsideRoot} is true for the root
 * itself — so the post-write walk must not be free to read a whole repository
 * into memory: `runCodegenCheck` takes every file's text as a `string`, and
 * this is a stdio server the host keeps alive for the session. The byte
 * budget is spent from each candidate's size before it is read, so one huge
 * file is refused rather than loaded. The bounds apply to ORPHAN CANDIDATES
 * only; the files just written are always read
 * back, so tripping a bound can never fabricate a `missing` drift. Tripping
 * either sets `orphansTruncated`, and the summary then says orphan detection
 * was partial rather than reporting a clean tree it did not fully see.
 */
export const MAX_WALK_CANDIDATES = 400;
export const MAX_WALK_BYTES = 4 * 1024 * 1024;

/** Directories a misaimed `output_dir` would otherwise drag in wholesale. */
const PRUNED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "__pycache__",
]);

/** Enough to hold either ownership marker; a foreign file is never read whole. */
const HEAD_BYTES = 512;

// ── the writer ──────────────────────────────────────────────────────

export interface CodegenWriteRequest {
  /** The workshop's working directory, absolute — the containment root. */
  root: string;
  /** The caller's `output_dir`, relative to `root`. */
  outputDir: string;
  artifacts: readonly { path: string; content: string }[];
  lock: string;
  lockFilename: string;
}

export interface WrittenArtifact {
  /** The artifact's path as the engine named it, relative to the generated directory. */
  path: string;
  bytes: number;
  /** Where it landed, relative to the working directory. */
  writtenTo: string;
}

export interface WrittenLock {
  filename: string;
  bytes: number;
  writtenTo: string;
}

export interface CodegenWriteSuccess {
  ok: true;
  /** The generated directory, relative to the working directory. */
  dir: string;
  written: WrittenArtifact[];
  lock: WrittenLock;
  /** The offline check's verdict over what actually landed on disk. */
  isCurrent: boolean;
  /** Stamped files in the directory the new lock does not track. Always present; empty when clean. */
  orphans: string[];
  /** True when a walk bound stopped orphan detection short of the whole directory. */
  orphansTruncated: boolean;
  /** Every drift that is not an orphan — a writer defect if it is ever non-empty. */
  drifts: CodegenDrift[];
}

export type CodegenWriteResult = CodegenWriteSuccess | { ok: false; error: ToolError };

const DEDICATED_DIRECTORY_HINT =
  "Point output_dir at a dedicated generated directory such as `src/generated/<method>/` — this tool overwrites only files carrying a codegen stamp and the codegen.lock beside them, so it refuses rather than touch anything else.";

const utf8 = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export async function writeCodegenTree(request: CodegenWriteRequest): Promise<CodegenWriteResult> {
  // 1. Contain the directory. This is the one call that creates anything, and
  //    it creates only `output_dir` itself.
  const target = await resolveSaveDir(request.root, request.outputDir, "output_dir");
  if (!target.ok) {
    return { ok: false, error: target.error };
  }
  const { root, dir } = target;

  // 2. Contain every destination, creating nothing. Separating containment
  //    from creation is what lets step 3 refuse with the tree byte-identical,
  //    directories included.
  const destinations: {
    relative: string;
    absolute: string;
    content: string;
    isLock: boolean;
  }[] = [];
  for (const artifact of request.artifacts) {
    const contained = containedDestination(dir, artifact.path);
    if (contained === undefined) {
      return { ok: false, error: escapedArtifactError(artifact.path) };
    }
    destinations.push({
      relative: artifact.path,
      absolute: contained,
      content: artifact.content,
      isLock: false,
    });
  }
  const lockDestination = containedDestination(dir, request.lockFilename);
  if (lockDestination === undefined) {
    return { ok: false, error: escapedArtifactError(request.lockFilename) };
  }
  destinations.push({
    relative: request.lockFilename,
    absolute: lockDestination,
    content: request.lock,
    isLock: true,
  });

  // 3. Inspect every existing destination BEFORE anything is created or
  //    written. `lstat`, not `stat`: an overwrite through a symlink writes
  //    wherever it points, so a symlink is foreign by construction.
  for (const destination of destinations) {
    const inspection = await inspectDestination(destination.absolute, destination.isLock);
    if (inspection.kind === "error") {
      return { ok: false, error: inspection.error };
    }
    if (inspection.kind === "foreign") {
      return {
        ok: false,
        error: foreignFileError(path.relative(root, destination.absolute), inspection.reason),
      };
    }
  }

  // 4. Create the sub-directories step 2 contained, then write — verbatim,
  //    with the default overwriting flag, deliberately the inverse of
  //    `openUniqueFile`'s `wx`.
  const written: WrittenArtifact[] = [];
  const landed: string[] = [];
  for (const destination of destinations) {
    const content = destination.content;
    const parent = path.dirname(destination.absolute);
    if (parent !== dir) {
      const created = await createSubdirectory(dir, parent);
      if (created !== undefined) {
        return { ok: false, error: midWriteError(created, landed) };
      }
    }
    try {
      await fs.writeFile(destination.absolute, content, "utf8");
    } catch (err) {
      return { ok: false, error: midWriteError(errorMessage(err), landed) };
    }
    landed.push(destination.relative);
    if (!destination.isLock) {
      written.push({
        path: destination.relative,
        bytes: utf8.encode(content).length,
        writtenTo: path.relative(root, destination.absolute),
      });
    }
  }

  // 5. Check what landed, against what landed — the lock re-read from disk
  //    with the same strict decoder, not the copy we meant to write.
  const verification = await verifyWrittenTree(dir, request.lockFilename, written);
  if (!verification.ok) {
    return { ok: false, error: verification.error };
  }

  return {
    ok: true,
    dir: path.relative(root, dir) === "" ? "." : path.relative(root, dir),
    written,
    lock: {
      filename: request.lockFilename,
      bytes: utf8.encode(request.lock).length,
      writtenTo: path.relative(root, lockDestination),
    },
    isCurrent: verification.report.isCurrent,
    orphans: verification.report.drifts
      .filter((drift) => drift.category === "orphan")
      .map((drift) => drift.path),
    orphansTruncated: verification.orphansTruncated,
    drifts: verification.report.drifts.filter((drift) => drift.category !== "orphan"),
  };
}

/** The joined destination when it stays inside `dir`; `undefined` when it escapes. */
function containedDestination(dir: string, relative: string): string | undefined {
  const absolute = path.resolve(dir, relative);
  return isInsideRoot(dir, absolute) && absolute !== dir ? absolute : undefined;
}

type Inspection =
  | { kind: "missing" }
  | { kind: "owned" }
  | { kind: "foreign"; reason: string }
  | { kind: "error"; error: ToolError };

async function inspectDestination(absolute: string, isLock: boolean): Promise<Inspection> {
  let stats: Stats;
  try {
    stats = await fs.lstat(absolute);
  } catch (err) {
    if (isMissingPathError(err)) {
      return { kind: "missing" };
    }
    return {
      kind: "error",
      error: {
        class: "runtime",
        message: `Could not inspect the existing file at ${absolute}: ${errorMessage(err)}`,
        hint: "Check the generated directory's permissions, then call again with the same output_dir.",
        retryable: true,
      },
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      kind: "foreign",
      reason: "it is a symlink, and writing through it would write outside the generated directory",
    };
  }
  if (!stats.isFile()) {
    return { kind: "foreign", reason: "it is not a regular file" };
  }

  const head = await readHead(absolute);
  if (head === undefined) {
    return {
      kind: "error",
      error: {
        class: "runtime",
        message: `Could not read the existing file at ${absolute}.`,
        hint: "Check the generated directory's permissions, then call again with the same output_dir.",
        retryable: true,
      },
    };
  }

  const owned = isLock ? isCodegenLock(head) : hasCodegenStamp(absolute, head);
  return owned
    ? { kind: "owned" }
    : {
        kind: "foreign",
        reason: isLock
          ? "it does not open with the `# codegen.lock` header, so it is not a lock this tool wrote"
          : "it carries no codegen stamp, so it was not generated by this tool",
      };
}

/**
 * Only the head is read: a foreign file must never be loaded whole just to be
 * refused. Decoded leniently on purpose — the comparison is a prefix match, so
 * a binary file simply fails to match rather than raising.
 */
async function readHead(absolute: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(absolute, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Create an artifact's sub-directory, contained on real paths BEFORE anything
 * is created and again after: `mkdir -p` through a symlinked component inside
 * the generated directory would otherwise create the missing levels at the
 * link's target, and a check that ran only afterwards would refuse a write
 * that had already put directories outside the workspace. That is the same
 * deepest-existing-ancestor rule `resolveSaveDir` applies to `output_dir`
 * itself, which is why both call the one routine in `workspace-boundary.ts`.
 *
 * Returns a message on failure, `undefined` on success. No target emits a
 * nested artifact today; this is what keeps that safe if one starts to.
 */
async function createSubdirectory(dir: string, parent: string): Promise<string | undefined> {
  const escaped = `the artifact's directory ${path.relative(dir, parent)} resolves outside the generated directory`;

  const ancestor = await checkDeepestExistingAncestor(dir, parent);
  if (!ancestor.ok) {
    return ancestor.reason === "escape" ? escaped : errorMessage(ancestor.err);
  }

  try {
    await fs.mkdir(parent, { recursive: true });
    // Closes the window between the check and the creation.
    const real = await fs.realpath(parent);
    if (!isInsideRoot(dir, real)) {
      return escaped;
    }
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

// ── the post-write check ────────────────────────────────────────────

type Verification =
  | { ok: true; report: Awaited<ReturnType<typeof runCodegenCheck>>; orphansTruncated: boolean }
  | { ok: false; error: ToolError };

async function verifyWrittenTree(
  dir: string,
  lockFilename: string,
  written: readonly WrittenArtifact[],
): Promise<Verification> {
  const locked = new Set(written.map((artifact) => artifact.path));

  const files: CodegenTreeFile[] = [];
  // The locked files are read back unconditionally, outside the walk bounds:
  // omitting one would report it `missing` though it sits on disk, which would
  // turn a bound into a fabricated drift instead of a partial orphan verdict.
  for (const artifact of written) {
    const text = await readStrict(path.join(dir, artifact.path));
    if (text === undefined) {
      return { ok: false, error: undecodableError(artifact.path) };
    }
    files.push({ path: artifact.path, content: text });
  }

  const walk = await collectOrphanCandidates(dir, locked, lockFilename);
  if (!walk.ok) {
    return { ok: false, error: walk.error };
  }
  files.push(...walk.files);

  const lockContent = await readStrict(path.join(dir, lockFilename));
  if (lockContent === undefined) {
    return { ok: false, error: undecodableError(lockFilename) };
  }

  try {
    const report = await runCodegenCheck({ lockContent, files });
    return { ok: true, report, orphansTruncated: walk.truncated };
  } catch (err) {
    if (err instanceof CodegenLockError) {
      return {
        ok: false,
        error: {
          class: "runtime",
          message: `The generated tree was written but its lock could not be read back: ${err.message}`,
          hint: "The files are on disk under output_dir; verify them with `pipelex codegen check` before committing them.",
          retryable: false,
        },
      };
    }
    return {
      ok: false,
      error: {
        class: "runtime",
        message: `The generated tree was written but could not be checked: ${errorMessage(err)}`,
        hint: "The files are on disk under output_dir; verify them with `pipelex codegen check` before committing them.",
        retryable: false,
      },
    };
  }
}

type WalkResult =
  | { ok: true; files: CodegenTreeFile[]; truncated: boolean }
  | { ok: false; error: ToolError };

/**
 * Walk the generated directory for stampable files the lock does not track —
 * the orphan candidates. Symlinks are skipped (a walk that followed them would
 * read outside the directory) and vendor/VCS directories are pruned, under the
 * two bounds above.
 */
async function collectOrphanCandidates(
  dir: string,
  locked: ReadonlySet<string>,
  lockFilename: string,
): Promise<WalkResult> {
  const files: CodegenTreeFile[] = [];
  let bytes = 0;
  let truncated = false;

  const visit = async (current: string): Promise<ToolError | undefined> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (isMissingPathError(err)) {
        return undefined;
      }
      return {
        class: "runtime",
        message: `Could not read the generated directory: ${errorMessage(err)}`,
        hint: "The files are on disk under output_dir; verify them with `pipelex codegen check`.",
        retryable: true,
      };
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) {
        return undefined;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (PRUNED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        const failure = await visit(absolute);
        if (failure !== undefined) {
          return failure;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relative = toPosix(path.relative(dir, absolute));
      if (relative === lockFilename || locked.has(relative)) {
        continue;
      }
      if (!isStampableArtifactPath(relative)) {
        continue;
      }
      if (files.length >= MAX_WALK_CANDIDATES) {
        truncated = true;
        return undefined;
      }

      // The budget is spent from the file's SIZE, before it is read: reading
      // first would decode a single enormous file whole into memory just to
      // refuse it, which is the allocation the bound exists to prevent. A file
      // that cannot be stat'ed falls back to the post-read check below.
      const size = await fileSize(absolute);
      if (size !== undefined && bytes + size > MAX_WALK_BYTES) {
        truncated = true;
        return undefined;
      }

      const text = await readStrict(absolute);
      if (text === undefined) {
        return undecodableError(relative);
      }
      bytes += size ?? utf8.encode(text).length;
      if (bytes > MAX_WALK_BYTES) {
        truncated = true;
        return undefined;
      }
      files.push({ path: relative, content: text });
    }
    return undefined;
  };

  const failure = await visit(dir);
  return failure === undefined ? { ok: true, files, truncated } : { ok: false, error: failure };
}

/**
 * The SDK's stated caller obligation: `readFile(p, "utf8")` substitutes U+FFFD
 * for invalid bytes and never throws, so a corrupted artifact could hash to
 * the locked value and report current. Decode strictly and report what cannot
 * be decoded.
 */
async function readStrict(absolute: string): Promise<string | undefined> {
  try {
    return strictDecoder.decode(await fs.readFile(absolute));
  } catch {
    return undefined;
  }
}

/** The file's size in bytes, or `undefined` when it cannot be stat'ed. */
async function fileSize(absolute: string): Promise<number | undefined> {
  try {
    return (await fs.stat(absolute)).size;
  } catch {
    return undefined;
  }
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

// ── error values ────────────────────────────────────────────────────

function escapedArtifactError(artifactPath: string): ToolError {
  return {
    class: "runtime",
    message: `The Pipelex API returned an artifact path that leaves the generated directory: ${artifactPath}`,
    hint: "Nothing was written. This is a contract violation on the API side; inspect pipelex-api logs.",
    retryable: false,
  };
}

function foreignFileError(relative: string, reason: string): ToolError {
  return {
    class: "input_domain",
    location: "output_dir",
    message: `output_dir already holds \`${relative}\`, which this tool does not own: ${reason}. Nothing was written.`,
    hint: DEDICATED_DIRECTORY_HINT,
    retryable: false,
  };
}

function midWriteError(detail: string, landed: readonly string[]): ToolError {
  const written =
    landed.length === 0
      ? "Nothing was written."
      : `Written before the failure: ${landed.map((file) => `\`${file}\``).join(", ")}.`;
  return {
    class: "runtime",
    message: `The generated tree could not be written: ${detail}. ${written}`,
    hint: "Call again with the same output_dir — regeneration overwrites its own files, so the retry finds the stamped files it left and proceeds.",
    retryable: true,
  };
}

function undecodableError(relative: string): ToolError {
  return {
    class: "runtime",
    message: `\`${relative}\` in the generated directory is not valid UTF-8, so the tree could not be checked.`,
    hint: "The offline check hashes exact UTF-8 bytes; a file that cannot be decoded cannot be verified. Remove or fix that file, or point output_dir at a dedicated generated directory.",
    retryable: false,
  };
}
