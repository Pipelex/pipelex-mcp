import { promises as fs } from "node:fs";
import path from "node:path";

import ignore from "ignore";
import type { Ignore } from "ignore";

/**
 * A method folder's members: which files under a method's folder belong to
 * its method tree.
 *
 * **This module is provisional.** It is written ahead of the MTHDS standard's
 * text, following the membership rule of the extra-files design word for
 * word, and it will be swapped for `mthds-js`'s implementation of the rule
 * once that one exists and is held to the conformance corpus; any difference
 * the corpus finds between the two is a bug of this module. Keep it
 * self-contained, so the swap stays one import.
 *
 * The rule: a file under the root belongs to the tree unless
 *
 * - **a segment of its path starts with a dot**, which keeps `.git/`,
 *   `.venv/`, `.env` and every other dotfile out by construction;
 * - **it sits under a `__pycache__/` or a `node_modules/` directory**, the
 *   defaults, read as directory-only patterns at any depth, as a `.gitignore`
 *   line would read them;
 * - **the `.gitignore` files inside the root exclude it**, at any depth, read
 *   with git's own semantics (negation, anchoring, directory-only patterns,
 *   a deeper file overriding a shallower one, and no re-inclusion under an
 *   excluded directory). Only those files count: neither the user's global
 *   excludes nor a `.gitignore` above the root, so one folder yields one tree
 *   on every machine. Patterns match case-sensitively for the same reason,
 *   whatever `core.ignorecase` a checkout would carry. A `.gitignore` that is
 *   a symbolic link is not read, as git ≥ 2.32 does not follow one.
 *
 * A symbolic link that the rule does not exclude is an error naming its path,
 * never followed and never skipped silently: a link is either a mistake or a
 * reach outside the root. A member is a regular file; a socket, a FIFO or a
 * device is no file of the tree and is passed over.
 *
 * What the design's later stages add is not here: `METHODS.toml`'s
 * `[package] exclude`, the tree-path rules (NFC, no case collisions, the
 * forbidden characters) and the digest. A run-artifacts directory a tool
 * writes beside a method keeps itself out by holding a `.gitignore` of `*`,
 * which `mthds_download_artifacts` writes into a directory it creates, so the
 * rule needs to know no such directory by name.
 */

/** The directory names the rule excludes by default, at any depth. */
export const DEFAULT_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  "__pycache__",
  "node_modules",
]);

/**
 * How many members, files and directories, a walk visits before it stops.
 * A method's folder holds a handful of files; a folder past this is a project
 * or a home directory, and the walk is bounded so pointing at one costs a
 * refusal rather than a long scan.
 */
export const MAX_METHOD_TREE_ENTRIES = 10_000;

const GITIGNORE = ".gitignore";

/** One member of the tree: its tree path (`/`-separated, relative to the root) and its size on the `lstat`. */
export interface MethodTreeFile {
  path: string;
  size: number;
}

export interface MethodTreeListing {
  /** The tree's regular files, sorted by tree path byte for byte; complete unless `truncated`. */
  files: MethodTreeFile[];
  /** The symbolic links the rule does not exclude, by tree path: each one is an error. */
  symlinks: string[];
  /** The walk stopped at `maxEntries`, the whole root level read first. */
  truncated: boolean;
}

export type MethodTreeResult =
  | { ok: true; listing: MethodTreeListing }
  | { ok: false; path: string; message: string };

/** A `.gitignore` in force, with the tree path of the directory holding it (`""` for the root). */
interface Level {
  base: string;
  matcher: Ignore;
}

/**
 * List the tree under `root`, an absolute path to an existing directory,
 * breadth first so the root level is read whole before anything below it.
 * A directory or a `.gitignore` that cannot be read fails the walk, naming it
 * by its tree path (`.` for the root), since the tree could not be known.
 */
