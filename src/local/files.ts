import { promises as fs } from "node:fs";
import path from "node:path";

import type { FileResolution, FileResolver } from "../capabilities/shared.js";

const MTHDS_EXTENSION = ".mthds";
const INLINE_FALLBACK = "or inline the contents as { content, uri? }.";

/**
 * The workshop's filesystem-backed {@link FileResolver}. Submitted paths
 * resolve relative to `rootDir` (the server's working directory — the host
 * spawns the stdio server in the workspace). Containment is enforced on real
 * paths (symlinks followed): the resolved target must live inside the
 * `rootDir` subtree. Escapes, missing files, non-regular files, and read
 * failures are reported as {@link FileResolution} failures, never thrown —
 * the seam turns them into `input_domain` errors at `files[i].path`.
 */
export function localFileResolver(rootDir: string = process.cwd()): FileResolver {
  return {
    async resolve(submitted: string): Promise<FileResolution> {
      // The `{ path }` arm is contracted to .mthds files (see filesInputSchema).
      // Enforce that before any filesystem access, so a path pointing at an
      // unrelated local file — a prompt-injected `.env`, `.git/config`, key
      // material — is refused without ever being opened. Containment below only
      // bounds *where* we read; this bounds *what* we read.
      if (path.extname(submitted).toLowerCase() !== MTHDS_EXTENSION) {
        return failure(
          `Path is not a .mthds file: ${submitted}`,
          `The local workshop reads only .mthds files. Point at a .mthds file, ${INLINE_FALLBACK}`,
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
        if (isMissingFileError(err)) {
          return failure(
            `File not found: ${submitted}`,
            `Paths are resolved relative to the MCP server's working directory (${rootDir}). Check the path, ${INLINE_FALLBACK}`,
          );
        }
        return failure(
          `Could not read file ${submitted}: ${errorMessage(err)}`,
          `Check the file and its permissions, ${INLINE_FALLBACK}`,
        );
      }

      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        return failure(
          `Path resolves outside the server's working directory: ${submitted}`,
          `The local workshop only reads files inside the directory it was started in (${rootDir}). Move the file into the workspace, ${INLINE_FALLBACK}`,
        );
      }

      try {
        const stats = await fs.stat(real);
        if (!stats.isFile()) {
          return failure(
            `Path is not a regular file: ${submitted}`,
            `Submit the path of a .mthds file, ${INLINE_FALLBACK}`,
          );
        }
        return { ok: true, content: await fs.readFile(real, "utf8") };
      } catch (err) {
        return failure(
          `Could not read file ${submitted}: ${errorMessage(err)}`,
          `Check the file and its permissions, ${INLINE_FALLBACK}`,
        );
      }
    },
  };
}

function failure(message: string, hint: string): FileResolution {
  return { ok: false, message, hint };
}

// ENOENT: the file (or a path component) does not exist. ENOTDIR: a path
// component that should be a directory is not one — the target equally does
// not exist at that path.
function isMissingFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
