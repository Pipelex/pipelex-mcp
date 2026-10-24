import { promises as fs } from "node:fs";
import path from "node:path";

import { describeTreeRefusal, listFolderTree } from "./capabilities/method-tree.js";
import type { FolderTree, ListingLimits } from "./capabilities/method-tree.js";
import { METHOD_FILE_EXTENSIONS, shownIn } from "./capabilities/shared.js";
import type {
  FileResolution,
  FileResolver,
  LocatedMethodDir,
  MethodDirLocation,
  MethodFileRead,
  MethodFileStat,
  MethodTreeRead,
  Refusal,
} from "./capabilities/shared.js";
import {
  errorMessage,
  isInsideRoot,
  isMissingPathError,
} from "./capabilities/workspace-boundary.js";

const MTHDS_EXTENSION = ".mthds";
const INLINE_FALLBACK = "or inline the contents as { content, uri? }.";
const METHOD_FILE_FALLBACK = "or pass the method's folder as method_dir.";

/**
 * What a resolver may vary besides its extension, each chosen where the
 * resolver is built and never reachable from the MCP surface.
 */
export interface LocalFileResolverOptions {
  /**
   * The clause every remedy ends on: what the caller can do instead of a path.
   * A files item falls back to inline `{ content, uri? }`; `inputs_path` falls
   * back to inline `inputs`. Defaults to the files wording.
   */
  fallback?: string;
  /**
   * Refuse a file larger than this many bytes, checked on the stat before the
   * read. Absent means no cap.
   */
  maxBytes?: number;
  /**
   * What the extension refusal says the argument reads, when it reads more
   * than its one text extension. Defaults to "only <extension> files".
   */
  reads?: string;
}

/**
 * The workshop's filesystem-backed {@link FileResolver}. Submitted paths
 * resolve relative to `rootDir` (the server's working directory — the host
 * spawns the stdio server in the workspace). Containment is enforced on real
 * paths (symlinks followed): the resolved target must live inside the
 * `rootDir` subtree. Escapes, missing files, non-regular files, and read
 * failures are reported as {@link FileResolution} failures, never thrown —
 * the seam turns them into `client.argument_invalid` problems at `files[i].path`.
 *
 * `extension` is the ONE thing a caller chooses, and it is chosen per argument
 * rather than per call: every bundle argument is `.mthds`. It is deliberately
 * not reachable from the MCP surface — a tool input that named the extension
 * would turn the read boundary into something the model picks, which is the
 * opposite of what it is for. `mthds_run` and `mthds_prepare_inputs`'s
 * `inputs_path` is the `.json` arm, built with its own fallback wording and a
 * size cap. The method-taking tools' `files` and `method_dir` are
 * {@link localMethodFileResolver}, which reads a method's files as bytes.
 */
export function localFileResolver(
  rootDir: string = process.cwd(),
  extension: string = MTHDS_EXTENSION,
  options: LocalFileResolverOptions = {},
): FileResolver {
  const fallback = options.fallback ?? INLINE_FALLBACK;
  const reads = options.reads ?? `only ${extension} files`;
  return {
    async resolve(submitted: string): Promise<FileResolution> {
      // Each `{ path }` arm is contracted to one extension — `.mthds` for every
      // bundle argument, `.json` for `inputs_path`. Enforce it
      // before any filesystem access, so a path pointing at an unrelated local
      // file — a prompt-injected `.env`, `.git/config`, key material — is refused
      // without ever being opened. Containment below only bounds *where* we read;
      // this bounds *what* we read, and a caller that could choose the extension
      // would have neither bound.
      if (path.extname(submitted).toLowerCase() !== extension) {
        return failure(
          `Path is not a ${extension} file: ${submitted}`,
          `This argument reads ${reads}. Point at a ${extension} file, ${fallback}`,
          { reason: "wrong_extension" },
        );
      }
      const root = await workingDirectory(rootDir);
      if (!root.ok) return root;
      const target = await containedTarget(rootDir, root.real, submitted, {
        kind: `a ${extension} file`,
        fallback,
        maxBytes: options.maxBytes,
      });
      if (!target.ok) return target;
      try {
        return { ok: true, content: await fs.readFile(target.real, "utf8") };
      } catch (err) {
        return readFailure(submitted, err, fallback);
      }
    },
  };
}

