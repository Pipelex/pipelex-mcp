import { promises as fs } from "node:fs";
import path from "node:path";

import { describeTreeRefusal, listFolderTree } from "./capabilities/method-tree.js";
import type { ListingLimits } from "./capabilities/method-tree.js";
import type { FolderTree, ListedFile } from "./capabilities/method-tree.js";
import { MAX_FOLDER_MTHDS_FILE_BYTES, MAX_FOLDER_MTHDS_FILES } from "./capabilities/shared.js";
import type {
  FileResolution,
  FileResolver,
  LocatedMethodDir,
  MethodDirLocation,
  MethodDirResolution,
  MethodTreeRead,
} from "./capabilities/shared.js";
import {
  MAX_TEMPLATE_FILE_BYTES,
  TEMPLATE_FILE_EXTENSIONS,
  isTemplateFilePath,
  planTemplateFiles,
  templateBudgetRefusals,
  templateFilesNamedBy,
  templateKeyOf,
} from "./capabilities/template-files.js";
import type {
  BundleFileOnDisk,
  LocatedTemplate,
  NamedTemplate,
  SubmittedTemplate,
  TemplateFiles,
  TemplateFilesResolution,
  TemplateRefusal,
} from "./capabilities/template-files.js";
import {
  errorMessage,
  isInsideRoot,
  isMissingPathError,
} from "./capabilities/workspace-boundary.js";
import { READING_TREE_LIMITS } from "./capabilities/tree-limits.js";

const MTHDS_EXTENSION = ".mthds";
const INLINE_FALLBACK = "or inline the contents as { content, uri? }.";
const TEMPLATE_SUFFIXES = TEMPLATE_FILE_EXTENSIONS.join(", ");
const TEMPLATE_FALLBACK = "or move the file where the step's template_file leads.";

/**
 * What a resolver may vary besides its extension, each chosen where the
 * resolver is built and never reachable from the MCP surface.
 */
