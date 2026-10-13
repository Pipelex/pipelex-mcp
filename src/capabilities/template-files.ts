import path from "node:path";

import { parse as parseToml } from "smol-toml";

import { GATEWAY_REQUEST_LIMIT_BYTES, base64EncodedLength, formatMib } from "./upload-ceiling.js";

/**
 * A bundle's template files: what a `PipeDocGen` step fills, sent beside the
 * bundle's `.mthds` files as the request's `resources`.
 *
 * This module holds what deciding them needs that touches no disk: which
 * submitted paths are template files, which template files each `.mthds`
 * file's steps name, the key each is sent under, and the planner that matches
 * the submitted files to the steps and holds them to the request's bounds.
 * The reads are the resolver's (`localBundleFileResolver` in `src/files.ts`),
 * which hands this planner what it found on disk.
 */

const MIB = 1024 * 1024;

/**
 * The suffixes of the template files a `PipeDocGen` step reads beside its
 * bundle: an HTML template for a PDF, the office file itself for a workbook, a
 * document or a deck. The runner's own list is `DocGenFormat.template_file_suffix`
 * in pipelex (`pipelex/cogt/doc_gen/doc_gen_format.py`), one suffix per format.
 * The `files` argument of the method-taking tools reads these, and only these,
 * besides `.mthds`: it is the extension gate of the read side, widened on
 * purpose, so a suffix a new format brings is added here deliberately.
 */
export const TEMPLATE_FILE_EXTENSIONS = [".html", ".xlsx", ".docx", ".pptx"] as const;

/**
 * The runner's default limits on the files sent with a bundle (`pipelex-api`'s
 * `limits.py`): 32 files, 5 MiB each and 10 MiB in all. A deployment may
 * configure larger ones, which this server cannot see; the defaults are what
 * every deployment the workshop targets runs.
 */
export const MAX_TEMPLATE_FILES = 32;
export const MAX_TEMPLATE_FILE_BYTES = 5 * MIB;
export const MAX_TEMPLATE_FILES_TOTAL_BYTES = 10 * MIB;

/**
 * Room, beside the template files and the `.mthds` contents, for the rest of a
 * request's JSON: its keys and quoting, the escapes in the contents, and a
 * run's or a template's small fields. A run's inputs ride the same body and are
 * not counted, so a request whose inputs fill the rest still meets the
 * gateway's `413`.
 */
export const REQUEST_ENVELOPE_ALLOWANCE_BYTES = 64 * 1024;

