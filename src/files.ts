import { promises as fs } from "node:fs";
import path from "node:path";

import type { FileResolution, FileResolver } from "./capabilities/shared.js";
import {
  MAX_TEMPLATE_FILE_BYTES,
  TEMPLATE_FILE_EXTENSIONS,
  planTemplateFiles,
  templateBudgetRefusals,
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
  };
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
