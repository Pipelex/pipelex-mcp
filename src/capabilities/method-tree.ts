import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { MethodTreeError, TreeLimitExceededError, listMethodTree, treeDigest } from "mthds";
import type {
  MethodTree,
  MethodTreeLimits,
  ReferenceResolution,
  ResolveReferenceInput,
  TreeLimit,
} from "mthds";

import { GRAPH_PAGE_FILENAME, GRAPH_PAGE_MARK } from "./graph-page.js";
import { errorMessage } from "./workspace-boundary.js";

/**
 * A method folder's tree, as the workshop lists it: the MTHDS standard's
 * membership rule, applied by `mthds`'s `listMethodTree` (the package that is
 * held to the standard's conformance corpus), and the few things the workshop
 * adds on top of it, each of which this module owns.
 *
 * - **The deployment's limits.** The tree is listed under the limits the
 *   Pipelex deployment announces (`tree-limits.ts`), so a folder the platform
 *   would refuse is refused while it is listed, from the sizes the walk reads,
 *   before any file is hashed. A refusal says whose limit it was
 *   ({@link FolderLimitError}): the deployment's, or the workshop's own scan
 *   limit standing for one the deployment did not announce. The listing is rooted at the folder handed over
 *   (`discover: false`), never at a `METHODS.toml` found above it: the folder
 *   the caller named is the method.
 * - **A run's inputs files.** `inputs.json` and `inputs.toml`, at any depth,
 *   hold one run's real data and never travel with a method: the standard keeps
 *   them out of every tree as its `run_inputs` default from `mthds` 0.33 on.
 *   The 0.32 line this workshop is pinned to lists them as members, so they are
 *   taken out here and the digest recomputed over what is left; the shim goes
 *   with the move to 0.33. A symbolic link of either name is refused as every
 *   link is until then, where 0.33 leaves it out unfollowed.
 * - **The workshop's own graph page.** `mthds_validate` writes
 *   `method-graph.html` beside the files it validated, so into a method's
 *   folder, and regenerates it on every validation. A page at the folder's top
 *   carrying the workshop's mark is the workshop's output, not the method: it is
 *   left out, so a validation never moves a saved draft. A file of that name
 *   without the mark is the user's, and stays.
 * - **A bounded, checked read.** A member is read again with
 *   {@link FolderTree.readFile}: opened without following a link, read to at
 *   most one byte past the size the listing recorded, and checked against the
 *   listing's SHA-256, so a file that grew or changed since the listing is
 *   refused rather than read whole. `mthds`'s own `readFile` checks the hash
 *   but reads the whole file first.
 */

/** The names of a run's inputs file, which no method tree holds, at any depth. */
export const RUN_INPUTS_NAMES: ReadonlySet<string> = new Set(["inputs.json", "inputs.toml"]);

/** Whether a tree path names a run's inputs file: its last segment is one of {@link RUN_INPUTS_NAMES}, byte for byte. */
export function isRunInputsPath(treePath: string): boolean {
  return RUN_INPUTS_NAMES.has(treePath.slice(treePath.lastIndexOf("/") + 1));
}

/** A file of a listed folder: its tree path, its size and the SHA-256 of its bytes. */
export interface ListedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** A listed method folder, with what the workshop left out of it. */
export interface FolderTree {
  /** The folder's real path. */
  readonly root: string;
  /** The tree's files, sorted by tree path byte for byte. */
  readonly files: readonly ListedFile[];
  /** The tree digest of {@link files}, `sha256:` and 64 lowercase hexadecimal digits. */
  readonly digest: string;
  /** The total of the files' sizes, in bytes. */
  readonly totalSize: number;
  /** The run's inputs files left out, by tree path. */
  readonly runInputs: readonly string[];
  /** The workshop's own graph page, when the folder's top holds one: left out. */
  readonly graphPage?: string;
  /** Whether `treePath` names a file of the tree. */
  has(treePath: string): boolean;
  /**
   * A file's bytes, read without following a link, to at most one byte past
   * its listed size, and checked against its listed SHA-256. Throws a
   * `MethodTreeError` for a file that changed since the listing.
   */
  readFile(treePath: string): Promise<Uint8Array>;
  /** Resolve a file reference written in one of the tree's files, as the standard resolves it. */
  resolveReference(input: ResolveReferenceInput): Promise<ReferenceResolution>;
}

export type FolderTreeListing =
  | { ok: true; tree: FolderTree }
  | { ok: false; error: MethodTreeError };

/** Whose limit refused a folder: the one the deployment announced, or the workshop's own. */
export type LimitOwner = "deployment" | "workshop";