export interface LocalFileResolverOptions {
  /**
   * The clause every hint ends on: what the caller can do instead of a path.
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
 * the seam turns them into `input_domain` errors at `files[i].path`.
 *
 * `extension` is the ONE thing a caller chooses, and it is chosen per argument
 * rather than per call: every bundle argument is `.mthds`. It is deliberately
 * not reachable from the MCP surface — a tool input that named the extension
 * would turn the read boundary into something the model picks, which is the
 * opposite of what it is for. `mthds_run` and `mthds_prepare_inputs`'s
 * `inputs_path` is the other arm, `.json`, built with its own fallback wording
 * and a size cap. The
 * method-taking tools' `files` is {@link localBundleFileResolver}, this
 * resolver plus a second, byte-reading arm for a bundle's template files.
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
 * The resolver of the method-taking tools' `files`: `.mthds` files read as
 * text, as {@link localFileResolver} reads them, and the template files a
 * bundle's `PipeDocGen` steps name read as bytes through `resolveTemplates`.
 *
 * `resolveTemplates` takes the request's template files together, once the
 * `.mthds` files resolved, and decides everything before reading a byte of
 * any. Each submitted file passes the read side's gates: its suffix is one of
 * `TEMPLATE_FILE_EXTENSIONS`, checked on the submitted name before the
 * filesystem is touched, so the widened gate still never opens a `.env`; its
 * real path lies inside the working directory; it is a regular file within
 * `MAX_TEMPLATE_FILE_BYTES` on its stat. Then each step's `template_file` is
 * looked up beside the `.mthds` file naming it, and `planTemplateFiles`
 * matches the two by real path: a submitted file is sent under the key of the
 * step naming it, the same file submitted twice once, and a file no step names
 * is refused, as is one a step reaches only through a symlink out of its own
 * directory, which pipelex's loader refuses too. The request's bounds are held
 * on the stat sizes, and again on the bytes read. The working directory and
 * each `.mthds` file's directory are resolved once per request.
 */
export function localBundleFileResolver(rootDir: string = process.cwd()): FileResolver {
  const text = localFileResolver(rootDir, MTHDS_EXTENSION, {
    reads: `.mthds files, and the template files their PipeDocGen steps name (${TEMPLATE_SUFFIXES}) as { path }`,
  });
  return {
    resolve: (submitted) => text.resolve(submitted),
    resolveTemplates: (templates, bundle, requestBytes) =>
      resolveTemplateFiles(rootDir, templates, bundle, requestBytes),
    resolveMethodDir: (methodDir) => resolveMethodFolder(rootDir, methodDir),
    locateMethodDir: (methodDir) => locateMethodFolder(rootDir, methodDir, SAVE_FALLBACK),
    readMethodTree: (location, options) => readMethodFolderTree(location, options.limits),
  };
}

/**
 * How a refusal of a method folder ends: what else the caller can do. The
 * method-taking tools also take `files`, so their hints offer it; the save
 * takes a folder and nothing else, so offering `files` there would send the
 * caller to an argument the tool does not have.
 */
interface FolderFallback {
  /** Closes a hint's last clause: "Check the path, <clause>". */
  readonly clause: string;
  /** A sentence of its own, or nothing. */
  readonly sentence: string;
  /** The hint for a `method_dir` that is not a directory. */
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

const FOLDER_COUNT_HINT =
  "The folder sends every template file its PipeDocGen steps name, and they name more than one request takes: have the steps share template files, or split the method.";

/** Refusals of a method folder shown by name, the rest counted. */
const MAX_LISTED_PATHS = 5;

type Refusals = { message: string; hint: string }[];

function refusedWith(message: string, hint: string): { ok: false; refusals: Refusals } {
  return { ok: false, refusals: [{ message, hint }] };
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
  if (!root.ok) return refusedWith(root.message, root.hint);

  let folder: string;
  try {
    folder = await fs.realpath(path.resolve(rootDir, methodDir));
  } catch (err) {
    return isMissingPathError(err)
      ? refusedWith(
          `Folder not found: ${methodDir}`,
          `method_dir is resolved against the MCP server's working directory (${rootDir}). Check the path, ${fallback.clause}`,
        )
      : refusedWith(
          `Could not read folder ${methodDir}: ${errorMessage(err)}`,
          `Check the folder and its permissions, ${fallback.clause}`,
        );
  }
  if (!isInsideRoot(root.real, folder)) {
    return refusedWith(
      `method_dir resolves outside the server's working directory: ${methodDir}`,
      `The local workshop only reads folders inside the directory it was started in (${rootDir}). Move the method into the workspace, ${fallback.clause}`,
    );
  }
  try {
    if (!(await fs.stat(folder)).isDirectory()) {
      return refusedWith(`method_dir is not a directory: ${methodDir}`, fallback.notADirectory);
    }
  } catch (err) {
    return refusedWith(
      `Could not read folder ${methodDir}: ${errorMessage(err)}`,
      `Check the folder and its permissions, ${fallback.clause}`,
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
    );
  }
  const listed = await listFolderTree(folder, limits);
  if (!listed.ok && listed.error.code !== "empty_tree") {
    const text = describeTreeRefusal(listed.error, fallback.clause);
    return refusedWith(text.message, text.hint);
  }
  const shown = shownUnder(methodDir);
  const mthds = listed.ok ? listed.tree.files.filter((file) => isMthdsPath(file.path)) : [];
  if (!listed.ok || !mthds.some((file) => !file.path.includes("/"))) {
    const deeper = mthds.map((file) => shown(file.path));
    return refusedWith(
      `${methodDir} holds no .mthds file at its top${deeper.length > 0 ? `; it holds ${listed_(deeper)} further down` : ""}.`,
      `Pass the folder whose top holds the method's .mthds file. Files whose names start with a dot, and what the folder's .gitignore files exclude, are not part of it; ${fallback.clause}`,
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
 * Read a method folder, `method_dir`, for a method-taking tool: the `.mthds`
 * files of its tree and the template files their `PipeDocGen` steps name, and
 * nothing else of it, since the runner refuses a file no step names (see
 * {@link folderRequestFrom}).
 *
 * The tree is listed under the workshop's scan bound alone
 * (`READING_TREE_LIMITS`), never under the limits a deployment stores a tree
 * under: those are about the whole tree, which only a save sends, and a
 * `main.mthds` beside a large sample PDF is a method these tools read and
 * send like any other. Bytes are judged on what is sent, by
 * {@link folderRequestFrom}. `mthds` 0.32 has no way to list a tree without
 * hashing every member, so the walk still reads each file once, streamed,
 * and the file count is what bounds it.
 */
async function resolveMethodFolder(
  rootDir: string,
  methodDir: string,
): Promise<MethodDirResolution> {
  const located = await locateMethodFolder(rootDir, methodDir, FOLDER_FALLBACK);
  if (!located.ok) return located;
  const listed = await listMethodFolder(located, READING_TREE_LIMITS, FOLDER_FALLBACK);
  if (!listed.ok) return listed;
  return folderRequestFrom(listed.tree, methodDir, (treePath) => listed.tree.readFile(treePath));
}

/**
 * Read a located method folder's whole tree for `mthds_save_method`: list it
 * under `limits` and read every file once, each to at most one byte past its
 * listed size and checked against its listed SHA-256. The request the folder
 * makes for a validation is built from those same bytes, never read again, so
 * what the save validates is what it sends.
 */
async function readMethodFolderTree(
  location: LocatedMethodDir,
  limits: ListingLimits,
): Promise<MethodTreeRead> {
  const listed = await listMethodFolder(location, limits, SAVE_FALLBACK);
  if (!listed.ok) return listed;
  const { tree } = listed;
  const shown = shownUnder(location.methodDir);
  const bytes = new Map<string, Uint8Array>();
  for (const file of tree.files) {
    try {
      bytes.set(file.path, await tree.readFile(file.path));
    } catch (err) {
      return refusedWith(...memberReadFailure(shown(file.path), errorMessage(err), SAVE_FALLBACK));
    }
  }
  return {
    ok: true,
    files: tree.files,
    digest: tree.digest,
    runInputs: tree.runInputs,
    ...(tree.graphPage === undefined ? {} : { graphPage: tree.graphPage }),
    bytes,
    folderRequest: () =>
      folderRequestFrom(tree, location.methodDir, async (treePath) => {
        const read = bytes.get(treePath);
        if (read === undefined) throw new Error(`${treePath} is not a file of the method tree`);
        return read;
      }),
  };
}

/**
 * The request a method folder makes: the `.mthds` files of its tree and the
 * template files their `PipeDocGen` steps name, read through `read`.
 * Everything is decided before a byte is read.
 *
 * - **What.** Only `.mthds` members and template files are read, and a
 *   template file only when a step names it, by the suffix of the name the
 *   step writes, so no step can make the workshop read a `.env` or a key: the
 *   read side's extension gate, applied to names the folder supplies.
 * - **The templates** are looked up as `lookUpNamedTemplates` looks them up,
 *   where each step's `template_file` leads from the directory of the
 *   `.mthds` file naming it, but among the tree's members rather than on disk:
 *   a template the rule excludes is not in the method, and one that is not
 *   there is left for the runner to report as not supplied. Each is keyed by
 *   the step naming it (`planTemplateFiles`), so a bundle in a subfolder keys
 *   its templates as with the file list.
 * - **How much.** The template files are held to the request's bounds
 *   (`templateBudgetRefusals`) on their listed sizes and again on the bytes
 *   read, and the `.mthds` files to the runner's count and per-file size,
 *   since a folder can hold more of them than the agent thought of.
 *
 * The `.mthds` files are sent top level first, then by tree path, so the
 * folder's own bundle leads, the one whose `main_pipe` a run defaults to when
 * several declare one. `sent` lists them, then the template files.
 */
async function folderRequestFrom(
  tree: FolderTree,
  methodDir: string,
  read: (treePath: string) => Promise<Uint8Array>,
): Promise<MethodDirResolution> {
  const shown = shownUnder(methodDir);
  const files = tree.files;
  const mthds = files.filter((file) => isMthdsPath(file.path)).sort(topLevelFirst);

  if (mthds.length > MAX_FOLDER_MTHDS_FILES) {
    return refusedWith(
      `${methodDir} holds ${mthds.length} .mthds files, over the ${MAX_FOLDER_MTHDS_FILES} one request takes: ${listed_(mthds.map((file) => shown(file.path)))}.`,
      "Keep the .mthds files that are not part of the method out with a .gitignore inside the folder, or point method_dir at the method's own folder.",
    );
  }
  const oversized = mthds.filter((file) => file.size > MAX_FOLDER_MTHDS_FILE_BYTES);
  if (oversized.length > 0) {
    return {
      ok: false,
      refusals: oversized.map((file) => mthdsTooLarge(shown(file.path), file.size)),
    };
  }

  // The .mthds files, read as text in the order they are sent.
  const bundle: { treePath: string; path: string; content: string }[] = [];
  for (const file of mthds) {
    let bytes: Uint8Array;
    try {
      bytes = await read(file.path);
    } catch (err) {
      return refusedWith(...memberReadFailure(shown(file.path), errorMessage(err)));
    }
    if (bytes.byteLength > MAX_FOLDER_MTHDS_FILE_BYTES) {
      return { ok: false, refusals: [mthdsTooLarge(shown(file.path), bytes.byteLength)] };
    }
    const content = Buffer.from(bytes).toString("utf8");
    if (content.trim() === "") {
      return refusedWith(
        `${shown(file.path)} is empty.`,
        "Write the bundle into the .mthds file, or keep it out of the method with a .gitignore inside the folder.",
      );
    }
    bundle.push({ treePath: file.path, path: shown(file.path), content });
  }

  // The template files the steps name, among the tree's members. The lookup
  // is case-sensitive, as on the runner's filesystem, whatever this one does,
  // and the standard's tree paths are in NFC already, so a name the step
  // writes is compared in NFC too.
  const members = new Map<string, ListedFile>();
  const membersByFoldedPath = new Map<string, string>();
  for (const file of files) {
    members.set(file.path, file);
    const folded = file.path.toLowerCase();
    if (!membersByFoldedPath.has(folded)) membersByFoldedPath.set(folded, file.path);
  }
  const named: NamedTemplate[] = [];
  const located = new Map<string, LocatedTemplate>();
  const lookupRefusals = new Map<string, { message: string; hint: string }>();
  for (const file of bundle) {
    const dir = path.posix.dirname(file.treePath);
    for (const templateFile of templateFilesNamedBy(file.content)) {
      const key = templateKeyOf(templateFile);
      if (key === undefined) continue;
      const treePath = (dir === "." ? key : `${dir}/${key}`).normalize("NFC");
      const member = isTemplateFilePath(key) ? members.get(treePath) : undefined;
      if (member === undefined && isTemplateFilePath(key)) {
        const refusal = await missedTemplateRefusal(
          tree,
          shown,
          file.treePath,
          templateFile,
          treePath,
          membersByFoldedPath,
        );
        if (refusal !== undefined) lookupRefusals.set(`${file.treePath}\0${treePath}`, refusal);
      }
      // A member's tree path stands for its real path in the planner, which
      // matches files by real path: one member is one file.
      const real = member === undefined ? null : member.path;
      named.push({ key, mthdsPath: file.path, real, escapes: false });
      if (member !== undefined && !located.has(member.path)) {
        located.set(member.path, {
          index: located.size,
          path: shown(member.path),
          real: member.path,
          size: member.size,
        });
      }
    }
  }
  if (lookupRefusals.size > 0) return { ok: false, refusals: [...lookupRefusals.values()] };
  const templates = [...located.entries()]
    .sort(([a], [b]) => byteOrder(a, b))
    .map(([, template]) => template);
  const requestBytes = bundle.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  const plan = planTemplateFiles(templates, named, requestBytes, { countHint: FOLDER_COUNT_HINT });
  if (plan.refusals.length > 0) return { ok: false, refusals: plan.refusals.map(asFolderRefusal) };

  // Each template file read once, whatever number of keys it is sent under,
  // and the request held to its bounds again on what was read.
  const bytesByPath = new Map<string, Uint8Array>();
  const read_: { key: string; index: number; path: string; size: number; bytes: Uint8Array }[] = [];
  for (const entry of plan.planned) {
    let bytes = bytesByPath.get(entry.real);
    if (bytes === undefined) {
      try {
        bytes = await read(entry.real);
      } catch (err) {
        return refusedWith(...memberReadFailure(entry.path, errorMessage(err)));
      }
      bytesByPath.set(entry.real, bytes);
    }
    read_.push({ ...entry, size: bytes.byteLength, bytes });
  }
  const overRead = templateBudgetRefusals(read_, requestBytes, { countHint: FOLDER_COUNT_HINT });
  if (overRead.length > 0) return { ok: false, refusals: overRead.map(asFolderRefusal) };

  const resources: TemplateFiles = {};
  for (const entry of read_) resources[entry.key] = entry.bytes;
  const sentTemplates = templates
    .filter((template) => bytesByPath.has(template.real))
    .map((template) => template.path);
  return {
    ok: true,
    files: bundle.map((file) => ({ path: file.path, content: file.content })),
    resources,
    sent: [...bundle.map((file) => file.path), ...sentTemplates],
  };
}

/**
 * Why a template a step names, that is no member of the folder, is refused
 * rather than left for the runner to report as not supplied; `undefined` when
 * it is simply missing. Two cases are the author's mistake and say so: the
 * path leads into a nested repository, which is out of the folder with
 * everything under it (the standard's reference resolution says so), or the
 * folder holds the file spelled in another case, which a case-insensitive
 * filesystem would open here and a case-sensitive runner would not.
 */
async function missedTemplateRefusal(
  tree: FolderTree,
  shown: (treePath: string) => string,
  mthdsTreePath: string,
  templateFile: string,
  treePath: string,
  membersByFoldedPath: ReadonlyMap<string, string>,
): Promise<{ message: string; hint: string } | undefined> {
  const step = `A PipeDocGen step of ${shown(mthdsTreePath)} names the template_file "${templateFile}"`;
  const resolution = await tree
    .resolveReference({ holder: mthdsTreePath, reference: templateFile, context: "path" })
    .catch(() => undefined);
  if (
    resolution?.kind === "refused" &&
    resolution.refusal.excludedBy === "nested_repository" &&
    resolution.refusal.excludedDirectory !== undefined
  ) {
    return {
      message: `${step}, which leads into ${shown(resolution.refusal.excludedDirectory)}, a nested git repository: a directory holding a .git entry is not part of the method's folder.`,
      hint: "Move the template file out of the nested repository into the method's folder, or pass method_dir for a folder that is not a repository's parent.",
    };
  }
  const spelled = membersByFoldedPath.get(treePath.toLowerCase());
  if (spelled !== undefined && spelled !== treePath) {
    return {
      message: `${step}, which leads to ${shown(treePath)}, and the folder holds ${shown(spelled)}, spelled in another case.`,
      hint: "Template files are matched case-sensitively, as the runner reads them: make the step's template_file and the file's name agree letter for letter.",
    };
  }
  return undefined;
}

function memberReadFailure(
  shownPath: string,
  message: string,
  fallback: FolderFallback = FOLDER_FALLBACK,
): [string, string] {
  return [
    `Could not read ${shownPath}: ${message}`,
    `Check the file and its permissions; a file that changed while the folder was read can be sent again.${fallback.sentence}`,
  ];
}

function mthdsTooLarge(shownPath: string, size: number): { message: string; hint: string } {
  return {
    message: `${shownPath} is ${size} bytes, over the ${MAX_FOLDER_MTHDS_FILE_BYTES} bytes one .mthds file may be.`,
    hint: "Split the bundle into smaller .mthds files, or keep a file that is not part of the method out with a .gitignore inside the folder.",
  };
}

/** A template refusal of the planner, at `method_dir` like every refusal of a folder. */
function asFolderRefusal(refusal: TemplateRefusal): { message: string; hint: string } {
  return { message: refusal.message, hint: refusal.hint };
}

/** A tree path as the caller can open it: `method_dir` joined with it. */
function shownUnder(methodDir: string): (treePath: string) => string {
  return (treePath) => path.join(methodDir, ...treePath.split("/"));
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

/** The files at the folder's top first, then every file by tree path byte for byte. */
function topLevelFirst(a: ListedFile, b: ListedFile): number {
  const nested = (file: ListedFile) => (file.path.includes("/") ? 1 : 0);
  return nested(a) - nested(b) || byteOrder(a.path, b.path);
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

async function resolveTemplateFiles(
  rootDir: string,
  templates: readonly SubmittedTemplate[],
  bundle: readonly BundleFileOnDisk[],
  requestBytes: number,
): Promise<TemplateFilesResolution> {
  const root = await workingDirectory(rootDir);
  if (!root.ok) return { ok: false, refusals: [{ message: root.message, hint: root.hint }] };

  const refusals: TemplateRefusal[] = [];
  const located: LocatedTemplate[] = [];
  for (const template of templates) {
    // The widened extension gate, still ahead of any filesystem access.
    const extension = path.extname(template.path).toLowerCase();
    if (!(TEMPLATE_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
      refusals.push({
        index: template.index,
        message: `Path is not a template file: ${template.path}`,
        hint: `A template file is one of ${TEMPLATE_SUFFIXES}. Point at the file a PipeDocGen step names.`,
      });
      continue;
    }
    const target = await containedTarget(rootDir, root.real, template.path, {
      kind: "a template file",
      fallback: TEMPLATE_FALLBACK,
      maxBytes: MAX_TEMPLATE_FILE_BYTES,
    });
    if (!target.ok) {
      refusals.push({ index: template.index, message: target.message, hint: target.hint });
      continue;
    }
    located.push({
      index: template.index,
      path: template.path,
      real: target.real,
      size: target.size,
    });
  }

  const named = await lookUpNamedTemplates(rootDir, bundle);
  const plan = planTemplateFiles(located, named, requestBytes);
  refusals.push(...plan.refusals);
  if (refusals.length > 0) return { ok: false, refusals: sortedByItem(refusals) };

  // Read each file once, whatever number of keys it is sent under, and hold
  // the request to its bounds again on what was read: a file can grow
  // between its stat and its read.
  const bytesByReal = new Map<string, Uint8Array>();
  const read: { key: string; index: number; path: string; size: number; bytes: Uint8Array }[] = [];
  for (const entry of plan.planned) {
    let bytes = bytesByReal.get(entry.real);
    if (bytes === undefined) {
      try {
        const buffer = await fs.readFile(entry.real);
        bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      } catch (err) {
        const failed = readFailure(entry.path, err, TEMPLATE_FALLBACK);
        return {
          ok: false,
          refusals: [{ index: entry.index, message: failed.message, hint: failed.hint }],
        };
      }
      bytesByReal.set(entry.real, bytes);
    }
    read.push({ ...entry, size: bytes.byteLength, bytes });
  }
  const overRead = templateBudgetRefusals(read, requestBytes);
  if (overRead.length > 0) return { ok: false, refusals: overRead };

  const resources: TemplateFiles = {};
  for (const entry of read) resources[entry.key] = entry.bytes;
  return { ok: true, resources };
}

/**
 * Each step's template file, looked up where its `template_file` leads from
 * the directory of the `.mthds` file naming it, by real path. A path the
 * runner refuses is skipped, so no file is sent under it; a missing file is
 * `null`, for the runner to say the step's file was not supplied.
 */
async function lookUpNamedTemplates(
  rootDir: string,
  bundle: readonly BundleFileOnDisk[],
): Promise<NamedTemplate[]> {
  const realDirs = new Map<string, string | null>();
  const named: NamedTemplate[] = [];
  for (const file of bundle) {
    const dir = path.dirname(path.resolve(rootDir, file.path));
    if (!realDirs.has(dir)) realDirs.set(dir, await fs.realpath(dir).catch(() => null));
    const realDir = realDirs.get(dir) ?? null;
    if (realDir === null) continue;
    for (const templateFile of file.named) {
      const key = templateKeyOf(templateFile);
      if (key === undefined) continue;
      const real = await regularFileRealPath(path.join(dir, ...key.split("/")));
      named.push({
        key,
        mthdsPath: file.path,
        real,
        escapes: real !== null && !isInsideRoot(realDir, real),
      });
    }
  }
  return named;
}

/** The real path of a regular file at `target`, or `null` when there is none. */
async function regularFileRealPath(target: string): Promise<string | null> {
  try {
    const real = await fs.realpath(target);
    return (await fs.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Refusals in the order of the items they are about, the whole-submission ones first. */
function sortedByItem(refusals: TemplateRefusal[]): TemplateRefusal[] {
  return [...refusals].sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
}

/** The working directory's real path, resolved once per request. */
async function workingDirectory(
  rootDir: string,
): Promise<{ ok: true; real: string } | { ok: false; message: string; hint: string }> {
  try {
    return { ok: true, real: await fs.realpath(rootDir) };
  } catch (err) {
    return failure(
      `Could not resolve the server's working directory: ${errorMessage(err)}`,
      `The local workshop resolves paths relative to its working directory (${rootDir}), which must exist.`,
    );
  }
}

/** A submitted path that passed the containment and file checks: its real path and its size on the stat. */
type ContainedTarget =
  | { ok: true; real: string; size: number }
  | { ok: false; message: string; hint: string };

/**
 * The checks every read makes after its extension gate: the target exists,
 * its real path lies inside the working directory (whose real path is
 * `rootReal`), it is a regular file, and it is within `maxBytes` when one is
 * set, all before a byte of it is read.
 */
async function containedTarget(
  rootDir: string,
  rootReal: string,
  submitted: string,
  options: { kind: string; fallback: string; maxBytes?: number },
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
      );
    }
    return failure(
      `Could not read file ${submitted}: ${errorMessage(err)}`,
      `Check the file and its permissions, ${fallback}`,
    );
  }

  if (!isInsideRoot(rootReal, real)) {
    return failure(
      `Path resolves outside the server's working directory: ${submitted}`,
      `The local workshop only reads files inside the directory it was started in (${rootDir}). Move the file into the workspace, ${fallback}`,
    );
  }

  try {
    const stats = await fs.stat(real);
    if (!stats.isFile()) {
      return failure(
        `Path is not a regular file: ${submitted}`,
        `Submit the path of ${kind}, ${fallback}`,
      );
    }
    if (maxBytes !== undefined && stats.size > maxBytes) {
      return failure(
        `File is too large: ${submitted} is ${stats.size} bytes, over the ${maxBytes}-byte limit for this argument.`,
        `Shrink the file, ${fallback}`,
      );
    }
    return { ok: true, real, size: stats.size };
  } catch (err) {
    return readFailure(submitted, err, fallback);
  }
}

function readFailure(
  submitted: string,
  err: unknown,
  fallback: string,
): { ok: false; message: string; hint: string } {
  return failure(
    `Could not read file ${submitted}: ${errorMessage(err)}`,
    `Check the file and its permissions, ${fallback}`,
  );
}

function failure(message: string, hint: string): { ok: false; message: string; hint: string } {
  return { ok: false, message, hint };
}
