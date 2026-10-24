import {
  ApiResponseError,
  ArtifactFetchError,
  INLINE_TREE_MAX_BYTES,
  PIPELEX_STORAGE_SCHEME,
  PipelexApiClient,
  RequestArgumentError,
  buildProblem,
  collectArtifacts,
  isProblemError,
  renderProblemMarkdown,
  reportedProblem,
} from "@pipelex/sdk";
import type { MethodTreeSource, PipelexApiClientOptions, Problem, ProblemItem } from "@pipelex/sdk";
import {
  compareUtf8,
  isExcludedName,
  isTreePath,
  pathCollisions,
  sha256Hex,
  treeDigest,
  treePathViolation,
} from "mthds";
import type { TreeLimit } from "mthds";
import path from "node:path";
import { z } from "zod";

import { BARE_APP_INFO } from "./client-identification.js";
import type { AppInfoSource } from "./client-identification.js";
import type { ListingLimits } from "./method-tree.js";
import { secretFindings, secretRefusalText } from "./secret-guard.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";
import { deepestCommonDirectory } from "./workspace-boundary.js";

export const DEFAULT_API_URL = "https://api.pipelex.com";

/**
 * The suffixes of the template files a `PipeDocGen` step reads from its
 * method's tree: an HTML template for a PDF, the office file itself for a
 * workbook, a document or a deck. The runner's own list is
 * `DocGenFormat.template_file_suffix` in pipelex
 * (`pipelex/cogt/doc_gen/doc_gen_format.py`), one suffix per format. The
 * `{ path }` arm of the method-taking tools' `files` reads these, and only
 * these, besides `.mthds`: it is the extension gate of the read side, widened
 * on purpose, so a suffix a new format brings is added here deliberately. A
 * method needing any other file sends its folder, `method_dir`.
 */
export const TEMPLATE_FILE_EXTENSIONS = [".html", ".xlsx", ".docx", ".pptx"] as const;

/** The extensions the `{ path }` arm of `files` reads: `.mthds`, and the template files. */
export const METHOD_FILE_EXTENSIONS = [".mthds", ...TEMPLATE_FILE_EXTENSIONS] as const;

/**
 * The `files` argument of the method-taking tools (`mthds_validate`,
 * `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`,
 * `mthds_run`). Each item is one of two arms: inline `.mthds` contents
 * (`{ content, uri? }`) or a file path (`{ path }`, a `.mthds` file or a
 * template file, read as bytes from disk through the context's resolver). The
 * arms are deliberately non-strict with first-match semantics: a pathological
 * item carrying both keys parses as the content arm and `path` is ignored.
 *
 * The items are sent as one method tree ({@link resolveMethodSource}): a
 * template file is a file of the tree like any other, found by the step naming
 * it where its `template_file` leads from the step's `.mthds` file, so the tree
 * keeps the files where they sit relative to one another.
 */
export const methodFilesInputSchema = z
  .array(
    z.union([
      z.object({
        content: z.string().describe("The full .mthds file contents."),
        uri: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Optional provenance URI; its file name, when it is a .mthds file's, is the name the contents are sent under.",
          ),
      }),
      z.object({
        path: z
          .string()
          .describe(
            `Filesystem path, resolved relative to this server's working directory: a .mthds file, or a template file a PipeDocGen step names (${TEMPLATE_FILE_EXTENSIONS.join(", ")}), read as bytes.`,
          ),
      }),
    ]),
  )
  .describe(
    "The method's files, sent as one tree. Each item is inline .mthds contents ({ content, uri? }) or a file path ({ path }). " +
      "For a method whose folder is on disk, pass method_dir instead, which sends the folder's whole tree. " +
      "The { path } items keep where they sit relative to one another: listed alone, the tree is rooted at the deepest directory holding them all, and each file is sent under its path from there, the path diagnostics name and a step's template_file leads to, " +
      'so [{ path: "invoice.mthds" }, { path: "templates/invoice.xlsx" }] sends templates/invoice.xlsx for a step whose template_file is templates/invoice.xlsx. ' +
      "An inline item is sent at the tree's top, under its uri's file name when that is a .mthds file's, else bundle.mthds; beside one, each { path } item is sent under its path from the working directory. " +
      "A file that looks like it holds a secret, a key file or a well-known key format, is refused before anything is sent; the result's files_sent lists every file sent.",
  );

/**
 * `method_dir`, the folder arm of the method-taking tools: the method's folder
 * on disk, whose whole tree under the MTHDS standard's membership rule
 * (`method-tree.ts`) the workshop sends. It is a top-level field beside
 * `files`, `method_ref` and `method_id` rather than a third arm of the files
 * union, since a folder is not a file and a folder beside listed files would
 * suggest merging the two. It composes as `files` does: alone on the tooling
 * tools, and beside a bare `method_id` as run-history linkage on `mthds_run`
 * ({@link SelectorRule}).
 */
export function methodDirInputSchema(rule: SelectorRule) {
  const pairing =
    rule === "run_source"
      ? "It pairs as files do: never with files or method_ref, and with a bare method_id the folder runs and the id only files the run under its method."
      : "Supply exactly ONE of method_dir / files / method_ref / method_id.";
  return z
    .string()
    .optional()
    .describe(
      "The method's folder, resolved against this server's working directory and required to stay inside it, with a .mthds file at its top. " +
        "The workshop sends the folder's whole tree, every file the MTHDS standard's membership rule keeps: it skips every path with a segment starting with a dot, __pycache__/ and node_modules/ directories, virtual environments, nested repositories, a run's inputs file (inputs.json or inputs.toml, at any depth), and what the .gitignore files inside the folder and its METHODS.toml exclude. " +
        "It refuses a folder holding a symbolic link it does not skip, one past the limits the Pipelex deployment announces, and one holding a file that looks like a secret, a key file or a well-known key format, before anything is sent. " +
        `Prefer it to files for a method on disk; the result's files_sent lists every file sent. ${pairing}`,
    );
}

/**
 * `files_sent`, the listing every method-taking tool's result carries when it
 * sent a method's tree: what left the machine, so a stray file the folder held
 * is seen rather than sent silently.
 */
export const filesSentSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Every file this call sent, as you can find it: from method_dir, method_dir joined with the file's path inside the folder; from files, each { path } item as given, and each inline item under the name it was sent as. Absent when the method was named by method_ref or method_id, or when nothing was sent.",
  );

/** A submitted inline file: a `.mthds` file's contents, and an optional label. */
export interface SubmittedFile {
  content: string;
  uri?: string | null;
}

/** The path arm of the submitted-files union. */
export interface SubmittedFilePath {
  path: string;
}

/** What the MCP surface accepts per files item — see {@link methodFilesInputSchema}. */
export type SubmittedFileInput = SubmittedFile | SubmittedFilePath;

/**
 * Outcome of resolving a text file from disk (`resolve`, which `inputs_path`
 * reads). Resolvers report failures as values (never throw): every failure is
 * a {@link Refusal} of the argument's own field, so the resolver supplies its
 * words and why, and the capability builds the problem.
 */
export type FileResolution = { ok: true; content: string } | ({ ok: false } & Refusal);

/**
 * What one `{ path }` item of a method's `files` is on disk
 * (`statMethodFile`), known before a byte of it is read: its absolute path as
 * the caller wrote it, resolved against the working directory without
 * following a link, the same path relative to the working directory, and its
 * size. The tree path is made from the first or the second. Failures are
 * values, at `files[i].path`.
 */
export type MethodFileStat =
  | { ok: true; absolute: string; relative: string; size: number }
  | ({ ok: false } & Refusal);

/**
 * Outcome of reading one `{ path }` item of a method's `files`
 * (`readMethodFile`): its bytes. Failures are values, at `files[i].path`.
 */
export type MethodFileRead = { ok: true; bytes: Uint8Array } | ({ ok: false } & Refusal);

/**
 * The seam the workshop fills with a filesystem-backed resolver
 * (`localFileResolver` and `localMethodFileResolver` in its `src/files.ts`). A
 * context built without one — the core's own `build…Context`, as the live
 * suite uses — turns every `{ path }` item and every `method_dir` into an
 * instructive rejection.
 *
 * `resolve` reads one text file of the argument's one extension, as
 * `inputs_path` does. `statMethodFile` and `readMethodFile` are what make an
 * argument take a method's `{ path }` items, a `.mthds` file or a template
 * file each: the first makes every check that reads no byte of the file, its
 * extension, where it lies, that it is a regular file and its size, so every
 * item is checked, and the list held to the deployment's limits, before any is
 * read; the second reads one as bytes, held to `maxBytes`. `locateMethodDir`
 * and `readMethodTree` are what make a tool take `method_dir`: the first finds
 * the folder on its real path before anything is read, and the second lists
 * its whole tree and reads every file of it once, so the bytes the workshop
 * checks and sends are one read. Absent, `method_dir` is refused.
 */
export interface FileResolver {
  resolve(path: string): Promise<FileResolution>;
  statMethodFile?(path: string): Promise<MethodFileStat>;
  readMethodFile?(path: string, options: { maxBytes: number }): Promise<MethodFileRead>;
  locateMethodDir?(methodDir: string): Promise<MethodDirLocation>;
  readMethodTree?(
    location: LocatedMethodDir,
    options: { limits: ListingLimits },
  ): Promise<MethodTreeRead>;
}

/** A method folder found on disk: its real path, and `method_dir` as the caller wrote it. */
export interface LocatedMethodDir {
  folder: string;
  methodDir: string;
}

export type MethodDirLocation =
  | ({ ok: true } & LocatedMethodDir)
  | { ok: false; refusals: Refusal[] };

/**
 * A method folder's whole tree, every file read once: the listing, its digest,
 * the workshop's graph page it left out, and the bytes. Failures are values,
 * all located at `method_dir`.
 */
export type MethodTreeRead =
  | {
      ok: true;
      files: readonly { path: string; size: number; sha256: string }[];
      digest: string;
      graphPage?: string;
      bytes: ReadonlyMap<string, Uint8Array>;
    }
  | { ok: false; refusals: Refusal[] };

/** A file of a method's tree as a tool sends it. */
export interface SentFile {
  /** Its path inside the tree, the name the runner's diagnostics give it. */
  readonly treePath: string;
  /** Where the caller finds it: `method_dir` joined with its tree path, a `{ path }` as given, an inline item's tree path. */
  readonly shown: string;
  /** Whether it was read from disk, which an inline item was not. */
  readonly onDisk: boolean;
  readonly bytes: Uint8Array;
}

