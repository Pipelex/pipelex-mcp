import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { errorMessage, isMissingPathError } from "./workspace-boundary.js";

/**
 * `pipelex-method.json` — the file that makes a directory *this* saved method,
 * written by `mthds_save_method` and `mthds_get_method` and by nobody else.
 *
 * It is meant to be COMMITTED. A team shares an organization, so the link is
 * what lets the second person update the method the first one saved instead of
 * creating a second one under the same name; an id grants nothing without the
 * organization's key, which is why committing it is safe.
 *
 * The workshop writes it because the workshop is the only party that knows
 * which API host it is talking to. That is also what makes an unknown id
 * diagnosable later: a link made against one plane, or with another
 * organization's key, reports the host it recorded rather than reading as a
 * method that vanished.
 *
 * It records NO source hashes, deliberately, and the cost is stated rather
 * than hidden — see `planPull` in `catalog-write.ts`, whose three-outcome
 * rule can tell "the draft moved" from "this directory moved" only by the
 * recorded `synced_updated_at`, and so cannot say which side a difference came
 * from once both have moved.
 *
 * What it does record is which content the directory was last synced with:
 * the method's draft (no `synced_version`), or one of its published versions
 * (`synced_version`), which a pull of `mt_…@<n>` writes. A later pull reads a
 * file still holding that version's bytes as stored, not as unsaved work.
 *
 * **Every write of it is a compare-and-swap on its own bytes**
 * ({@link replaceMethodLink}): a save or a pull decides what to write from the
 * link it read, and writes only while the file still holds exactly those
 * bytes. A link another call wrote meanwhile describes what THAT call put in
 * the directory, so it is left as it is and the result says so. That is what
 * keeps the link truthful when two calls touch one directory, in this process
 * ({@link inLinkTurn}) or in another workshop process ({@link withLinkLock}).
 */

export const LINK_FILE_NAME = "pipelex-method.json";

const LINK_COMMENT =
  "Written by the Pipelex workshop (@pipelex/mcp). This directory is saved on Pipelex as the method below. " +
  "Commit this file so that a teammate updates the same method instead of creating a second one. Do not hand-edit it.";

const LINK_GENERATOR = "pipelex-mcp";

export interface MethodLink {
  comment: string;
  generator: string;
  api_host: string;
  method_id: string;
  name: string;
  /**
   * The method's draft token — its `updated_at`, which moves on every draft
   * write and on nothing else — as of the last save or pull through this
   * directory. A save sends it as `expected_updated_at`, so the platform
   * refuses to replace a draft that moved since.
   */
  synced_updated_at: string;
  /**
   * The published version whose files the last pull wrote here, when it pulled
   * `mt_…@<n>` rather than the draft. Absent after a save and after a pull of
   * the draft, since the directory then holds the draft.
   */
  synced_version?: number;
  /**
   * Set while a pull is landing files, cleared when it finishes.
   *
   * A pull writes several files and can fail between two of them. Without this
   * the half-written directory holds `.mthds` files and no link, which the
   * ownership guard reads as somebody else's bundle — so the retry the failure
   * advertises is refused and the caller has nowhere to go. The marker says
   * "these files are an interrupted pull of this same method", which is the one
   * state where writing over them destroys nothing the catalog does not hold.
   */
  partial_pull?: boolean;
}

export interface LinkFileReport {
  /** Where the link went, relative to the working directory. */
  path: string;
  written: boolean;
  reason?: string;
}

export function buildMethodLink(fields: {
  apiHost: string;
  methodId: string;
  name: string;
  syncedUpdatedAt: string;
  syncedVersion?: number;
  partialPull?: boolean;
}): MethodLink {
  return {
    comment: LINK_COMMENT,
    generator: LINK_GENERATOR,
    api_host: fields.apiHost,
    method_id: fields.methodId,
    name: fields.name,
    synced_updated_at: fields.syncedUpdatedAt,
    ...(fields.syncedVersion === undefined ? {} : { synced_version: fields.syncedVersion }),
    ...(fields.partialPull === true ? { partial_pull: true } : {}),
  };
}

/**
 * The host of the configured base URL, which is what the link records — not the
 * whole URL, because the port and path are deployment detail and the host is
 * the part that tells a reader which plane an id belongs to. An unparseable
 * base URL yields the raw string: a link that records something odd is more
 * useful than one that records nothing.
 */
