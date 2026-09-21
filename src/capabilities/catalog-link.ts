import { promises as fs } from "node:fs";
import path from "node:path";

import { errorMessage, isInsideRoot, isMissingPathError } from "./workspace-boundary.js";

/**
 * `pipelex-method.json` — the file that makes a directory *this* saved method,
 * written by `mthds_save_method` and `mthds_get_method` and by nobody else.
 *
 * It is meant to be COMMITTED. A team shares an organization, so the link is
 * what lets the second person update the method the first one saved instead of
 * creating a second one under the same name; an id grants nothing without the
 * organization's key, which is why committing it is safe.
 *
 * The workshop writes it because the workshop is the only party that knows
 * which API host it is talking to. That is also what makes an unknown id
 * diagnosable later: a link made against one plane, or with another
 * organization's key, reports the host it recorded rather than reading as a
 * method that vanished.
 *
 * It records NO source hashes, deliberately, and the cost is stated rather
 * than hidden — see `guardOutputDir` in `catalog-write.ts`, whose three-outcome
 * rule can tell "the stored method moved" from "this directory moved" only by
 * the recorded `synced_updated_at`, and so cannot say which side a difference
 * came from once both have moved.
 */

export const LINK_FILE_NAME = "pipelex-method.json";

const LINK_COMMENT =
  "Written by the Pipelex workshop (@pipelex/mcp). This directory is saved on Pipelex as the method below. " +
  "Commit this file so that a teammate updates the same method instead of creating a second one. Do not hand-edit it.";

const LINK_GENERATOR = "pipelex-mcp";

export interface MethodLink {
  comment: string;
  generator: string;
  api_host: string;
  method_id: string;
  name: string;
  /** The saved method's `updated_at` as of the last save or pull through this directory. */
  synced_updated_at: string;
  /**
   * Set while a pull is landing files, cleared when it finishes.
   *
   * A pull writes several files and can fail between two of them. Without this
   * the half-written directory holds `.mthds` files and no link, which the
   * ownership guard reads as somebody else's bundle — so the retry the failure
   * advertises is refused and the caller has nowhere to go. The marker says
   * "these files are an interrupted pull of this same method", which is the one
   * state where writing over them destroys nothing the catalog does not hold.
   */
  partial_pull?: boolean;
}

export interface LinkFileReport {
  /** Where the link went, relative to the working directory. */
  path: string;
  written: boolean;
  reason?: string;
}

export function buildMethodLink(fields: {
  apiHost: string;
  methodId: string;
  name: string;
  syncedUpdatedAt: string;
  partialPull?: boolean;
}): MethodLink {
  return {
    comment: LINK_COMMENT,
    generator: LINK_GENERATOR,
    api_host: fields.apiHost,
    method_id: fields.methodId,
    name: fields.name,
    synced_updated_at: fields.syncedUpdatedAt,
    ...(fields.partialPull === true ? { partial_pull: true } : {}),
  };
}

/**
 * The host of the configured base URL, which is what the link records — not the
 * whole URL, because the port and path are deployment detail and the host is
 * the part that tells a reader which plane an id belongs to. An unparseable
 * base URL yields the raw string: a link that records something odd is more
 * useful than one that records nothing.
 */
export function apiHostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Write the link file, reporting failure as a value.
 *
 * A failed write NEVER fails the save. The method is already stored by then,
 * and answering `status: "error"` would tell the caller their save did not
 * happen — the one thing that is certainly untrue. So the failure is reported
 * in `link_file` with its reason, and the summary says the directory is not
 * linked, which is the consequence the caller has to act on: the next save
 * would create a second method unless they pass the id.
 */
export async function writeMethodLink(
  root: string,
  dir: string,
  link: MethodLink,
): Promise<LinkFileReport> {
  const absolute = path.join(dir, LINK_FILE_NAME);
  const relative = path.relative(root, absolute);
  // Containing the DIRECTORY does not contain the leaf: a `pipelex-method.json`
  // that is already a symlink sends this write wherever it points, which on the
  // save path replaces a file the user owns with link JSON. The refusal lives
  // here rather than at either call site so both inherit it.
  const foreign = await foreignEntryReason(absolute);
  if (foreign !== undefined) {
    return { path: relative, written: false, reason: foreign };
  }
  try {
    await fs.writeFile(absolute, `${JSON.stringify(link, null, 2)}\n`, "utf8");
    return { path: relative, written: true };
  } catch (err) {
    return { path: relative, written: false, reason: errorMessage(err) };
  }
}