/**
 * A limit that refused a folder, with whose limit it was, so the refusal
 * blames the deployment only for a limit the deployment announced.
 */
export class FolderLimitError extends TreeLimitExceededError {
  readonly owner: LimitOwner;

  constructor(
    root: string,
    limit: TreeLimit,
    maximum: number,
    reached: number,
    path: string | undefined,
    owner: LimitOwner,
  ) {
    super(root, limit, maximum, reached, path);
    this.name = "FolderLimitError";
    this.owner = owner;
  }
}

/** The limits a listing takes: `mthds`'s, and which of them the workshop set itself (`tree-limits.ts`). */
export type ListingLimits = MethodTreeLimits & { readonly workshopSet?: readonly TreeLimit[] };

/**
 * List the tree of `folder`, an absolute path to an existing directory, under
 * `limits`. Every refusal, a limit passed included, comes back as the
 * `MethodTreeError` that names it, never as a throw; a limit passed is a
 * {@link FolderLimitError} saying whose limit it was.
 */
export async function listFolderTree(
  folder: string,
  limits: ListingLimits,
): Promise<FolderTreeListing> {
  let tree: MethodTree;
  try {
    tree = await listMethodTree(folder, { discover: false, limits: mthdsLimitsOf(limits) });
  } catch (err) {
    if (err instanceof TreeLimitExceededError) {
      const owner = limits.workshopSet?.includes(err.limit) === true ? "workshop" : "deployment";
      return {
        ok: false,
        error: new FolderLimitError(
          err.root,
          err.limit,
          err.maximum,
          err.reached,
          err.names[0],
          owner,
        ),
      };
    }
    return { ok: false, error: asTreeError(err, folder) };
  }
  const root = tree.root ?? folder;

  const runInputs: string[] = [];
  let graphPage: string | undefined;
  const kept: ListedFile[] = [];
  for (const file of tree.files) {
    if (isRunInputsPath(file.path)) {
      runInputs.push(file.path);
      continue;
    }
    if (file.path === GRAPH_PAGE_FILENAME && (await carriesGraphPageMark(root, file))) {
      graphPage = file.path;
      continue;
    }
    kept.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }

  const byPath = new Map(kept.map((file) => [file.path, file]));
  const dropped = runInputs.length > 0 || graphPage !== undefined;
  return {
    ok: true,
    tree: {
      root,
      files: kept,
      digest: dropped ? (kept.length === 0 ? "" : treeDigest(kept)) : tree.digest,
      totalSize: kept.reduce((total, file) => total + file.size, 0),
      runInputs,
      ...(graphPage === undefined ? {} : { graphPage }),
      has: (treePath) => byPath.has(treePath),
      readFile: async (treePath) => {
        const file = byPath.get(treePath);
        if (file === undefined) {
          throw new MethodTreeError(
            "not_found",
            `'${treePath}' is not a file of the method tree.`,
            {
              names: [treePath],
            },
          );
        }
        return readListedFile(root, file, () => tree.readFile(treePath));
      },
      resolveReference: (input) => tree.resolveReference(input),
    },
  };
}

/** The limits as `mthds` takes them, and nothing else. */
function mthdsLimitsOf(limits: ListingLimits): MethodTreeLimits {
  const { maxFileCount, maxFileSize, maxTotalSize } = limits;
  return {
    ...(maxFileCount === undefined ? {} : { maxFileCount }),
    ...(maxFileSize === undefined ? {} : { maxFileSize }),
    ...(maxTotalSize === undefined ? {} : { maxTotalSize }),
  };
}

/** Any failure of a listing as the `MethodTreeError` it reports; an unexpected one as `not_listable`. */
function asTreeError(err: unknown, folder: string): MethodTreeError {
  if (err instanceof MethodTreeError) return err;
  return new MethodTreeError("not_listable", `Cannot list ${folder}: ${errorMessage(err)}`, {
    names: ["."],
  });
}

