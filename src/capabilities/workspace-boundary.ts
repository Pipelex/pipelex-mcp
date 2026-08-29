import { promises as fs } from "node:fs";
import path from "node:path";

import type { ToolError } from "./shared.js";

/**
 * The containment boundary every filesystem-touching capability shares.
 *
 * Three tools reach the disk on the local workshop — `{ path }` file reads
 * (`local/files.ts`), run-artifact downloads (`capabilities/artifacts.ts`) and
 * generated-tree writes (`capabilities/codegen-writer.ts`) — and all three ask
 * the same question: does this path stay inside the directory the host started
 * the server in, on REAL paths, with symlinks followed? That question, and
 * only that question, lives here.
 *
 * What deliberately does NOT live here is write POLICY. The two writers are
 * inverted on purpose: `mthds_download_artifacts` never overwrites (`wx`, a
 * numeric suffix on collision) because its filenames come from a storage key,
 * while `mthds_codegen` must overwrite its own previous output and only that,
 * because its paths come from the engine and the lock hashes them. One shared
 * "write a file" helper would either suffix a regeneration or let a download
 * clobber, so the fold stops at containment.
 */

/** Whether `candidate` (an absolute, already-real path) is `root` itself or inside it. */
export function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export type AncestorCheck =
  | { ok: true }
  | { ok: false; reason: "escape" }
  | { ok: false; reason: "unusable"; err: unknown };

/**
 * Where does the deepest EXISTING ancestor of `target` really live?
 *
 * This is the rule that has to run BEFORE anything creates a directory, and
 * the reason it lives here rather than inside either caller: `mkdir -p
 * root/link/sub`, with `link` a symlink pointing out of `root`, creates `sub`
 * at the link's target. A real-path check that runs only AFTER the creation
 * refuses a write that has already mutated the filesystem where it must not —
 * it reports the escape instead of preventing it.
 *
 * A missing path is not an answer, so the walk climbs to the deepest component
 * that does exist. `escape` means that component resolves outside `root`;
 * `unusable` carries the error for a path that failed for any other reason.
 */
export async function checkDeepestExistingAncestor(
  root: string,
  target: string,
): Promise<AncestorCheck> {
  let probe = target;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      return isInsideRoot(root, real) ? { ok: true } : { ok: false, reason: "escape" };
    } catch (err) {
      if (!isMissingPathError(err)) {
        return { ok: false, reason: "unusable", err };
      }
      const parent = path.dirname(probe);
      // Climbed past the filesystem root without finding anything that exists:
      // nothing anchors this path inside `root`.
      if (parent === probe) {
        return { ok: false, reason: "escape" };
      }
      probe = parent;
    }
  }
}

export type SaveDirResolution =
  | { ok: true; root: string; dir: string }
  | { ok: false; error: ToolError };

/**
 * Turn an optional relative `dir` into an absolute, existing directory inside
 * `saveRoot`, on REAL paths (symlinks followed) — the write-side mirror of the
 * read resolver's containment rule. The lexical check refuses a `..` escape
 * before anything touches the filesystem; the real-path check on the deepest
 * existing ancestor refuses a symlink inside the workspace that points out of
 * it BEFORE `mkdir` could create directories at its target; a final real-path
 * check on the created directory closes the window between the two.
 *
 * `location` is the caller's own input field (`dir` for the download tool,
 * `output_dir` for codegen), so a refusal locates at the value the caller
 * actually typed. Failures are `input_domain` there — except an unusable
 * `saveRoot`, which is the deployment's fault, not the caller's.
 *
 * This is the ONE call in either writer that creates a directory, and it
 * creates only the requested one. Containment without creation is
 * {@link isInsideRoot}, which is what lets a caller contain every destination
 * before deciding whether to write any of them.
 */
export async function resolveSaveDir(
  saveRoot: string,
  dir: string | undefined,
  location: string,
): Promise<SaveDirResolution> {
  let root: string;
  try {
    root = await fs.realpath(saveRoot);
  } catch (err) {
    return {
      ok: false,
      error: {
        class: "config",
        location: "deployment",
        message: `Could not resolve the server's working directory: ${errorMessage(err)}`,
        hint: `The local workshop works under its working directory (${saveRoot}), which must exist.`,
        retryable: false,
      },
    };
  }

  if (dir === undefined) {
    return { ok: true, root, dir: root };
  }

  const target = path.resolve(root, dir);
  if (!isInsideRoot(root, target)) {
    return { ok: false, error: escapeError(dir, root, location) };
  }

  const ancestor = await checkDeepestExistingAncestor(root, target);
  if (!ancestor.ok) {
    return {
      ok: false,
      error:
        ancestor.reason === "escape"
          ? escapeError(dir, root, location)
          : unusableDirError(dir, ancestor.err, location),
    };
  }

  let real: string;
  try {
    await fs.mkdir(target, { recursive: true });
    real = await fs.realpath(target);
    if (!(await fs.stat(real)).isDirectory()) {
      return {
        ok: false,
        error: {
          class: "input_domain",
          location,
          message: `${location} is not a directory: ${dir}`,
          hint: "Pass a directory (existing or new) relative to the server's working directory.",
          retryable: false,
        },
      };
    }
  } catch (err) {
    return { ok: false, error: unusableDirError(dir, err, location) };
  }

  if (!isInsideRoot(root, real)) {
    return { ok: false, error: escapeError(dir, root, location) };
  }

  return { ok: true, root, dir: real };
}

export function escapeError(dir: string, root: string, location: string): ToolError {
  return {
    class: "input_domain",
    location,
    message: `${location} resolves outside the server's working directory: ${dir}`,
    hint: `Files stay inside the directory the host started this server in (${root}). Pass a relative directory that stays inside it.`,
    retryable: false,
  };
}

export function unusableDirError(dir: string, err: unknown, location: string): ToolError {
  return {
    class: "input_domain",
    location,
    message: `Could not use ${location} ${dir}: ${errorMessage(err)}`,
    hint: "Check that the directory (or the path to create it) is writable and not a file.",
    retryable: false,
  };
}

// ENOENT: the path (or a component) does not exist. ENOTDIR: a component that
// should be a directory is not one — the target equally does not exist there.
export function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
