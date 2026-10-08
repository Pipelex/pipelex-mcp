import { promises as fs } from "node:fs";
import path from "node:path";

import type { FileResolution, FileResolver } from "./capabilities/shared.js";
import {
  errorMessage,
  isInsideRoot,
  isMissingPathError,
} from "./capabilities/workspace-boundary.js";

const MTHDS_EXTENSION = ".mthds";
const INLINE_FALLBACK = "or inline the contents as { content, uri? }.";

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
 * third arm, `.json`, built with its own fallback wording and a size cap.
 */
export function localFileResolver(
  rootDir: string = process.cwd(),
  extension: string = MTHDS_EXTENSION,
  options: LocalFileResolverOptions = {},
): FileResolver {
  const fallback = options.fallback ?? INLINE_FALLBACK;
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
          `This argument reads only ${extension} files. Point at a ${extension} file, ${fallback}`,
        );
      }

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
            `Submit the path of a ${extension} file, ${fallback}`,
          );
        }
        if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
          return failure(
            `File is too large: ${submitted} is ${stats.size} bytes, over the ${options.maxBytes}-byte limit for this argument.`,
            `Shrink the file, ${fallback}`,
          );
        }
        return { ok: true, content: await fs.readFile(real, "utf8") };
      } catch (err) {
        return failure(
          `Could not read file ${submitted}: ${errorMessage(err)}`,
          `Check the file and its permissions, ${fallback}`,
        );
      }
    },
  };
}

function failure(message: string, hint: string): FileResolution {
  return { ok: false, message, hint };
}