// Neither flag exists on Windows, where the listing's own `lstat` is the only guard.
const READ_FLAGS =
  fsConstants.O_RDONLY |
  ((fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) |
  ((fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0);

/**
 * Read a listed file to at most one byte past its listed size, never through
 * a link, and check it against the listing. A name the listing recorded in
 * NFC, which a normalization-sensitive file system holds decomposed, is not
 * found under that spelling: it is read through `mthds`'s own reader instead,
 * which knows the name on disk and checks the hash, and held to the listed
 * size after.
 */
async function readListedFile(
  root: string,
  file: ListedFile,
  byStoredName: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const changed = () =>
    new MethodTreeError(
      "not_listable",
      `'${file.path}' changed since the method tree was listed; list it again.`,
      { names: [file.path] },
    );
  let handle;
  try {
    handle = await fs.open(path.join(root, ...file.path.split("/")), READ_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const bytes = await byStoredName();
      if (bytes.byteLength !== file.size) throw changed();
      return bytes;
    }
    if (code === "ELOOP" || code === "EMLINK") {
      throw new MethodTreeError(
        "symbolic_link",
        `'${file.path}' is now a symbolic link, which a method tree never follows; replace it with the file itself and list the tree again.`,
        { names: [file.path] },
      );
    }
    throw new MethodTreeError("not_listable", `Cannot read '${file.path}': ${errorMessage(err)}`, {
      names: [file.path],
    });
  }
  try {
    if (!(await handle.stat()).isFile()) throw changed();
    const buffer = Buffer.alloc(file.size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const bytes = buffer.subarray(0, filled);
    if (filled !== file.size || sha256Hex(bytes) !== file.sha256) throw changed();
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (err) {
    if (err instanceof MethodTreeError) throw err;
    throw new MethodTreeError("not_listable", `Cannot read '${file.path}': ${errorMessage(err)}`, {
      names: [file.path],
    });
  } finally {
    await handle.close();
  }
}

/** How much of a graph page is read to find the workshop's mark, which sits at the top of its head. */
const GRAPH_PAGE_HEAD_BYTES = 1024;

/** Whether the file at the folder's top named like the graph page carries the workshop's mark. */
async function carriesGraphPageMark(root: string, file: ListedFile): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(path.join(root, file.path), READ_FLAGS);
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(GRAPH_PAGE_HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).toString("utf8").includes(GRAPH_PAGE_MARK);
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A refusal of a listing as a tool shows it: what happened, and what the caller can do. */
export interface TreeRefusalText {
  message: string;
  hint: string;
}

/**
 * The words a tool puts on a listing's refusal, at the field that named the
 * folder. The message is `mthds`'s own, which names the offending path; the
 * hint says what the caller can change, by refusal code. `fallback` is the
 * tool's own last resort, appended to every hint.
 */
export function describeTreeRefusal(error: MethodTreeError, fallback: string): TreeRefusalText {
  if (error instanceof TreeLimitExceededError) {
    const what =
      error.limit === "maxFileCount"
        ? `more than ${error.maximum} files`
        : error.limit === "maxFileSize"
          ? `a file over ${error.maximum} bytes`
          : `more than ${error.maximum} bytes in all`;
    const whose =
      error instanceof FolderLimitError && error.owner === "workshop"
        ? `That bound is the workshop's own scan limit, not the Pipelex deployment's, which announced none for it: the workshop lists no folder holding ${what}.`
        : `The Pipelex deployment this workshop talks to takes no method holding ${what}.`;
    return {
      message: `${error.message} ${whose}`,
      hint: `Point at the method's own folder, or keep what is not part of the method out with a .gitignore inside the folder or METHODS.toml's [package] exclude; ${fallback}`,
    };
  }
  switch (error.code) {
    case "symbolic_link":
      return {
        message: error.message,
        hint: `A link in a method's folder is refused, never followed: replace it with the file it points at, or keep it out with a name starting with a dot or a .gitignore line inside the folder, written without a trailing slash (node_modules, not node_modules/), since git matches a link as a file; ${fallback}`,
      };
    case "special_file":
      return {
        message: error.message,
        hint: `Remove it, or keep it out with a .gitignore line inside the folder; ${fallback}`,
      };
    case "invalid_tree_path":
    case "normalization_collision":
    case "path_collision":
      return {
        message: error.message,
        hint: `A method's files must keep their names on every machine, case-insensitive file systems included: rename what the message names, or keep it out with a .gitignore line inside the folder; ${fallback}`,
      };
    case "gitignore_not_utf8":
      return {
        message: error.message,
        hint: `Re-save that .gitignore as UTF-8; ${fallback}`,
      };
    case "manifest_invalid":
      return {
        message: error.message,
        hint: `Fix METHODS.toml's [package] exclude, an array of patterns, each a string; ${fallback}`,
      };
    case "empty_tree":
      return {
        message: error.message,
        hint: `Files whose names start with a dot, and what the folder's .gitignore files exclude, are not part of a method; ${fallback}`,
      };
    default:
      return {
        message: error.message,
        hint: `Check the file and its permissions, or keep it out of the method with a .gitignore inside the folder; ${fallback}`,
      };
  }
}