/**
 * A method's tree, read whole and through the secret guard, ready to send: the
 * tree in the SDK's form, built from the bytes in hand, so what was checked is
 * what is sent, and every file of it, in tree path order.
 */
export interface MethodTreeToSend {
  readonly source: MethodTreeSource;
  readonly files: readonly SentFile[];
  /** Whether it came from `method_dir`, which is where every refusal of it then locates. */
  readonly fromFolder: boolean;
  /**
   * The folder's real path, for a tree read from `method_dir`: where the files
   * of the folder itself are read, such as the link file naming the saved
   * method it holds. Absent for a list of files.
   */
  readonly folder?: string;
}

/** What a method-taking request names its method by, before anything is read. */
export interface MethodSourceInput extends MethodSelectors {
  files?: SubmittedFileInput[];
  method_dir?: string;
}

/**
 * A method-taking request's source, resolved: the tree it sends when it names
 * its method by `method_dir` or `files`, or no tree when it names it by
 * `method_ref` or `method_id`. `tree` is meaningful only when `faults` is
 * empty; the faults, each a refusal's problem, make the call's one problem
 * ({@link faultsProblem}).
 */
export interface ResolvedMethodSource {
  tree?: MethodTreeToSend;
  faults: Problem[];
}

/**
 * Resolve a method-taking request's source into the tree it sends: `files`
 * through {@link resolveFilesTree}, or `method_dir` through the resolver's
 * `locateMethodDir` and `readMethodTree`, listed under the limits `limits`
 * reads, which is called only when something is to be read from disk. The
 * folder's pairings are refused before it is read, at the field that came
 * second in the order method_dir, files, method_ref, method_id, as the other
 * pairs are: `files` beside it at `method_dir`, `method_ref` at `method_ref`,
 * and `method_id` at `method_id` on the tooling tools, while on `mthds_run` a
 * folder takes a `method_id` beside it as files do. Either way an empty
 * `.mthds` file is refused, and the secret guard reads every byte before any
 * is sent, and the selector checks that
 * follow ({@link validateMethodSelectorRequest}) see a tree as a method named.
 */
export async function resolveMethodSource(
  source: MethodSourceInput,
  resolver: FileResolver | undefined,
  rule: SelectorRule,
  limits: () => Promise<ListingLimits>,
): Promise<ResolvedMethodSource> {
  if (source.method_dir !== undefined) {
    return resolveFolderTree(source, source.method_dir, resolver, rule, limits);
  }
  const files = source.files ?? [];
  if (files.length === 0) return { faults: [] };
  return resolveFilesTree(files, resolver, limits);
}

/** `method_dir`: located, listed and read whole, then through the secret guard. */
async function resolveFolderTree(
  source: MethodSourceInput,
  methodDir: string,
  resolver: FileResolver | undefined,
  rule: SelectorRule,
  limits: () => Promise<ListingLimits>,
): Promise<ResolvedMethodSource> {
  const pairingFaults = methodDirPairingFaults(source, methodDir, rule);
  if (pairingFaults.length > 0) return { faults: pairingFaults };

  if (resolver?.locateMethodDir === undefined || resolver.readMethodTree === undefined) {
    return {
      faults: [
        argumentProblem(
          "method_dir",
          "not_readable_here",
          "This deployment cannot read a folder from disk; submit the method's files instead.",
          "Resubmit the method's .mthds files inline as files [{ content, uri? }], or use the local workshop server (npx @pipelex/mcp), which reads method_dir.",
        ),
      ],
    };
  }

  const located = await resolver.locateMethodDir(methodDir);
  if (!located.ok) return { faults: located.refusals.map(atMethodDirRefusal) };
  const read = await resolver.readMethodTree(located, { limits: await limits() });
  if (!read.ok) return { faults: read.refusals.map(atMethodDirRefusal) };

  const tree = folderTreeToSend(located, read);
  const empty = tree.files.find(isEmptyBundle);
  if (empty !== undefined) {
    return {
      faults: [
        atMethodDirRefusal({
          reason: "empty_bundle",
          message: emptyBundleMessage(empty.shown),
          remedy:
            "Write the bundle into the .mthds file, or keep it out of the method with a .gitignore inside the folder.",
        }),
      ],
    };
  }
  const findings = secretFindings(
    tree.files.map((file) => ({ path: file.treePath, bytes: file.bytes })),
  );
  if (findings.length > 0) {
    return {
      faults: [
        atMethodDirRefusal({
          reason: SECRET_REASON,
          ...secretRefusalText(findings, (treePath) => shownIn(methodDir, treePath), {
            arm: "folder",
            again: SEND_AGAIN,
          }),
        }),
      ],
    };
  }
  return { faults: [], tree };
}

/**
 * A method folder's tree as read, every file of it once, in the form a tool
 * sends: the SDK's tree over the bytes in hand, and every file as the caller
 * finds it, `method_dir` joined with its tree path. The save builds the tree
 * it validates and stores with it too, so the bytes it checked are the bytes
 * both requests send.
 */
export function folderTreeToSend(
  location: LocatedMethodDir,
  read: {
    files: readonly { path: string; size: number; sha256: string }[];
    digest: string;
    bytes: ReadonlyMap<string, Uint8Array>;
  },
): MethodTreeToSend {
  return {
    source: treeSourceOf(read.files, read.digest, read.bytes),
    files: read.files.map((file) => ({
      treePath: file.path,
      shown: shownIn(location.methodDir, file.path),
      onDisk: true,
      bytes: read.bytes.get(file.path) ?? new Uint8Array(),
    })),
    fromFolder: true,
    folder: location.folder,
  };
}

/**
 * Whether a file of a tree is a `.mthds` file holding nothing but whitespace,
 * which no runner loads as a bundle: the method-taking tools refuse one before
 * anything is sent, from `method_dir` or a `{ path }` item, as they refuse an
 * inline item with no content.
 */
function isEmptyBundle(file: { treePath: string; bytes: Uint8Array }): boolean {
  return (
    file.treePath.toLowerCase().endsWith(".mthds") &&
    Buffer.from(file.bytes).toString("utf8").trim() === ""
  );
}

function emptyBundleMessage(shown: string): string {
  return `${shown} is empty.`;
}

/** What a caller does once a refused file is dealt with, closing the secret guard's remedy. */
const SEND_AGAIN = "call the tool again";

/** The reason a refusal of a file that looks like a secret names. */
export const SECRET_REASON = "secret_suspected";

function atMethodDirRefusal(refusal: Refusal): Problem {
  return refusalProblem("method_dir", refusal);
}

/** `method_dir`'s own request-shape checks: not blank, and none of the pairings its rule refuses. */
function methodDirPairingFaults(
  source: MethodSourceInput,
  methodDir: string,
  rule: SelectorRule,
): Problem[] {
  if (methodDir.trim() === "") {
    return [
      argumentProblem(
        "method_dir",
        "empty",
        "method_dir must not be empty when supplied.",
        "Pass the folder holding the method's .mthds files, relative to the server's working directory (\".\" for that directory itself).",
      ),
    ];
  }
  const faults: Problem[] = [];
  if ((source.files ?? []).length > 0) {
    faults.push(
      argumentProblem(
        "method_dir",
        "mutually_exclusive",
        "method_dir and files are mutually exclusive — pass the method's folder or list its files, never both.",
        "method_dir sends the folder's whole tree by itself; drop files to send the folder, or drop method_dir to send exactly the files listed.",
      ),
    );
  }
  if (source.method_ref !== undefined && source.method_ref.trim() !== "") {
    faults.push(
      argumentProblem(
        "method_ref",
        "mutually_exclusive",
        "method_dir and method_ref are mutually exclusive — submit the folder or the address, never both.",
        "An address is a complete method source resolved server-side; drop method_ref to operate on the folder, or drop method_dir to operate on the published package.",
      ),
    );
  }
  if (rule === "one_selector" && source.method_id !== undefined && source.method_id.trim() !== "") {
    faults.push(
      argumentProblem(
        "method_id",
        "mutually_exclusive",
        "method_dir and method_id are mutually exclusive on this tool — submit the folder or the catalog id, never both.",
        "This operation is stateless, so there is no run-history linkage for an extra id to feed; drop method_id to operate on the folder, or drop method_dir to operate on the registered method.",
      ),
    );
  }
  return faults;
}

/** One `files` item on its way into the tree, with the item it came from. */
interface ItemFile {
  index: number;
  /** Where the item's refusals locate: `files[i].path` or `files[i].content`. */
  location: string;
  treePath: string;
  shown: string;
  /** The `{ path }` item as submitted, read once every check has passed; absent for an inline item. */
  submitted?: string;
  /** Its size: on the stat for a `{ path }` item, of its text for an inline one. */
  size: number;
  /** Its bytes: an inline item's from the start, a `{ path }` item's once read. */
  bytes?: Uint8Array;
}

/** The name an inline item is sent under when its uri gives none. */
const INLINE_STEM = "bundle";

/** Whether a `files` item is a `.mthds` file: an inline item always is, a `{ path }` item by its extension. */
function namesBundle(item: SubmittedFileInput): boolean {
  return "content" in item || item.path.trim().toLowerCase().endsWith(".mthds");
}

/**
 * `files`, as one tree, made in an order that reads no byte of a file before
 * the whole list has passed every check that needs none.
 *
 * 0. That the list names a method at all: one `.mthds` file, an inline item
 *    or a `{ path }` item with that extension. A list of other files makes no
 *    method, and the runner would refuse its tree only once the SDK had sent
 *    it, uploading its files to the organization's storage first when they
 *    weigh enough, so it is refused at `files` before any item is stated,
 *    read or hashed.
 * 1. Each item's shape, and each `{ path }` item's stat through the
 *    resolver's `statMethodFile`: its extension, where it lies, that it is a
 *    regular file, its size.
 * 2. Each file's tree path. Without inline items, the tree is rooted at the
 *    deepest directory holding every `{ path }` item, and each is sent under
 *    its path from there. Beside an inline item, which has no directory, the
 *    tree is rooted at the working directory and each `{ path }` item is sent
 *    under its path from there, as the caller wrote it, so a template listed
 *    as `templates/invoice.xlsx` keeps the path a step of the inline `.mthds`
 *    file names. A path given twice is one file; two different paths that
 *    name one tree path once Unicode-normalized are refused, as are a tree
 *    path the standard refuses, a name it never admits to a tree and two
 *    paths that collide. Each inline item is a `.mthds` file at the tree's
 *    top, under its uri's file name when that names a `.mthds` file no other
 *    file of the tree takes, else `bundle.mthds`, `bundle-2.mthds` and on.
 * 3. The deployment's limits, asked for every list, an inline-only one
 *    included: one file's size at its item, the file count and the total at
 *    `files`, on the sizes the stat gave.
 * 4. The reads, one file at a time, each held to the limit on one file and
 *    the running total held to the limit on all, so a file that grew since
 *    its stat stops the reads at the limit rather than past it; then a
 *    `.mthds` file read empty is refused at its item.
 * 5. The secret guard, over every byte in hand, before anything is sent.
 */
