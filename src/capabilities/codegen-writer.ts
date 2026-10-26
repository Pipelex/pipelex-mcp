import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

import {
  buildProblem,
  isProblemError,
  isStampableArtifactPath,
  runCodegenCheck,
} from "@pipelex/sdk";
import type { CodegenDrift, CodegenTreeFile, Problem } from "@pipelex/sdk";

import { PRUNED_DIRECTORIES, asOneLine, problemOf } from "./shared.js";
import {
  containedPath,
  createContainedSubdirectory,
  errorMessage,
  isMissingPathError,
  resolveSaveDir,
} from "./workspace-boundary.js";

/**
 * The generated-tree writer behind `mthds_codegen`'s `output_dir` — the
 * workshop's second write path, and deliberately NOT the first one's policy.
 *
 * `mthds_download_artifacts` never overwrites: the SDK names each file after
 * the output field it fills (the storage key supplies only the extension), so
 * a name already taken belongs to another file — another field that reduces
 * to the same name, or another run saved into the same directory — and the
 * safe move is a numeric suffix. This writer is the inverse: its paths come
 * from the engine, the lock hashes them, and regeneration MUST land on the
 * same names — so it overwrites, but only files it can prove are its own
 * (they carry a codegen stamp), and it writes the whole tree or refuses
 * before creating anything. The two share {@link resolveSaveDir}'s
 * containment and nothing above it.
 *
 * Every failure is a returned value, never a throw: a problem, built with a
 * core client code (`client.target_exists`, `client.write_failed`,
 * `client.file_unreadable`) or read from the SDK, which the capability puts
 * on the tool result. Each carries the writer's own sentence as its
 * `message`, saying what is on disk.
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
 * `output_dir: "."` is legal — `isInsideRoot` is true for the root
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

export type CodegenWriteResult = CodegenWriteSuccess | { ok: false; problem: Problem };

const DEDICATED_DIRECTORY_HINT =
  "Point output_dir at a dedicated generated directory such as `src/generated/<method>/` — this tool overwrites only files carrying a codegen stamp and the codegen.lock beside them, so it refuses rather than touch anything else.";

const utf8 = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export async function writeCodegenTree(request: CodegenWriteRequest): Promise<CodegenWriteResult> {
  // 1. Contain the directory. This is the one call that creates it, and it
  //    creates only `output_dir` itself; an artifact's missing parents are
  //    created at write time, in step 4.
  const target = await resolveSaveDir(request.root, request.outputDir, "output_dir");
  if (!target.ok) {
    return { ok: false, problem: target.problem };
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
    const contained = containedPath(dir, artifact.path);
    if (contained === undefined) {
      return { ok: false, problem: escapedArtifactError(artifact.path) };
    }
    destinations.push({
      relative: artifact.path,
      absolute: contained,
      content: artifact.content,
      isLock: false,
    });
  }
  const lockDestination = containedPath(dir, request.lockFilename);
  if (lockDestination === undefined) {
    return { ok: false, problem: escapedArtifactError(request.lockFilename) };
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
    const shown = path.relative(root, destination.absolute);
    const inspection = await inspectDestination(destination.absolute, shown, destination.isLock);
    if (inspection.outcome === "error") {
      return { ok: false, problem: inspection.problem };
    }
    if (inspection.outcome === "foreign") {
      return { ok: false, problem: foreignFileError(shown, inspection.reason) };
    }
  }

  // 4. Create the sub-directories step 2 contained, then write — verbatim,
  //    with the default overwriting flag, deliberately the inverse of the
  //    exclusive `wx` create the SDK's `downloadArtifacts` uses for
  //    mthds_download_artifacts.
  const written: WrittenArtifact[] = [];
  const landed: string[] = [];
  for (const destination of destinations) {
    const content = destination.content;
    const parent = path.dirname(destination.absolute);
    if (parent !== dir) {
      const created = await createSubdirectory(dir, parent);
      if (created !== undefined) {
        return {
          ok: false,
          problem: midWriteError(path.relative(root, parent), "mkdir_failed", created, landed),
        };
      }
    }
    try {
      await fs.writeFile(destination.absolute, content, "utf8");
    } catch (err) {
      return {
        ok: false,
        problem: midWriteError(
          path.relative(root, destination.absolute),
          systemReason(err),
          errorMessage(err),
          landed,
        ),
      };
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
  const verification = await verifyWrittenTree(root, dir, request.lockFilename, written);
  if (!verification.ok) {
    return { ok: false, problem: verification.problem };
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

type Inspection =
  | { outcome: "missing" }
  | { outcome: "owned" }
  | { outcome: "foreign"; reason: string }
  | { outcome: "error"; problem: Problem };

/** `shown` is the destination as the caller finds it: its path from the working directory. */
async function inspectDestination(
  absolute: string,
  shown: string,
  isLock: boolean,
): Promise<Inspection> {
  let stats: Stats;
  try {
    stats = await fs.lstat(absolute);
  } catch (err) {
    if (isMissingPathError(err)) {
      return { outcome: "missing" };
    }
    return {
      outcome: "error",
      problem: unreadableError(
        shown,
        systemReason(err),
        `Could not inspect the existing file at ${absolute}: ${errorMessage(err)}. Nothing was written. Check the generated directory's permissions, then call again with the same output_dir.`,
      ),
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      outcome: "foreign",
      reason: "it is a symlink, and writing through it would write outside the generated directory",
    };
  }
  if (!stats.isFile()) {
    return { outcome: "foreign", reason: "it is not a regular file" };
  }

  const head = await readHead(absolute);
  if (head === undefined) {
    return {
      outcome: "error",
      problem: unreadableError(
        shown,
        "unreadable",
        `Could not read the existing file at ${absolute}. Nothing was written. Check the generated directory's permissions, then call again with the same output_dir.`,
      ),
    };
  }

  const owned = isLock ? isCodegenLock(head) : hasCodegenStamp(absolute, head);
  return owned
    ? { outcome: "owned" }
    : {
        outcome: "foreign",
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
 * Create an artifact's sub-directory through `workspace-boundary.ts`, which
 * contains it on real paths before and after the `mkdir`. No target emits a
 * nested artifact today; this is what keeps that safe if one starts to.
 */
function createSubdirectory(dir: string, parent: string): Promise<string | undefined> {
  return createContainedSubdirectory(
    dir,
    parent,
    `the artifact's directory ${path.relative(dir, parent)} resolves outside the generated directory`,
  );
}

// ── the post-write check ────────────────────────────────────────────

type Verification =
  | { ok: true; report: Awaited<ReturnType<typeof runCodegenCheck>>; orphansTruncated: boolean }
  | { ok: false; problem: Problem };

async function verifyWrittenTree(
  root: string,
  dir: string,
  lockFilename: string,
  written: readonly WrittenArtifact[],
): Promise<Verification> {
  const shown = (relative: string) => path.relative(root, path.join(dir, relative));
  const locked = new Set(written.map((artifact) => artifact.path));

  const files: CodegenTreeFile[] = [];
  // The locked files are read back unconditionally, outside the walk bounds:
  // omitting one would report it `missing` though it sits on disk, which would
  // turn a bound into a fabricated drift instead of a partial orphan verdict.
  for (const artifact of written) {
    const text = await readStrict(path.join(dir, artifact.path));
    if (text === undefined) {
      return { ok: false, problem: undecodableError(artifact.path, shown(artifact.path)) };
    }
    files.push({ path: artifact.path, content: text });
  }

  const walk = await collectOrphanCandidates(root, dir, locked, lockFilename);
  if (!walk.ok) {
    return { ok: false, problem: walk.problem };
  }
  files.push(...walk.files);

  const lockContent = await readStrict(path.join(dir, lockFilename));
  if (lockContent === undefined) {
    return { ok: false, problem: undecodableError(lockFilename, shown(lockFilename)) };
  }

  try {
    const report = await runCodegenCheck({ lockContent, files });
    return { ok: true, report, orphansTruncated: walk.truncated };
  } catch (err) {
    // The SDK's own problem when it raised one (`CodegenLockError` is
    // `client.file_unreadable` naming the lock), with the writer's sentence
    // saying the files are on disk.
    return {
      ok: false,
      problem: withWriterMessage(
        problemOf(err),
        isProblemError(err)
          ? `The generated tree was written but its lock could not be read back: ${err.message} The files are on disk under output_dir; verify them with \`pipelex codegen check\` before committing them.`
          : `The generated tree was written but could not be checked: ${errorMessage(err)} The files are on disk under output_dir; verify them with \`pipelex codegen check\` before committing them.`,
      ),
    };
  }
}

type WalkResult =
  | { ok: true; files: CodegenTreeFile[]; truncated: boolean }
  | { ok: false; problem: Problem };

/**
 * Walk the generated directory for stampable files the lock does not track —
 * the orphan candidates. Symlinks are skipped (a walk that followed them would
 * read outside the directory) and vendor/VCS directories are pruned, under the
 * two bounds above.
 */
async function collectOrphanCandidates(
  root: string,
  dir: string,
  locked: ReadonlySet<string>,
  lockFilename: string,
): Promise<WalkResult> {
  const files: CodegenTreeFile[] = [];
  let bytes = 0;
  let truncated = false;

  const visit = async (current: string): Promise<Problem | undefined> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (isMissingPathError(err)) {
        return undefined;
      }
      return unreadableError(
        path.relative(root, current) || ".",
        systemReason(err),
        `Could not read the generated directory: ${errorMessage(err)}. The files are on disk under output_dir; verify them with \`pipelex codegen check\`.`,
      );
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
        return undecodableError(relative, path.relative(root, absolute));
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
  return failure === undefined ? { ok: true, files, truncated } : { ok: false, problem: failure };
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

// ── the writer's problems ───────────────────────────────────────────

/** Why a filesystem call failed, as the system's error code (`EACCES`, …), or `failed`. */
function systemReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code !== "" ? code : "failed";
}

/**
 * A problem with the writer's sentence as its `message`, on one line, unless
 * it carries a message of its own that the sentence does not already quote:
 * the writer's sentence quotes the error's, which `problemOf` relays as the
 * message of a problem that has none.
 */
function withWriterMessage(problem: Problem, message: string): Problem {
  const sentence = asOneLine(message);
  const own = problem.message;
  return typeof own === "string" && own !== "" && !sentence.includes(own)
    ? problem
    : { ...problem, message: sentence };
}

/**
 * An artifact path the API returned that leaves the generated directory: the
 * API broke its own contract in a `200`, so its answer cannot be used,
 * `client.response_unreadable`, and nothing the caller passed is at fault.
 */
function escapedArtifactError(artifactPath: string): Problem {
  return buildProblem(
    "client.response_unreadable",
    { status: 200 },
    {
      extra: {
        message: `The Pipelex API returned an artifact path that leaves the generated directory: ${artifactPath}. Nothing was written. This is a contract violation on the API side; inspect pipelex-api logs.`,
      },
    },
  );
}

/** A file in `output_dir` this tool does not own: `client.target_exists`, located at `output_dir`. */
function foreignFileError(relative: string, reason: string): Problem {
  return buildProblem(
    "client.target_exists",
    { path: relative },
    {
      location: { field: "output_dir" },
      extra: {
        message: `output_dir already holds \`${relative}\`, which this tool does not own: ${reason}. Nothing was written. ${DEDICATED_DIRECTORY_HINT}`,
      },
    },
  );
}

/** A write that failed part-way: `client.write_failed` at the path it could not write, naming what landed. */
function midWriteError(
  relative: string,
  reason: string,
  detail: string,
  landed: readonly string[],
): Problem {
  const written =
    landed.length === 0
      ? "Nothing was written."
      : `Written before the failure: ${landed.map((file) => `\`${file}\``).join(", ")}.`;
  return buildProblem(
    "client.write_failed",
    { path: relative, reason },
    {
      location: { field: "output_dir" },
      extra: {
        message: `The generated tree could not be written: ${detail}. ${written} Call again with the same output_dir — regeneration overwrites its own files, so the retry finds the stamped files it left and proceeds.`,
      },
    },
  );
}

/** A file of the generated directory that could not be read: `client.file_unreadable`. */
function unreadableError(relative: string, reason: string, message: string): Problem {
  return buildProblem(
    "client.file_unreadable",
    { path: relative, reason },
    { location: { field: "output_dir" }, extra: { message } },
  );
}

function undecodableError(relative: string, shown: string): Problem {
  return unreadableError(
    shown,
    "not_utf8",
    `\`${relative}\` in the generated directory is not valid UTF-8, so the tree could not be checked. The generated files are on disk under output_dir, but the tree could not be confirmed current. The offline check hashes exact UTF-8 bytes, so a file that cannot be decoded cannot be verified: remove or fix that file, or point output_dir at a dedicated generated directory, then verify with \`pipelex codegen check\`.`,
  );
}