/**
 * The resolver of a method's files: the method-taking tools' `files` and
 * `method_dir`, and `mthds_save_method`'s `method_dir` (`save`, which words
 * its refusals for a tool that takes a folder alone).
 *
 * `statMethodFile` makes every check of one `{ path }` item that reads no
 * byte of it: its extension is `.mthds` or a template file's
 * (`METHOD_FILE_EXTENSIONS`), checked on the submitted name before the
 * filesystem is touched, so a `.env` or a key is never opened; its real path
 * lies inside the working directory; it is a regular file. It answers the
 * path as the caller wrote it, resolved against the working directory and
 * relative to it, from which the tree path is made, and the size the stat
 * gave. `readMethodFile` makes the same checks again and reads the file as
 * bytes, within `maxBytes`, the deployment's limit on one file of a method,
 * on its stat and again on the bytes read.
 *
 * `locateMethodDir` finds a folder on its real path before anything under it
 * is read, and `readMethodTree` lists its whole tree under the deployment's
 * limits and reads every file of it once (`readMethodFolderTree`).
 */
export function localMethodFileResolver(
  rootDir: string = process.cwd(),
  options: { save?: boolean } = {},
): FileResolver {
  const text = localFileResolver(rootDir, MTHDS_EXTENSION);
  const fallback = options.save === true ? SAVE_FALLBACK : FOLDER_FALLBACK;
  return {
    resolve: (submitted) => text.resolve(submitted),
    statMethodFile: (submitted) => statMethodFile(rootDir, submitted),
    readMethodFile: (submitted, read) => readMethodFile(rootDir, submitted, read.maxBytes),
    locateMethodDir: (methodDir) => locateMethodFolder(rootDir, methodDir, fallback),
    readMethodTree: (location, read) => readMethodFolderTree(location, read.limits, fallback),
  };
}

/** One `{ path }` item of a method's `files`, past every gate that reads no byte of it. */
async function statMethodFile(rootDir: string, submitted: string): Promise<MethodFileStat> {
  const target = await methodFileTarget(rootDir, submitted);
  if (!target.ok) return target;
  const absolute = path.resolve(rootDir, submitted);
  return { ok: true, absolute, relative: path.relative(rootDir, absolute), size: target.size };
}

/** One `{ path }` item of a method's `files`, read as bytes past the read side's gates. */
async function readMethodFile(
  rootDir: string,
  submitted: string,
  maxBytes: number,
): Promise<MethodFileRead> {
  const target = await methodFileTarget(rootDir, submitted, maxBytes);
  if (!target.ok) return target;
  let bytes: Uint8Array;
  try {
    bytes = await readUpTo(target.real, target.size);
  } catch (err) {
    return readFailure(submitted, err, METHOD_FILE_FALLBACK);
  }
  if (bytes.byteLength !== target.size) {
    return failure(
      `${submitted} changed while it was read.`,
      `Send it again once nothing is writing to it, ${METHOD_FILE_FALLBACK}`,
      { busy: submitted },
    );
  }
  return { ok: true, bytes };
}

/**
 * The gates of a method file before any byte of it is read: the extension on
 * the submitted name, before the filesystem is touched, then the working
 * directory's containment, a regular file, and `maxBytes` when one is given.
 */