async function resolveFilesTree(
  items: SubmittedFileInput[],
  resolver: FileResolver | undefined,
  limits: () => Promise<ListingLimits>,
): Promise<ResolvedMethodSource> {
  const errors: Problem[] = [];
  const refuse = (location: string, refusal: Refusal) =>
    errors.push(refusalProblem(location, refusal));

  // 0. A method, before anything of the list is stated, read or hashed.
  if (!items.some(namesBundle)) {
    return {
      faults: [
        refusalProblem("files", {
          reason: "no_method_file",
          message:
            "The files hold no .mthds file, so they make no method; nothing was read or sent.",
          remedy:
            "List the method's .mthds files with the files they read, as { path } items or inline as { content }, or pass the method's folder as method_dir.",
        }),
      ],
    };
  }

  // 1. Every item's shape, and what each { path } item is on disk.
  const inline: { index: number; item: SubmittedFile }[] = [];
  const stated: {
    index: number;
    submitted: string;
    absolute: string;
    relative: string;
    size: number;
  }[] = [];
  for (const [index, item] of items.entries()) {
    // First-match union semantics: a pathological { content, path } item is
    // the content arm, and its path is ignored.
    if ("content" in item) {
      if (item.content.trim() === "") {
        refuse(`files[${index}].content`, {
          reason: "empty",
          message: "File content must not be empty.",
          remedy: "Submit the full .mthds file contents.",
        });
      }
      if (item.uri !== undefined && item.uri !== null && item.uri.trim() === "") {
        refuse(`files[${index}].uri`, {
          reason: "empty",
          message: "File uri must not be empty when supplied.",
          remedy: "Omit uri for inline content or provide a stable path or URI.",
        });
      }
      inline.push({ index, item });
      continue;
    }
    if (item.path.trim() === "") {
      refuse(`files[${index}].path`, {
        reason: "empty",
        message: "File path must not be empty.",
        remedy: "Submit a file path, or inline the contents as { content, uri? }.",
      });
      continue;
    }
    if (resolver?.statMethodFile === undefined || resolver.readMethodFile === undefined) {
      refuse(`files[${index}].path`, {
        reason: "not_readable_here",
        message: "This deployment cannot read files from disk; submit the file contents instead.",
        remedy:
          "Resubmit this item as { content, uri? } with the file contents inline, or use the local workshop server (npx @pipelex/mcp), which resolves paths.",
      });
      continue;
    }
    const stat = await resolver.statMethodFile(item.path);
    if (!stat.ok) {
      refuse(`files[${index}].path`, stat);
      continue;
    }
    stated.push({ index, submitted: item.path, ...stat });
  }
  if (errors.length > 0) return { faults: errors };

  // 2. Each file's tree path: from the deepest directory holding every
  // { path } item, or from the working directory beside an inline item.
  const files: ItemFile[] = [];
  const fromWorkingDirectory = inline.length > 0;
  const root = deepestCommonDirectory(stated.map((file) => path.dirname(file.absolute)));
  const byAbsolute = new Set<string>();
  const byTreePath = new Map<string, ItemFile>();
  for (const file of stated) {
    // The same path given twice, under any spelling that resolves alike, is one file.
    if (byAbsolute.has(file.absolute)) continue;
    byAbsolute.add(file.absolute);
    const fromRoot = fromWorkingDirectory ? file.relative : path.relative(root, file.absolute);
    const treePath = fromRoot.split(path.sep).join("/").normalize("NFC");
    const location = `files[${file.index}].path`;
    const violation = treePathViolation(treePath);
    if (violation !== null) {
      refuse(location, {
        reason: "invalid_tree_path",
        message: `${file.submitted} cannot be sent under the name ${treePath}: ${violation}.`,
        remedy: fromWorkingDirectory
          ? "Beside an inline item, a { path } item is sent under its path from the working directory. List a file inside the working directory, rename it so its name is one every machine keeps, or pass the method's folder as method_dir."
          : "Rename the file so its name is one every machine keeps, or pass the method's folder as method_dir.",
      });
      continue;
    }
    if (isExcludedName(treePath)) {
      refuse(location, {
        reason: "excluded_name",
        message: `${file.submitted} would be sent as ${treePath}, a name no method's tree holds: a segment starting with a dot, a __pycache__ or node_modules directory, or a run's inputs file.`,
        remedy:
          "Move or rename the file, or list it beside the files it belongs with so the tree is rooted where they sit.",
      });
      continue;
    }
    const other = byTreePath.get(treePath);
    if (other !== undefined) {
      refuse(location, {
        reason: "normalization_collision",
        message: `${file.submitted} and ${other.shown} are two spellings of one name, ${treePath}, once Unicode-normalized, so they cannot both be sent.`,
        remedy:
          "List the file once, under one spelling. Two files whose names differ only in their Unicode normalization cannot both belong to a method: every machine reads them as one name.",
      });
      continue;
    }
    const entry: ItemFile = {
      index: file.index,
      location,
      treePath,
      shown: file.submitted,
      submitted: file.submitted,
      size: file.size,
    };
    byTreePath.set(treePath, entry);
    files.push(entry);
  }
  const colliding = new Set(pathCollisions(files.map((file) => file.treePath)));
  for (const file of files) {
    if (colliding.has(file.treePath)) {
      refuse(file.location, {
        reason: "path_collision",
        message: `${file.shown} collides with another file listed, by its name once case is ignored, or by naming one's directory: ${[...colliding].join(", ")}.`,
        remedy:
          "A method's files must keep their names on every machine, case-insensitive file systems included: rename one of them.",
      });
    }
  }
  if (errors.length > 0) return { faults: errors };

  // The inline items, each a .mthds file at the tree's top.
  const taken = files.map((file) => file.treePath);
  for (const { index, item } of inline) {
    const treePath = inlineTreePath(item.uri, taken);
    taken.push(treePath);
    const bytes = new TextEncoder().encode(item.content);
    files.push({
      index,
      location: `files[${index}].content`,
      treePath,
      shown: treePath,
      size: bytes.byteLength,
      bytes,
    });
  }

  // 3. The deployment's limits, on the sizes known before any read.
  const bounds = await limits();
  const maxFileSize = bounds.maxFileSize ?? Number.MAX_SAFE_INTEGER;
  for (const file of files) {
    if (file.size > maxFileSize) {
      refuse(file.location, {
        reason: "file_too_large",
        message: `${file.shown} is ${file.size} bytes, past ${limitWords(bounds, "maxFileSize", maxFileSize)} for one file of a method.`,
        remedy: "Make the file smaller, or leave it off the list if the method does not need it.",
      });
    }
  }
  if (errors.length > 0) return { faults: errors };
  const tooMany = treeTotalRefusal(bounds, { count: files.length });
  if (tooMany !== undefined) return { faults: [tooMany] };
  const tooLarge = treeTotalRefusal(bounds, {
    total: files.reduce((sum, file) => sum + file.size, 0),
  });
  if (tooLarge !== undefined) return { faults: [tooLarge] };

  // 4. The reads, one file at a time, the running total held to the limit.
  let total = files.reduce((sum, file) => sum + (file.bytes?.byteLength ?? 0), 0);
  for (const file of files) {
    if (file.submitted === undefined || resolver?.readMethodFile === undefined) continue;
    const outcome = await resolver.readMethodFile(file.submitted, { maxBytes: maxFileSize });
    if (!outcome.ok) return { faults: [refusalProblem(file.location, outcome)] };
    file.bytes = outcome.bytes;
    total += outcome.bytes.byteLength;
    const over = treeTotalRefusal(bounds, { total });
    if (over !== undefined) return { faults: [over] };
  }

  const read = files.map((file) => ({ ...file, bytes: file.bytes ?? new Uint8Array() }));
  // An empty .mthds file read from disk, as an inline item with no content was
  // refused in step 1.
  for (const file of read) {
    if (file.submitted !== undefined && isEmptyBundle(file)) {
      refuse(file.location, {
        reason: "empty_bundle",
        message: emptyBundleMessage(file.submitted),
        remedy: "Write the bundle into the .mthds file, or leave it off the list.",
      });
    }
  }
  if (errors.length > 0) return { faults: errors };

  // 5. The secret guard, over every byte about to be sent.
  for (const finding of secretFindings(
    read.map((file) => ({ path: file.treePath, bytes: file.bytes })),
  )) {
    const file = read.find((candidate) => candidate.treePath === finding.path);
    if (file === undefined) continue;
    const text = secretRefusalText([finding], () => file.shown, {
      arm: "files",
      again: SEND_AGAIN,
    });
    refuse(file.location, { reason: SECRET_REASON, ...text });
  }
  if (errors.length > 0) return { faults: errors };

  read.sort((left, right) => compareUtf8(left.treePath, right.treePath));
  const listing = read.map((file) => ({
    path: file.treePath,
    size: file.bytes.byteLength,
    sha256: sha256Hex(file.bytes),
  }));
  return {
    faults: [],
    tree: {
      source: treeSourceOf(
        listing,
        treeDigest(listing),
        new Map(read.map((file) => [file.treePath, file.bytes])),
      ),
      files: read.map(({ treePath, shown, submitted, bytes }) => ({
        treePath,
        shown,
        onDisk: submitted !== undefined,
        bytes,
      })),
      fromFolder: false,
    },
  };
}

/** A limit with its number, and whose it is: the deployment's, or the workshop's own when the deployment announced none. */
function limitWords(bounds: ListingLimits, limit: TreeLimit, maximum: number): string {
  return bounds.workshopSet?.includes(limit) === true
    ? `the workshop's own limit of ${maximum}${limit === "maxFileCount" ? "" : " bytes"}`
    : `the limit of ${maximum}${limit === "maxFileCount" ? "" : " bytes"} the Pipelex deployment takes`;
}