/** Whether `submitted` names a template file by its suffix, case-insensitively, the way the read gate does. */
export function isTemplateFilePath(submitted: string): boolean {
  const extension = path.extname(submitted).toLowerCase();
  return (TEMPLATE_FILE_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * The paths of the template files the steps of one `.mthds` file name: each
 * `PipeDocGen` pipe's `template_file`, as written. A file that does not parse
 * names none, the runner giving its own verdict on it. The SDK's `.mthds` check
 * hook reads a bundle the same way (`templateFilesNamedBy` in `@pipelex/sdk`'s
 * `hooks/bundle-gather.ts`), so the two never disagree about which step names
 * which file.
 */
export function templateFilesNamedBy(mthdsContent: string): string[] {
  let document: unknown;
  try {
    document = parseToml(mthdsContent);
  } catch {
    return [];
  }
  const pipes = isRecord(document) ? document["pipe"] : undefined;
  if (!isRecord(pipes)) return [];
  const named: string[] = [];
  for (const pipe of Object.values(pipes)) {
    if (
      isRecord(pipe) &&
      pipe["type"] === "PipeDocGen" &&
      typeof pipe["template_file"] === "string"
    ) {
      named.push(pipe["template_file"]);
    }
  }
  return named;
}

/**
 * The key a step's `template_file` is sent under: the path with its `.`
 * segments and repeated slashes collapsed, or `undefined` for a path no file
 * inside the bundle can have (empty, absolute, holding a backslash, a colon, a
 * NUL character or a `..` segment), which the runner refuses at load, so no
 * submitted file is ever sent under it. It restates the runner's rule
 * (`resource_path_refusal` in pipelex's `bundle_resource.py`), which the SDK
 * holds as `bundleResourcePathRefusal` and `canonicalBundleResourcePath` but
 * does not export; its whitespace test is JavaScript's `trim`, close enough for
 * a path that is only matched against files on disk.
 */
export function templateKeyOf(named: string): string | undefined {
  if (named.trim() === "") return undefined;
  if (/[\\:\0]/.test(named) || named.startsWith("/")) return undefined;
  const segments = named.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  return segments.join("/");
}

/** A bundle's template files, keyed by the path a step names, each as its bytes: the request's `resources`. */
export type TemplateFiles = Record<string, Uint8Array>;

/** A `.mthds` file read from disk, by its submitted path, with the `template_file` of each of its `PipeDocGen` steps. */
export interface BundleFileOnDisk {
  path: string;
  named: readonly string[];
}

/** A `{ path }` item carrying a template suffix, at its index in `files`. */
export interface SubmittedTemplate {
  index: number;
  path: string;
}

/**
 * Why a submitted template file is not sent: at its item when `index` is set,
 * and at `files` as a whole otherwise. Failures are values, as every
 * resolution failure is; the core fixes the class and the locator.
 */
export interface TemplateRefusal {
  index?: number;
  message: string;
  hint: string;
}

export type TemplateFilesResolution =
  | { ok: true; resources: TemplateFiles }
  | { ok: false; refusals: TemplateRefusal[] };

/** A submitted template file found on disk: a regular file inside the working directory, by its real path and its size on the stat. */
export interface LocatedTemplate {
  index: number;
  path: string;
  real: string;
  size: number;
}

/**
 * One step's template file, looked up beside the `.mthds` file naming it:
 * `real` is the file's real path, `null` when nothing is there, and `escapes`
 * says that real path leaves the real directory of that `.mthds` file, through
 * a symlink, which pipelex's own loader refuses.
 */
export interface NamedTemplate {
  key: string;
  mthdsPath: string;
  real: string | null;
  escapes: boolean;
}

/** One entry the request will carry: a submitted template file under the key a step names it by. */
export interface PlannedTemplate {
  key: string;
  index: number;
  path: string;
  real: string;
  size: number;
}

const ONLY_NAMED_HINT =
  "Send only the template files the bundle's PipeDocGen steps name. A template file is sent under the step's template_file, and found where that path leads from the directory of the .mthds file holding the step, which must be given as { path }.";

/**
 * Match the submitted template files to the steps naming them, and hold what
 * the request would carry to its bounds, all before a byte of any is read.
 *
 * - A submitted file is sent under the `template_file` of every step whose
 *   `dirname(<.mthds path>)/<template_file>` is the same real file, so a bundle
 *   whose `.mthds` files sit in several directories keys each template as the
 *   step naming it does.
 * - The same real file submitted twice, under any spelling and on a filesystem
 *   that ignores case too, is one entry.
 * - A file no step names is refused at its item, the workshop's own
 *   `method-graph.html` among them; one a step names only through a symlink
 *   out of the step's directory is refused there too.
 * - One key naming two different files beside two `.mthds` files is refused,
 *   since the runner reads every `.mthds` file of a request from one directory
 *   and one key can carry one file.
 * - The entries are then held to {@link templateBudgetRefusals}, on the sizes
 *   the stat gave.
 */
export function planTemplateFiles(
  located: readonly LocatedTemplate[],
  named: readonly NamedTemplate[],
  requestBytes: number,
  options: TemplateBudgetOptions = {},
): { planned: PlannedTemplate[]; refusals: TemplateRefusal[] } {
  const namesByReal = new Map<string, NamedTemplate[]>();
  const realsByKey = new Map<string, Map<string, string>>();
  for (const name of named) {
    if (name.real === null) continue;
    namesByReal.set(name.real, [...(namesByReal.get(name.real) ?? []), name]);
    if (name.escapes) continue;
    const reals = realsByKey.get(name.key) ?? new Map<string, string>();
    if (!reals.has(name.real)) reals.set(name.real, name.mthdsPath);
    realsByKey.set(name.key, reals);
  }

  const refusals: TemplateRefusal[] = [];
  const planned: PlannedTemplate[] = [];
  const seenReals = new Set<string>();
  for (const template of located) {
    if (seenReals.has(template.real)) continue;
    seenReals.add(template.real);
    const names = namesByReal.get(template.real) ?? [];
    const inside = names.filter((name) => !name.escapes);
    if (names.length === 0) {
      refusals.push({
        index: template.index,
        message: `${template.path} is named by no PipeDocGen step of the .mthds files given as { path }${expectedLocations(named)}.`,
        hint: ONLY_NAMED_HINT,
      });
      continue;
    }
    if (inside.length === 0) {
      const [first] = names;
      refusals.push({
        index: template.index,
        message: `${template.path} is the template_file "${first?.key}" of ${first?.mthdsPath} only through a symlink out of that file's directory. A symlink does not make a file part of the method.`,
        hint: "Copy the template file into the directory of the .mthds file naming it, where its template_file leads.",
      });
      continue;
    }
    for (const key of new Set(inside.map((name) => name.key))) {
      const reals = realsByKey.get(key);
      if (reals !== undefined && reals.size > 1) {
        const beside = [...reals.values()].join(" and ");
        refusals.push({
          index: template.index,
          message: `The template_file "${key}" names a different file beside each of ${beside}, and a request carries one file per path.`,
          hint: "The runner reads every .mthds file of a request from one directory, so give the steps different template_file paths, or make them name one file.",
        });
        continue;
      }
      planned.push({
        key,
        index: template.index,
        path: template.path,
        real: template.real,
        size: template.size,
      });
    }
  }
  return {
    planned,
    refusals: [...refusals, ...templateBudgetRefusals(planned, requestBytes, options)],
  };
}

/** Where the steps' template files were looked for, for a refusal of a file none of them names. */
function expectedLocations(named: readonly NamedTemplate[]): string {
  if (named.length === 0) return "";
  const shown = named
    .slice(0, 5)
    .map((name) =>
      path.posix.join(path.dirname(name.mthdsPath).split(path.sep).join("/"), name.key),
    );
  const more = named.length > shown.length ? `, and ${named.length - shown.length} more` : "";
  return `; the steps name ${shown.join(", ")}${more}`;
}

/**
 * What a caller of the planner may word for itself. `countHint` replaces the
 * hint of the count refusal, which otherwise tells a caller who listed the
 * files to send only the named ones: a method folder sends nothing else, so
 * the advice there is about the steps.
 */
export interface TemplateBudgetOptions {
  countHint?: string;
}

/**
 * The bounds a request's template files are held to, on the sizes given: the
 * stat's before any read, then the bytes actually read, since a file can grow
 * between the two.
 *
 * - **The runner's count**, {@link MAX_TEMPLATE_FILES}, refused at `files` as a
 *   whole.
 * - **The runner's per-file size**, {@link MAX_TEMPLATE_FILE_BYTES}, refused at
 *   the file. The resolver checks it on the stat already, so here it catches a
 *   file that grew.
 * - **The runner's total**, {@link MAX_TEMPLATE_FILES_TOTAL_BYTES} of raw
 *   bytes, refused at the file that crosses it.
 * - **The hosted gateway's request quota**, `GATEWAY_REQUEST_LIMIT_BYTES`,
 *   which `upload-ceiling.ts` measures for uploads: the request travels as
 *   JSON with each template base64-encoded, beside the `.mthds` contents
 *   (`requestBytes`) and an allowance for the rest of the body, so the encoded
 *   total binds before the runner's raw one, at about 7.4 MiB of template files
 *   beside a small bundle. The workshop cannot tell a deployment behind that
 *   gateway from one that is not, so it holds every request to it, as it holds
 *   every upload.
 */
export function templateBudgetRefusals(
  entries: readonly { key: string; index: number; path: string; size: number }[],
  requestBytes: number,
  options: TemplateBudgetOptions = {},
): TemplateRefusal[] {
  if (entries.length > MAX_TEMPLATE_FILES) {
    return [
      {
        message: `${entries.length} template files would be sent, over the ${MAX_TEMPLATE_FILES} one request takes.`,
        hint: options.countHint ?? ONLY_NAMED_HINT,
      },
    ];
  }
  const refusals: TemplateRefusal[] = [];
  let rawBytes = 0;
  let encodedBytes = requestBytes + REQUEST_ENVELOPE_ALLOWANCE_BYTES;
  for (const entry of entries) {
    if (entry.size > MAX_TEMPLATE_FILE_BYTES) {
      refusals.push({
        index: entry.index,
        message: `${entry.path} is ${formatMib(entry.size)}, over the ${formatMib(MAX_TEMPLATE_FILE_BYTES)} one template file may be.`,
        hint: "Make the template file smaller.",
      });
      continue;
    }
    rawBytes += entry.size;
    // The key and the JSON quoting around the key and the value travel too.
    encodedBytes += base64EncodedLength(entry.size) + entry.key.length + 8;
    if (rawBytes > MAX_TEMPLATE_FILES_TOTAL_BYTES) {
      refusals.push({
        index: entry.index,
        message: `The template files come to ${formatMib(rawBytes)} once ${entry.path} is added, over the ${formatMib(MAX_TEMPLATE_FILES_TOTAL_BYTES)} one request takes.`,
        hint: "Send only the template files the steps name, or make them smaller.",
      });
      break;
    }
    if (encodedBytes > GATEWAY_REQUEST_LIMIT_BYTES) {
      refusals.push({
        index: entry.index,
        message: `Once ${entry.path} is added, the request comes to ${formatMib(encodedBytes)} with its template files base64-encoded, over the ${formatMib(GATEWAY_REQUEST_LIMIT_BYTES)} the hosted API's gateway takes.`,
        hint: "Template files travel base64-encoded, a third larger than on disk, so a request holds about 7.4 MiB of them beside a small bundle. Send only the template files the steps name, or make them smaller.",
      });
      break;
    }
  }
  return refusals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