async function methodFileTarget(
  rootDir: string,
  submitted: string,
  maxBytes?: number,
): Promise<ContainedTarget> {
  const extension = path.extname(submitted).toLowerCase();
  if (!(METHOD_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    return failure(
      `Path is not a .mthds file or a template file: ${submitted}`,
      `This argument reads .mthds files and the template files their PipeDocGen steps name (${METHOD_FILE_EXTENSIONS.slice(1).join(", ")}). Point at one, ${METHOD_FILE_FALLBACK}`,
      { reason: "wrong_extension" },
    );
  }
  const root = await workingDirectory(rootDir);
  if (!root.ok) return root;
  return containedTarget(rootDir, root.real, submitted, {
    kind: "a .mthds file or a template file",
    fallback: METHOD_FILE_FALLBACK,
    ...(maxBytes === undefined
      ? {}
      : {
          maxBytes,
          limit: `the limit of ${maxBytes} bytes the Pipelex deployment takes for one file of a method`,
        }),
  });
}

/**
 * A file's bytes, read to at most one byte past `size`, the size its stat gave
 * and the limit held it to, so a file that grew since is never read whole.
 */
async function readUpTo(real: string, size: number): Promise<Uint8Array> {
  const handle = await fs.open(real, "r");
  try {
    const buffer = Buffer.alloc(size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
  } finally {
    await handle.close();
  }
}

/**
 * How a refusal of a method folder ends: what else the caller can do. The
 * method-taking tools also take `files`, so their remedies offer it; the save
 * takes a folder and nothing else, so offering `files` there would send the
 * caller to an argument the tool does not have.
 */
interface FolderFallback {
  /** Closes a remedy's last clause: "Check the path, <clause>". */
  readonly clause: string;
  /** A sentence of its own, or nothing. */
  readonly sentence: string;
  /** The remedy for a `method_dir` that is not a directory. */
  readonly notADirectory: string;
}

const FOLDER_FALLBACK: FolderFallback = {
  clause: "or list the method's files in files.",
  sentence: " Or list the method's files in files.",
  notADirectory:
    "Pass the folder holding the method's .mthds files, or give a single .mthds file in files as { path }.",
};

const SAVE_FALLBACK: FolderFallback = {
  clause: "then save the folder again.",
  sentence: "",
  notADirectory:
    "Pass the folder holding the method's .mthds files: its whole tree is what a save stores.",
};

/** Refusals of a method folder shown by name, the rest counted. */
const MAX_LISTED_PATHS = 5;

type Refusals = Refusal[];

function refusedWith(
  message: string,
  remedy: string,
  facts: Omit<Refusal, "message" | "remedy">,
): { ok: false; refusals: Refusals } {
  return { ok: false, refusals: [{ message, remedy, ...facts }] };
}

/**
 * Where a method folder is: `method_dir` resolved against the working
 * directory, inside it on its real path, as every read must be, and a
 * directory. Nothing under it is read.
 */
async function locateMethodFolder(
  rootDir: string,
  methodDir: string,
  fallback: FolderFallback,
): Promise<MethodDirLocation> {
  const root = await workingDirectory(rootDir);
  if (!root.ok) return { ok: false, refusals: [root] };

  let folder: string;
  try {
    folder = await fs.realpath(path.resolve(rootDir, methodDir));
  } catch (err) {
    return isMissingPathError(err)
      ? refusedWith(
          `Folder not found: ${methodDir}`,
          `method_dir is resolved against the MCP server's working directory (${rootDir}). Check the path, ${fallback.clause}`,
          { reason: "not_found", unreadable: methodDir },
        )
      : refusedWith(
          `Could not read folder ${methodDir}: ${errorMessage(err)}`,
          `Check the folder and its permissions, ${fallback.clause}`,
          { reason: systemReason(err), unreadable: methodDir },
        );
  }
  if (!isInsideRoot(root.real, folder)) {
    return refusedWith(
      `method_dir resolves outside the server's working directory: ${methodDir}`,
      `The local workshop only reads folders inside the directory it was started in (${rootDir}). Move the method into the workspace, ${fallback.clause}`,
      { reason: "outside_workspace" },
    );
  }
  try {
    if (!(await fs.stat(folder)).isDirectory()) {
      return refusedWith(`method_dir is not a directory: ${methodDir}`, fallback.notADirectory, {
        reason: "not_a_directory",
      });
    }
  } catch (err) {
    return refusedWith(
      `Could not read folder ${methodDir}: ${errorMessage(err)}`,
      `Check the folder and its permissions, ${fallback.clause}`,
      { reason: systemReason(err), unreadable: methodDir },
    );
  }
  return { ok: true, folder, methodDir };
}

/**
 * List a located method folder's tree under `limits` (`listFolderTree` in
 * `capabilities/method-tree.ts`, the MTHDS standard's membership rule), and
 * refuse what is no method's folder: one that is itself a Python virtual
 * environment, and one with no `.mthds` file at its top.
 */
async function listMethodFolder(
  location: LocatedMethodDir,
  limits: ListingLimits,
  fallback: FolderFallback,
): Promise<{ ok: true; tree: FolderTree } | { ok: false; refusals: Refusals }> {
  const { folder, methodDir } = location;
  if (await holdsVirtualEnvironmentMarker(folder)) {
    return refusedWith(
      `${methodDir} holds a pyvenv.cfg file, which makes it a Python virtual environment, and nothing in one is part of a method's folder.`,
      `Pass the folder holding the method's .mthds files, outside the virtual environment, ${fallback.clause}`,
      { reason: "virtual_environment" },
    );
  }
  const listed = await listFolderTree(folder, limits);
  if (!listed.ok && listed.error.code !== "empty_tree") {
    return { ok: false, refusals: [describeTreeRefusal(listed.error, fallback.clause)] };
  }
  const shown = (treePath: string) => shownIn(methodDir, treePath);
  const mthds = listed.ok ? listed.tree.files.filter((file) => isMthdsPath(file.path)) : [];
  if (!listed.ok || !mthds.some((file) => !file.path.includes("/"))) {
    const deeper = mthds.map((file) => shown(file.path));
    return refusedWith(
      `${methodDir} holds no .mthds file at its top${deeper.length > 0 ? `; it holds ${listed_(deeper)} further down` : ""}.`,
      `Pass the folder whose top holds the method's .mthds file. Files whose names start with a dot, and what the folder's .gitignore files exclude, are not part of it; ${fallback.clause}`,
      { reason: "no_method_file" },
    );
  }
  return { ok: true, tree: listed.tree };
}

/** Whether the folder's top holds a `pyvenv.cfg` that is not a directory, PEP 405's mark of a virtual environment. */
async function holdsVirtualEnvironmentMarker(folder: string): Promise<boolean> {
  try {
    return !(await fs.lstat(path.join(folder, "pyvenv.cfg"))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a located method folder's whole tree, for every tool that sends a
 * folder: list it under `limits` and read every file once, each to at most one
 * byte past its listed size and checked against its listed SHA-256. What the
 * secret guard checks and the tool sends are these bytes, never read again.
 */
async function readMethodFolderTree(
  location: LocatedMethodDir,
  limits: ListingLimits,
  fallback: FolderFallback,
): Promise<MethodTreeRead> {
  const listed = await listMethodFolder(location, limits, fallback);
  if (!listed.ok) return listed;
  const { tree } = listed;
  const bytes = new Map<string, Uint8Array>();
  for (const file of tree.files) {
    try {
      bytes.set(file.path, await tree.readFile(file.path));
    } catch (err) {
      const shown = shownIn(location.methodDir, file.path);
      return refusedWith(...memberReadFailure(shown, errorMessage(err), fallback), {
        reason: systemReason(err),
        unreadable: shown,
      });
    }
  }
  return {
    ok: true,
    files: tree.files,
    digest: tree.digest,
    ...(tree.graphPage === undefined ? {} : { graphPage: tree.graphPage }),
    bytes,
  };
}

function memberReadFailure(
  shownPath: string,
  message: string,
  fallback: FolderFallback,
): [string, string] {
  return [
    `Could not read ${shownPath}: ${message}`,
    `Check the file and its permissions; a file that changed while the folder was read can be sent again.${fallback.sentence}`,
  ];
}

/** A few paths by name, the rest counted. */
function listed_(paths: readonly string[]): string {
  const head = paths.slice(0, MAX_LISTED_PATHS).join(", ");
  return paths.length > MAX_LISTED_PATHS
    ? `${head}, and ${paths.length - MAX_LISTED_PATHS} more`
    : head;
}

function isMthdsPath(treePath: string): boolean {
  return path.posix.extname(treePath).toLowerCase() === MTHDS_EXTENSION;
}

/** The working directory's real path, resolved once per request. */
async function workingDirectory(
  rootDir: string,
): Promise<{ ok: true; real: string } | ({ ok: false } & Refusal)> {
  try {
    return { ok: true, real: await fs.realpath(rootDir) };
  } catch (err) {
    return failure(
      `Could not resolve the server's working directory: ${errorMessage(err)}`,
      `The local workshop resolves paths relative to its working directory (${rootDir}), which must exist.`,
      { reason: systemReason(err), unreadable: rootDir },
    );
  }
}

/** A submitted path that passed the containment and file checks: its real path and its size on the stat. */
type ContainedTarget = { ok: true; real: string; size: number } | ({ ok: false } & Refusal);

/**
 * The checks every read makes after its extension gate: the target exists,
 * its real path lies inside the working directory (whose real path is
 * `rootReal`), it is a regular file, and it is within `maxBytes` when one is
 * set (worded by `limit`, which names it), all before a byte of it is read.
 */
async function containedTarget(
  rootDir: string,
  rootReal: string,
  submitted: string,
  options: { kind: string; fallback: string; maxBytes?: number; limit?: string },
): Promise<ContainedTarget> {
  const { kind, fallback, maxBytes } = options;
  const target = path.resolve(rootDir, submitted);

  let real: string;
  try {
    real = await fs.realpath(target);
  } catch (err) {
    if (isMissingPathError(err)) {
      return failure(
        `File not found: ${submitted}`,
        `Paths are resolved relative to the MCP server's working directory (${rootDir}). Check the path, ${fallback}`,
        { reason: "not_found", unreadable: submitted },
      );
    }
    return readFailure(submitted, err, fallback);
  }

  if (!isInsideRoot(rootReal, real)) {
    return failure(
      `Path resolves outside the server's working directory: ${submitted}`,
      `The local workshop only reads files inside the directory it was started in (${rootDir}). Move the file into the workspace, ${fallback}`,
      { reason: "outside_workspace" },
    );
  }

  try {
    const stats = await fs.stat(real);
    if (!stats.isFile()) {
      return failure(
        `Path is not a regular file: ${submitted}`,
        `Submit the path of ${kind}, ${fallback}`,
        {
          reason: "not_a_file",
          unreadable: submitted,
        },
      );
    }
    if (maxBytes !== undefined && stats.size > maxBytes) {
      return failure(
        `File is too large: ${submitted} is ${stats.size} bytes, over ${options.limit ?? `the ${maxBytes}-byte limit for this argument`}.`,
        `Shrink the file, ${fallback}`,
        { reason: "file_too_large" },
      );
    }
    return { ok: true, real, size: stats.size };
  } catch (err) {
    return readFailure(submitted, err, fallback);
  }
}

function readFailure(submitted: string, err: unknown, fallback: string): { ok: false } & Refusal {
  return failure(
    `Could not read file ${submitted}: ${errorMessage(err)}`,
    `Check the file and its permissions, ${fallback}`,
    { reason: systemReason(err), unreadable: submitted },
  );
}

/**
 * A refused read: its words, and the facts its problem is built from — why,
 * and the path of a file that exists and cannot be read, or that changed
 * while it was read ({@link Refusal}).
 */
function failure(
  message: string,
  remedy: string,
  facts: Omit<Refusal, "message" | "remedy">,
): { ok: false } & Refusal {
  return { ok: false, message, remedy, ...facts };
}

/** Why a read failed, as the system's error code (`EACCES`, `EISDIR`, …), or `unreadable`. */
function systemReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code !== "" ? code : "unreadable";
}