/** The refusal, at `files`, of a list past the limit on the file count or on the total, or nothing. */
function treeTotalRefusal(
  bounds: ListingLimits,
  measured: { count?: number; total?: number },
): Problem | undefined {
  const { maxFileCount, maxTotalSize } = bounds;
  if (measured.count !== undefined && maxFileCount !== undefined && measured.count > maxFileCount) {
    return refusalProblem("files", {
      reason: "too_many_files",
      message: `The files make a tree of ${measured.count} files, past ${limitWords(bounds, "maxFileCount", maxFileCount)}.`,
      remedy: "Send only the method's own files, or pass the method's folder as method_dir.",
    });
  }
  if (measured.total !== undefined && maxTotalSize !== undefined && measured.total > maxTotalSize) {
    return refusalProblem("files", {
      reason: "tree_too_large",
      message: `The files hold more than ${maxTotalSize} bytes in all, past ${limitWords(bounds, "maxTotalSize", maxTotalSize)} for a method's tree; nothing was sent.`,
      remedy: "Send only the method's own files, or make them smaller.",
    });
  }
  return undefined;
}

/**
 * The tree path an inline item is sent under: its uri's last segment when that
 * names a `.mthds` file a tree may hold and no file of `taken` collides with,
 * else the first of `bundle.mthds`, `bundle-2.mthds` and on that none does.
 */
function inlineTreePath(uri: string | null | undefined, taken: readonly string[]): string {
  const free = (candidate: string) =>
    !taken.includes(candidate) && pathCollisions([...taken, candidate]).length === 0;
  const named = uri?.split(/[\\/]/).pop()?.normalize("NFC");
  if (
    named !== undefined &&
    named.toLowerCase().endsWith(".mthds") &&
    isTreePath(named) &&
    !isExcludedName(named) &&
    free(named)
  ) {
    return named;
  }
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = `${INLINE_STEM}${ordinal === 1 ? "" : `-${ordinal}`}.mthds`;
    if (free(candidate)) return candidate;
  }
}

/** The tree the SDK sends, inline or by hash, from bytes already read and checked. */
function treeSourceOf(
  files: readonly { path: string; size: number; sha256: string }[],
  digest: string,
  bytes: ReadonlyMap<string, Uint8Array>,
): MethodTreeSource {
  return {
    files,
    digest,
    readFile: async (treePath) => {
      const read = bytes.get(treePath);
      if (read === undefined) throw new Error(`${treePath} is not a file of this method's tree`);
      return read;
    },
  };
}

/** A tree path as the caller can open it: `method_dir` joined with it. */
export function shownIn(methodDir: string, treePath: string): string {
  return path.join(methodDir, ...treePath.split("/"));
}

/**
 * The no-verdict results whose request never left the machine, held by
 * identity so the mark rides no field a host could see.
 */
const unsentResults = new WeakSet<object>();

/**
 * Mark a no-verdict result as one whose request was never sent, so
 * {@link withFilesSent} lists no file on it. A request fn marks its failure
 * when the client could not be built or {@link failedBeforeSending} says so.
 */
export function markUnsent<R extends object>(result: R): R {
  unsentResults.add(result);
  return result;
}

/**
 * Whether a call failed before its request left the machine. The SDK raises
 * `RequestArgumentError` for an argument it refuses before sending anything,
 * the base URL its client is built with among them; every other failure of a
 * call may have come after the request, or a file of its tree, was sent, so it
 * counts as sent.
 */
export function failedBeforeSending(err: unknown): boolean {
  return err instanceof RequestArgumentError;
}

/**
 * What a method's tree had to do with a request refused as too large:
 * `tree`, it travelled inline at a weight that can have made it so; `not_tree`,
 * its bytes did not ride the request, since none was sent or it travelled by
 * hash; `unknown`, it rode inline at a weight that may or may not have, or
 * how it travelled cannot be told.
 */
export type TreeShareOfTooLarge = "tree" | "not_tree" | "unknown";

/**
 * What `tree` had to do with `err` when it is a `413`, or `undefined` for any
 * other error. A tree within the SDK's inline threshold
 * (`INLINE_TREE_MAX_BYTES`), weighed as the SDK weighs it
 * ({@link inlineTreeWeight}), travels inline everywhere, so it rode the
 * request and may have filled it to a limit lower than the threshold:
 * `unknown`. A heavier one travels by hash to a deployment keeping a blob
 * store and inline only to one keeping none, so the deployment is asked,
 * through the client's `version()` (`GET /v1/version`'s `blob_store`), only
 * then; a client without `version()`, or a handshake that fails, says
 * nothing, which is `unknown` too.
 */
export async function treeShareOfTooLarge(
  err: unknown,
  tree: MethodTreeToSend | undefined,
  client: unknown,
): Promise<TreeShareOfTooLarge | undefined> {
  if (!(err instanceof ApiResponseError) || err.status !== 413) return undefined;
  if (tree === undefined) return "not_tree";
  if (inlineTreeWeight(tree) <= INLINE_TREE_MAX_BYTES) return "unknown";
  if (typeof client !== "object" || client === null) return "unknown";
  const version = (client as { version?: unknown }).version;
  if (typeof version !== "function") return "unknown";
  try {
    const info: unknown = await (version as () => Promise<unknown>).call(client);
    return asRecord(info)?.blob_store === true ? "not_tree" : "tree";
  } catch {
    return "unknown";
  }
}

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The weight of a tree's inline `files` map as the SDK measures it against
 * its inline threshold: the map's JSON with no whitespace, in UTF-8 bytes,
 * each file as its text, or as `{ base64 }` when it is not UTF-8 text, so a
 * binary file weighs about four thirds of its bytes.
 */
export function inlineTreeWeight(tree: MethodTreeToSend): number {
  const files: Record<string, string | { base64: string }> = {};
  for (const file of tree.files) {
    let entry: string | { base64: string };
    try {
      entry = STRICT_UTF8_DECODER.decode(file.bytes);
    } catch {
      entry = { base64: Buffer.from(file.bytes).toString("base64") };
    }
    Object.defineProperty(files, file.treePath, { value: entry, enumerable: true });
  }
  return Buffer.byteLength(JSON.stringify(files), "utf8");
}

/** What to do about a method's tree that made a request too large. */
const TREE_TOO_LARGE_REMEDY =
  "Keep what is not part of the method out of its folder with a .gitignore inside it or METHODS.toml's [package] exclude, or send fewer or smaller files.";

/** What to do about a run's inputs that made its start too large. */
const INPUTS_TOO_LARGE_REMEDY = `Upload large file inputs with ${WORKSHOP_TOOL_NAMES.prepareInputs}, which replaces them with pipelex-storage:// references, or pass them as URLs.`;

/**
 * `problem` with what the workshop can tell of a request refused as too
 * large, a `413`, added to its `message`, since neither the platform's answer
 * nor a bare gateway `413` says which part of the request made it so. Any
 * other failure comes back as it was, and so does a `413` the workshop can say
 * nothing about. The problem's code, domain, retry and next step are kept.
 *
 * - A tree shown to have travelled inline at a weight that can have made the
 *   request too large ({@link treeShareOfTooLarge} is `tree`): a deployment
 *   without a blob store takes every file of a tree inline, so the caller
 *   sends a smaller tree.
 * - On a start (`run` given): the inputs are blamed only when the start
 *   carried some and the tree is shown not to have ridden the request;
 *   otherwise the note names both possible causes, with the weights measured
 *   here, the tree's as it travels inline and the inputs' as JSON.
 */
export async function withTooLargeNote(
  problem: Problem,
  err: unknown,
  tree: MethodTreeToSend | undefined,
  client: unknown,
  run?: { inputs: Record<string, unknown> | undefined },
): Promise<Problem> {
  const share = await treeShareOfTooLarge(err, tree, client);
  if (share === undefined) return problem;
  const note = tooLargeNote(share, tree, run);
  if (note === undefined) return problem;
  const said = typeof problem.message === "string" && problem.message !== "" ? problem.message : "";
  return { ...problem, message: said === "" ? note : `${said} ${note}` };
}

function tooLargeNote(
  share: TreeShareOfTooLarge,
  tree: MethodTreeToSend | undefined,
  run: { inputs: Record<string, unknown> | undefined } | undefined,
): string | undefined {
  if (share === "tree" && tree !== undefined) {
    return `The method's files travelled inline in this request, ${sizeWords(inlineTreeWeight(tree))} of them, which is what made it larger than the Pipelex deployment takes in one request: a deployment without a blob store takes every file of a tree inline. ${TREE_TOO_LARGE_REMEDY}`;
  }
  if (run === undefined) return undefined;
  const inputs = run.inputs ?? {};
  const carriesInputs = Object.keys(inputs).length > 0;
  if (share === "not_tree" && carriesInputs) {
    return `The method's files are not what made the run's request too large, since they did not ride it inline: its inputs did. ${INPUTS_TOO_LARGE_REMEDY}`;
  }
  const measured: string[] = [];
  if (tree !== undefined && share !== "not_tree") {
    measured.push(`the method's files weigh ${sizeWords(inlineTreeWeight(tree))} inline`);
  }
  if (!carriesInputs) {
    measured.push("the run carries no inputs");
  } else {
    const weight = jsonWeight(inputs);
    if (weight !== undefined) measured.push(`its inputs weigh ${sizeWords(weight)} as JSON`);
  }
  return `Which part of the run's request made it too large cannot be told from here: the method's files, when they travel inline, or the run's inputs. ${TREE_TOO_LARGE_REMEDY} ${INPUTS_TOO_LARGE_REMEDY} Measured here, ${measured.join(", and ")}.`;
}