export async function listMethodTree(
  root: string,
  options: { maxEntries?: number } = {},
): Promise<MethodTreeResult> {
  const maxEntries = options.maxEntries ?? MAX_METHOD_TREE_ENTRIES;
  const files: MethodTreeFile[] = [];
  const symlinks: string[] = [];
  const queue: { dir: string; levels: readonly Level[] }[] = [{ dir: "", levels: [] }];
  let entries = 0;

  while (queue.length > 0) {
    const { dir, levels: above } = queue.shift()!;
    const absolute = absoluteOf(root, dir);

    let names: string[];
    try {
      names = await fs.readdir(absolute);
    } catch (err) {
      return { ok: false, path: dir === "" ? "." : dir, message: errorMessage(err) };
    }

    let levels = above;
    if (names.includes(GITIGNORE)) {
      const own = await readGitignore(absolute);
      if (!own.ok) return { ok: false, path: join(dir, GITIGNORE), message: own.message };
      if (own.matcher !== undefined) levels = [...above, { base: dir, matcher: own.matcher }];
    }

    for (const name of names.sort(byteOrder)) {
      if (name.startsWith(".")) continue;
      const treePath = join(dir, name);
      let stats;
      try {
        stats = await fs.lstat(path.join(absolute, name));
      } catch (err) {
        // Gone between the listing and the look: it is not in the tree.
        if (isMissing(err)) continue;
        return { ok: false, path: treePath, message: errorMessage(err) };
      }

      if (stats.isSymbolicLink()) {
        // Git matches a link as a file, never as a directory.
        if (!isExcluded(levels, treePath, false)) symlinks.push(treePath);
        continue;
      }
      if (stats.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRECTORIES.has(name) || isExcluded(levels, treePath, true)) continue;
        if (++entries > maxEntries) return truncatedListing(files, symlinks);
        queue.push({ dir: treePath, levels });
        continue;
      }
      if (!stats.isFile() || isExcluded(levels, treePath, false)) continue;
      if (++entries > maxEntries) return truncatedListing(files, symlinks);
      files.push({ path: treePath, size: stats.size });
    }
  }

  return {
    ok: true,
    listing: { files: sortedByPath(files), symlinks: symlinks.sort(byteOrder), truncated: false },
  };
}

/**
 * Whether the `.gitignore` files in force exclude `treePath`, the deepest one
 * that has a say deciding, as git reads a lower-level file over a higher-level
 * one. Each file's patterns are relative to its own directory. A parent
 * directory excluded higher up never reaches here, since the walk does not
 * enter it, which is git's "no re-inclusion under an excluded directory".
 */
function isExcluded(levels: readonly Level[], treePath: string, isDirectory: boolean): boolean {
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const level = levels[index]!;
    const relative = level.base === "" ? treePath : treePath.slice(level.base.length + 1);
    const verdict = level.matcher.test(isDirectory ? `${relative}/` : relative);
    if (verdict.ignored) return true;
    if (verdict.unignored) return false;
  }
  return false;
}

/**
 * The patterns of the `.gitignore` in `directory`, when it holds one as a
 * regular file. A UTF-8 byte-order mark is skipped, as git skips it.
 */
async function readGitignore(
  directory: string,
): Promise<{ ok: true; matcher?: Ignore } | { ok: false; message: string }> {
  const target = path.join(directory, GITIGNORE);
  try {
    const stats = await fs.lstat(target);
    if (!stats.isFile()) return { ok: true };
    const text = (await fs.readFile(target, "utf8")).replace(/^\uFEFF/, "");
    return { ok: true, matcher: ignore({ ignorecase: false }).add(text) };
  } catch (err) {
    if (isMissing(err)) return { ok: true };
    return { ok: false, message: errorMessage(err) };
  }
}

function truncatedListing(files: MethodTreeFile[], symlinks: string[]): MethodTreeResult {
  return {
    ok: true,
    listing: { files: sortedByPath(files), symlinks: symlinks.sort(byteOrder), truncated: true },
  };
}

function sortedByPath(files: MethodTreeFile[]): MethodTreeFile[] {
  return files.sort((a, b) => byteOrder(a.path, b.path));
}

/** Byte-for-byte order of the UTF-8 encodings, the order the design's listing sorts in. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function join(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

function absoluteOf(root: string, treePath: string): string {
  return treePath === "" ? root : path.join(root, ...treePath.split("/"));
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