export function apiHostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Write the link file, reporting failure as a value.
 *
 * A failed write NEVER fails the save. The method is already stored by then,
 * and answering `status: "error"` would tell the caller their save did not
 * happen — the one thing that is certainly untrue. So the failure is reported
 * in `link_file` with its reason, and the summary says the directory is not
 * linked, which is the consequence the caller has to act on: the next save
 * would create a second method unless they pass the id.
 */
async function writeMethodLink(
  root: string,
  dir: string,
  link: MethodLink,
): Promise<LinkFileReport> {
  const absolute = path.join(dir, LINK_FILE_NAME);
  const relative = path.relative(root, absolute);
  // Containing the DIRECTORY does not contain the leaf: a `pipelex-method.json`
  // that is already a symlink sends this write wherever it points, which on the
  // save path replaces a file the user owns with link JSON. The refusal lives
  // here rather than at either call site so both inherit it.
  const foreign = await foreignEntryReason(absolute);
  if (foreign !== undefined) {
    return { path: relative, written: false, reason: foreign };
  }
  try {
    await fs.writeFile(absolute, serializeMethodLink(link), "utf8");
    return { path: relative, written: true };
  } catch (err) {
    return { path: relative, written: false, reason: errorMessage(err) };
  }
}

/** The link file's bytes, exactly as {@link writeMethodLink} writes them. */
function serializeMethodLink(link: MethodLink): string {
  return `${JSON.stringify(link, null, 2)}\n`;
}

/** A link file this call wrote, as a later compare-and-swap expects to find it. */
export function linkAsWritten(link: MethodLink): LinkRead {
  return { kind: "link", link, raw: serializeMethodLink(link) };
}

/** The read of a directory holding no link file. */
export const NO_LINK: LinkRead = { kind: "none" };

/** What a compare-and-swap of the link file did. */
export interface LinkReplacement {
  report: LinkFileReport;
  /**
   * The write was refused because the file no longer held what the caller
   * read: another save or pull wrote it meanwhile, so it describes what that
   * call put in the directory, or it was removed or became unreadable. It was
   * left as it is.
   */
  changed: boolean;
  /** What the file holds after a write this call made; absent when it made none. */
  wrote?: LinkRead;
}

/**
 * Write the link file only while it still holds exactly what `expected` read
 * — a compare-and-swap on the file's own bytes.
 *
 * A save and a pull each decide what to write from the link they read: a save
 * records the token its bytes were sent under, and a pull records which
 * content it landed. A link another call wrote between that read and this
 * write describes the directory as THAT call left it — a version pulled over
 * the files, an interrupted pull, another save's token — and writing over it
 * would make the link say something about the directory that this call does
 * not know to be true. So the write is refused, nothing is lost, and the
 * caller reports it.
 *
 * A link that cannot be read is never written over, whatever was expected:
 * something claims the directory, and following it would be guesswork. One
 * that BECAME unreadable after the caller read it is a change like any other,
 * reported as such — a merge conflict landing in the file mid-call is the
 * usual cause — so a caller that refuses on a change refuses on it too.
 *
 * Call it inside {@link inLinkTurn} and {@link withLinkLock}, which make the
 * compare and the write one step for every call in this process and in every
 * other workshop process on this machine.
 */
export async function replaceMethodLink(
  root: string,
  dir: string,
  expected: LinkRead,
  link: MethodLink,
): Promise<LinkReplacement> {
  const relative = path.relative(root, path.join(dir, LINK_FILE_NAME));
  const current = await readMethodLink(dir);
  if (!sameLinkRead(expected, current)) {
    return {
      report: {
        path: relative,
        written: false,
        reason:
          current.kind === "none"
            ? "it was removed while this call ran, so it was not recreated"
            : current.kind === "unreadable"
              ? `it became unreadable while this call ran (${current.reason}), and overwriting it would destroy whatever it holds`
              : "another save or pull rewrote it while this call ran, so it was left as that one wrote it",
      },
      changed: true,
    };
  }
  if (current.kind === "unreadable") {
    return {
      report: {
        path: relative,
        written: false,
        reason: `it is there but cannot be read (${current.reason}), and overwriting it would destroy whatever it holds`,
      },
      changed: false,
    };
  }
  const report = await writeMethodLink(root, dir, link);
  return report.written
    ? { report, changed: false, wrote: linkAsWritten(link) }
    : { report, changed: false };
}

/**
 * Whether two reads saw the same link file: both absent, both the same bytes,
 * or both unreadable for the same reason. {@link replaceMethodLink} never
 * writes over an unreadable file whatever this says, so the last case only
 * lets a save that reads such a file twice, and writes no link there, carry on.
 */
