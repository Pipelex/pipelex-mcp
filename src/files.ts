import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { MAX_FOLDER_MTHDS_FILE_BYTES, MAX_FOLDER_MTHDS_FILES } from "./capabilities/shared.js";
import type { FileResolution, FileResolver, MethodDirResolution } from "./capabilities/shared.js";
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
import { MAX_METHOD_TREE_ENTRIES, listMethodTree } from "./method-tree.js";
import type { MethodTreeFile } from "./method-tree.js";

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
 * rather than per call: every bundle argument is `.mthds`, and
 * `mthds_save_method`'s `python` is `.py`. It is deliberately not reachable
 * from the MCP surface — a tool input that named the extension would turn the
 * read boundary into something the model picks, which is the opposite of what
 * it is for. `mthds_run` and `mthds_prepare_inputs`'s `inputs_path` is the
 * third arm, `.json`, built with its own fallback wording and a size cap. The
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
      // bundle argument, `.py` for `mthds_save_method`'s `python`. Enforce it
      // before any filesystem access, so a path pointing at an unrelated local
      // file — a prompt-injected `.env`, `.git/config`, key material — is refused
      // without ever being opened. Containment below only bounds *where* we read;
      // this bounds *what* we read, and a caller that could choose the extension
      // would have neither bound. `inputs_path` is gated on `.json` the same way.
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
  };
}

const FOLDER_FALLBACK = "or list the method's files in files.";

const FOLDER_COUNT_HINT =
  "The folder sends every template file its PipeDocGen steps name, and they name more than one request takes: have the steps share template files, or split the method.";

/** Refusals of a method folder shown by name, the rest counted. */
const MAX_LISTED_PATHS = 5;

/**
 * Read a method folder, `method_dir`, whole: the `.mthds` files the membership
 * rule keeps (`listMethodTree` in `src/method-tree.ts`) and the template files
 * their `PipeDocGen` steps name, and nothing else of it, since the runner
 * refuses a file no step names. Everything is decided before a byte is read.
 *
 * - **Where.** The folder is resolved against the working directory and must
 *   lie inside it on its real path, as every read must, and be a directory
 *   holding a `.mthds` member at its top.
 * - **What.** Only `.mthds` members and template files are read, and a
 *   template file only when a step names it, by the suffix of the name the
 *   step writes, so no step can make the workshop read a `.env` or a key: the
 *   read side's extension gate, applied to names the folder supplies. A
 *   symbolic link the rule does not exclude refuses the folder, so every file
 *   read is a regular file under it, opened without following a link that
 *   appeared since the walk.
 * - **The templates** are looked up as `lookUpNamedTemplates` looks them up,
 *   where each step's `template_file` leads from the directory of the
 *   `.mthds` file naming it, but among the tree's members rather than on disk:
 *   a template the rule excludes is not in the method, and one that is not
 *   there is left for the runner to report as not supplied. Each is keyed by
 *   the step naming it (`planTemplateFiles`), so a bundle in a subfolder keys
 *   its templates as with the file list.
 * - **How much.** The template files are held to the request's bounds
 *   (`templateBudgetRefusals`) on their sizes in the walk and again on the
 *   bytes read, and the `.mthds` files to the runner's count and per-file
 *   size, since a folder can hold more of them than the agent thought of.
 *
 * The `.mthds` files are sent top level first, then by tree path, so the
 * folder's own bundle leads, the one whose `main_pipe` a run defaults to when
 * several declare one. `sent` lists them, then the template files.
 */