/** A value's weight as a request carries it: its JSON, in UTF-8 bytes, or `undefined` when it has none. */
function jsonWeight(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

/** A size in the unit that reads best: KiB below a mebibyte, MiB above. */
function sizeWords(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Put a tree's listing on a result produced once its request was sent, a
 * no-verdict error included, since its files left the machine either way. A
 * result {@link markUnsent} marked, whose request never left, gets no listing.
 * A request that sent no tree (`tree` undefined) is returned as it was. A
 * problem is never rewritten here: its location is the API's, which names the
 * request's fields.
 */
export function withFilesSent<R extends { structuredContent: object }>(
  result: R,
  tree: MethodTreeToSend | undefined,
): R {
  if (tree === undefined || unsentResults.has(result)) return result;
  return {
    ...result,
    structuredContent: {
      ...result.structuredContent,
      files_sent: tree.files.map((file) => file.shown),
    },
  };
}

/**
 * The largest inputs file `inputs_path` reads: 1 MiB. Inputs ride the JSON
 * body of `POST /v1/start` or `POST /v1/pipe-io`; a set past this size is an
 * asset in disguise and belongs in a file input, uploaded by
 * `mthds_prepare_inputs`, rather than in the run's inputs.
 */
export const MAX_INPUTS_FILE_BYTES = 1024 * 1024;

/**
 * `inputs_path`, the file arm of a run's inputs: the same schema on
 * `mthds_run` and `mthds_prepare_inputs`. A separate argument rather than a
 * `{ path }` shape inside `inputs`, because an inputs map may legitimately
 * declare an input named `path`.
 */
export const inputsPathSchema = z
  .string()
  .optional()
  .describe(
    "Path to a .json file holding the inputs as one JSON object, resolved relative to this server's working directory and read only inside it. Use it instead of inputs for a large or machine-produced inputs set, so it never passes through the conversation. Mutually exclusive with inputs. The loaded object is used exactly as inline inputs would be.",
  );

/** The two ways a caller supplies a run's inputs, before the file arm is read. */
export interface InputsSource {
  inputs?: Record<string, unknown>;
  inputs_path?: string;
}

export interface ResolvedInputs {
  /** The inputs to send: the inline object, the loaded file, or absent when neither was supplied. */
  inputs?: Record<string, unknown>;
  /** The refusals' problems, empty when the inputs settled. */
  faults: Problem[];
}

/**
 * Settle `inputs` / `inputs_path` into the one inputs object the capability
 * sends, ahead of the request-shape checks, as {@link resolveMethodSource}
 * does for `method_dir` and `files`. Both supplied is refused at `inputs_path`; `required`
 * refuses neither at `inputs`. The file arm reads through the context's
 * `.json` resolver — the workshop's `localFileResolver`, under the same
 * extension and working-directory gates as a `{ path }` item — and a context
 * without one, as the core's own `build…Context` builds, refuses it, as it
 * refuses a `{ path }` item. The file must hold one JSON object.
 */
export async function resolveInputsSource(
  source: InputsSource,
  resolver: FileResolver | undefined,
  options: { required: boolean },
): Promise<ResolvedInputs> {
  const refuse = (location: string, refusal: Refusal): ResolvedInputs => ({
    faults: [refusalProblem(location, refusal)],
  });

  if (source.inputs_path === undefined) {
    if (source.inputs === undefined && options.required) {
      return refuse("inputs", {
        reason: "missing",
        message: "Supply the filled inputs, as inputs or as inputs_path.",
        remedy:
          "Pass the filled template as inputs, or the path of a .json file holding it as inputs_path. An empty object {} is accepted.",
      });
    }
    return { ...(source.inputs === undefined ? {} : { inputs: source.inputs }), faults: [] };
  }

  if (source.inputs !== undefined) {
    return refuse("inputs_path", {
      reason: "mutually_exclusive",
      message: "Supply inputs or inputs_path, not both.",
      remedy:
        "Drop inputs to read the inputs from the file, or drop inputs_path to send the inline object.",
    });
  }

  if (source.inputs_path.trim() === "") {
    return refuse("inputs_path", {
      reason: "empty",
      message: "inputs_path must not be empty when supplied.",
      remedy: "Pass the path of a .json file, or pass the inputs inline as inputs.",
    });
  }

  if (resolver === undefined) {
    return refuse("inputs_path", {
      reason: "not_readable_here",
      message: "This deployment cannot read files from disk; pass the inputs inline.",
      remedy:
        "Pass the inputs inline as inputs, or use the local workshop server (npx @pipelex/mcp), which reads inputs_path.",
    });
  }

  const resolution = await resolver.resolve(source.inputs_path);
  if (!resolution.ok) {
    return refuse("inputs_path", resolution);
  }

  let parsed: unknown;
  try {
    // Some Windows editors and PowerShell write UTF-8 with a byte-order mark, which JSON.parse refuses.
    parsed = JSON.parse(resolution.content.replace(/^\uFEFF/, ""));
  } catch (err) {
    return refuse("inputs_path", {
      reason: "not_json",
      message: `File is not valid JSON: ${source.inputs_path} (${err instanceof Error ? err.message : String(err)}).`,
      remedy:
        "Fix the file so it holds one JSON object, the filled inputs template, or pass the inputs inline as inputs.",
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const found = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    return refuse("inputs_path", {
      reason: "not_an_object",
      message: `File does not hold a JSON object: ${source.inputs_path} holds ${found}.`,
      remedy:
        "The file must hold one JSON object mapping each input name to its value, as the filled inputs template does.",
    });
  }

  return { inputs: parsed as Record<string, unknown>, faults: [] };
}

// ── the problem: the one shape every failure takes ──────────────────

/**
 * Where a problem, or one of its items, happened: the MTHDS protocol's
 * location, open to members it does not name. A refusal the workshop makes
 * itself is located at the tool argument it refuses, by `field`, written as
 * the argument's path (`files[2].path`).
 */
export const problemLocationSchema = z
  .looseObject({
    pipe: z.string().optional(),
    path: z.array(z.string()).optional(),
    input: z.string().optional(),
    field: z.string().optional(),
    item: z.number().optional(),
    attempt: z.number().optional(),
    file: z.string().optional(),
    line: z.number().optional(),
    column: z.number().optional(),
  })
  .describe("Where it happened; field names the tool argument of a refusal this server made.");

/**
 * One fault of a problem or of a verdict, as the MTHDS protocol states it:
 * its code and detail, and where it happened. Open to members the protocol
 * does not name.
 */
export const problemItemSchema = z
  .looseObject({
    code: z.string(),
    detail: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
    location: problemLocationSchema.optional(),
    suggestions: z.array(z.string()).optional(),
    suggested_fix: z.looseObject({}).optional(),
  })
  .describe("One fault, as the MTHDS protocol states it.");

/**
 * The problem document, the caller's view: the MTHDS protocol's members, the
 * Pipelex API's `request_id` and the `message` a refusal of this server's own
 * carries, and never the operator's `diagnostics`. Open, so a member a newer
 * API adds reaches the caller as it was sent. A program branches on `code`,
 * `domain`, `retry` and `next_step.kind`, never on the wording.
 */
export const problemSchema = z
  .looseObject({
    type: z.string(),
    title: z.string(),
    status: z.number().optional(),
    detail: z.string(),
    code: z.string().describe("The registry code to branch on."),
    domain: z.string().describe("Who must act: input, method, account, operator or runtime."),
    retry: z
      .string()
      .describe("yes, no, or outcome_unknown: it may have taken effect, so read before resending."),
    retry_after: z.number().optional(),
    next_step: z.looseObject({ kind: z.string(), detail: z.string() }),
    params: z.record(z.string(), z.unknown()).optional(),
    location: problemLocationSchema.optional(),
    errors: z.array(problemItemSchema).optional(),
    pipeline_run_id: z.string().optional(),
    request_id: z.string().optional(),
    message: z.string().optional().describe("The client's own sentence, when it adds to detail."),
    run_error: z.unknown().optional(),
  })
  .describe("The MTHDS problem document, as the caller sees it.");

export type { Problem, ProblemItem };

/**
 * A refusal a file resolver, a folder's listing or the secret guard words
 * before anything is sent: what happened and what the caller can do, and the
 * facts the problem it becomes is built from. `reason` says why in one
 * identifier; `unreadable` names a local path that cannot be read — missing,
 * not a regular file, or refused by the system — which is
 * `client.file_unreadable` rather than a refused argument; `busy`
 * names one that changed while it was read, which is `client.workspace_busy`.
 */
export interface Refusal {
  message: string;
  remedy: string;
  reason?: string;
  unreadable?: string;
  busy?: string;
}

/** The caller's view of a problem: everything but the operator's `diagnostics`. */
export function callerView(problem: Problem): Problem {
  if (!("diagnostics" in problem)) return problem;
  const { diagnostics: _operatorOnly, ...view } = problem;
  return view as Problem;
}

/**
 * The longest error sentence a problem carries as its `message`, in code
 * points: an SDK error whose answer was unreadable quotes the body it read,
 * which a misbehaving server can make arbitrarily long.
 */
const ERROR_SENTENCE_MAX_CODE_POINTS = 600;

/** The error's own sentence, on one line and bounded, or `undefined` when it has none. */
function errorSentence(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const line = asOneLine(err.message);
  if (line === "") return undefined;
  const bounded = boundCodePoints(line, ERROR_SENTENCE_MAX_CODE_POINTS);
  return bounded.truncated ? `${bounded.value}…` : bounded.value;
}

/**
 * The problem a failure reports, in the caller's view. Every error
 * `@pipelex/sdk` raises carries its problem, with the answer's request id
 * (`reportedProblem`); anything else is `runtime.unexpected`, since nothing
 * says more about it.
 *
 * The error's own sentence rides as the problem's `message` when the problem
 * carries none and the sentence says more than its `detail`: a problem the SDK
 * builds from a registry code is worded for the code, generic by design (an
 * argument refused, a runtime that could not be reached), while the error's
 * sentence says which argument and why, or which address answered what. A
 * sentence that quotes the detail adds nothing and is left out. An answer the
 * server gave is its own account (`ApiResponseError`, whose sentence is the
 * route, the status and the detail again), except one the SDK could not read,
 * whose next step asks for the body that sentence quotes. Nothing else of the
 * problem changes: its code, domain, retry and next step are the SDK's.
 */
export function problemOf(err: unknown): Problem {
  const sentence = errorSentence(err);
  if (isProblemError(err)) {
    const problem = callerView(reportedProblem(err));
    const said = problem.message;
    if ((typeof said === "string" && said !== "") || sentence === undefined) return problem;
    if (err instanceof ApiResponseError && problem.code !== "client.response_unreadable") {
      return problem;
    }
    return sentence.includes(problem.detail) ? problem : { ...problem, message: sentence };
  }
  return buildProblem("runtime.unexpected", {}, { extra: { message: sentence } });
}

/**
 * A sentence and its remedy as one `message`, the remedy closing it, on one line:
 * a path the sentence quotes may hold a newline, which would otherwise open a
 * heading or end a list in the Markdown it is rendered into.
 */
function messageWithRemedy(message: string, remedy: string | undefined): string {
  return asOneLine(remedy === undefined || remedy === "" ? message : `${message} ${remedy}`);
}

/**
 * The problem of a tool argument this server refuses before anything is sent:
 * `client.argument_invalid`, naming the argument by its path and why in one
 * identifier, located at the same path, with the server's own sentence and
 * remedy as its `message`.
 */
export function argumentProblem(
  field: string,
  reason: string,
  message: string,
  remedy?: string,
): Problem {
  return buildProblem(
    "client.argument_invalid",
    { argument: field, reason },
    { location: { field }, extra: { message: messageWithRemedy(message, remedy) } },
  );
}

/** The problem of a {@link Refusal} of the argument at `field`. */
export function refusalProblem(field: string, refusal: Refusal): Problem {
  const options = {
    location: { field },
    extra: { message: messageWithRemedy(refusal.message, refusal.remedy) },
  };
  if (refusal.busy !== undefined) {
    return buildProblem("client.workspace_busy", { path: refusal.busy }, options);
  }
  if (refusal.unreadable !== undefined) {
    return buildProblem(
      "client.file_unreadable",
      { path: refusal.unreadable, reason: refusal.reason ?? "unreadable" },
      options,
    );
  }
  return argumentProblem(field, refusal.reason ?? "refused", refusal.message, refusal.remedy);
}

/**
 * The one problem of a call refused before anything was sent, from every
 * fault found: the fault itself when there is one, else one
 * `client.argument_invalid` naming the first fault's argument, whose `errors`
 * list every fault as an item, its own code, sentence and location kept.
 *
 * A fault a retry can clear (its `retry` other than `no`, such as a file that
 * changed while it was read, `client.workspace_busy`) is reported on its
 * own, ahead of every other, since a problem item carries no retry verdict
 * and the wrapper's `no` would hide it: what was read while files were
 * changing cannot be trusted, and the retry reads again and reports whatever
 * faults remain. Its `message` says that other faults were found.
 */
export function faultsProblem(faults: readonly Problem[]): Problem {
  const [first] = faults;
  if (first === undefined) {
    throw new Error("faultsProblem needs at least one fault");
  }
  if (faults.length === 1) return first;
  const retryable = faults.find((fault) => fault.retry !== "no");
  if (retryable !== undefined) {
    const said = typeof retryable.message === "string" ? `${retryable.message} ` : "";
    return {
      ...retryable,
      message: `${said}Other faults were found in this call too; once retried, it reports any that remain.`,
    };
  }
  const argument =
    typeof first.params?.argument === "string"
      ? first.params.argument
      : (first.location?.field ?? "arguments");
  return buildProblem(
    "client.argument_invalid",
    { argument, reason: "several_faults" },
    {
      ...(first.location === undefined ? {} : { location: first.location }),
      errors: faults.map(problemItemOf),
      extra: {
        message:
          "Several arguments were refused before anything was sent; each fault is listed under errors.",
      },
    },
  );
}

/** A problem as one item of another's `errors`: its code, its own sentence, its parameters and location. */
function problemItemOf(problem: Problem): ProblemItem {
  const message = problem.message;
  return {
    code: problem.code,
    detail: typeof message === "string" && message !== "" ? message : problem.detail,
    ...(problem.params === undefined ? {} : { params: problem.params }),
    ...(problem.location === undefined ? {} : { location: problem.location }),
  };
}

/**
 * What this server says about the API a call used, beside the problem of a
 * request that failed: where its key came from and how to change it, and
 * where its base URL came from. The workshop sets both on every tool call
 * from where it read them (`src/credentials.ts`); a context without them, as
 * in a capability's own tests, names the environment variables.
 */
export interface ApiNotes {
  apiKey?: string;
  baseUrl?: string;
}

/** The API-key note of a context that carries none. */
const DEFAULT_API_KEY_NOTE = "The API key is read from PIPELEX_API_KEY.";

/** The base-URL note of a context that carries none. */
const DEFAULT_BASE_URL_NOTE =
  "The Pipelex API in use is the one PIPELEX_BASE_URL names, else the hosted Pipelex API.";

/** The codes of a refused or missing credential, whose fix is the key the call sent. */
const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  "auth.missing_credential",
  "auth.invalid_credential",
  "auth.credential_expired",
]);

/**
 * The codes whose fix may be the API the call reached: an API it could not
 * reach, a route or a capability the deployment does not serve, an answer it
 * could not read, and a refused credential, which a key minted for another
 * deployment meets. A base URL the client could not use is
 * `client.not_configured` naming `base_url`, read by {@link isBaseUrlProblem}
 * beside these, since the same code names the working directory too.
 */
const BASE_URL_CODES: ReadonlySet<string> = new Set([
  ...CREDENTIAL_CODES,
  "client.unreachable",
  "client.response_unreadable",
  "request.not_found",
  "runtime.unsupported",
]);

/** Whether the fix of `problem` may be the API the call reached, so its base URL's note belongs beside it. */
function isBaseUrlProblem(problem: Problem): boolean {
  if (BASE_URL_CODES.has(problem.code)) return true;
  return problem.code === "client.not_configured" && problem.params?.setting === "base_url";
}

/**
 * The Markdown summary of a call that produced no verdict: the problem as
 * `renderProblemMarkdown` renders it, its title, detail, this server's
 * message, next step, code, request id, run and location, then each fault of
 * its `errors`; and, when the fix may be the API or the key the call used,
 * the notes saying where they came from. Every tool's no-verdict summary is
 * this one rendering, so every failure reads alike.
 */
export function problemSummary(problem: Problem, notes: ApiNotes = {}): string {
  const parts = [renderProblemMarkdown(problem).trimEnd()];
  if (CREDENTIAL_CODES.has(problem.code)) parts.push(notes.apiKey ?? DEFAULT_API_KEY_NOTE);
  if (isBaseUrlProblem(problem)) parts.push(notes.baseUrl ?? DEFAULT_BASE_URL_NOTE);
  return parts.join("\n\n");
}

/**
 * One problem on one line, for a list of items a produced result reports
 * apart from its verdict, such as a picture or a file that could not be
 * fetched: what went wrong, this server's or the store's own sentence when
 * there is one, the code, and what to do.
 */
export function problemLine(problem: Problem): string {
  const message =
    typeof problem.message === "string" && problem.message !== "" ? ` ${problem.message}` : "";
  return asOneLine(
    `${problem.detail}${message} (\`${problem.code}\`) Next step: ${problem.next_step.detail}`,
  );
}

/** One MCP `content` item — the human/LLM-readable text stream. */
export type ContentText = { type: "text"; text: string };

/**
 * One MCP `image` content item — base64 bytes the host puts in front of the
 * model as a picture. `_meta.uri` is the storage reference the bytes came
 * from, so a programmatic consumer can correlate a block with the `main_stuff`
 * value that produced it; it is the tool result's own `_meta` channel, so the
 * model never pays for it.
 *
 * **No `annotations`, ever.** The MCP standard's `annotations` hint (audience,
 * priority) is optional and looks harmless, but the host probe found that Codex
 * refuses an annotated image block outright with `Unexpected response type`,
 * against a control proving the identical block without them is accepted
 * (L-260920-fc66db).
 */
export type ContentImage = {
  type: "image";
  data: string;
  mimeType: string;
  _meta: { uri: string };
};

/**
 * Compose a tool result's `content` text stream: the summary, the produced
 * verdict's or the problem's ({@link problemSummary}), then, when the call
 * sent a method's tree, its `files_sent` as a list ({@link filesSentSection}),
 * so the reader sees what left the machine.
 */
export function toolResultContent(summary: string, filesSent?: readonly string[]): [ContentText] {
  const parts = [summary];
  if (filesSent !== undefined && filesSent.length > 0) {
    parts.push(filesSentSection(filesSent));
  }
  return [{ type: "text", text: parts.join("\n\n") }];
}

/**
 * The summary's account of what a method's tree sent: every file, so the
 * reader sees a file the folder held without anyone listing it.
 */
export function filesSentSection(paths: readonly string[]): string {
  return [
    "## Files sent",
    "",
    "The method's tree, every file this call sent and nothing else:",
    "",
    ...paths.map((sent) => `- ${codeSpan(asOneLine(sent))}`),
  ].join("\n");
}

/**
 * `text` as a Markdown code span that a backtick inside it cannot close: the
 * fence is one backtick longer than the longest run in the text, padded with
 * a space when the text starts or ends with one, as CommonMark reads it.
 */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Collapse internal whitespace runs (including newlines) to single spaces so a
 * message/remedy stays a single Markdown list bullet. An embedded blank line would
 * otherwise terminate the list item early — reachable via a crafted path (a
 * filename may legally contain newlines and still end in `.mthds`), SDK-thrown
 * error text, or a stored catalog name/description. The raw one-liners we
 * normally emit are unaffected.
 */
export function asOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Escape the Markdown a member-chosen text could use to break out of where a
 * summary puts it: emphasis (`*`, `_`), a code span (a backtick), a link
 * (`[`, `]`), inline HTML (`<`, `>`), a table cell (`|`), strikethrough (`~`)
 * and the escape character itself. A file name wrapped in `**…**` could
 * otherwise close the bold and write a code span of its own, such as a fake
 * `uri`, onto the line the model reads. Characters that matter only at the
 * start of a line are left alone: the text never starts one.
 */
export function escapeMarkdownInline(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, (character) => `\\${character}`);
}

/**
 * Cut a text to `limit` Unicode code points, never splitting a surrogate pair,
 * and say whether anything was cut.
 */
export function boundCodePoints(
  value: string,
  limit: number,
): { value: string; truncated: boolean } {
  const codePoints = Array.from(value);
  return {
    value: codePoints.slice(0, limit).join(""),
    truncated: codePoints.length > limit,
  };
}

/** A bare catalog id, as the platform mints them; a version suffix (`@draft`, `@3`) is no part of it. */
export const BARE_METHOD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The platform's bound on an id it takes as a filter. */
export const METHOD_ID_MAX_CHARS = 128;

/**
 * Read `value` as a method's bare catalog id, the one form that names a
 * method's files: they are the method's, whatever version took or made them.
 * A suffixed id is reported with its bare part rather than stripped, so the
 * caller can be told what to pass: a selector is never rewritten behind its
 * back.
 */
export function bareMethodIdOf(
  value: string,
):
  | { ok: true; methodId: string }
  | { ok: false; suffixed: true; bare: string }
  | { ok: false; suffixed: false } {
  const methodId = value.trim();
  const at = methodId.indexOf("@");
  if (at >= 0) {
    const bare = methodId.slice(0, at);
    if (BARE_METHOD_ID_PATTERN.test(bare) && bare.length <= METHOD_ID_MAX_CHARS) {
      return { ok: false, suffixed: true, bare };
    }
    return { ok: false, suffixed: false };
  }
  if (methodId.length > METHOD_ID_MAX_CHARS || !BARE_METHOD_ID_PATTERN.test(methodId)) {
    return { ok: false, suffixed: false };
  }
  return { ok: true, methodId };
}

/**
 * The refusal of a method id that should name a method's files and does not
 * read as its bare id, located at `location`: a suffixed one names the bare id
 * to pass, any other one says it is no catalog id. `remedy` closes either remedy
 * with the caller's own alternative.
 */
export function bareMethodIdRefusal(
  value: string,
  check: { ok: false; suffixed: true; bare: string } | { ok: false; suffixed: false },
  location: string,
  remedy: string,
): Problem {
  if (check.suffixed) {
    return argumentProblem(
      location,
      "version_suffix",
      `${location} ${JSON.stringify(value)} names a version of the method, and files belong to the method, not to one of its versions.`,
      `Pass ${location} ${JSON.stringify(check.bare)}, the method's bare id. ${remedy}`,
    );
  }
  return argumentProblem(
    location,
    "not_a_catalog_id",
    `${location} ${JSON.stringify(value)} is not a catalog id.`,
    `Pass a saved method's bare id as ${WORKSHOP_TOOL_NAMES.listMethods} returns it (mt_…). ${remedy}`,
  );
}

/** The env-derived API coordinates every capability context starts from. */
export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
  /**
   * Who is calling, for the `User-Agent` (`./client-identification.ts`). Set by
   * the workshop through `patchLocalApiContexts` in its `src/tools.ts`, never
   * by the env: the workshop reads its host from the MCP handshake, so it is a
   * function called when a client is constructed. Absent, a client still names
   * itself `pipelex-mcp` (`BARE_APP_INFO`).
   */
  appInfo?: AppInfoSource;
}