export function sameLinkRead(a: LinkRead, b: LinkRead): boolean {
  if (a.kind === "link" && b.kind === "link") return a.raw === b.raw;
  if (a.kind === "unreadable" && b.kind === "unreadable") return a.reason === b.reason;
  return a.kind === "none" && b.kind === "none";
}

// ── one local step at a time ────────────────────────────────────────

/**
 * The tail of the queue the workshop's link work takes its turns in.
 *
 * A turn holds only LOCAL filesystem work, never a call to the platform: a
 * save's read of its link and its files, a save's compare-and-swap of its
 * link, and a pull's landing (its provisional link, its files and its final
 * link). Each of those is a few file operations, so serializing every one of
 * them across the whole process costs nothing that matters, and holding none
 * across a remote validation or a draft write is what keeps a slow save from
 * delaying every pull. One queue for the process rather than one per
 * directory: a save's files and its link can sit in different directories, a
 * pull can write into a directory nested in another's, and symlinks and case
 * make two spellings of one directory.
 *
 * Within a turn the steps are atomic for this process. Every WRITE in one —
 * the save's compare-and-swap, the pull's whole landing — also holds
 * {@link withLinkLock}, which makes it atomic for every other workshop process
 * on this machine. A save's read takes no lock: a pull marks the link
 * (`partial_pull`) before it writes a file and finishes it after the last, and
 * the save reads its links again after its files and refuses when they moved,
 * so a landing that overlaps the read is caught without one.
 */
let linkTurn: Promise<unknown> = Promise.resolve();

export function inLinkTurn<T>(work: () => Promise<T>): Promise<T> {
  const turn = linkTurn.then(work);
  linkTurn = turn.catch(() => undefined);
  return turn;
}

// ── one writer per directory, across processes ─────────────────────

/** How long a call waits for another workshop process to finish writing one directory. */
export const LINK_LOCK_WAIT_MS = 10_000;

/**
 * The age past which a lock is taken for abandoned. A lock is held only for a
 * few local file operations — never across a call to the platform — so a lock
 * this old belongs to a process that was killed, or paused far longer than any
 * write it was making.
 */
export const LINK_LOCK_STALE_MS = 30_000;

const LINK_LOCK_POLL_MS = 5;

/** Why a call could not take the lock of the directory it writes; nothing was written under it. */
export class LinkLockError extends Error {
  override name = "LinkLockError";
}

/** Who holds a lock, as the lock file records it. */
interface LockHolder {
  pid: number;
  host: string;
  at: number;
}

/**
 * Run `work` holding the lock every workshop process on this machine takes
 * before it writes the link file, or a pull's files, in `dir`.
 *
 * The link's compare-and-swap is two file operations, a read and a write, and
 * only one process's turns are ordered by {@link inLinkTurn}. Between two
 * processes nothing ordered them: a pull of a published version from a second
 * workshop process could land between a save's compare and its write, the save
 * then recorded its draft token over the version's files, and the next
 * ordinary save replaced the draft with that version — the restore guard
 * bypassed, and the bytes the first save sent gone from the draft and from
 * disk. Under contention the two processes lost about half their swaps to
 * each other. So every write holds this lock, and the compare and the write,
 * and a pull's provisional link, files and final link, are one step for every
 * process that takes it.
 *
 * The lock is a file created exclusively under the OS temp directory, never
 * in the user's directory, which is committed. Its name is derived from the
 * directory's device and inode, so two spellings of one directory — a
 * symlink, a different case on a case-insensitive disk — take one lock. A
 * directory that does not exist yet is named by its nearest existing ancestor
 * and the rest of its path.
 *
 * It is held for a few file operations and never across a call to the
 * platform. A holder that cannot have finished is taken for dead, which is
 * the guess any lock on disk must make: a holder on this host whose process is
 * gone is dead at once, and any holder older than {@link LINK_LOCK_STALE_MS}
 * is dead too. A holder merely paused past that age resumes inside the next
 * one's lock, which reopens the window this lock closes, but only after a
 * pause thousands of times longer than the hold. And the lock binds only
 * processes that share the temp directory — by default, one user's sessions on
 * one machine, which is where two workshops write one directory.
 *
 * Waits up to {@link LINK_LOCK_WAIT_MS}; past that, or when the lock file
 * cannot be created at all, it throws {@link LinkLockError} and `work` never
 * runs, so a caller refuses rather than write unguarded.
 */