async function resolveMethodFolder(
  rootDir: string,
  methodDir: string,
): Promise<MethodDirResolution> {
  const refuse = (message: string, hint: string): MethodDirResolution => ({
    ok: false,
    refusals: [{ message, hint }],
  });
  const shown = (treePath: string): string => path.join(methodDir, ...treePath.split("/"));

  const root = await workingDirectory(rootDir);
  if (!root.ok) return refuse(root.message, root.hint);

  let folder: string;
  try {
    folder = await fs.realpath(path.resolve(rootDir, methodDir));
  } catch (err) {
    return isMissingPathError(err)
      ? refuse(
          `Folder not found: ${methodDir}`,
          `method_dir is resolved against the MCP server's working directory (${rootDir}). Check the path, ${FOLDER_FALLBACK}`,
        )
      : refuse(
          `Could not read folder ${methodDir}: ${errorMessage(err)}`,
          `Check the folder and its permissions, ${FOLDER_FALLBACK}`,
        );
  }
  if (!isInsideRoot(root.real, folder)) {
    return refuse(
      `method_dir resolves outside the server's working directory: ${methodDir}`,
      `The local workshop only reads folders inside the directory it was started in (${rootDir}). Move the method into the workspace, ${FOLDER_FALLBACK}`,
    );
  }
  try {
    if (!(await fs.stat(folder)).isDirectory()) {
      return refuse(
        `method_dir is not a directory: ${methodDir}`,
        "Pass the folder holding the method's .mthds files, or give a single .mthds file in files as { path }.",
      );
    }
  } catch (err) {
    return refuse(
      `Could not read folder ${methodDir}: ${errorMessage(err)}`,
      `Check the folder and its permissions, ${FOLDER_FALLBACK}`,
    );
  }

  const tree = await listMethodTree(folder);
  if (!tree.ok) {
    return refuse(
      `Could not read ${shown(tree.path)} in the method's folder: ${tree.message}`,
      `Check its permissions, or keep it out of the method with a .gitignore inside the folder; ${FOLDER_FALLBACK}`,
    );
  }
  const { files, symlinks, nestedRepositories, truncated, rootIsVirtualEnvironment } = tree.listing;
  if (rootIsVirtualEnvironment) {
    return refuse(
      `${methodDir} holds a pyvenv.cfg file, which makes it a Python virtual environment, and nothing in one is part of a method's folder.`,
      `Pass the folder holding the method's .mthds files, outside the virtual environment, ${FOLDER_FALLBACK}`,
    );
  }
  const mthds = files.filter((file) => isMthdsPath(file.path)).sort(topLevelFirst);

  if (!mthds.some((file) => !file.path.includes("/")) && !truncated) {
    const deeper = mthds.map((file) => shown(file.path));
    return refuse(
      `${methodDir} holds no .mthds file at its top${deeper.length > 0 ? `; it holds ${listed(deeper)} further down` : ""}.`,
      `Pass the folder whose top holds the method's .mthds file. Files whose names start with a dot, and what the folder's .gitignore files exclude, are not part of it; ${FOLDER_FALLBACK}`,
    );
  }
  if (truncated) {
    return refuse(
      `${methodDir} holds more than ${MAX_METHOD_TREE_ENTRIES} files and folders besides what it excludes, more than a method's folder holds.`,
      `Point method_dir at the method's own folder, or keep the rest out with a .gitignore inside the folder; ${FOLDER_FALLBACK}`,
    );
  }
  if (symlinks.length > 0) {
    return refuse(
      `The method's folder holds ${symlinks.length === 1 ? "a symbolic link" : `${symlinks.length} symbolic links`}: ${listed(symlinks.map(shown))}.`,
      "A link in a method's folder is refused, never followed: replace it with the file it points at, or keep it out with a name starting with a dot or a .gitignore line inside the folder, written without a trailing slash (node_modules, not node_modules/), since git matches a link as a file.",
    );
  }
  if (mthds.length > MAX_FOLDER_MTHDS_FILES) {
    return refuse(
      `${methodDir} holds ${mthds.length} .mthds files, over the ${MAX_FOLDER_MTHDS_FILES} one request takes: ${listed(mthds.map((file) => shown(file.path)))}.`,
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
    const read = await readMember(folder, file.path);
    if (!read.ok) return refuse(...memberReadFailure(shown(file.path), read.message));
    if (read.bytes.byteLength > MAX_FOLDER_MTHDS_FILE_BYTES) {
      return { ok: false, refusals: [mthdsTooLarge(shown(file.path), read.bytes.byteLength)] };
    }
    const content = Buffer.from(read.bytes).toString("utf8");
    if (content.trim() === "") {
      return refuse(
        `${shown(file.path)} is empty.`,
        "Write the bundle into the .mthds file, or keep it out of the method with a .gitignore inside the folder.",
      );
    }
    bundle.push({ treePath: file.path, path: shown(file.path), content });
  }

  // The template files the steps name, among the tree's members. The lookup
  // is case-sensitive, as on the runner's filesystem, whatever this one does,
  // but blind to Unicode normalization: a name is compared in NFC, as git
  // records a macOS file whose name the disk holds decomposed, and as a path
  // in files reaches the same file on such a disk. A member is read by its
  // name on disk and sent under the step's key, as files does.
  const members = new Map<string, MethodTreeFile>();
  const membersByFoldedPath = new Map<string, string>();
  for (const file of files) {
    const composed = file.path.normalize("NFC");
    if (!members.has(composed)) members.set(composed, file);
    const folded = composed.toLowerCase();
    if (!membersByFoldedPath.has(folded)) membersByFoldedPath.set(folded, file.path);
  }
  const named: NamedTemplate[] = [];
  const located = new Map<string, LocatedTemplate>();
  const treePathByReal = new Map<string, string>();
  const lookupRefusals = new Map<string, { message: string; hint: string }>();
  for (const file of bundle) {
    const dir = path.posix.dirname(file.treePath);
    for (const templateFile of templateFilesNamedBy(file.content)) {
      const key = templateKeyOf(templateFile);
      if (key === undefined) continue;
      const treePath = dir === "." ? key : `${dir}/${key}`;
      const member = isTemplateFilePath(key) ? members.get(treePath.normalize("NFC")) : undefined;
      if (member === undefined && isTemplateFilePath(key)) {
        const refusal = missedTemplateRefusal(
          shown,
          file.treePath,
          templateFile,
          treePath,
          nestedRepositories,
          membersByFoldedPath,
        );
        if (refusal !== undefined) lookupRefusals.set(`${file.treePath}\0${treePath}`, refusal);
      }
      const real = member === undefined ? null : path.join(folder, ...member.path.split("/"));
      named.push({ key, mthdsPath: file.path, real, escapes: false });
      if (member !== undefined && real !== null && !located.has(member.path)) {
        treePathByReal.set(real, member.path);
        located.set(member.path, {
          index: located.size,
          path: shown(member.path),
          real,
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
  const bytesByReal = new Map<string, Uint8Array>();
  const read: { key: string; index: number; path: string; size: number; bytes: Uint8Array }[] = [];
  for (const entry of plan.planned) {
    let bytes = bytesByReal.get(entry.real);
    if (bytes === undefined) {
      const outcome = await readMember(folder, treePathByReal.get(entry.real) ?? "");
      if (!outcome.ok) return refuse(...memberReadFailure(entry.path, outcome.message));
      bytes = outcome.bytes;
      bytesByReal.set(entry.real, bytes);
    }
    read.push({ ...entry, size: bytes.byteLength, bytes });
  }
  const overRead = templateBudgetRefusals(read, requestBytes, { countHint: FOLDER_COUNT_HINT });
  if (overRead.length > 0) return { ok: false, refusals: overRead.map(asFolderRefusal) };

  const resources: TemplateFiles = {};
  for (const entry of read) resources[entry.key] = entry.bytes;
  const sentTemplates = templates
    .filter((template) => bytesByReal.has(template.real))
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
 * everything under it, or the folder holds the file spelled in another case,
 * which a case-insensitive filesystem would open here and a case-sensitive
 * runner would not. Names are compared in NFC, so a case near-miss is one of
 * case alone.
 */
function missedTemplateRefusal(
  shown: (treePath: string) => string,
  mthdsTreePath: string,
  templateFile: string,
  treePath: string,
  nestedRepositories: readonly string[],
  membersByFoldedPath: ReadonlyMap<string, string>,
): { message: string; hint: string } | undefined {
  const step = `A PipeDocGen step of ${shown(mthdsTreePath)} names the template_file "${templateFile}"`;
  const composed = treePath.normalize("NFC");
  const repository = nestedRepositories.find((repo) =>
    composed.startsWith(`${repo.normalize("NFC")}/`),
  );
  if (repository !== undefined) {
    return {
      message: `${step}, which leads into ${shown(repository)}, a nested git repository: a directory holding a .git entry is not part of the method's folder.`,
      hint: "Move the template file out of the nested repository into the method's folder, or pass method_dir for a folder that is not a repository's parent.",
    };
  }
  // Only a difference of case is refused: the lookup already reads both
  // Unicode normalizations of a name as one.
  const spelled = membersByFoldedPath.get(composed.toLowerCase());
  if (spelled !== undefined && spelled.normalize("NFC") !== composed) {
    return {
      message: `${step}, which leads to ${shown(treePath)}, and the folder holds ${shown(spelled)}, spelled in another case.`,
      hint: "Template files are matched case-sensitively, as the runner reads them: make the step's template_file and the file's name agree letter for letter.",
    };
  }
  return undefined;
}

/**
 * Read one member of a method folder by its tree path, refusing to follow a
 * symbolic link that took the place of the regular file the walk saw. A link
 * swapped into a directory component in between is the residual SPEC.md's
 * read side accepts.
 */
async function readMember(
  folder: string,
  treePath: string,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }> {
  let handle;
  try {
    handle = await fs.open(path.join(folder, ...treePath.split("/")), READ_NO_FOLLOW);
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
  try {
    if (!(await handle.stat()).isFile()) return { ok: false, message: "not a regular file" };
    const buffer = await handle.readFile();
    return { ok: true, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  } finally {
    await handle.close();
  }
}

/** Open for reading without following a final symbolic link; Windows has no such flag. */
const READ_NO_FOLLOW =
  fsConstants.O_RDONLY | ((fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

function memberReadFailure(shownPath: string, message: string): [string, string] {
  return [
    `Could not read ${shownPath}: ${message}`,
    `Check the file and its permissions; a file that changed while the folder was read can be sent again. ${FOLDER_FALLBACK.replace(/^or /, "Or ")}`,
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

/** A few paths by name, the rest counted. */
function listed(paths: readonly string[]): string {
  const head = paths.slice(0, MAX_LISTED_PATHS).join(", ");
  return paths.length > MAX_LISTED_PATHS
    ? `${head}, and ${paths.length - MAX_LISTED_PATHS} more`
    : head;
}

function isMthdsPath(treePath: string): boolean {
  return path.posix.extname(treePath).toLowerCase() === MTHDS_EXTENSION;
}

/** The files at the folder's top first, then every file by tree path byte for byte. */
function topLevelFirst(a: MethodTreeFile, b: MethodTreeFile): number {
  const nested = (file: MethodTreeFile) => (file.path.includes("/") ? 1 : 0);
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