/**
 * What the workshop may override on every capability context that talks to
 * the API. Its tool table applies it to the whole context set, since that
 * table is where the list of contexts lives. The workshop patches `appInfo`
 * once, when its server is built, and `baseUrl`, `apiKey` and `apiNotes` at
 * the start of every tool call, from its host's environment and the saved key
 * in the home `.env` (`src/credentials.ts`).
 */
export interface ApiContextPatch {
  baseUrl?: string;
  apiKey?: string;
  apiNotes?: ApiNotes;
  appInfo?: AppInfoSource;
}

/**
 * THE one place this server constructs a Pipelex API client. Every client is
 * given the caller's `appInfo`, so every request it sends carries the
 * `pipelex-mcp/<version> (<mode>; host=<host>)` `User-Agent` and the platform
 * attributes it to the `mcp` surface. The `pipelex/sdk-client-factory` lint rule
 * (`eslint-rules/pipelex-api-boundary.mjs`) refuses `new PipelexApiClient(…)` —
 * or any other `…ApiClient` — anywhere else, and `pipelex/no-raw-fetch` refuses
 * a bare `fetch` outside the files that fetch third-party links.
 *
 * `clientClass` lets a capability pick a subclass (`SizeGuardedPipelexApiClient`)
 * without constructing it itself. The client is built per tool call, which is
 * what makes the lazy `appInfo` possible: by then the workshop has completed its
 * handshake.
 */