export async function withLinkLock<T>(
  dir: string,
  work: () => Promise<T>,
  options: { waitMs?: number } = {},
): Promise<T> {
  const lockPath = await linkLockPath(dir);
  const token = await acquireLinkLock(lockPath, options.waitMs ?? LINK_LOCK_WAIT_MS);
  try {
    return await work();
  } finally {
    await releaseLinkLock(lockPath, token);
  }
}

/** Where the lock of `dir` lives — exported so a test can stand in for another process holding it. */
export async function linkLockPath(dir: string): Promise<string> {
  const key = await directoryKey(dir);
  const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return path.join(os.tmpdir(), "pipelex-mcp-link-locks", `${name}.lock`);
}

/** The device and inode of `dir`, or of its nearest existing ancestor followed by the rest of its path. */
async function directoryKey(dir: string): Promise<string> {
  let current = path.resolve(dir);
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = await fs.stat(current, { bigint: true });
      return [`${stat.dev}:${stat.ino}`, ...missing.reverse()].join("/");
    } catch (err) {
      if (!isMissingPathError(err)) throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(dir);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function acquireLinkLock(lockPath: string, waitMs: number): Promise<string> {
  const holder: LockHolder = { pid: process.pid, host: os.hostname(), at: Date.now() };
  const token = JSON.stringify({ ...holder, nonce: randomUUID() });
  const deadline = Date.now() + waitMs;
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    for (;;) {
      try {
        await fs.writeFile(lockPath, token, { encoding: "utf8", flag: "wx" });
        return token;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      await breakAbandonedLock(lockPath);
      if (Date.now() >= deadline) {
        throw new LinkLockError(
          `another workshop process has been writing this directory for over ${Math.round(waitMs / 1000)} s`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LINK_LOCK_POLL_MS));
    }
  } catch (err) {
    if (err instanceof LinkLockError) throw err;
    throw new LinkLockError(
      `the workshop's lock for this directory could not be taken at ${lockPath} (${errorMessage(err)})`,
    );
  }
}

/**
 * Remove the lock at `lockPath` when its holder cannot still be writing.
 *
 * The removal renames the lock aside first, which only one of several callers
 * can do, and then checks that what it moved is the lock it judged: a holder
 * that took the lock in between is put back.
 */
async function breakAbandonedLock(lockPath: string): Promise<void> {
  let raw: string;
  let modifiedAt: number;
  try {
    raw = await fs.readFile(lockPath, "utf8");
    modifiedAt = (await fs.stat(lockPath)).mtimeMs;
  } catch (err) {
    if (isMissingPathError(err)) return;
    throw err;
  }
  const holder = lockHolderOf(raw);
  // A lock file read between its creation and its first write is empty, so its
  // age is the file's own.
  const age = Date.now() - (holder?.at ?? modifiedAt);
  const gone = holder !== undefined && holder.host === os.hostname() && !processAlive(holder.pid);
  if (!gone && age < LINK_LOCK_STALE_MS) return;

  const aside = `${lockPath}.abandoned-${randomUUID()}`;
  try {
    await fs.rename(lockPath, aside);
  } catch (err) {
    if (isMissingPathError(err)) return;
    throw err;
  }
  const moved = await fs.readFile(aside, "utf8").catch(() => undefined);
  if (moved !== raw) {
    // Not the lock judged abandoned: a live holder took it after the read.
    await fs.link(aside, lockPath).catch(() => undefined);
  }
  await fs.rm(aside, { force: true });
}

/** Remove the lock only while it is still this call's own, never one taken after it was broken. */
async function releaseLinkLock(lockPath: string, token: string): Promise<void> {
  const raw = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  if (raw === token) await fs.rm(lockPath, { force: true }).catch(() => undefined);
}

function lockHolderOf(raw: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    return typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.at === "number"
      ? { pid: parsed.pid, host: parsed.host, at: parsed.at }
      : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Why this existing entry may not be written through, or `undefined` when it is
 * absent or an ordinary file.
 *
 * `lstat`, never `stat`: a write through a symlink lands at the link's target,
 * so a symlink is foreign by construction however contained its own path looks.
 * This is `codegen-writer.ts`'s rule, applied to the files a pull lands.
 */
export async function foreignEntryReason(absolute: string): Promise<string | undefined> {
  let entry;
  try {
    entry = await fs.lstat(absolute);
  } catch (err) {
    return isMissingPathError(err) ? undefined : errorMessage(err);
  }
  if (entry.isSymbolicLink()) {
    return "it is a symlink, and writing through it would land outside this directory";
  }
  if (!entry.isFile()) {
    return "it is not a regular file";
  }
  return undefined;
}

/**
 * A directory's link file as read. The `link` arm keeps the file's exact bytes
 * in `raw`, which a later {@link replaceMethodLink} compares against.
 */
export type LinkRead =
  | { kind: "none" }
  | { kind: "link"; link: MethodLink; raw: string }
  | { kind: "unreadable"; reason: string };

/**
 * Read a directory's link file.
 *
 * A malformed or foreign-shaped link is `unreadable`, never `none`: the two
 * lead to opposite decisions — `none` lets a pull write, `unreadable` must
 * refuse — and a link nobody can parse is evidence that *something* claims the
 * directory, which is exactly when writing over it is wrong.
 */
export async function readMethodLink(dir: string): Promise<LinkRead> {
  const absolute = path.join(dir, LINK_FILE_NAME);
  // A symlinked link file is `unreadable`, not `none`: something else claims
  // this directory, and following it would let a foreign file decide ownership
  // — and then be overwritten by the link write that follows.
  const foreign = await foreignEntryReason(absolute);
  if (foreign !== undefined) {
    return { kind: "unreadable", reason: foreign };
  }

  let text: string;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch (err) {
    if (isMissingPathError(err)) {
      return { kind: "none" };
    }
    return { kind: "unreadable", reason: errorMessage(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "unreadable", reason: `it is not valid JSON (${errorMessage(err)})` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unreadable", reason: "it is not a JSON object" };
  }
  const row = parsed as Record<string, unknown>;
  for (const field of ["method_id", "name", "api_host", "synced_updated_at"] as const) {
    if (typeof row[field] !== "string") {
      return { kind: "unreadable", reason: `it has no string \`${field}\`` };
    }
  }
  // A version marker that is present but not a version number is refused with
  // the rest of a malformed link, never dropped: dropped, it would read as a
  // directory holding the draft, and a save from it would replace the draft
  // with a pulled version's files without the explicit token a restore needs.
  // Absent or null still means the directory holds the draft.
  if (
    row.synced_version !== undefined &&
    row.synced_version !== null &&
    !isVersionNumber(row.synced_version)
  ) {
    return { kind: "unreadable", reason: "its `synced_version` is not a version number" };
  }

  return {
    kind: "link",
    raw: text,
    link: {
      comment: typeof row.comment === "string" ? row.comment : LINK_COMMENT,
      generator: typeof row.generator === "string" ? row.generator : LINK_GENERATOR,
      api_host: row.api_host as string,
      method_id: row.method_id as string,
      name: row.name as string,
      synced_updated_at: row.synced_updated_at as string,
      ...(isVersionNumber(row.synced_version) ? { synced_version: row.synced_version } : {}),
      ...(row.partial_pull === true ? { partial_pull: true } : {}),
    },
  };
}

function isVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Which of these destinations already exist — "is anything this pull would land
 * on already here".
 *
 * This deliberately replaces a top-level `.mthds` scan. The question the guard
 * has to answer is about the set the write loop lands, which includes `.py`
 * files and nested paths; a directory holding the user's own `helpers.py`, or a
 * `nested/other.mthds`, has no top-level `.mthds` file and so read as empty
 * while the loop overwrote it. Asking each destination is the same question the
 * action asks.
 */
export async function existingDestinations(
  destinations: readonly { name: string; absolute: string }[],
): Promise<string[]> {
  const present: string[] = [];
  for (const destination of destinations) {
    try {
      await fs.lstat(destination.absolute);
      present.push(destination.name);
    } catch {
      // Absent (or unstattable, which the write itself will report).
    }
  }
  return present;
}

/**
 * The directory's own top-level `.mthds` files — "does a bundle already live
 * here at all".
 *
 * This is NOT {@link existingDestinations}, and the two are not
 * interchangeable. That one asks about the write set, which is what keeps a
 * pull from landing on a file it would replace; this one asks the ownership
 * question the link file exists for — a directory holding a bundle and no link
 * is somebody else's work, whatever that bundle's files happen to be called.
 * Asking only the first let a pull land beside a stranger's `their_bundle.mthds`
 * and then claim the whole directory with a link file.
 *
 * Top level only, and files only: a nested bundle under a directory of its own
 * is not a claim on this one, and an unreadable directory answers "nothing
 * here", which the write that follows reports for itself.
 */
export async function bundleFilesIn(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mthds"))
    .map((entry) => entry.name)
    .sort();
}
