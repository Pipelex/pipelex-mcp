import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  FileResolution,
  FileResolver,
  TemplateFileResolution,
} from "./capabilities/shared.js";
import { MAX_TEMPLATE_FILE_BYTES, TEMPLATE_FILE_EXTENSIONS } from "./capabilities/shared.js";
import {
  deepestCommonDirectory,
  errorMessage,
  isInsideRoot,
  isMissingPathError,
} from "./capabilities/workspace-boundary.js";

const MTHDS_EXTENSION = ".mthds";
const INLINE_FALLBACK = "or inline the contents as { content, uri? }.";
const TEMPLATE_SUFFIXES = TEMPLATE_FILE_EXTENSIONS.join(", ");

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
      const target = await containedTarget(rootDir, submitted, {
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
 * bundle's `PipeDocGen` steps name read as bytes through `resolveTemplate`.
 *
 * A template file passes the same three gates as every read, ahead of it, and
 * one more of its own. **What**: its suffix must be one of
 * `TEMPLATE_FILE_EXTENSIONS`, checked on the submitted name before the
 * filesystem is touched, so the widened gate still never opens a `.env`.
 * **Where**: its real path must lie inside the working directory, and also
 * inside the bundle's directory, the deepest one holding the bundle's
 * `.mthds` `{ path }` items, on real paths too, as pipelex's own loader
 * refuses a template file that leaves its bundle's directory: a symlink does
 * not make a file part of the method. **Failure as a value**: every refusal is
 * a {@link TemplateFileResolution}, never a throw. Its size is held to
 * `MAX_TEMPLATE_FILE_BYTES` on the stat, before the read.
 *
 * The key is the template's path relative to that directory, taken from the
 * submitted paths rather than the real ones, so it is the layout the caller
 * named, written with forward slashes: `invoice.mthds` beside
 * `templates/invoice.xlsx` sends `templates/invoice.xlsx`.
 */
export function localBundleFileResolver(rootDir: string = process.cwd()): FileResolver {
  const text = localFileResolver(rootDir, MTHDS_EXTENSION, {
    reads: `.mthds files, and the template files their PipeDocGen steps name (${TEMPLATE_SUFFIXES}) as { path }`,
  });
  return {
    resolve: (submitted) => text.resolve(submitted),
    async resolveTemplate(
      submitted: string,
      bundlePaths: readonly string[],
    ): Promise<TemplateFileResolution> {
      // The widened extension gate, still ahead of any filesystem access.
      const extension = path.extname(submitted).toLowerCase();
      if (!(TEMPLATE_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
        return failure(
          `Path is not a template file: ${submitted}`,
          `A template file is one of ${TEMPLATE_SUFFIXES}. Point at the file a PipeDocGen step names.`,
        );
      }

      // Where the template sits in the bundle, from the submitted paths alone,
      // before anything is opened.
      const bundleDir = deepestCommonDirectory(
        bundlePaths.map((bundlePath) => path.dirname(path.resolve(rootDir, bundlePath))),
      );
      const relative = path.relative(bundleDir, path.resolve(rootDir, submitted));
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return failure(
          `Template file ${submitted} is outside the bundle's directory, ${displayDir(rootDir, bundleDir)}, the deepest directory holding the .mthds files given as { path }.`,
          "A template file is sent under its path relative to that directory, as the step's template_file names it, so it must sit at or under it. Move it into the bundle's directory.",
        );
      }

      const fallback = "or move the file where the step's template_file names it.";
      const target = await containedTarget(rootDir, submitted, {
        kind: "a template file",
        fallback,
        maxBytes: MAX_TEMPLATE_FILE_BYTES,
      });
      if (!target.ok) return target;

      let bundleReal: string;
      try {
        bundleReal = await fs.realpath(bundleDir);
      } catch (err) {
        return failure(
          `Could not resolve the bundle's directory, ${displayDir(rootDir, bundleDir)}: ${errorMessage(err)}`,
          "Check that the .mthds files given as { path } are there.",
        );
      }
      if (!isInsideRoot(bundleReal, target.real)) {
        return failure(
          `Template file ${submitted} resolves to ${target.real}, which is outside the bundle's directory, ${displayDir(rootDir, bundleDir)}. A symlink does not make a file part of the method.`,
          "Copy the template file into the bundle's directory, where the step's template_file names it.",
        );
      }

      try {
        const bytes = await fs.readFile(target.real);
        return {
          ok: true,
          key: relative.split(path.sep).join("/"),
          bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        };
      } catch (err) {
        return readFailure(submitted, err, fallback);
      }
    },
  };
}

/** A submitted path that passed the containment and file checks: its real path. */
type ContainedTarget = { ok: true; real: string } | { ok: false; message: string; hint: string };

/**
 * The checks every read makes after its extension gate: the working directory
 * resolves, the target exists, its real path lies inside the working
 * directory, it is a regular file, and it is within `maxBytes` when one is set,
 * all before a byte of it is read.
 */
async function containedTarget(
  rootDir: string,
  submitted: string,
  options: { kind: string; fallback: string; maxBytes?: number },
): Promise<ContainedTarget> {
  const { kind, fallback, maxBytes } = options;
  let rootReal: string;
  try {
    rootReal = await fs.realpath(rootDir);
  } catch (err) {
    return failure(
      `Could not resolve the server's working directory: ${errorMessage(err)}`,
      `The local workshop resolves paths relative to its working directory (${rootDir}), which must exist.`,
    );
  }

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
  } catch (err) {
    return readFailure(submitted, err, fallback);
  }
  return { ok: true, real };
}

/** The bundle's directory as the caller would name it: relative to the working directory. */
function displayDir(rootDir: string, dir: string): string {
  const relative = path.relative(path.resolve(rootDir), dir);
  return relative === "" ? "." : relative;
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