export function createPipelexApiClient<T extends PipelexApiClient = PipelexApiClient>(
  config: ApiConfig,
  clientClass?: new (options: PipelexApiClientOptions) => T,
): T {
  const options: PipelexApiClientOptions = {
    baseUrl: config.baseUrl,
    // The config's key is the whole decision. Handed none, the SDK falls back
    // to the process's own `PIPELEX_API_KEY`, so a call the workshop resolved as
    // keyless (`src/credentials.ts`) could still carry an ambient key; an empty
    // string is the SDK's "no key", which sends no `Authorization` header.
    apiKey: config.apiKey ?? "",
    appInfo: config.appInfo?.() ?? BARE_APP_INFO,
  };
  const Client =
    clientClass ?? (PipelexApiClient as unknown as new (options: PipelexApiClientOptions) => T);
  return new Client(options);
}

interface ApiEnv {
  PIPELEX_BASE_URL?: string;
  PIPELEX_API_KEY?: string;
}

export function buildApiConfig(env: ApiEnv = process.env): ApiConfig {
  return {
    baseUrl: env.PIPELEX_BASE_URL || DEFAULT_API_URL,
    apiKey: env.PIPELEX_API_KEY || undefined,
  };
}

/**
 * The bundle blueprint's declared `main_pipe`, qualified by the blueprint's
 * `domain` when it is authored bare — the fallback pipe the validate
 * capability consults behind the runner's own `default_pipe_ref`.
 *
 * Every read is defensive: `bundle_blueprint` is opaque transport (its schema
 * is the runtime's, not this server's), so a blueprint that is not an object,
 * a non-string `main_pipe` and a non-string `domain` are all "the blueprint
 * declares none" rather than something to guess at.
 *
 * **A `main_pipe` that already carries a domain is returned untouched**, which
 * is the rule `@pipelex/sdk`'s own `readBlueprintMainPipeRef` applies and which
 * this repo used to get wrong by always prefixing: a cross-domain
 * `main_pipe = "other.shout"` became `demo.other.shout`, a ref that keys
 * neither `pipe_io_contracts` nor `input_form`, so the signature silently went
 * missing instead of being found. Only reachable on a runner old enough to
 * serve no `default_pipe_ref`, which is why it went unseen.
 *
 * **Both members are trimmed before use**, which is not cosmetic: the SDK reads
 * them through its own `nonEmptyString`, so without the trim a padded
 * `main_pipe` keyed nothing here and `domain.main` there, and the signature
 * named a different pipe from the one the SDK selects. Nothing upstream
 * strips it: `pipelex`'s `DomainBlueprint.main_pipe` is a bare `str` with no
 * validator, so a padded TOML value reaches the wire intact.
 */
export function blueprintMainPipeRefOf(blueprint: unknown): string | undefined {
  if (blueprint === null || typeof blueprint !== "object" || Array.isArray(blueprint)) {
    return undefined;
  }
  const record = blueprint as Record<string, unknown>;
  const mainPipe = trimmedNonEmpty(record.main_pipe);
  if (mainPipe === undefined) {
    return undefined;
  }
  if (mainPipe.includes(".")) {
    return mainPipe;
  }
  const domain = trimmedNonEmpty(record.domain);
  return domain === undefined ? undefined : `${domain}.${mainPipe}`;
}

/** A trimmed non-empty string, or `undefined` — the SDK's `nonEmptyString` rule. */
function trimmedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A plain object, or `undefined` — the one narrowing step every artifact check starts from. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The shared `<address>[@<tag>]` grammar sentence, reused by schema descriptions and remedies. */
export const METHOD_REF_GRAMMAR =
  "github.com/<owner>/<repo>[/<selector>][@<tag>], e.g. github.com/Pipelex/methods/documents@v0.1.0";

/**
 * The selectors a method-taking request may carry beside its (already
 * resolved) tree. `undefined` means "not supplied"; a supplied-but-blank value
 * is rejected loudly rather than treated as absent. A method folder
 * (`method_dir`) or `files` has resolved into that tree by the time these are
 * checked, the folder's own pairings refused first
 * ({@link resolveMethodSource}).
 */
export interface MethodSelectors {
  method_ref?: string;
  method_id?: string;
}

/**
 * The two uniform combination rules of the addressing contract (SPEC.md →
 * Method Selectors):
 *
 * - `"one_selector"` — the tooling tools (`mthds_validate`,
 *   `mthds_inputs_template`, `mthds_prepare_inputs`, `mthds_codegen`): exactly one of
 *   `method_dir` / files / `method_ref` / `method_id`. Stateless operations have no Run row, so
 *   "linkage" has no referent and an extra selector could only be ignored —
 *   the worst contract of the three.
 * - `"run_source"` — `mthds_run`: inline files, or a method folder, win and
 *   `method_id` beside them demotes to run-history linkage (legal pair), while
 *   `method_ref` is a complete run source of its own and pairs with nothing.
 */
export type SelectorRule = "one_selector" | "run_source";

/**
 * Request-shape checks for every method-taking tool: at least one method
 * selector must be supplied (`hasTree` says whether `method_dir` or `files`
 * resolved into a tree), blank selectors are rejected at their own field,
 * and the illegal pairings for the given {@link SelectorRule} are rejected
 * before anything reaches the wire (mirroring the API's own 422s). Selector
 * format beyond non-blank stays server-owned (the `run_id` stance).
 *
 * Every method-taking tool exposes every selector, so the teaching text is
 * unconditional. It was not always: `mthds_prepare_inputs` withheld
 * `method_ref` while the SDK's `prepareInputs` took inline files only, and this
 * function took an `acceptsMethodRef` flag to keep the "no selector" message
 * honest for it. The flag went out with the exception rather than surviving as
 * a parameter with one reachable value.
 */
export function validateMethodSelectorRequest(
  hasTree: boolean,
  selectors: MethodSelectors,
  options: { rule: SelectorRule },
): Problem[] {
  const errors: Problem[] = [];

  if (selectors.method_ref !== undefined && selectors.method_ref.trim() === "") {
    errors.push(
      argumentProblem(
        "method_ref",
        "empty",
        "method_ref must not be empty when supplied.",
        `Pass a published method's address — ${METHOD_REF_GRAMMAR} — or submit files or a method_id instead.`,
      ),
    );
  }

  if (selectors.method_id !== undefined && selectors.method_id.trim() === "") {
    errors.push(
      argumentProblem(
        "method_id",
        "empty",
        "method_id must not be empty when supplied.",
        "Pass the catalog id (mt_…) of a registered method, or submit files instead.",
      ),
    );
  }

  if (!hasTree && selectors.method_ref === undefined && selectors.method_id === undefined) {
    errors.push(
      argumentProblem(
        "files",
        "missing",
        "Provide a method folder, MTHDS files, a method_ref address, or a method_id.",
        `Pass the method's folder as method_dir, submit files as [{ path }] or [{ content, uri? }], a published method's address (${METHOD_REF_GRAMMAR}) as method_ref, or the catalog id (mt_…) of a registered method as method_id.`,
      ),
    );
  }

  errors.push(...validateSelectorExclusivity(hasTree, selectors, options.rule));
  return errors;
}

/**
 * The illegal pairings per {@link SelectorRule}. Evaluated only on validly
 * supplied selectors (a blank one already earned its own error above), and
 * emitting one error per illegal pair so a three-selector request teaches both
 * offenses instead of one.
 */
