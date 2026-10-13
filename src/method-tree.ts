import { promises as fs } from "node:fs";
import path from "node:path";

import ignore from "ignore";
import type { Ignore } from "ignore";

/**
 * A method folder's members: which files under a method's folder belong to
 * its method tree.
 *
 * **This module is provisional.** It is the workshop's own membership rule,
 * written ahead of the MTHDS standard's text and of its conformance corpus,
 * and restated in SPEC.md ("The method folder"). It will be swapped for
 * `mthds-js`'s implementation of the standard's rule once that one exists and
 * is held to the corpus. Keep it self-contained, so the swap stays one import.
 *
 * The rule: a file under the root belongs to the tree unless
 *
 * - **a segment of its path starts with a dot**, which keeps `.git/`,
 *   `.venv/`, `.env` and every other dotfile out by construction;
 * - **it sits under a `__pycache__/` or a `node_modules/` directory**, the
 *   defaults, read as directory-only patterns at any depth, as a `.gitignore`
 *   line would read them;
 * - **it sits under a directory holding a `pyvenv.cfg` file**, which PEP 405
 *   puts at the top of every Python virtual environment, so a `venv/` without
 *   a dot stays out whatever its name; a root holding one is a virtual
 *   environment itself, of which nothing belongs, and the listing says so;
 * - **it sits under a directory below the root holding a `.git` entry**, a
 *   nested repository's directory or a submodule's `.git` file, which git
 *   leaves out of every commit of the repository around it; the listing names
 *   each such directory, so a reference into one can be refused by name;
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
 * What the standard's packaging will add is not here: a package's own
 * exclusions, the tree-path rules (NFC, no case collisions, the forbidden
 * characters) and the digest. A run-artifacts directory a tool
 * writes beside a method keeps itself out by holding a `.gitignore` of `*`,
 * which `mthds_download_artifacts` writes into a directory it creates, so the
 * rule needs to know no such directory by name.
 */

/** The directory names the rule excludes by default, at any depth below the root. */
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

/** The file PEP 405 puts at the top of every Python virtual environment. */
const VIRTUAL_ENVIRONMENT_MARKER = "pyvenv.cfg";

/** The entry that makes a directory a repository of its own: a directory, or a submodule's file. */
const REPOSITORY_MARKER = ".git";

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
  /** The directories below the root left out for holding a `.git` entry, by tree path. */
  nestedRepositories: string[];
  /** The root itself holds a `pyvenv.cfg` file: it is a virtual environment, and the listing is empty. */
  rootIsVirtualEnvironment: boolean;
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
  const nestedRepositories: string[] = [];
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

    // A directory below the root that is a repository of its own, or any
    // directory that is a virtual environment, is out with everything under
    // it: it is known only once its own entries are read. The root's own
    // `.git` is the repository the folder belongs to, and leaves it whole.
    if (dir !== "" && names.includes(REPOSITORY_MARKER)) {
      nestedRepositories.push(dir);
      continue;
    }
    const environment = await holdsFile(absolute, VIRTUAL_ENVIRONMENT_MARKER, names);
    if (!environment.ok) {
      return {
        ok: false,
        path: join(dir, VIRTUAL_ENVIRONMENT_MARKER),
        message: environment.message,
      };
    }
    if (environment.holds) {
      if (dir === "") return listingOf([], [], [], false, true);
      continue;
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
        if (++entries > maxEntries) return truncatedListing(files, symlinks, nestedRepositories);
        queue.push({ dir: treePath, levels });
        continue;
      }
      if (!stats.isFile() || isExcluded(levels, treePath, false)) continue;
      if (++entries > maxEntries) return truncatedListing(files, symlinks, nestedRepositories);
      files.push({ path: treePath, size: stats.size });
    }
  }

  return listingOf(files, symlinks, nestedRepositories, false, false);
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

function truncatedListing(
  files: MethodTreeFile[],
  symlinks: string[],
  nestedRepositories: string[],
): MethodTreeResult {
  return listingOf(files, symlinks, nestedRepositories, true, false);
}

function listingOf(
  files: MethodTreeFile[],
  symlinks: string[],
  nestedRepositories: string[],
  truncated: boolean,
  rootIsVirtualEnvironment: boolean,
): MethodTreeResult {
  return {
    ok: true,
    listing: {
      files: sortedByPath(files),
      symlinks: symlinks.sort(byteOrder),
      nestedRepositories: nestedRepositories.sort(byteOrder),
      truncated,
      rootIsVirtualEnvironment,
    },
  };
}

/**
 * Whether `directory`, whose entries are `names`, holds `name` as anything but
 * a directory: a virtual environment's marker is a file, and a directory of
 * that name marks nothing.
 */
async function holdsFile(
  directory: string,
  name: string,
  names: readonly string[],
): Promise<{ ok: true; holds: boolean } | { ok: false; message: string }> {
  if (!names.includes(name)) return { ok: true, holds: false };
  try {
    return { ok: true, holds: !(await fs.lstat(path.join(directory, name))).isDirectory() };
  } catch (err) {
    if (isMissing(err)) return { ok: true, holds: false };
    return { ok: false, message: errorMessage(err) };
  }
}

function sortedByPath(files: MethodTreeFile[]): MethodTreeFile[] {
  return files.sort((a, b) => byteOrder(a.path, b.path));
}

/** Byte-for-byte order of the UTF-8 encodings, the order the listing sorts in, whatever the locale. */
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