/**
 * Why this existing entry may not be written through, or `undefined` when it is
 * absent or an ordinary file.
 *
 * `lstat`, never `stat`: a write through a symlink lands at the link's target,
 * so a symlink is foreign by construction however contained its own path looks.
 * This is `codegen-writer.ts`'s rule, applied to the files a pull lands.
 */
export async function foreignEntryReason(absolute: string): Promise<string | undefined> {
  let entry;
  try {
    entry = await fs.lstat(absolute);
  } catch (err) {
    return isMissingPathError(err) ? undefined : errorMessage(err);
  }
  if (entry.isSymbolicLink()) {
    return "it is a symlink, and writing through it would land outside this directory";
  }
  if (!entry.isFile()) {
    return "it is not a regular file";
  }
  return undefined;
}

export type LinkRead =
  | { kind: "none" }
  | { kind: "link"; link: MethodLink }
  | { kind: "unreadable"; reason: string };

/**
 * Read a directory's link file.
 *
 * A malformed or foreign-shaped link is `unreadable`, never `none`: the two
 * lead to opposite decisions — `none` lets a pull write, `unreadable` must
 * refuse — and a link nobody can parse is evidence that *something* claims the
 * directory, which is exactly when writing over it is wrong.
 */
export async function readMethodLink(dir: string): Promise<LinkRead> {
  const absolute = path.join(dir, LINK_FILE_NAME);
  // A symlinked link file is `unreadable`, not `none`: something else claims
  // this directory, and following it would let a foreign file decide ownership
  // — and then be overwritten by the link write that follows.
  const foreign = await foreignEntryReason(absolute);
  if (foreign !== undefined) {
    return { kind: "unreadable", reason: foreign };
  }

  let text: string;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch (err) {
    if (isMissingPathError(err)) {
      return { kind: "none" };
    }
    return { kind: "unreadable", reason: errorMessage(err) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: "unreadable", reason: `it is not valid JSON (${errorMessage(err)})` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unreadable", reason: "it is not a JSON object" };
  }
  const row = parsed as Record<string, unknown>;
  for (const field of ["method_id", "name", "api_host", "synced_updated_at"] as const) {
    if (typeof row[field] !== "string") {
      return { kind: "unreadable", reason: `it has no string \`${field}\`` };
    }
  }

  return {
    kind: "link",
    link: {
      comment: typeof row.comment === "string" ? row.comment : LINK_COMMENT,
      generator: typeof row.generator === "string" ? row.generator : LINK_GENERATOR,
      api_host: row.api_host as string,
      method_id: row.method_id as string,
      name: row.name as string,
      synced_updated_at: row.synced_updated_at as string,
      ...(row.partial_pull === true ? { partial_pull: true } : {}),
    },
  };
}

/**
 * Which of these destinations already exist — "is anything this pull would land
 * on already here".
 *
 * This deliberately replaces a top-level `.mthds` scan. The question the guard
 * has to answer is about the set the write loop lands, which includes `.py`
 * files and nested paths; a directory holding the user's own `helpers.py`, or a
 * `nested/other.mthds`, has no top-level `.mthds` file and so read as empty
 * while the loop overwrote it. Asking each destination is the same question the
 * action asks.
 */
export async function existingDestinations(
  destinations: readonly { name: string; absolute: string }[],
): Promise<string[]> {
  const present: string[] = [];
  for (const destination of destinations) {
    try {
      await fs.lstat(destination.absolute);
      present.push(destination.name);
    } catch {
      // Absent (or unstattable, which the write itself will report).
    }
  }
  return present;
}

/** The joined destination when it stays inside `dir`; `undefined` when it escapes. */
export function containedInDir(dir: string, relative: string): string | undefined {
  const absolute = path.resolve(dir, relative);
  return isInsideRoot(dir, absolute) && absolute !== dir ? absolute : undefined;
}