function validateSelectorExclusivity(
  hasFiles: boolean,
  selectors: MethodSelectors,
  rule: SelectorRule,
): Problem[] {
  const errors: Problem[] = [];
  const hasRef = selectors.method_ref !== undefined && selectors.method_ref.trim() !== "";
  const hasId = selectors.method_id !== undefined && selectors.method_id.trim() !== "";

  if (hasFiles && hasRef) {
    errors.push(
      argumentProblem(
        "method_ref",
        "mutually_exclusive",
        "files and method_ref are mutually exclusive — submit the files or the address, never both.",
        "An address is a complete method source resolved server-side; drop method_ref to operate on the submitted files, or drop files to operate on the published package.",
      ),
    );
  }

  if (hasRef && hasId) {
    errors.push(
      argumentProblem(
        "method_id",
        "mutually_exclusive",
        rule === "run_source"
          ? "method_ref and method_id are mutually exclusive — an address run carries its own provenance and takes no linkage id."
          : "method_ref and method_id are mutually exclusive — select the method by exactly one of them.",
        "Drop one of the two selectors.",
      ),
    );
  }

  if (rule === "one_selector" && hasFiles && hasId) {
    errors.push(
      argumentProblem(
        "method_id",
        "mutually_exclusive",
        "files and method_id are mutually exclusive on this tool — submit the files or the catalog id, never both.",
        "This operation is stateless, so there is no run-history linkage for an extra id to feed; drop method_id to operate on the submitted files, or drop files to operate on the registered method.",
      ),
    );
  }

  return errors;
}

/** Request-shape check on a run id (format stays server-owned). */
export function validateRunIdRequest(runId: string): Problem[] {
  if (runId.trim() === "") {
    return [
      argumentProblem(
        "run_id",
        "empty",
        "run_id must not be empty.",
        `Pass the durable run id returned by ${WORKSHOP_TOOL_NAMES.run}.`,
      ),
    ];
  }
  return [];
}

/**
 * The registry codes of the execution-locus gate's refusals: a method
 * shipping Python (`.py`) on a deployment that is not sandbox-hosted, and a
 * method declaring its structures as Python classes on one that imports none.
 */
const EXECUTION_LOCUS_CODES: ReadonlySet<string> = new Set([
  "pipelex.deployment.custom_code_requires_sandbox",
  "pipelex.deployment.python_structures_refused",
]);

/**
 * Whether `err` is the execution-locus gate refusing a method for the Python it
 * holds, by the problem's code: the deployment will not load the method at
 * all, so no verdict about it can be had there, while nothing is wrong with
 * the request. The save reads it to store a draft unvalidated rather than
 * refuse it.
 */
export function isExecutionLocusRefusal(err: unknown): boolean {
  return isProblemError(err) && EXECUTION_LOCUS_CODES.has(err.problem.code);
}

// ── the artifact fetch boundary, shared by the two tools that cross it ──

/**
 * The explicit override of the plain-http rule, read by every capability that
 * fetches a stored artifact — `mthds_download_artifacts` and
 * `mthds_show_images`. Unset, a plain `http:` link is accepted
 * exactly when `PIPELEX_BASE_URL` is itself `http:` (the local compose stack,
 * whose object store mints plain-http links); `true` / `1` accepts one from any
 * deployment, `false` / `0` refuses one from every deployment. Any other value
 * refuses, so a typo fails closed.
 */
export const ALLOW_HTTP_ENV = "PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP";

/**
 * Read {@link ALLOW_HTTP_ENV}: `undefined` when unset or blank (derive from
 * the base URL), otherwise the override. An unrecognized value refuses rather
 * than falling back to the derivation, so a misspelled override can only ever
 * make the fetch stricter.
 */
export function parseAllowHttpOverride(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return undefined;
  return normalized === "true" || normalized === "1";
}

/** The env-derived coordinates plus the plain-http override, for a fetching capability. */
export interface ArtifactFetchConfig extends ApiConfig {
  allowHttp?: boolean;
}

interface ArtifactFetchEnv extends ApiEnv {
  [ALLOW_HTTP_ENV]?: string;
}

export function buildArtifactFetchConfig(env: ArtifactFetchEnv = process.env): ArtifactFetchConfig {
  const allowHttp = parseAllowHttpOverride(env[ALLOW_HTTP_ENV]);
  return { ...buildApiConfig(env), ...(allowHttp === undefined ? {} : { allowHttp }) };
}

/**
 * Whether a plain `http:` download link is fetched: the explicit override when
 * one is set, otherwise exactly when the configured API is itself plain http —
 * the local compose stack, whose object store mints plain-http presigned links.
 * A deployment reached over https gets https links, so a plain-http one there
 * is refused rather than followed silently. A malformed base URL refuses; the
 * client constructor then reports it as the config error it is.
 */
export function allowsPlainHttp(context: ArtifactFetchConfig): boolean {
  if (context.allowHttp !== undefined) return context.allowHttp;
  try {
    return new URL(context.baseUrl).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The problem of one reference a download or an image fetch could not read,
 * from the SDK's `{ code, detail }` verdict item: the SDK's own reading of
 * the fetch boundary's codes (`ArtifactFetchError`'s problem), with the
 * item's detail as its `message`. The codes are the SDK's closed vocabulary,
 * relayed from the bulk resolve route without validation, so a detail that is
 * no string is left out rather than failing the result.
 */
export function fetchItemProblem(error: { code: string; detail: string }, uri: string): Problem {
  const detail: unknown = error.detail;
  const code: unknown = error.code;
  const problem = callerView(
    new ArtifactFetchError(
      typeof detail === "string" ? detail : "",
      uri,
      typeof code === "string" ? code : "unknown",
    ).problem,
  );
  return typeof detail === "string" && detail.trim() !== "" && detail !== problem.detail
    ? { ...problem, message: detail }
    : problem;
}

/**
 * Directories a misaimed `output_dir` would otherwise drag in wholesale.
 *
 * Shared by the two walks that descend a user's directory — the codegen
 * writer's orphan walk and the catalog pull's unmanaged-source walk — because
 * they ask the same question of the same kind of tree, and a set that lived in
 * one of them was a set the other silently did without.
 */
export const PRUNED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "__pycache__",
]);

// ── the image-inlining boundary (mthds_show_images) ─────────────────

/**
 * The per-image byte cap. NOT a cost control: the host probe
 * (L-260920-fc66db) established that a host bills an
 * image block at the model's native vision price, derived from its pixel
 * dimensions, and that its base64 size costs nothing. This is a transport
 * guard and a point of diminishing returns — Claude Code's stdio transport
 * carried an 8 MiB PNG and died on a 12 MiB one with `Connection closed`,
 * and above roughly a megabyte every host measured re-encodes the image to a
 * fraction of what was sent, so bytes past that buy nothing.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * The total bytes one `mthds_show_images` call inlines. Chosen so a whole tool
 * result stays well under the JSON-RPC message size that killed the probe's
 * 12 MiB rung while its 8 MiB rung passed.
 */
export const INLINE_IMAGES_BUDGET = 6 * 1024 * 1024;

/**
 * How many candidates one call may *attempt* — so one call makes at most this
 * many network exchanges whatever the run produced, and buys at most this much
 * permanent context (about eight thousand tokens at the worst per-picture price
 * the probe observed, and far less in practice).
 */
export const MAX_INLINE_IMAGES = 6;

/**
 * How many image candidates one tool result may ENUMERATE — the bound on the
 * inventory itself, as distinct from {@link MAX_INLINE_IMAGES}, which bounds
 * how many are fetched.
 *
 * The two tools that publish the inventory were both unbounded: a completed
 * run walks its FULL output for candidates (deliberately — a reference pruned
 * out of the bounded `main_stuff` is still a real picture), so a method
 * emitting a large `Image[]` put an arbitrarily long list of references into
 * model-facing `structuredContent`, outside the `MAIN_STUFF_CAP` discipline
 * the output beside it obeys. `mthds_show_images` compounded it, emitting one
 * entry and one prose line per candidate however few it fetched.
 *
 * Generous against the cap that matters: a caller can only fetch six per call,
 * so this is about being able to SEE what a run produced and page through it
 * by naming references, not about fetching. A run with more than this many
 * pictures reports the remainder as a count.
 */
export const MAX_IMAGE_CANDIDATE_ENTRIES = 32;

/**
 * The response content types that may be emitted as an MCP image block. The
 * object store answers with the type the runtime stored, which is the
 * authority — the resolve route's `content_type` is only a guess from the
 * reference's extension. No SVG: it is not a model-accepted image type, and it
 * is a script-bearing document in a renderer.
 */
export const INLINE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type InlineImageMimeType = (typeof INLINE_IMAGE_MIME_TYPES)[number];

/**
 * The storage-key extensions that make a reference an image *candidate* — a
 * free prefilter over the key alone, never a verdict. Keep it in step with the
 * SDK's `artifactFilename` extension table, which is what decides the key a
 * produced file is stored under. A key with no extension at all is a candidate
 * too: the runtime does store such keys, and only the fetched response's
 * content type can settle them.
 */
export const INLINE_IMAGE_KEY_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;

/** One stored reference that might be an image, as the prefilter found it. */
export interface ImageCandidate {
  /** The `pipelex-storage://` reference, exactly as it appears in the run output. */
  uri: string;
  /** The reference's storage key — everything after the scheme. */
  key: string;
}

/** The storage key of a reference: everything after `pipelex-storage://`. */
export function storageKeyOf(uri: string): string {
  return uri.startsWith(PIPELEX_STORAGE_SCHEME) ? uri.slice(PIPELEX_STORAGE_SCHEME.length) : uri;
}

/**
 * Whether a storage key looks like an image: a known image extension, or no
 * extension at all on the key's last segment. Case-insensitive, and anything
 * after a `?` or `#` is ignored — a key is not a URL, but a stored one has been
 * seen to carry a query-looking tail.
 */
export function looksLikeImageKey(key: string): boolean {
  const name = key.split(/[?#]/, 1)[0].split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true; // no extension (a leading dot is not one either)
  const extension = name.slice(dot).toLowerCase();
  return (INLINE_IMAGE_KEY_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * Every stored reference in a run's main output that passes the key prefilter,
 * in the SDK's discovery order. Pure — `collectArtifacts` is an in-memory walk,
 * so this costs no network call and is safe on every completed result.
 */
export function imageCandidatesOf(mainStuff: unknown): ImageCandidate[] {
  const seen = new Set<string>();
  return collectArtifacts(mainStuff)
    .filter((uri) => {
      // One reference is one picture, however many times the output names it.
      // An output that carries the same stored file in two places would
      // otherwise be fetched twice, billed twice, and shown twice — and, since
      // `indices` are positions in this list, would give the same picture two
      // positions.
      if (seen.has(uri)) return false;
      seen.add(uri);
      return true;
    })
    .map((uri) => ({ uri, key: storageKeyOf(uri) }))
    .filter((candidate) => looksLikeImageKey(candidate.key));
}
