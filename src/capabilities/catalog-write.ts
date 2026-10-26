import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ApiResponseError, MethodFileTransferError, buildProblem } from "@pipelex/sdk";
import type {
  CoreErrorCode,
  MethodData,
  MethodDetail,
  MethodDraftInput,
  MethodPublishInput,
  MethodPublishResult,
  MethodRenameInput,
  MethodTreeLimits,
  MethodTreeSource,
  MethodVersion,
  MethodWriteInput,
  Problem,
  ProblemItem,
  ProblemParamsByCode,
  SavedMethodFile,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  LEGACY_LINK_FILE_NAME,
  LEGACY_LINK_MOVE,
  LINK_FILE_NAME,
  LinkLockError,
  apiHostOf,
  buildMethodLink,
  existingDestinations,
  foreignEntryReason,
  holdsLegacyLink,
  inLinkTurn,
  readMethodLink,
  replaceMethodLink,
  sameLinkRead,
  withLinkLock,
} from "./catalog-link.js";
import type { LinkFileReport, LinkRead, LinkReplacement, MethodLink } from "./catalog-link.js";
import { listFolderTree } from "./method-tree.js";
import type { ListingLimits } from "./method-tree.js";
import {
  methodVersionsOf,
  methodVersionsSupport,
  readMethodSelector,
  versionReaderOf,
} from "./method-versions.js";
import type {
  MethodSelector,
  MethodVersionsMemories,
  MethodVersionsSupport,
} from "./method-versions.js";
import { secretFindings, secretRefusalText } from "./secret-guard.js";
import {
  SECRET_REASON,
  argumentProblem,
  asOneLine,
  buildApiConfig,
  createPipelexApiClient,
  failedBeforeSending,
  faultsProblem,
  folderTreeToSend,
  problemItemSchema,
  problemOf,
  problemSchema,
  problemSummary,
  refusalProblem,
  shownIn,
  toolResultContent,
} from "./shared.js";
import type {
  ApiConfig,
  ApiNotes,
  FileResolver,
  LocatedMethodDir,
  MethodTreeRead,
  Refusal,
} from "./shared.js";
import { type FolderLimits, methodTreeLimitsOf } from "./tree-limits.js";
import type { TreeLimitsAware } from "./tree-limits.js";
import { validateMethodTree } from "./validate.js";
import type { ValidationContext, ValidationStructuredContent } from "./validate.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";
import {
  containedPath,
  createContainedSubdirectory,
  errorMessage,
  isInsideRoot,
  isMissingPathError,
  resolveSaveDir,
} from "./workspace-boundary.js";

/**
 * The catalog's write half — `mthds_save_method` and `mthds_get_method` (and,
 * in `catalog-publish.ts`, `mthds_publish_method`, over the same context).
 *
 * They complete the loop `mthds_list_methods` opened: the listing says which
 * methods exist, and these two say what a method *is* and let a workshop
 * session change it. **A saved method is a method tree**: every file of its
 * folder the MTHDS standard's membership rule keeps (`method-tree.ts`), its
 * `.mthds` files, its Python modules, its templates, its data, each at its
 * path. A save sends the folder's whole tree, and a pull writes a saved tree
 * back to disk, file for file. Both need the filesystem: a save without its
 * folder would leave no link file, so the next save would duplicate the
 * method — a materially different act under the same name.
 *
 * **A save writes the method's DRAFT.** A saved method has a draft, replaced
 * by every save and never validated on write, and immutable published
 * versions numbered from 1, which only a publish adds. The draft write is a
 * compare-and-swap on the draft's token (`updated_at`), which the link file
 * records, so a save never replaces a draft that moved since this folder
 * synced with it — the webapp autosaves the same draft. A pull reads the draft
 * by default and a published version on `mt_…@<n>`.
 *
 * **The invariants**, and what holds each one:
 *
 * 1. A draft is never replaced by older bytes, or by a version's bytes,
 *    without the caller's explicit, informed choice. A save sends the token of
 *    the link that vouches for its bytes, read before them, so the platform
 *    refuses it when the draft moved since; a link recording a pulled version,
 *    an unfinished pull or no token refuses the save unless the caller passes
 *    `expected_updated_at`, which is that choice. The link is read again after
 *    the files, so bytes a concurrent pull was writing are never sent.
 * 2. A link file says truthfully what its folder holds. Every write of it is a
 *    compare-and-swap on the bytes the writer decided from
 *    (`replaceMethodLink`), so a save never records its token over a version
 *    a pull landed meanwhile, and a pull never lands on a folder whose link
 *    moved, or whose files changed, since it read them — the link before the
 *    method, so the link is never ahead of the content; a pull marks the link
 *    before its first file and finishes it after its last. The link lives in
 *    the folder it describes, `.pipelex/method.json`, outside the tree it
 *    names.
 * 3. No argument bypasses a guard. `overwrite` opens only the two questions it
 *    answers; `mt_…@draft` is the bare id; and `expected_updated_at` is the
 *    one deliberate override, named in every refusal it lifts.
 * 4. Nothing secret leaves by accident. Before a byte is sent, the save
 *    refuses a tree holding a known secret file or a well-known key format
 *    (`secret-guard.ts`); the validation and the catalog write come after.
 *
 * The local work — a save's read of its link and files, its link write, a
 * pull's landing — takes turns across the process (`inLinkTurn`) and holds the
 * workshop's write lock across processes (`withLinkLock`), and neither is held
 * across a call to the platform but a create's turn: creates take turns among
 * themselves from claim read to link write (`inCreateTurn`), since the link
 * one writes last is what refuses a duplicate from the next. A pull downloads
 * its tree into a private staging directory before its landing, so no
 * download runs under the lock. `catalog-link.ts` says what the lock covers
 * and what it does not.
 */

// ── the inline budget ───────────────────────────────────────────────

/**
 * The whole-set budget for the inline arm of `mthds_get_method`, applied by
 * WHOLE FILE in order, on the sizes the method lists — the codegen streams
 * rule, for the same reason: half a `.mthds` file is worse than none, because
 * a truncated bundle reads as a complete one that fails to parse.
 */
export const MAX_INLINE_SOURCE_BYTES = 256 * 1024;

// ── input schemas ───────────────────────────────────────────────────

export const mthdsSaveMethodInputSchema = {
  method_dir: z
    .string()
    .min(1)
    .describe(
      "The method's folder, relative to the working directory and inside it, with a .mthds file at its top. Its whole tree is saved, every file the MTHDS standard's membership rule keeps: it skips paths with a segment starting with a dot, __pycache__/ and node_modules/, virtual environments, nested repositories, a run's inputs.json or inputs.toml, the workshop's own method-graph.html, and what the folder's .gitignore files and METHODS.toml exclude. The folder's .pipelex/method.json links it to the saved method.",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The catalog name. Required on a create. On an update, omit it to keep the method's name; a name different from the stored one renames the method, which changes the name alone.",
    ),
  method_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absent creates a new method; present writes THAT method's draft. The bare id (mt_…); mt_…@draft is the same thing, and a version (mt_…@<n>) is refused, since a published version never changes.",
    ),
  expected_updated_at: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The draft token this save believes it is replacing; the platform refuses the save when the draft has moved since, atomically, and nothing is written. Omitted, the folder's .pipelex/method.json synced_updated_at is used, and only a save from an unlinked folder replaces whatever the draft holds. Pass the draft's current updated_at only to replace a draft that moved, after the user said to. Ignored on a create.",
    ),
};

export const mthdsSaveMethodInputObjectSchema = z.object(mthdsSaveMethodInputSchema);

export const mthdsGetMethodInputSchema = {
  method_id: z
    .string()
    .min(1)
    .describe(
      "The registered method's catalog id. A bare mt_… (or mt_…@draft) reads its draft, what the last save holds; mt_…@<n> reads published version n.",
    ),
  output_dir: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Write the method's whole tree here, relative to the working directory, every file at its path, with .pipelex/method.json linking the folder — no file passes through the conversation. Omitted, the text files come back inline.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      "Only meaningful with output_dir, and only for a folder already linked to THIS method whose files differ after the stored method has moved. Send it after asking the user, never by reflex.",
    ),
};

export const mthdsGetMethodInputObjectSchema = z.object(mthdsGetMethodInputSchema);

// ── output schemas ──────────────────────────────────────────────────

// One Zod object for MCP SDK compatibility, as in `catalog.ts`: the TypeScript
// result stays a discriminated union and the capability emits only the exact
// arm's fields, while optionality here lets the transport validate either arm.
const linkFileSchema = z.object({
  path: z.string(),
  written: z.boolean(),
  reason: z.string().optional(),
});

/** How the draft stands against the latest published version — derived, never stored. */
export const publishStateSchema = z
  .enum(["never_published", "draft_unchanged", "draft_ahead"])
  .describe(
    "never_published: the method has no published version. draft_unchanged: the draft's tree is the latest published version's. draft_ahead: the draft differs from it, so a publish would add a version.",
  );

export type PublishState = z.infer<typeof publishStateSchema>;

const latestVersionSchema = z
  .number()
  .int()
  .nullable()
  .describe(
    "The number of the method's latest published version; null when it was never published.",
  );

export const mthdsSaveMethodOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean().optional(),
  is_runnable: z.boolean().optional(),
  pending_signatures: z.array(z.string()).optional(),
  method_id: z.string().optional(),
  name: z.string().optional(),
  saved: z.enum(["created", "updated", "renamed"]).optional(),
  updated_at: z
    .string()
    .optional()
    .describe(
      "The draft's new token — what .pipelex/method.json now records, and what the next save sends as expected_updated_at and a publish as expected_draft_updated_at.",
    ),
  latest_version: latestVersionSchema.optional(),
  publish_state: publishStateSchema.optional(),
  api_host: z.string().optional(),
  link_file: linkFileSchema.optional(),
  files_sent: z
    .array(z.string())
    .optional()
    .describe(
      "Every file of the tree this save sent, each as method_dir joined with its path inside the folder.",
    ),
  rename_error: problemSchema
    .optional()
    .describe(
      "Present when the draft was saved but the requested rename failed: the rename's problem, and the name is unchanged.",
    ),
  validation_errors: z
    .array(problemItemSchema)
    .optional()
    .describe("The validation verdict's errors, one problem item each, when it found any."),
  validation_warnings: z
    .array(problemItemSchema)
    .optional()
    .describe("The validation verdict's advisory findings, one problem item each."),
  validation_refused: problemSchema
    .optional()
    .describe(
      "Present, with no is_valid, is_runnable or pending_signatures, when the deployment refused to load the method for the Python it holds, so it gave no verdict: the draft was saved unvalidated, and this is the deployment's problem, whose code names the refusal.",
    ),
  problem: problemSchema
    .optional()
    .describe("Present with status error: why nothing was saved, and what to do."),
});

const treeFileSchema = z.object({
  path: z.string().describe("The file's path in the method's tree."),
  bytes: z.number().int().nonnegative(),
  content: z.string().optional(),
  binary: z
    .boolean()
    .optional()
    .describe("Inline arm: true for a file that is not UTF-8 text, which carries no content."),
  written_to: z.string().optional(),
});

export const mthdsGetMethodOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  method_id: z.string().optional(),
  name: z.string().optional(),
  version: z
    .union([z.number().int(), z.literal("draft")])
    .optional()
    .describe('Which content was read: "draft", or the published version\'s number.'),
  updated_at: z
    .string()
    .optional()
    .describe(
      "The draft's token as of this read, whichever content was read — what .pipelex/method.json records and what a later save sends. After a read of a version it is for a restore only, never a publish: the draft's content was not read.",
    ),
  latest_version: latestVersionSchema.optional(),
  publish_state: publishStateSchema.optional(),
  api_host: z.string().optional(),
  files: z.array(treeFileSchema).optional(),
  output_dir: z.string().optional(),
  link_file: linkFileSchema.optional(),
  unmanaged: z.array(z.string()).optional(),
  unmanaged_truncated: z.boolean().optional(),
  truncated: z.boolean().optional(),
  problem: problemSchema
    .optional()
    .describe("Present with status error: why nothing was fetched or written, and what to do."),
});

// ── TypeScript surfaces ─────────────────────────────────────────────

export interface MthdsSaveMethodInput {
  method_dir: string;
  name?: string;
  method_id?: string;
  expected_updated_at?: string;
}

export interface MthdsGetMethodInput {
  method_id: string;
  output_dir?: string;
  overwrite?: boolean;
}

/** One file of a pulled tree, as a result reports it. */
export interface TreeFile {
  path: string;
  bytes: number;
  content?: string;
  binary?: boolean;
  written_to?: string;
}

export interface SaveMethodSuccess {
  status: "ok";
  is_valid?: boolean;
  is_runnable?: boolean;
  pending_signatures?: string[];
  method_id?: string;
  name?: string;
  saved?: "created" | "updated" | "renamed";
  updated_at?: string;
  latest_version?: number | null;
  publish_state?: PublishState;
  api_host?: string;
  link_file?: LinkFileReport;
  files_sent?: string[];
  rename_error?: Problem;
  validation_errors?: ProblemItem[];
  validation_warnings?: ProblemItem[];
  validation_refused?: Problem;
}

export interface SaveMethodFailure {
  status: "error";
  problem: Problem;
}

export type SaveMethodStructuredContent = SaveMethodSuccess | SaveMethodFailure;

export interface SaveMethodResult {
  structuredContent: SaveMethodStructuredContent;
  summary: string;
}

export interface GetMethodSuccess {
  status: "ok";
  method_id: string;
  name: string;
  version: number | "draft";
  updated_at: string;
  latest_version?: number | null;
  publish_state?: PublishState;
  api_host: string;
  files: TreeFile[];
  output_dir?: string;
  link_file?: LinkFileReport;
  /**
   * Files of the folder's tree that this method does not have — present only
   * on the written arm, and only when there are any.
   */
  unmanaged?: string[];
  unmanaged_truncated?: boolean;
  truncated?: boolean;
}

export interface GetMethodFailure {
  status: "error";
  problem: Problem;
}

export type GetMethodStructuredContent = GetMethodSuccess | GetMethodFailure;

export interface GetMethodResult {
  structuredContent: GetMethodStructuredContent;
  summary: string;
}

/**
 * The narrow SDK seam these tools call (test seam). `version` is optional: it
 * is the platform handshake that says whether bare ids resolve to a published
 * version yet, which only shapes a result's sentences, and a fake without it
 * reads as "could not tell" without sending anything. `methodTreeLimits` is
 * optional for the same reason: a fake without it lists a folder under the
 * workshop's own limits.
 */
export interface CatalogWriteClient {
  getMethod(methodId: string): Promise<MethodDetail>;
  createMethod(input: MethodWriteInput): Promise<MethodData>;
  writeDraft(methodId: string, input: MethodDraftInput): Promise<MethodData>;
  renameMethod(methodId: string, input: MethodRenameInput): Promise<MethodData>;
  getMethodVersion(methodId: string, version: number): Promise<MethodVersion>;
  publishMethod(methodId: string, input: MethodPublishInput): Promise<MethodPublishResult>;
  writeMethodTree(
    files: readonly SavedMethodFile[],
    options: { destination: string },
  ): Promise<void>;
  methodTreeLimits?(): Promise<MethodTreeLimits>;
  version?(): Promise<unknown>;
}

export interface CatalogWriteContext extends ApiConfig, TreeLimitsAware {
  client?: CatalogWriteClient;
  /** The workshop's shared memory of whether each platform resolves version selectors. */
  methodVersions?: MethodVersionsMemories;
  /** Finds and reads `method_dir` (`locateMethodDir`, `readMethodTree`). */
  resolver?: FileResolver;
  /**
   * The workshop's working directory. Both tools are registered only where this
   * exists, so its absence is a deployment fault rather than a caller's.
   */
  saveRoot?: string;
  /** The validation capability these saves run the bundle through — `mthds_validate`'s own. */
  validation: ValidationContext;
  /** Where the call's key and base URL came from, which a failed request's summary closes with. */
  apiNotes?: ApiNotes;
}

export function buildCatalogWriteContext(env = process.env): CatalogWriteContext {
  const config = buildApiConfig(env);
  return { ...config, validation: config };
}

export function catalogWriteClient(context: CatalogWriteContext): CatalogWriteClient {
  return context.client ?? createPipelexApiClient(context);
}

/** Whether the platform resolves version selectors, through this context's client and memory. */
export function catalogVersionsSupport(
  context: CatalogWriteContext,
  client: CatalogWriteClient,
): Promise<MethodVersionsSupport> {
  return methodVersionsSupport(methodVersionsOf(context), versionReaderOf(client));
}

/**
 * How the draft stands against the latest published version, read from a
 * method the platform answered: the draft's tree digest against the version's.
 * `undefined` when the answer carries neither field, as a platform that
 * predates versions answers, or when either digest is unknown.
 */
export function publishStateOf(method: MethodData): PublishState | undefined {
  if (method.latest_version === null) return "never_published";
  if (typeof method.latest_version !== "number") return undefined;
  const latest = method.latest_published;
  if (
    latest === null ||
    latest === undefined ||
    typeof method.draft_digest !== "string" ||
    typeof latest.tree_digest !== "string"
  ) {
    return undefined;
  }
  return method.draft_digest === latest.tree_digest ? "draft_unchanged" : "draft_ahead";
}

/** `latest_version` as the platform answered it, or `undefined` when it did not. */
export function latestVersionOf(method: MethodData): number | null | undefined {
  const value: unknown = method.latest_version;
  return value === null || typeof value === "number" ? value : undefined;
}

/**
 * The sentence a result carries about what callers of the bare id run, now
 * that this draft is saved. On a platform that does not resolve versions yet,
 * a bare id still reads the draft, so a save there changes what every caller
 * runs from its next call, and the sentence says so rather than promise a
 * protection that platform does not give.
 */
export function bareIdCallersSentence(
  method: MethodData,
  support: MethodVersionsSupport,
): string | undefined {
  const state = publishStateOf(method);
  const id = method.method_id;
  const latest = latestVersionOf(method);
  if (support === "unsupported") {
    return `This platform does not resolve versions yet, so every caller of the bare \`${id}\` runs this draft from its next call${typeof latest === "number" ? `, not version ${latest}` : ""}.`;
  }
  if (state === undefined) return undefined;
  const where = support === "supported" ? "" : " wherever the platform resolves versions";
  if (state === "never_published") {
    return `It has never been published, so the bare \`${id}\` answers pipelex.catalog.not_published${where} until it is.`;
  }
  if (state === "draft_unchanged") {
    return `The draft is identical to version ${latest}, the latest published, which callers of the bare \`${id}\` run${where}.`;
  }
  return `Callers of the bare \`${id}\` still run version ${latest}${where}; this draft is ahead of it until it is published.`;
}

// ── problems ────────────────────────────────────────────────────────

/**
 * A refusal these tools make themselves, before or after anything is sent:
 * the problem of a core code, located at the tool argument `field` when one
 * names what to change, or at the method's `file` it is about, with this
 * server's sentence and remedy as its `message`, on one line. A failure the SDK
 * raised is never one of these: it is relayed as the SDK read it
 * ({@link problemOf}).
 */
function workshopProblem<Code extends CoreErrorCode>(
  code: Code,
  params: ProblemParamsByCode[Code],
  where: { field?: string; file?: string; message: string; remedy: string },
): Problem {
  const location = {
    ...(where.field === undefined ? {} : { field: where.field }),
    ...(where.file === undefined ? {} : { file: where.file }),
  };
  return buildProblem(code, params, {
    ...(Object.keys(location).length === 0 ? {} : { location }),
    extra: { message: asOneLine(`${where.message} ${where.remedy}`) },
  });
}

/** The catalog's refusal of a draft write whose token no longer names the draft. */
const UPDATE_CONFLICT_CODE = "pipelex.catalog.update_conflict";

/** The catalog's answer for a method, or a version of one, it does not hold. */
const NOT_FOUND_CODE = "pipelex.catalog.not_found";

/** The refusal of a deployment without the working directory these tools read or write under. */
function noWorkingDirectory(message: string, remedy: string): Problem {
  return workshopProblem(
    "client.not_configured",
    { setting: "working_directory" },
    { message, remedy },
  );
}

/**
 * The workshop's write lock that could not be taken, so the call read or
 * wrote nothing under it, as `consequence` says: another workshop process
 * holding it, which a retry in a moment passes, or a lock that cannot be had
 * here at all.
 */
function lockProblem(
  err: LinkLockError,
  where: { folder: string; field: string; consequence: string; again: string },
): Problem {
  const message = `${err.message}, ${where.consequence}`;
  return err.busy
    ? workshopProblem(
        "client.workspace_busy",
        { path: where.folder },
        {
          field: where.field,
          message,
          remedy: `${where.again} in a moment: another workshop process on this machine is saving or pulling.`,
        },
      )
    : workshopProblem(
        "client.write_failed",
        { path: where.folder, reason: "lock_unavailable" },
        {
          field: where.field,
          message,
          remedy: `Fix what the message names, then ${where.again.toLowerCase()}: no save reads its files and no pull writes without that lock.`,
        },
      );
}

/** The problem of a zod issue in a tool's arguments, at the argument it names. */
function issueProblem(issue: z.core.$ZodIssue, remedy: string): Problem {
  const field = issue.path.length === 0 ? "arguments" : issue.path.map(String).join(".");
  return argumentProblem(field, issue.code, issue.message, remedy);
}

/**
 * The bare id a method route takes, from a `method_id` the caller passed, or a
 * refusal. The method routes address the method itself: `mt_…@draft` names
 * the draft, which is what they act on, and is taken as the bare id; a version
 * suffix names an immutable version, which no save, pull of the draft or
 * publish can act on, and a value carrying an `@` that is not a selector is
 * refused with the grammar rather than sent for the SDK to throw on. Any other
 * value goes through as it is, its format being the server's to judge.
 */
export function methodRouteId(
  value: string,
  refuseVersion: (selector: Extract<MethodSelector, { form: "version" }>) => Problem,
): { ok: true; methodId: string; selector: MethodSelector } | { ok: false; problem: Problem } {
  const selector = readMethodSelector(value);
  if (selector.form === "version") {
    return { ok: false, problem: refuseVersion(selector) };
  }
  const malformed = malformedSuffixProblem(value, selector);
  if (malformed !== undefined) {
    return { ok: false, problem: malformed };
  }
  return { ok: true, methodId: selector.methodId, selector };
}

/**
 * A value carrying an `@` that is not a selector, refused with the grammar
 * rather than sent for the SDK to throw on; the method routes' one check of
 * the id's shape. Any other value is the server's to judge.
 */
function malformedSuffixProblem(value: string, selector: MethodSelector): Problem | undefined {
  if (selector.form !== "opaque" || !value.includes("@")) return undefined;
  return argumentProblem(
    "method_id",
    "not_a_selector",
    `\`${value}\` is not a method id: a catalog id is mt_… with at most one suffix, @<n> for a published version or @draft for the draft.`,
    `Pass the id as ${WORKSHOP_TOOL_NAMES.listMethods} or ${LINK_FILE_NAME} gives it.`,
  );
}

// ── mthds_save_method ───────────────────────────────────────────────

export async function saveMthdsMethod(
  input: MthdsSaveMethodInput,
  context: CatalogWriteContext,
): Promise<SaveMethodResult> {
  const parsed = mthdsSaveMethodInputObjectSchema.safeParse(input);
  if (!parsed.success) {
    return saveError(
      context,
      faultsProblem(
        parsed.error.issues.map((issue) =>
          issueProblem(
            issue,
            "Send method_dir, the method's folder, and a name on a create; add method_id to save an existing method's draft.",
          ),
        ),
      ),
    );
  }
  const data = parsed.data;

  if (data.method_id === undefined && data.name === undefined) {
    return saveError(
      context,
      argumentProblem(
        "name",
        "missing",
        "name is required to create a method.",
        `Pass the name the method is listed under. To save an existing method's draft instead, pass its method_id (from the folder's ${LINK_FILE_NAME}).`,
      ),
    );
  }

  // The id the method routes take. A version is immutable, so a save aimed at
  // one is refused rather than silently retargeted at the draft.
  let targetId: string | undefined;
  if (data.method_id !== undefined) {
    const routeId = methodRouteId(data.method_id, (selector) =>
      argumentProblem(
        "method_id",
        "version_selector",
        `\`${data.method_id}\` names published version ${selector.version}, which never changes: a save writes the method's draft.`,
        `Pass method_id "${selector.methodId}" to save this folder as the draft of that method.`,
      ),
    );
    if (!routeId.ok) {
      return saveError(context, routeId.problem);
    }
    targetId = routeId.methodId;
  }

  const resolver = context.resolver;
  if (
    context.saveRoot === undefined ||
    resolver?.locateMethodDir === undefined ||
    resolver.readMethodTree === undefined
  ) {
    return saveError(
      context,
      noWorkingDirectory(
        "This deployment has no working directory to read a method's folder from, so the method was not saved.",
        "Use the local workshop server (npx @pipelex/mcp), which reads method_dir under the directory the host started it in.",
      ),
    );
  }

  // Where the folder is, on its real path inside the working directory, before
  // anything under it is read: its link is read first, from there.
  const located = await resolver.locateMethodDir(data.method_dir);
  if (!located.ok) {
    return saveError(context, atMethodDir(located.refusals));
  }

  // A folder still holding the link an earlier release wrote reads as
  // unlinked here, and its whole tree, the old link included, would be
  // uploaded as the method: refused before anything is asked or sent.
  if (await holdsLegacyLink(located.folder)) {
    return saveError(
      context,
      argumentProblem(
        "method_dir",
        "legacy_link_file",
        `${data.method_dir} holds ${LEGACY_LINK_FILE_NAME}, the link file an earlier release of the workshop wrote, which it now reads only at ${LINK_FILE_NAME}: saved as it is, the folder would read as unlinked and the old file would be uploaded as one of the method's files. Nothing was sent.`,
        `Move it into place from inside the folder, then save again: ${LEGACY_LINK_MOVE} (plain mv outside git), and commit the move.`,
      ),
    );
  }

  // Built inside a try, as the pull and the publish build theirs: the SDK's
  // constructor refuses a malformed base URL by throwing, and that must come
  // back as a problem rather than reject the MCP handler.
  let client: CatalogWriteClient;
  try {
    client = catalogWriteClient(context);
  } catch (err) {
    return saveError(context, problemOf(err));
  }

  // A create holds a turn of its own across its whole flow — see inCreateTurn.
  const run = () =>
    saveToCatalog(context, data, client, {
      targetId,
      location: { folder: located.folder, methodDir: located.methodDir },
    });
  return targetId === undefined ? inCreateTurn(run) : run();
}

/** The refusals of the folder's resolver, at `method_dir`, as the call's one problem. */
function atMethodDir(refusals: readonly Refusal[]): Problem {
  return faultsProblem(refusals.map((refusal) => refusalProblem("method_dir", refusal)));
}

/**
 * A save refused for the link its folder already holds: the link claims the
 * folder for a method this call does not name, or claims it with content no
 * one can read. `client.target_exists`, naming the link file, the core code
 * nearest the catalog's own link conflict, which a problem built here cannot
 * carry until the Pipelex registry is vendored.
 */
function linkClaimProblem(
  dir: string,
  where: { field: string; message: string; remedy: string },
): Problem {
  return workshopProblem("client.target_exists", { path: path.join(dir, LINK_FILE_NAME) }, where);
}

/**
 * The tail of the queue a create takes its turn in, from its claim read to its
 * link write, its calls to the platform included.
 *
 * A create is refused when its folder is already claimed, and what claims it
 * is the link the create before it writes last. Two creates from one folder
 * that overlapped both read it unclaimed and both minted a method, and the
 * second's link write then found the first's link and wrote nothing, leaving
 * a duplicate only an administrator can delete. Queued, the second reads the
 * first's link and is refused. One queue for the process rather than one per
 * folder, for the reasons {@link inLinkTurn} gives, and holding remote calls
 * costs little here: creates are rare and paced by a person, only another
 * create waits on one, and an update never does. Another workshop process
 * creating from the same folder at the same moment is not covered.
 */
let createTurn: Promise<unknown> = Promise.resolve();

function inCreateTurn<T>(work: () => Promise<T>): Promise<T> {
  const turn = createTurn.then(work);
  createTurn = turn.catch(() => undefined);
  return turn;
}

/** A save from its read of the link and the tree to its result. */
async function saveToCatalog(
  context: CatalogWriteContext,
  data: z.infer<typeof mthdsSaveMethodInputObjectSchema>,
  client: CatalogWriteClient,
  where: { targetId: string | undefined; location: LocatedMethodDir },
): Promise<SaveMethodResult> {
  const { targetId, location } = where;

  // The limits the deployment holds a tree to, so a folder it would refuse is
  // refused while it is listed. Asked before the turn, never inside it: the
  // turn holds local work alone.
  const limits = await methodTreeLimitsOf(context, () => client);

  // The link and the tree are read in one local turn, holding the workshop's
  // write lock and no call to the platform, and every refusal the link and
  // the secret guard make is made there, before the validation and the
  // catalog write: see readSaveSources. A lock that cannot be taken refuses
  // the save before anything is sent, since a read it does not guard may mix
  // two contents.
  let sources: SaveSources;
  try {
    sources = await inLinkTurn(() =>
      withLinkLock(() => readSaveSources(context, { data, targetId, location, limits })),
    );
  } catch (err) {
    if (!(err instanceof LinkLockError)) throw err;
    return saveError(
      context,
      lockProblem(err, {
        folder: data.method_dir,
        field: "method_dir",
        consequence: "so this save read nothing and sent nothing.",
        again: "Save again",
      }),
    );
  }
  if (!sources.ok) {
    return sources.result;
  }
  const { claim, claimRead, token, namingLink, tree } = sources;

  // The tree as read, in the form both requests send: the validation and the
  // catalog write carry the same bytes, which the secret guard has passed.
  const toSend = folderTreeToSend(location, tree);
  const source: MethodTreeSource = toSend.source;

  // Validate through the same capability mthds_validate uses, on the tree
  // already read and checked, so the validate leg re-reads nothing, scans
  // nothing again and asks no limits again, and the verdict is about the bytes
  // saved. The verdict rides beside the save and does not gate it: a draft may
  // be invalid, an agent's work in progress often is, and the verdict is what
  // tells it so. A publish is where validity is required. A deployment that
  // refuses the method for the Python it holds, the execution-locus gate,
  // will load it on no request, so it can give no verdict while nothing is
  // wrong with the draft: the save goes ahead unvalidated and says why. Any
  // other validation that produced no verdict, an unreachable API or a refused
  // credential, refuses the save, since the tool could not say what it saved.
  const verdict = await validateMethodTree(toSend, context.validation);
  const validation: ValidationStructuredContent = verdict.structuredContent;
  let validationRefused: Problem | undefined;
  if (validation.status === "error") {
    const problem = validation.problem ?? problemOf(undefined);
    if (verdict.refusedForPython === true) {
      validationRefused = problem;
    } else {
      return saveError(
        context,
        problem,
        "The method was not saved: validating it produced no verdict, so nothing of the folder was written to the catalog.",
      );
    }
  }

  // Asked beside the catalog calls rather than after them: it never rejects,
  // and only the summary's sentence about callers waits on it.
  const support = catalogVersionsSupport(context, client);
  let stored: MethodData;
  let saved: "created" | "updated" | "renamed";
  let renameError: Problem | undefined;
  let previousName: string | undefined;
  let staleName: string | undefined;
  let draftMovedTo: string | undefined;

  if (targetId === undefined) {
    try {
      // Present: the create arm was refused above without one.
      stored = await client.createMethod({ name: data.name ?? "", tree: source });
    } catch (err) {
      return saveError(context, createFailureProblem(err, problemOf(err)));
    }
    saved = "created";
  } else {
    // The platform's own compare-and-swap on the draft token: a draft that
    // moved since the token is refused atomically and nothing is written. The
    // token is the caller's when given, and otherwise the link file's — the
    // claim above already proved it names this method — so a save from a
    // linked folder never replaces a draft somebody saved since this folder
    // synced, the webapp's autosave included. Only a save from an unlinked
    // folder is last-writer-wins. `input_data` is omitted, which keeps the
    // form inputs a webapp user saved, and so is the name: a rename is its own
    // call below.
    const draftInput: MethodDraftInput = {
      tree: source,
      ...(token === undefined ? {} : { expected_updated_at: token }),
    };
    try {
      stored = await client.writeDraft(targetId, draftInput);
    } catch (err) {
      const problem = problemOf(err);
      const reported =
        problem.code === UPDATE_CONFLICT_CODE && token !== undefined
          ? await draftConflictProblem(problem, client, targetId, {
              token,
              fromLink: data.expected_updated_at === undefined,
            })
          : problem;
      return saveError(context, reported);
    }
    saved = "updated";

    // The rename changes the name alone and moves no token, so it runs after
    // the draft write, whose token check is what licenses touching this
    // method at all. A rename that fails leaves a saved draft behind, which the
    // result reports as saved, with the rename's error beside it.
    //
    // Only the NAME is taken from the rename's answer. The rename returns the
    // row as it stands, so a save that landed between the two calls — the
    // webapp autosaves — would hand back another writer's draft and token:
    // recording that token beside these files would let the next save from
    // here replace that draft without a conflict, and a publish under it would
    // publish content nobody here has seen. The draft write's own snapshot is
    // what this call saved, and a token that moved since is reported.
    //
    // A name that is the one the link recorded is not a rename asked for: it
    // is what an agent reads back out of the link file, and when the method
    // was renamed elsewhere since — in the webapp, by a teammate — sending it
    // would quietly undo that rename. The stored name is kept, and the link
    // written below records it, so saving again with the old name is then a
    // rename the caller means.
    const name = data.name;
    if (name !== undefined && name !== stored.name && name === namingLink?.name) {
      staleName = name;
    } else if (name !== undefined && name !== stored.name) {
      previousName = stored.name;
      try {
        const renamed = await client.renameMethod(targetId, { name });
        if (renamed.updated_at !== stored.updated_at) {
          draftMovedTo = renamed.updated_at;
        }
        stored = { ...stored, name: renamed.name };
        saved = "renamed";
      } catch (err) {
        renameError = problemOf(err);
      }
    }
  }

  const apiHost = apiHostOf(context.baseUrl);
  // Written only while the link still holds what this save read before its
  // files: anything else describes what another save or a pull put in the
  // folder since, which this save's token says nothing about.
  const written = await inLinkTurn(() =>
    writeLinkForSave(context, location.folder, claimRead, {
      apiHost,
      methodId: stored.method_id,
      name: stored.name,
      syncedUpdatedAt: stored.updated_at,
    }),
  );
  const linkFile = written.report;

  const latestVersion = latestVersionOf(stored);
  const publishState = publishStateOf(stored);
  const structuredContent: SaveMethodSuccess = {
    status: "ok",
    ...(validationRefused === undefined
      ? {
          is_valid: validation.is_valid,
          is_runnable: validation.is_runnable,
          pending_signatures: validation.pending_signatures,
        }
      : { validation_refused: validationRefused }),
    method_id: stored.method_id,
    name: stored.name,
    saved,
    updated_at: stored.updated_at,
    ...(latestVersion === undefined ? {} : { latest_version: latestVersion }),
    ...(publishState === undefined ? {} : { publish_state: publishState }),
    api_host: apiHost,
    link_file: linkFile,
    files_sent: toSend.files.map((file) => file.shown),
    ...(renameError === undefined ? {} : { rename_error: renameError }),
    ...(validation.errors === undefined || validation.errors.length === 0
      ? {}
      : { validation_errors: validation.errors }),
    ...(validation.warnings === undefined || validation.warnings.length === 0
      ? {}
      : { validation_warnings: validation.warnings }),
  };

  const answer = await support;
  return {
    structuredContent,
    summary: saveSummary(structuredContent, {
      support: answer,
      linkChanged: written.changed,
      linkedAnyway: claim?.kind === "link",
      claimUnreadable: claim?.kind === "unreadable",
      previousName,
      staleName,
      draftMovedTo,
      callers: bareIdCallersSentence(stored, answer),
      leftOut: tree.graphPage === undefined ? [] : [shownIn(location.methodDir, tree.graphPage)],
    }),
  };
}

/** What a save read from disk, in one turn, before it sent anything. */
type SaveSources =
  | { ok: false; result: SaveMethodResult }
  | {
      ok: true;
      claim: DirectoryClaim | undefined;
      /** The folder's link as read: what this save's link write compares against. */
      claimRead: LinkRead;
      token?: string;
      /** The link that names the method this update writes, for the rename. */
      namingLink?: MethodLink;
      tree: Extract<MethodTreeRead, { ok: true }>;
    };

/**
 * A save's local read, made in one turn ({@link inLinkTurn}) holding the
 * workshop's write lock ({@link withLinkLock}), with no call to the platform
 * in it: the folder's link, every refusal it makes, then the folder's whole
 * tree, every file read once, and the secret guard over those bytes.
 *
 * The lock keeps every workshop pull out of the read, in this process and in
 * every other: a pull landing while the save read would leave it a mix of two
 * contents, which a caller passing `expected_updated_at` sends past the
 * `partial_pull` refusal, and a pull into a folder nested in this one changes
 * its files without touching its link.
 *
 * The link is read BEFORE the bytes it vouches for, because the token
 * certifies the state those bytes were read against. Read after them, a save
 * from the same folder landing in between could move the draft and refresh
 * the link, and this save would send that newer token with older bytes and
 * replace the newer draft without a conflict.
 *
 * It is read again AFTER the files, and the save is refused when it moved:
 * something wrote the link while the files were read, so the bytes in hand
 * may be its, or a mix, and no link vouches for them. The lock keeps every
 * workshop pull out, so this answers a writer that takes no lock: an editor,
 * a git checkout, a workshop too old to share this one's lock.
 *
 * Every refusal is made here, before the remote validation and the catalog
 * write, because both arms are irreversible in the same way: a create that
 * ran first left a duplicate, and a draft write that ran first left a
 * different method's draft replaced — delete is admin-only, and a replaced
 * draft is gone. A save refused here sends nothing of the folder.
 */
async function readSaveSources(
  context: CatalogWriteContext,
  request: {
    data: z.infer<typeof mthdsSaveMethodInputObjectSchema>;
    targetId: string | undefined;
    location: LocatedMethodDir;
    limits: ListingLimits;
  },
): Promise<SaveSources> {
  const { data, targetId, location, limits } = request;
  const refuse = (problem: Problem): SaveSources => ({
    ok: false,
    result: saveError(context, problem),
  });

  const at: LinkAt = {
    dir: location.methodDir,
    absolute: location.folder,
    read: await readMethodLink(location.folder),
  };
  const claim = claimOf(at);
  const claimRead = at.read;

  let token: string | undefined;
  let namingLink: MethodLink | undefined;
  if (targetId === undefined) {
    // Preventing a duplicate is the link file's whole purpose: a create from a
    // folder already linked would mint a SECOND method for the same files.
    if (claim !== undefined) {
      return refuse(
        claim.kind === "link"
          ? linkClaimProblem(claim.dir, {
              field: "method_id",
              message: `\`${claim.dir}\` is linked to \`${claim.link.method_id}\` (${claim.link.name} on ${claim.link.api_host}), and this call names no method_id, so it would have created a SECOND method for the same folder. Nothing was sent.`,
              remedy: `Pass method_id: "${claim.link.method_id}" to save the draft of the method this folder is linked to. To make a genuinely new method from these files, copy the folder without its ${LINK_FILE_NAME} and save the copy.`,
            })
          : linkClaimProblem(claim.dir, {
              field: "method_dir",
              message: `\`${claim.dir}\` holds a \`${LINK_FILE_NAME}\` that cannot be read (${claim.reason}), so something already claims this folder. Creating a method from here would leave a SECOND method that this tool cannot delete. Nothing was sent.`,
              remedy: `Repair or remove \`${LINK_FILE_NAME}\` in that folder — if it names the method you meant, pass its method_id — or copy the folder without it to create a genuinely new method.`,
            }),
      );
    }
  } else {
    // A method_id read from the wrong place, or a stale one pasted by a user,
    // would write THIS folder's tree into that method's draft, and only
    // afterwards would the link write report the mismatch — leaving the wrong
    // draft replaced and the folder still linked to the right method. The ids
    // are compared bare, since the link records the bare id and `@draft` names
    // the same method.
    if (claim?.kind === "link" && readMethodSelector(claim.link.method_id).methodId !== targetId) {
      return refuse(
        linkClaimProblem(claim.dir, {
          field: "method_id",
          message: `\`${claim.dir}\` is linked to \`${claim.link.method_id}\` (${claim.link.name} on ${claim.link.api_host}), but this call names method_id \`${data.method_id}\`. Saving would have replaced a different method's draft with this folder's files, and a replaced draft cannot be given back. Nothing was sent.`,
          remedy: `Pass method_id: "${claim.link.method_id}" to save the draft of the method this folder is linked to. If you really mean to save these files as \`${targetId}\`, copy the folder without its ${LINK_FILE_NAME} and save the copy, so the two methods stop sharing one link.`,
        }),
      );
    }
    const linked = draftTokenOf(claim, data.expected_updated_at, targetId);
    if (!linked.ok) {
      return refuse(linked.problem);
    }
    token = linked.token;
    if (claim?.kind === "link") {
      namingLink = claim.link;
    }
  }

  // Read ONCE. The bytes that are checked, validated and saved are one read:
  // splitting them would read the files twice, and neither the guard nor the
  // verdict would be provably about the saved bytes. `readMethodTree` is
  // present: the caller refused a deployment without it.
  const tree = await context.resolver!.readMethodTree!(location, { limits });
  if (!tree.ok) {
    return refuse(atMethodDir(tree.refusals));
  }

  // The secret guard, over the bytes in hand, before any of them is sent.
  const findings = secretFindings(
    tree.files.map((file) => ({
      path: file.path,
      bytes: tree.bytes.get(file.path) ?? new Uint8Array(),
    })),
  );
  if (findings.length > 0) {
    const text = secretRefusalText(findings, (treePath) => shownIn(location.methodDir, treePath), {
      arm: "folder",
      again: "save again",
    });
    return refuse(refusalProblem("method_dir", { reason: SECRET_REASON, ...text }));
  }

  // The second read of the link, now that the bytes are in hand.
  const after = await readMethodLink(location.folder);
  if (!sameLinkRead(at.read, after)) {
    return refuse(
      workshopProblem(
        "client.workspace_busy",
        { path: path.join(at.dir, LINK_FILE_NAME) },
        {
          field: "method_dir",
          message: `\`${path.join(at.dir, LINK_FILE_NAME)}\` changed while this save read the files — something that does not take the workshop's write lock, an editor, a git checkout or an older workshop, wrote into \`${at.dir}\` meanwhile — so the bytes read may not be the ones its link vouches for. Nothing was sent.`,
          remedy: "Look at what the folder holds now, then save again.",
        },
      ),
    );
  }

  return {
    ok: true,
    claim,
    claimRead,
    ...(token === undefined ? {} : { token }),
    ...(namingLink === undefined ? {} : { namingLink }),
    tree,
  };
}

/**
 * The draft token a save from this folder is held to: the caller's
 * `expected_updated_at` when given, and otherwise the link file's
 * `synced_updated_at` — but only when the link is a clean record of a sync
 * with the DRAFT. Each other state of the link is refused before anything is
 * written, because each would turn the compare-and-swap into a blind write:
 *
 * - a link that cannot be read offers no token, and a save without one
 *   replaces whatever the draft holds — a git merge conflict in the committed
 *   link, the team case the token exists for, is the usual cause;
 * - a link carrying `partial_pull` records a pull that never finished, so the
 *   files may mix two contents, and its token is the sync before that pull
 *   (or empty, after an interrupted first pull);
 * - a link carrying `synced_version` records a pulled VERSION, so the files
 *   are that version's, and a save would replace the draft with them —
 *   restoring the version and losing whatever the draft held beyond it, which
 *   the caller makes happen only on purpose, by passing the token.
 *
 * An unlinked folder has no token and is last-writer-wins.
 */
function draftTokenOf(
  claim: DirectoryClaim | undefined,
  explicit: string | undefined,
  methodId: string,
): { ok: true; token?: string } | { ok: false; problem: Problem } {
  if (explicit !== undefined) return { ok: true, token: explicit };
  if (claim === undefined) return { ok: true };
  const toSaveAnyway = `To save these files as they stand, pass expected_updated_at with the draft's current updated_at (${WORKSHOP_TOOL_NAMES.getMethod} reports it) once the user has said to.`;
  if (claim.kind === "unreadable") {
    return {
      ok: false,
      problem: workshopProblem(
        "client.file_unreadable",
        { path: path.join(claim.dir, LINK_FILE_NAME), reason: "link_unreadable" },
        {
          field: "method_dir",
          message: `\`${claim.dir}\` holds a \`${LINK_FILE_NAME}\` that cannot be read (${claim.reason}), so this save has no draft token to protect the draft with, and without one it would replace whatever the draft holds now. Nothing was sent.`,
          remedy: `Repair it — a git merge conflict is the usual cause, and the side with the later synced_updated_at is the one to keep — or remove it and pull the method into the folder to relink it. ${toSaveAnyway}`,
        },
      ),
    };
  }
  const link = claim.link;
  if (link.partial_pull === true || link.synced_updated_at === "") {
    return {
      ok: false,
      problem: argumentProblem(
        "method_dir",
        "partial_pull",
        `An earlier pull of \`${methodId}\` into \`${claim.dir}\` was interrupted, so the folder may hold a mix of two contents, and its \`${LINK_FILE_NAME}\` records no sync that finished. Saving would replace the draft with that mix. Nothing was sent.`,
        `Pull the method into the folder again, which finishes the interrupted pull, then save. ${toSaveAnyway}`,
      ),
    };
  }
  if (link.synced_version !== undefined) {
    return {
      ok: false,
      problem: argumentProblem(
        "expected_updated_at",
        "version_pulled",
        `\`${claim.dir}\` holds version ${link.synced_version} of \`${methodId}\`, pulled over the draft, so this save would replace the draft with that version's files and any edits made to them: that restores version ${link.synced_version} as the draft, and loses whatever the draft held beyond it. Nothing was sent.`,
        `If the user wants version ${link.synced_version} restored as the draft, save again with expected_updated_at "${link.synced_updated_at}". Otherwise pull the draft back into the folder (method_id "${methodId}") and work from it.`,
      ),
    };
  }
  return { ok: true, token: link.synced_updated_at };
}

/**
 * The draft write's stale-token refusal, the catalog's problem as it sent it
 * with a `message` carrying both tokens. The platform's refusal names
 * neither, and the caller needs both: the stored one to tell a teammate's
 * save from this session's own (a save whose link write failed leaves the
 * link a token behind), the one it sent to see which sync it was. The read is
 * best-effort — when it fails, the refusal stands as the platform worded it.
 */
async function draftConflictProblem(
  problem: Problem,
  client: CatalogWriteClient,
  methodId: string,
  sent: { token: string; fromLink: boolean },
): Promise<Problem> {
  let current: MethodData;
  try {
    current = await client.getMethod(methodId);
  } catch {
    return problem;
  }
  const source = sent.fromLink
    ? ` as this folder's ${LINK_FILE_NAME} records (synced_updated_at)`
    : "";
  return {
    ...problem,
    message: `The method's draft was last saved at ${current.updated_at}, not ${sent.token}${source}. Nothing was written. Somebody saved this method's draft since this folder synced with it — the webapp saves as it edits. Pull it with ${WORKSHOP_TOOL_NAMES.getMethod} into a folder of its own to compare, then decide with the user what to keep. To replace their draft knowingly, save again with expected_updated_at set to the draft's current updated_at. If that updated_at is your own last save's (one whose link write failed), pull the method into this folder to refresh the link.`,
  };
}

/**
 * The problem of a failed create. A create that may have reached the catalog
 * cannot be replayed safely: `POST /v1/methods` honours an `Idempotency-Key`
 * and `@pipelex/sdk` exposes no way to send one, so a retry mints a SECOND
 * method under the same name. Such a failure is therefore
 * `client.outcome_unknown` in the structured result, whatever the SDK read,
 * so that no caller branching on `retry` resends it: its `retry` is
 * `outcome_unknown`, and its step is to list the catalog before saving again.
 * The SDK's own reading is kept in `message`, with its code, and its
 * `request_id` beside it for support. A draft write has no such hazard —
 * `PUT` replaces the draft and is idempotent by construction — so this
 * applies to the create alone.
 *
 * A create may have reached the catalog unless its failure proves otherwise
 * ({@link createMayHaveLanded}), the same safe side the SDK takes for a start.
 *
 * When the SDK gains the key, this function goes.
 */
function createFailureProblem(err: unknown, problem: Problem): Problem {
  if (!createMayHaveLanded(err)) return problem;
  const outcome = buildProblem("client.outcome_unknown", {});
  return {
    ...outcome,
    title: "The save may have created the method",
    detail:
      "The create request may have left before the save failed, so the catalog may already hold the new method.",
    next_step: {
      kind: "refresh",
      detail: `List the catalog with ${WORKSHOP_TOOL_NAMES.listMethods} before saving again: if the method is there, save again with its method_id, which writes its draft. A save without it would create a second method, since the create cannot yet carry an idempotency key.`,
    },
    message: asOneLine(`The create failed with ${problem.code}: ${problemSentence(problem)}`),
    ...(problem.request_id === undefined ? {} : { request_id: problem.request_id }),
  };
}

/**
 * Whether a failed create may have reached the catalog (see
 * {@link createFailureProblem}). Only a proof, read from the error's class and
 * status alone, says it did not:
 *
 * - the SDK refused an argument before any request (`RequestArgumentError`);
 * - a file could not be uploaded (`MethodFileTransferError`): the uploads come
 *   before the create, which `createMethod` then never sends;
 * - an answer refused the call, a `4xx` other than `408`, or a `501`: a
 *   refusal of a step before the create, the version handshake or the blob
 *   route, means the create was never sent, and a refusal of the create
 *   itself means nothing was written, `createMethod` making no request after
 *   the create.
 *
 * Everything else may have landed: a `2xx` the SDK could not read, a `408` or
 * another `5xx`, whichever route answered it, a transport failure, the SDK's
 * test of one that proves nothing left not being exported, and a failure the
 * SDK did not raise, such as an abort or a wrapper's error, which proves
 * nothing of what was sent, whatever problem it reads as.
 */
function createMayHaveLanded(err: unknown): boolean {
  if (failedBeforeSending(err) || err instanceof MethodFileTransferError) return false;
  if (!(err instanceof ApiResponseError)) return true;
  const { status } = err;
  if (status >= 200 && status < 300) return true;
  return status === 408 || (status >= 500 && status !== 501);
}

/**
 * The save's link write, made only over the link this save read before its
 * files ({@link replaceMethodLink}). That one compare carries every rule the
 * write used to re-check on its own: the save's guards already refused a link
 * naming another method (a takeover would send a teammate's next save to this
 * method) and refused to create beside any link, a link that cannot be read is
 * never written over (truncating it destroyed whatever it held), and a link
 * that changed since the read — a version pulled over the files, another
 * save's token — is left as that call wrote it. Called inside the turn.
 */
async function writeLinkForSave(
  context: CatalogWriteContext,
  folder: string,
  expected: LinkRead,
  fields: { apiHost: string; methodId: string; name: string; syncedUpdatedAt: string },
): Promise<{ report: LinkFileReport; changed: boolean }> {
  // Present: the save refused a deployment without one.
  const root = await fs.realpath(context.saveRoot ?? folder).catch(() => folder);
  // A save makes the folder the draft, so the link records no published
  // version, whatever an earlier pull of one left there. The lock makes the
  // compare and the write one step for other workshop processes too; one that
  // cannot be taken leaves the link unwritten rather than written unguarded,
  // and never fails the save, whose draft is already stored.
  try {
    const replaced = await withLinkLock(() =>
      replaceMethodLink(root, folder, expected, buildMethodLink(fields)),
    );
    return { report: replaced.report, changed: replaced.changed };
  } catch (err) {
    if (!(err instanceof LinkLockError)) throw err;
    return {
      report: {
        path: path.relative(root, path.join(folder, LINK_FILE_NAME)),
        written: false,
        reason: `${err.message}, so it was not written`,
      },
      changed: false,
    };
  }
}

function saveSummary(
  result: SaveMethodSuccess,
  notes: {
    support: MethodVersionsSupport;
    linkChanged: boolean;
    linkedAnyway: boolean;
    claimUnreadable: boolean;
    previousName?: string;
    staleName?: string;
    draftMovedTo?: string;
    callers?: string;
    leftOut: readonly string[];
  },
): string {
  const id = result.method_id ?? "";
  const lines: string[] = [];
  const sent = result.files_sent ?? [];
  const tree = `${sent.length} file${sent.length === 1 ? "" : "s"}, listed in files_sent`;
  if (result.saved === "created") {
    lines.push(
      `Method **${result.name}** created on ${result.api_host} (method_id: \`${id}\`, updated_at ${result.updated_at}), holding this folder's tree as its draft (${tree}).`,
    );
  } else {
    lines.push(
      `The draft of **${result.name}** was saved on ${result.api_host} (method_id: \`${id}\`, updated_at ${result.updated_at}) from this folder's tree (${tree})${result.saved === "renamed" && notes.previousName !== undefined ? `, and the method was renamed from **${notes.previousName}**` : ""}.`,
    );
  }
  if (notes.leftOut.length > 0) {
    lines.push(
      `Left out, as never part of a method: ${notes.leftOut.map((each) => `\`${each}\``).join(", ")}, the page ${WORKSHOP_TOOL_NAMES.validate} regenerates.`,
    );
  }
  if (result.rename_error !== undefined) {
    lines.push(
      `The rename to the requested name FAILED, so the method keeps its name: ${problemSentence(result.rename_error)} (${result.rename_error.code}). The draft itself was saved; save again with the same name to retry the rename alone.`,
    );
  }
  if (notes.staleName !== undefined) {
    lines.push(
      `The method keeps its stored name **${result.name}**: the name passed, **${notes.staleName}**, is the one ${LINK_FILE_NAME} recorded before the method was renamed elsewhere, so it was not taken as a rename. ${
        result.link_file?.written === true
          ? `This save recorded the stored name in the link, so saving again with **${notes.staleName}** renames the method back.`
          : `The link could not be refreshed, so a save with **${notes.staleName}** keeps the stored name again until it is.`
      }`,
    );
  }
  if (notes.draftMovedTo !== undefined) {
    lines.push(
      `The draft changed again right after this save: somebody saved it at ${notes.draftMovedTo}, so it no longer holds these files. The link records this save's updated_at, so the next save from here, and a publish under that token, are refused until the user decides what to keep — pull the method into a folder of its own to see what the draft holds now.`,
    );
  }

  if (result.validation_refused !== undefined) {
    const refused = result.validation_refused;
    const said = problemSentence(refused);
    lines.push(
      `The method was NOT validated, so whether it is valid is unknown: this deployment refuses to load it for the Python it holds — ${said}${/[.!?]$/.test(said) ? "" : "."} It was saved anyway, as a draft may be, and a publish validates it before publishing anything. ${refused.next_step.detail}`,
    );
  } else if (!result.is_valid) {
    lines.push(
      "The method is NOT valid. It was saved anyway, as a draft may be, and a publish refuses it until it validates: fix the validation errors and save again.",
    );
  } else if (result.is_runnable === false) {
    const pending = result.pending_signatures ?? [];
    lines.push(
      pending.length === 0
        ? "The method is valid but does not run yet, and a publish refuses it until it does."
        : `The method is valid but does not run yet — these signatures are still pending: ${pending.map((ref) => `\`${ref}\``).join(", ")}. A publish refuses it until they resolve.`,
    );
  }

  if (notes.callers !== undefined) {
    lines.push(notes.callers);
  }
  // Where the platform does not resolve versions, a suffix is refused and the
  // bare id is what reads the draft, as the callers' sentence above says.
  const draftId = notes.support === "unsupported" ? id : `${id}@draft`;
  lines.push(
    notes.draftMovedTo === undefined
      ? `To validate or run what you just saved, pass method_id \`${draftId}\`${notes.support === "unsupported" ? `, the bare id, which reads the draft here; \`${id}@draft\` would be refused until the platform resolves versions` : ""}. Publish it only when the user asks for a publish: ${WORKSHOP_TOOL_NAMES.publishMethod} with method_id \`${id}\` and expected_draft_updated_at ${result.updated_at}.`
      : `\`${draftId}\` now names that other save, not these files, and a publish needs the draft's current updated_at, which the user should see the draft for first.`,
  );

  if (result.link_file === undefined) {
    return lines.join("\n");
  }
  // Saying "NOT linked" about a linked folder was the worst of the three
  // answers, because it told the caller to pass a method_id they did not need
  // — and the id it named was this method, about a folder whose surviving
  // link names another. So the answer is three-way, as the pull's is.
  lines.push(
    result.link_file.written
      ? `Linked by \`${result.link_file.path}\` — commit it, so a teammate saves this same method instead of creating a second one.`
      : notes.linkChanged
        ? `\`${result.link_file.path}\` was not refreshed: ${result.link_file.reason}. It no longer holds what this save read, so it does not describe the files this save sent: look at what the folder holds before saving from it again — a save from it is held to that link.`
        : notes.linkedAnyway
          ? `The folder IS linked to this method, but \`${result.link_file.path}\` could not be refreshed (${result.link_file.reason}), so it still records an out-of-date synced_updated_at, and the next save from here will be refused as stale. Fix that and pull this method into the folder, which refreshes the link alone while the files match.`
          : notes.claimUnreadable
            ? `\`${result.link_file.path}\` cannot be read (${result.link_file.reason}), so it was not refreshed, and a save from here is refused until it is: repair or remove it, then pull this method into the folder to relink it.`
            : `The folder is NOT linked (${result.link_file.reason}), so the next save would create a SECOND method unless it passes method_id \`${id}\`.`,
  );
  return lines.join("\n");
}

/**
 * A save that produced no result: its one problem, and the problem's summary
 * with, when given, a closing paragraph of what this tool knows beside it.
 */
function saveError(
  context: { apiNotes?: ApiNotes },
  problem: Problem,
  closing?: string,
): SaveMethodResult {
  const summary = problemSummary(problem, context.apiNotes);
  return {
    structuredContent: { status: "error", problem },
    summary: closing === undefined ? summary : `${summary}\n\n${closing}`,
  };
}

/** A problem's own sentence, on one line: this server's `message` when it wrote one, else the `detail`. */
function problemSentence(problem: Problem): string {
  const message = problem.message;
  return asOneLine(typeof message === "string" && message !== "" ? message : problem.detail);
}

// ── mthds_get_method ────────────────────────────────────────────────

/**
 * What a pull brings back: the method's draft, or one of its published
 * versions, as a listing of its tree. A version carries no name of its own,
 * so the method's name always comes from the method read.
 */
interface PulledContent {
  /** `"draft"`, or the published version's number. */
  version: number | "draft";
  /** The tree, each file with its SHA-256, its size and its link, in tree path order. */
  files: readonly SavedMethodFile[];
  /** A version's publish instant, for the summary. */
  publishedAt?: string;
}

export async function getMthdsMethod(
  input: MthdsGetMethodInput,
  context: CatalogWriteContext,
): Promise<GetMethodResult> {
  const parsed = mthdsGetMethodInputObjectSchema.safeParse(input);
  if (!parsed.success) {
    return getError(
      context,
      faultsProblem(
        parsed.error.issues.map((issue) =>
          issueProblem(
            issue,
            "Pass method_id as the catalog returned it; add output_dir to write the method's tree to disk.",
          ),
        ),
      ),
    );
  }

  // A bare id and `@draft` read the draft; `@<n>` reads that version. The
  // method read itself always takes the bare id, and it runs either way: it
  // carries the name, the draft's token the link records, the draft's tree,
  // and the latest version's number.
  const selector = readMethodSelector(parsed.data.method_id);
  const malformed = malformedSuffixProblem(parsed.data.method_id, selector);
  if (malformed !== undefined) {
    return getError(context, malformed);
  }
  const methodId = selector.methodId;
  const wanted: number | "draft" = selector.form === "version" ? selector.version : "draft";

  // The output folder's link is read BEFORE the method, so the link the pull
  // plans against never records a sync newer than the content it read. Read
  // after it, a save landing in between — the draft written, the link
  // refreshed — handed the pull a link ahead of its method: it called the
  // draft moved when the folder was ahead, and under `overwrite` wrote the
  // older content back. Read first, that save rewrote the link since, and the
  // landing's compare-and-swap refuses the pull.
  const linkBefore =
    parsed.data.output_dir === undefined
      ? undefined
      : (await linkAt(context, parsed.data.output_dir))?.read;

  let client: CatalogWriteClient;
  let support: Promise<MethodVersionsSupport>;
  let stored: MethodDetail;
  let version: MethodVersion | undefined;
  try {
    client = catalogWriteClient(context);
    // Asked beside the read rather than after it: it never rejects, and only
    // the draft's sentences wait on it. A version read's result never reads it,
    // so it does not ask.
    support =
      wanted === "draft"
        ? catalogVersionsSupport(context, client)
        : Promise.resolve<MethodVersionsSupport>("unknown");
    if (wanted === "draft") {
      stored = await client.getMethod(methodId);
    } else {
      const [method, read] = await Promise.allSettled([
        client.getMethod(methodId),
        client.getMethodVersion(methodId, wanted),
      ]);
      if (method.status === "rejected") throw method.reason;
      stored = method.value;
      if (read.status === "rejected") {
        return versionReadError(read.reason, stored, wanted, context);
      }
      version = read.value;
    }
  } catch (err) {
    return getError(context, problemOf(err));
  }

  const content: PulledContent = {
    version: version === undefined ? "draft" : version.version,
    files: version === undefined ? stored.files : version.files,
    ...(version === undefined ? {} : { publishedAt: version.published_at }),
  };
  if (content.files.length === 0) {
    // The row exists but its draft holds no file — a produced failure, and a
    // different answer from "no such method", which is a 404 at the same field.
    return emptyTreeError(context, content.version);
  }
  const apiHost = apiHostOf(context.baseUrl);

  if (parsed.data.output_dir === undefined) {
    return inlineResult(context, client, stored, content, apiHost, support);
  }
  return writtenResult(context, client, parsed.data, stored, content, apiHost, support, linkBefore);
}

/**
 * A version read the platform refused, its problem as the SDK read it. The
 * catalog answers `pipelex.catalog.not_found` alike for a method it does not
 * hold and for a version the method never published; the method read beside
 * this one succeeded, so here it is the version, and the problem's `message`
 * says what the method does have.
 */
function versionReadError(
  err: unknown,
  stored: MethodData,
  wanted: number,
  context: CatalogWriteContext,
): GetMethodResult {
  const problem = problemOf(err);
  if (problem.code !== NOT_FOUND_CODE) {
    return getError(context, problem);
  }
  const latest = latestVersionOf(stored);
  const has =
    latest === null
      ? "it has never been published, so it has only its draft"
      : typeof latest === "number"
        ? `its latest published version is ${latest}`
        : "it has no such version";
  return getError(context, {
    ...problem,
    message: `\`${stored.method_id}\` has no version ${wanted}: ${has}. Pull its draft with method_id "${stored.method_id}"${typeof latest === "number" ? `, or a version from 1 to ${latest} as "${stored.method_id}@<n>"` : ""}.`,
  });
}

/** "The draft of **Name**" or "Version 3 of **Name**", to open a summary. */
function contentTitle(stored: MethodData, content: PulledContent): string {
  return content.version === "draft"
    ? `The draft of **${stored.name}**`
    : `Version ${content.version} of **${stored.name}**`;
}

/** Where the read came from, for a summary: the method, and the draft's token or the version's publish date. */
function contentCoordinates(stored: MethodData, content: PulledContent, apiHost: string): string {
  return content.version === "draft"
    ? `method_id: \`${stored.method_id}\`, updated_at ${stored.updated_at} on ${apiHost}`
    : `method_id: \`${stored.method_id}\`, published ${content.publishedAt ?? "at an unrecorded time"} on ${apiHost}`;
}

/** The result fields both arms share. */
function contentFields(
  stored: MethodData,
  content: PulledContent,
  apiHost: string,
): Pick<
  GetMethodSuccess,
  "method_id" | "name" | "version" | "updated_at" | "latest_version" | "publish_state" | "api_host"
> {
  const latestVersion = latestVersionOf(stored);
  const publishState = publishStateOf(stored);
  return {
    method_id: stored.method_id,
    name: stored.name,
    version: content.version,
    updated_at: stored.updated_at,
    ...(latestVersion === undefined ? {} : { latest_version: latestVersion }),
    ...(publishState === undefined ? {} : { publish_state: publishState }),
    api_host: apiHost,
  };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A directory of this process's own under the system's temporary directory,
 * created closed to everyone else, for a tree downloaded before it is used.
 * `work` gets the destination `writeMethodTree` writes into, which must not
 * exist yet; the directory is removed whatever happens.
 */
async function withStagedTree<T>(
  client: CatalogWriteClient,
  files: readonly SavedMethodFile[],
  work: (staged: string) => Promise<T>,
): Promise<T> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-pull-"));
  try {
    const destination = path.join(staging, "tree");
    await client.writeMethodTree(files, { destination });
    return await work(destination);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function inlineResult(
  context: CatalogWriteContext,
  client: CatalogWriteClient,
  stored: MethodData,
  content: PulledContent,
  apiHost: string,
  support: Promise<MethodVersionsSupport>,
): Promise<GetMethodResult> {
  // One budget over the whole tree, spent by WHOLE FILE in order, on the sizes
  // the method lists: only the files that fit are downloaded. A withheld file
  // keeps its path and size and carries no content, and so does a file that
  // is not text.
  let spent = 0;
  let truncated = false;
  const taken: SavedMethodFile[] = [];
  for (const file of content.files) {
    if (truncated || spent + file.size > MAX_INLINE_SOURCE_BYTES) {
      truncated = true;
      continue;
    }
    spent += file.size;
    taken.push(file);
  }

  let files: TreeFile[];
  try {
    const texts =
      taken.length === 0
        ? new Map<string, string | undefined>()
        : await withStagedTree(client, taken, async (staged) => {
            const read = new Map<string, string | undefined>();
            for (const file of taken) {
              const bytes = await fs.readFile(path.join(staged, ...file.path.split("/")));
              let text: string | undefined;
              try {
                text = strictUtf8.decode(bytes);
              } catch {
                text = undefined;
              }
              read.set(file.path, text);
            }
            return read;
          });
    files = content.files.map((file) => {
      if (!texts.has(file.path)) return { path: file.path, bytes: file.size };
      const text = texts.get(file.path);
      return text === undefined
        ? { path: file.path, bytes: file.size, binary: true }
        : { path: file.path, bytes: file.size, content: text };
    });
  } catch (err) {
    return getError(context, problemOf(err));
  }

  const structuredContent: GetMethodSuccess = {
    status: "ok",
    ...contentFields(stored, content, apiHost),
    files,
    truncated,
  };

  const count = content.files.length;
  const lines = [
    `${contentTitle(stored, content)} (${contentCoordinates(stored, content, apiHost)}): ${count} file${count === 1 ? "" : "s"}, returned inline.`,
  ];
  if (content.version === "draft") {
    const callers = bareIdCallersSentence(stored, await support);
    if (callers !== undefined) lines.push(callers);
  }
  const binary = files.filter((file) => file.binary === true);
  if (binary.length > 0) {
    lines.push(
      `${binary.map((file) => `\`${file.path}\``).join(", ")} ${binary.length === 1 ? "is" : "are"} not text and come${binary.length === 1 ? "s" : ""} back by size alone — call again with output_dir to write the whole tree to disk.`,
    );
  }
  if (truncated) {
    lines.push(
      "Some files were WITHHELD for size and carry no content — call again with output_dir to write the whole method to disk instead.",
    );
  }
  lines.push(
    "This arm exists for reading a method you cannot see on disk. To work on it, call again with output_dir so its tree is written and the folder is linked.",
  );

  return { structuredContent, summary: lines.join("\n") };
}

async function writtenResult(
  context: CatalogWriteContext,
  client: CatalogWriteClient,
  input: { method_id: string; output_dir?: string; overwrite?: boolean },
  stored: MethodDetail,
  content: PulledContent,
  apiHost: string,
  // Awaited only for the summary, once the files and the link have landed:
  // nothing written depends on it.
  support: Promise<MethodVersionsSupport>,
  // The folder's link as read before the method was; see getMthdsMethod.
  linkBefore: LinkRead | undefined,
): Promise<GetMethodResult> {
  if (context.saveRoot === undefined) {
    return getError(
      context,
      noWorkingDirectory(
        "This deployment has no working directory to write into, so the method was not written.",
        "Use the local workshop server (npx @pipelex/mcp), which writes under the directory the host started it in.",
      ),
    );
  }

  const target = await resolveSaveDir(context.saveRoot, input.output_dir, "output_dir");
  if (!target.ok) {
    return getError(context, target.problem);
  }
  const { root, dir } = target;

  // A folder still holding the link an earlier release wrote reads as
  // unlinked, so the pull would judge it as somebody else's folder and write
  // a second link beside the old one: refused before anything is planned.
  if (await holdsLegacyLink(dir)) {
    return getError(
      context,
      argumentProblem(
        "output_dir",
        "legacy_link_file",
        `${input.output_dir} holds ${LEGACY_LINK_FILE_NAME}, the link file an earlier release of the workshop wrote, which it now reads only at ${LINK_FILE_NAME}: pulled into as it is, the folder would read as unlinked. Nothing was written.`,
        `Move it into place from inside the folder, then pull again: ${LEGACY_LINK_MOVE} (plain mv outside git), and commit the move.`,
      ),
    );
  }

  // ── the write set, computed ONCE ──────────────────────────────────
  //
  // Everything below iterates this one list: the ownership guard, the symlink
  // inspection, the sub-directory creation and the write loop. A guard that
  // inspects a narrower set than the action lands is not a guard.
  const destinations: Destination[] = [];
  const claimed = new Map<string, string>();
  for (const file of content.files) {
    const absolute = containedPath(dir, file.path);
    if (absolute === undefined) {
      return storedNameRefusal(context, file.path, "it leaves the output folder");
    }
    const refused = storedNameReason(file.path);
    if (refused !== undefined) {
      return storedNameRefusal(context, file.path, refused);
    }
    // Two stored paths can land on ONE file on a case-insensitive filesystem.
    // Written in sequence one replaces the other, both are reported as
    // written, and the next pull refuses the folder for holding changes nobody
    // made. Compare folded, so the check answers for the filesystem the write
    // lands on.
    const key = absolute.toLowerCase();
    const taken = claimed.get(key);
    if (taken !== undefined) {
      return storedNameRefusal(
        context,
        file.path,
        `it lands on the same file as \`${taken}\`, so one would silently replace the other`,
      );
    }
    claimed.set(key, file.path);
    destinations.push({ file, name: file.path, absolute });
  }

  // An entry this pull may not write through — a symlink, a directory, or a
  // symlinked directory on a destination's path — is refused for what it is
  // before anything is planned, so the refusal names
  // it rather than calling it unsaved work. The landing asks again inside its
  // turn, where the entry inspected is the one written.
  const foreign = await foreignDestinationRefusal(dir, destinations);
  if (foreign !== undefined) {
    return getError(context, foreign);
  }

  // A version whose tree is exactly the draft's, path for path and hash for
  // hash, leaves the folder holding the draft, so the link records no
  // version: marked, a save from here would be refused as a restore that
  // restores nothing.
  const versionIsDraft = content.version !== "draft" && sameListing(content.files, stored.files);
  const link = linkBefore ?? (await readMethodLink(dir));
  const observed = await observeDestinations(destinations);
  // The limits are asked for once, before the landing's turn, which holds no
  // call to the platform: the folder is listed against them before planning,
  // again inside the turn when it holds no link, and after the landing.
  const limits = await methodTreeLimitsOf(context, () => client);
  const othersHere = () => unmanagedFiles(dir, limits, content.files);
  // output_dir as the caller wrote it, which the problems name.
  const shown = input.output_dir ?? (path.relative(root, dir) || ".");
  const plan = await planPull(
    shown,
    stored,
    destinations,
    observed,
    input.overwrite === true,
    link,
    {
      target: content.version,
      // A version pull may land over the draft's own files, which are stored,
      // so writing over them loses nothing. For a draft pull the target IS the
      // draft, and a file differing from it is by definition not the draft.
      ...(content.version === "draft" ? {} : { draft: hashesByPath(stored.files) }),
      readVersion: (number) => readVersionHashes(client, stored, number),
    },
    othersHere,
  );
  if (plan.kind === "refuse") {
    return getError(context, plan.problem);
  }

  // The tree is downloaded into a private staging directory BEFORE the
  // landing, so no download runs while the landing holds the workshop's
  // lock, and a download that fails leaves output_dir untouched. A pull that
  // only refreshes the link downloads nothing.
  const land = (staged: string | undefined) =>
    inLinkTurn(() =>
      withLinkLock(() =>
        landPull({
          root,
          dir,
          shown,
          link,
          plan,
          destinations,
          observed,
          stored,
          content,
          versionIsDraft,
          apiHost,
          staged,
          othersHere,
        }),
      ),
    );

  // The landing is one local turn — the provisional link, the files, the final
  // link — and every link write in it is a compare-and-swap: the first against
  // the link this pull planned on, the last against the provisional one it
  // wrote. A save or a pull that wrote the link after this pull read it moved
  // the folder under the plan, and so did an edit to a destination since the
  // plan read it, so the pull is refused before it writes a file, rather than
  // land on a state it never looked at. The whole landing holds the
  // workshop's write lock, so another workshop process neither writes between
  // a compare and its write, nor resumes this pull while it is still writing,
  // nor lands into a folder nested in this one at the same time, nor reads
  // the folder for a save while this pull is half landed.
  let landed: PullLanding;
  try {
    landed =
      plan.kind === "write"
        ? await withStagedTree(client, content.files, (staged) => land(staged))
        : await land(undefined);
  } catch (err) {
    if (err instanceof LinkLockError) {
      return getError(
        context,
        lockProblem(err, {
          folder: shown,
          field: "output_dir",
          consequence: "so nothing was written.",
          again: "Pull again",
        }),
      );
    }
    return getError(context, problemOf(err));
  }
  if (!landed.ok) {
    return getError(context, landed.problem);
  }
  const { provisional, final } = landed;
  const linkFile = final.report;

  // What is here that this method does not have. The pull writes the files the
  // catalog holds NOW, so a file a teammate removed from the stored method is
  // neither written nor noticed — and the link was refreshed to the new
  // updated_at anyway, leaving the folder certifying a sync it does not have,
  // with a tree that validates and runs differently from the catalog's.
  //
  // This tool records no per-file state, so it cannot tell a file the catalog
  // dropped from one the user simply keeps here, and deleting on a guess is the
  // one thing it must not do. So it names them and says which two things they
  // might be: the files of the folder's tree, as a save from here would send
  // them, that the method does not hold.
  const { names: unmanaged, complete: unmanagedComplete } = await othersHere();

  const relativeDir = path.relative(root, dir) === "" ? "." : path.relative(root, dir);
  const structuredContent: GetMethodSuccess = {
    status: "ok",
    ...contentFields(stored, content, apiHost),
    files: content.files.map((file) => ({
      path: file.path,
      bytes: file.size,
      written_to: path.join(relativeDir, ...file.path.split("/")),
    })),
    output_dir: relativeDir,
    link_file: linkFile,
    ...(unmanaged.length === 0 ? {} : { unmanaged }),
    ...(unmanagedComplete ? {} : { unmanaged_truncated: true }),
    truncated: false,
  };

  const count = content.files.length;
  const lines = [
    `${contentTitle(stored, content)} written to \`${relativeDir}\`, ${count} file${count === 1 ? "" : "s"} (${contentCoordinates(stored, content, apiHost)}).`,
  ];
  if (content.version === "draft") {
    const callers = bareIdCallersSentence(stored, await support);
    if (callers !== undefined) lines.push(callers);
  } else if (versionIsDraft) {
    lines.push(
      `Version ${content.version} is identical to the draft (updated_at ${stored.updated_at}), file for file, so the folder holds the draft: the link records no version, and a save from here needs no token, sending the link's as it would after a pull of the draft.`,
    );
  } else {
    lines.push(
      `The folder now holds version ${content.version}, not the draft. To restore it as the draft once the user has asked, save from here with expected_updated_at ${stored.updated_at}; a save without the token is refused, so the draft (updated_at ${stored.updated_at}) is never replaced by accident. Restoring publishes nothing, and that token is not one to publish under: the draft's content was not read here.`,
    );
  }
  // What a failed link write means depends on what is already on disk, and
  // saying "NOT linked" about a linked folder was the worst of the three: it
  // told the caller to pass a method_id they did not need, about a folder
  // that would have saved the right method on its own. A link this pull wrote
  // provisionally still carries the interrupted-pull marker, and one written by
  // an earlier pull still carries that pull's synced_updated_at — neither is
  // the refresh this pull owed, and both leave the folder linked.
  const marked = provisional?.report.written === true;
  const linkedAnyway = marked || link.kind === "link";
  lines.push(
    linkFile.written
      ? `Linked by \`${linkFile.path}\` — commit it, so a save from this folder writes this method's draft instead of creating a second method.`
      : final.changed
        ? `The files are written, but \`${linkFile.path}\` was not refreshed: ${linkFile.reason}. It may not describe these files, so pull again before saving from here.`
        : linkedAnyway
          ? `The files are written and the folder IS linked to this method, but \`${linkFile.path}\` could not be refreshed (${linkFile.reason}), so it still records an out-of-date synced_updated_at${marked ? " and this pull's interrupted-pull marker" : ""}. Fix that and pull again${marked ? ": until then a save from here is refused, since the link marks this pull as unfinished." : " before saving from here: the link still describes the folder's previous sync, not these files."}`
          : `The folder is NOT linked (${linkFile.reason}), so a save from it would create a SECOND method unless it passes method_id \`${stored.method_id}\`.`,
  );

  if (unmanaged.length > 0) {
    lines.push(
      `The folder also holds ${unmanaged.map((name) => `\`${name}\``).join(", ")}, which this method does not. Either somebody removed ${unmanaged.length === 1 ? "it" : "them"} from the stored method, or ${unmanaged.length === 1 ? "it is" : "they are"} yours — this tool cannot tell, and deletes nothing. Check before saving from here, which would add ${unmanaged.length === 1 ? "it" : "them"} back to the catalog.`,
    );
  } else if (!unmanagedComplete) {
    lines.push(
      `This tool could not list what else \`${relativeDir}\` holds — the folder's tree is refused (a symbolic link, a name no tree takes) or past the deployment's limits — so it is NOT saying the folder holds only this method's files. It is saying it does not know. Check before saving from here, which lists the folder the same way.`,
    );
  }

  return { structuredContent, summary: lines.join("\n") };
}

/** One file a pull lands: the listing's entry, its path, and where it goes on disk. */
interface Destination {
  file: SavedMethodFile;
  name: string;
  absolute: string;
}

/** What a pull's landing did, or the refusal it made before writing a file. */
type PullLanding =
  | { ok: false; problem: Problem }
  | { ok: true; provisional?: LinkReplacement; final: LinkReplacement };

/**
 * Land a planned pull: the provisional link, the files, the final link. Called
 * inside the turn ({@link inLinkTurn}), so within this process nothing reads
 * or writes the folder's link or files between those steps; every step is
 * local, the files copied from the tree staged before the turn, so the turn is
 * short.
 *
 * Both link writes are compare-and-swaps ({@link replaceMethodLink}). The
 * first expects the link this pull planned on: one that moved since was
 * written by a save or a pull that changed what the folder holds, so the plan
 * is about a state that is gone, and the pull is refused before a file is
 * written. The last expects the provisional link this pull wrote.
 */
async function landPull(landing: {
  root: string;
  dir: string;
  /** output_dir as the caller wrote it, for the problems. */
  shown: string;
  link: LinkRead;
  plan: Exclude<PullPlan, { kind: "refuse" }>;
  destinations: readonly Destination[];
  observed: readonly ObservedFile[];
  stored: MethodData;
  content: PulledContent;
  versionIsDraft: boolean;
  apiHost: string;
  /** The staged tree the files are copied from; absent on a link-only refresh. */
  staged: string | undefined;
  /** The files of the folder's tree the pull does not land, listed now. */
  othersHere: () => Promise<{ names: string[]; complete: boolean }>;
}): Promise<PullLanding> {
  const {
    root,
    dir,
    shown,
    link,
    plan,
    destinations,
    observed,
    stored,
    content,
    versionIsDraft,
    apiHost,
    staged,
    othersHere,
  } = landing;
  const linkFields = { apiHost, methodId: stored.method_id, name: stored.name };
  const moved = (report: LinkFileReport): PullLanding => ({
    ok: false,
    problem: workshopProblem(
      "client.workspace_busy",
      { path: report.path },
      {
        field: "output_dir",
        message: `\`${report.path}\` changed after this pull read it — ${report.reason ?? "another save or pull rewrote it"} — so what this pull planned to write is about a folder that is gone. Nothing was written.`,
        remedy: "Pull again: the next pull plans against the folder as it stands now.",
      },
    ),
  });

  // `containedPath` is lexical — it joins and compares strings. A destination
  // that is a symlink passes it and then sends `writeFile` to the link's
  // target, which is how a pull wrote outside the workspace entirely. Inspect
  // every destination and every existing directory on its path on REAL
  // entries before anything is created or written, the provisional link included,
  // exactly as `codegen-writer.ts` does, and inside the turn, so the entry
  // inspected is the one written. A link-only refresh is refused too: it would
  // vouch for a file that is not an ordinary file of this folder.
  const foreign = await foreignDestinationRefusal(dir, destinations);
  if (foreign !== undefined) {
    return { ok: false, problem: foreign };
  }

  // A pull whose destinations already match writes NOTHING and refreshes the
  // link alone. Rewriting identical bytes changed every mtime, woke every
  // watcher, and — where one file was read-only — turned a pure link refresh
  // into a mid-write failure that marked the folder as an interrupted pull
  // having written nothing at all, which the next pull then read as licence to
  // overwrite.
  let provisional: LinkReplacement | undefined;
  let landedOn = link;
  if (plan.kind === "write") {
    const edited = await changedDestinations(destinations, observed);
    if (edited.length > 0) {
      return {
        ok: false,
        problem: workshopProblem(
          "client.workspace_busy",
          { path: shown },
          {
            field: "output_dir",
            message: `${edited.map((name) => `\`${name}\``).join(", ")} changed after this pull read ${edited.length === 1 ? "it" : "them"}, so the plan to write over ${edited.length === 1 ? "it" : "them"} is about bytes that are gone. Nothing was written.`,
            remedy:
              "Pull again once the edit is done: the next pull compares the files as they stand.",
          },
        ),
      };
    }

    // A folder with no link was found holding nothing but this method before
    // the download, outside this turn: a file landing in it meanwhile would be
    // claimed by the link written next, and sent by the next save from here
    // as the method's own. So its tree is listed again here, where nothing of
    // this process writes it, and the planned refusal is made on what it holds now.
    if (link.kind === "none") {
      const refusal = unlinkedOthersRefusal(shown, await othersHere());
      if (refusal !== undefined) {
        return { ok: false, problem: refusal };
      }
    }

    // The link goes down BEFORE the files, marked `partial_pull`, so that a
    // failure between two files leaves the folder owned by this method
    // instead of looking like somebody else's work — which is what made the
    // retry this failure advertises impossible to perform. It keeps the sync
    // the folder had, since the files are not yet what this pull brings, and
    // is rewritten without the marker once every file has landed. A save holds
    // the same lock while it reads, so none reads this landing half done; one
    // from a workshop too old to share the lock sees this link move when it
    // reads its link again after its files.
    provisional = await replaceMethodLink(
      root,
      dir,
      link,
      buildMethodLink({
        ...linkFields,
        syncedUpdatedAt: link.kind === "link" ? link.link.synced_updated_at : "",
        ...(link.kind === "link" && link.link.synced_version !== undefined
          ? { syncedVersion: link.link.synced_version }
          : {}),
        partialPull: true,
      }),
    );
    if (provisional.changed) {
      return moved(provisional.report);
    }
    // A version's files land only under a link that says so. Without the
    // marker, the link left in place records the draft's current token and no
    // version, so it would vouch for these files as the draft, and an ordinary
    // save from here would replace the draft with the version, with no
    // explicit token: the restore guard the save keeps would never see them.
    // A draft pull over a link that records a version is refused the same way:
    // left in place, that link would say the folder holds the version while it
    // held the draft, and a later save would be refused on that false premise.
    // Any other draft pull needs no refusal — a link still describing an older
    // sync is refused as stale, or the files are the draft's own.
    const markedVersion = link.kind === "link" ? link.link.synced_version : undefined;
    const report = provisional.report;
    if (!report.written && (content.version !== "draft" || markedVersion !== undefined)) {
      const consequence =
        content.version === "draft"
          ? `so its record of version ${markedVersion} could not be cleared, and the draft's files would have sat under a link saying they are that version`
          : `so the folder could not be marked as holding version ${content.version}, and its files would have read as the draft's to a later save`;
      return {
        ok: false,
        problem: workshopProblem(
          "client.write_failed",
          { path: report.path, reason: "link_unwritable" },
          {
            field: "output_dir",
            message: `\`${report.path}\` could not be written (${report.reason ?? "unknown reason"}), ${consequence}. Nothing was written.`,
            remedy:
              "Check the link file's and the folder's permissions, then pull again — or pull the version into a folder of its own.",
          },
        ),
      };
    }
    landedOn = provisional.wrote ?? link;

    const written: string[] = [];
    for (const destination of destinations) {
      const parent = path.dirname(destination.absolute);
      if (parent !== dir) {
        const escaped = await createSubdirectory(dir, parent);
        if (escaped !== undefined) {
          return {
            ok: false,
            problem: midWriteProblem(destination.name, escaped, written, report.written),
          };
        }
      }
      try {
        // Present: a write plan lands only from a staged tree.
        const bytes = await fs.readFile(
          path.join(staged ?? "", ...destination.file.path.split("/")),
        );
        await fs.writeFile(destination.absolute, bytes);
      } catch (err) {
        return {
          ok: false,
          problem: midWriteProblem(destination.name, errorMessage(err), written, report.written),
        };
      }
      written.push(destination.name);
    }
  }

  // The link records the draft's token whichever content was pulled: it is
  // what a save from here sends, and a save from a folder holding a version
  // replaces the draft with it, which is how a version is restored. It records
  // the version too, so a later pull reads a file still holding that version's
  // bytes as stored rather than as unsaved work — unless the version is the
  // draft, file for file, when the folder holds the draft.
  const final = await replaceMethodLink(
    root,
    dir,
    landedOn,
    buildMethodLink({
      ...linkFields,
      syncedUpdatedAt: stored.updated_at,
      ...(content.version === "draft" || versionIsDraft ? {} : { syncedVersion: content.version }),
    }),
  );
  // A refresh alone writes no file, so a link that moved under it leaves
  // nothing half done: the pull is refused as one that never ran.
  if (final.changed && plan.kind === "link-only") {
    return moved(final.report);
  }
  return { ok: true, ...(provisional === undefined ? {} : { provisional }), final };
}

/**
 * The refusal of a pull whose destination is an entry it may not write
 * through — a symlink, a directory, anything but an ordinary file — or lies
 * below a directory symlink ({@link ancestorReason}), or `undefined` when
 * every destination is absent or an ordinary file on an ordinary path.
 */
async function foreignDestinationRefusal(
  dir: string,
  destinations: readonly Destination[],
): Promise<Problem | undefined> {
  for (const destination of destinations) {
    const foreign =
      (await ancestorReason(dir, destination.absolute)) ??
      (await foreignEntryReason(destination.absolute));
    if (foreign !== undefined) {
      return workshopProblem(
        "client.target_exists",
        { path: destination.name },
        {
          field: "output_dir",
          message: `\`${destination.name}\` cannot be written: ${foreign}. No files were written.`,
          remedy:
            "A method's files are written as ordinary files. Remove or move that entry aside, or point output_dir at a folder of its own.",
        },
      );
    }
  }
  return undefined;
}

/**
 * Why the directories between `dir`, the pull's real output folder, and a
 * destination may not be written through, or `undefined` when they may.
 *
 * A stored path is checked lexically ({@link storedNameReason}) and the
 * destination's own entry with `lstat` ({@link foreignEntryReason}), and
 * neither sees a directory symlink on the way: `assets -> .claude` in the
 * folder let a stored `assets/settings.json`, which has no dot segment and
 * whose real parent stays inside the folder, land in `.claude/`, where an
 * agent reads its configuration. So every existing ancestor is inspected with
 * `lstat` and a symlink anywhere on the path refuses the pull, and the path
 * the write would really take, from the deepest existing ancestor's real path
 * on, is held to the same dot-segment rule as the stored one.
 */
async function ancestorReason(dir: string, destination: string): Promise<string | undefined> {
  const segments = path.relative(dir, path.dirname(destination)).split(path.sep).filter(Boolean);
  let deepest = dir;
  let walked = 0;
  for (const segment of segments) {
    const next = path.join(deepest, segment);
    let entry;
    try {
      entry = await fs.lstat(next);
    } catch (err) {
      if (isMissingPathError(err)) break;
      return errorMessage(err);
    }
    if (entry.isSymbolicLink()) {
      return `\`${segments.slice(0, walked + 1).join("/")}\` on its path is a symlink, and writing through it would land wherever it points`;
    }
    // A file in the way fails the write, which reports it; nothing lies beyond it.
    if (!entry.isDirectory()) break;
    deepest = next;
    walked += 1;
  }
  let realDeepest: string;
  try {
    realDeepest = await fs.realpath(deepest);
  } catch (err) {
    return errorMessage(err);
  }
  const realPath = path.join(realDeepest, ...segments.slice(walked), path.basename(destination));
  const relative = path.relative(dir, realPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "its real path leaves the output folder";
  }
  if (relative.split(path.sep).some((segment) => segment.startsWith("."))) {
    return `its real path in the output folder, \`${relative.split(path.sep).join("/")}\`, has a component beginning with a dot, which no method tree holds`;
  }
  return undefined;
}

/** Whether two listings name the same tree: the same paths, each with the same SHA-256. */
function sameListing(
  a: readonly { path: string; sha256: string }[],
  b: readonly { path: string; sha256: string }[],
): boolean {
  if (a.length !== b.length) return false;
  const byPath = hashesByPath(b);
  return byPath.size === b.length && a.every((file) => byPath.get(file.path) === file.sha256);
}

/** A listing's SHA-256 by tree path. */
function hashesByPath(files: readonly { path: string; sha256: string }[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.sha256]));
}

/**
 * A published version's files' hashes by path, or `undefined` when it cannot
 * be read — which the pull then treats as knowing nothing about it, so it
 * refuses more, never less.
 */
async function readVersionHashes(
  client: CatalogWriteClient,
  stored: MethodData,
  version: number,
): Promise<Map<string, string> | undefined> {
  try {
    return hashesByPath((await client.getMethodVersion(stored.method_id, version)).files);
  } catch {
    return undefined;
  }
}

/**
 * The files of the output folder's tree that are not this method's: the
 * folder listed as a save from it would list it (`method-tree.ts`, the
 * deployment's limits), minus the paths the pull wrote.
 *
 * It reports nothing when the folder's tree cannot be listed, and says so: a
 * partial list read as a complete one would be worse than none, since the
 * point of the line it feeds is "here is everything here that the catalog does
 * not have", and a folder whose tree cannot be listed is one a save from it
 * refuses too.
 */
async function unmanagedFiles(
  dir: string,
  limits: FolderLimits,
  stored: readonly SavedMethodFile[],
): Promise<{ names: string[]; complete: boolean }> {
  const listed = await listFolderTree(dir, limits);
  if (!listed.ok) {
    // A folder holding no file of a tree beside the pulled ones holds nothing
    // unmanaged; an empty tree is no refusal of anything.
    return listed.error.code === "empty_tree"
      ? { names: [], complete: true }
      : { names: [], complete: false };
  }
  const managed = new Set(stored.map((file) => file.path));
  return {
    names: listed.tree.files.map((file) => file.path).filter((treePath) => !managed.has(treePath)),
    complete: true,
  };
}

/**
 * Why this stored path may not be written here, or `undefined` when it may.
 *
 * Containment is not enough, because the catalog is an untrusted source of
 * paths: a method's paths come from whoever saved it, and `output_dir` may be
 * the workspace root. The occupancy guard only refuses paths that already
 * EXIST, so a stored method could leave `.github/workflows/…` or an agent's
 * configuration file behind it in a workspace that had neither. So no path
 * component may begin with a dot, which is where a workspace keeps the files
 * that configure its tools rather than its code, and where the link file
 * lives: a method tree holds no such path under the standard, and a pull
 * writes none. The SDK refuses a path that is not a tree path, or two that
 * collide, before it downloads anything.
 */
function storedNameReason(name: string): string | undefined {
  if (name.split("/").some((segment) => segment.startsWith("."))) {
    return "it has a path component beginning with a dot, which no method tree holds, and a pull writes a method's files, not a workspace's configuration";
  }
  return undefined;
}

/**
 * A pull refused for a path the stored method names: the method's package,
 * which whoever saved it fixes, located at that file of the method.
 */
function storedNameRefusal(
  context: CatalogWriteContext,
  name: string,
  reason: string,
): GetMethodResult {
  return getError(
    context,
    workshopProblem(
      "method.package_invalid",
      { reason: "unsafe_file_path" },
      {
        file: name,
        message: `The stored method names a file this pull will not write: \`${name}\` — ${reason}.`,
        remedy:
          "No files were written. A method's file paths come from whoever saved it, and output_dir may hold more than this method; fix the path in the webapp editor, or pull without output_dir to read the files inline.",
      },
    ),
  );
}

/**
 * Create a destination's parent through `workspace-boundary.ts`, which refuses
 * a symlinked component before the `mkdir` and checks the real path again
 * after it, as `resolveSaveDir` and `codegen-writer.ts` do.
 */
function createSubdirectory(dir: string, parent: string): Promise<string | undefined> {
  return createContainedSubdirectory(
    dir,
    parent,
    `its directory \`${path.relative(dir, parent)}\` resolves outside output_dir`,
  );
}

/**
 * The mid-write failure, and the cure that actually works: the link file goes
 * down first, so the folder is this method's, marked as an interrupted pull,
 * and a call made again once the cause is fixed is let through.
 */
function midWriteProblem(
  name: string,
  reason: string,
  written: readonly string[],
  linked: boolean,
): Problem {
  const landed =
    written.length === 0
      ? "No files were written."
      : `Written before the failure: ${written.map((each) => `\`${each}\``).join(", ")}.`;
  return workshopProblem(
    "client.write_failed",
    { path: name, reason: "partly_written" },
    {
      field: "output_dir",
      message: `Could not write ${name}: ${reason}. ${landed}`,
      remedy: linked
        ? "The folder is linked to this method and marked as an interrupted pull, so calling again with the same output_dir resumes it once the cause is fixed. Check the folder's permissions first."
        : "The link file could not be written either, so calling again would be refused as somebody else's work. Check the folder's permissions, then pull into an empty folder instead.",
    },
  );
}

/**
 * What a pull decided to do, rather than merely whether it was allowed to.
 * `link-only` is a folder whose every destination already matches: it needs
 * no write at all, and saying so here is what keeps a pure link refresh out of
 * `writeFile`.
 */
type PullPlan = { kind: "refuse"; problem: Problem } | { kind: "write" } | { kind: "link-only" };

/**
 * What the catalog holds besides the content being pulled — the other places
 * a local file's bytes may already be stored, so that writing over them loses
 * nothing. Files are compared by SHA-256, which the method's listings carry.
 */
interface StoredElsewhere {
  /** The content being pulled: `"draft"`, or a published version's number. */
  target: number | "draft";
  /** The draft's files' hashes by path, when the pull's target is a version. */
  draft?: ReadonlyMap<string, string>;
  /** Reads a published version's files' hashes by path; `undefined` when it cannot. */
  readVersion: (version: number) => Promise<ReadonlyMap<string, string> | undefined>;
}

/**
 * What this pull should do with `output_dir` — write, refresh the link alone,
 * or refuse — and why the rule is not the codegen writer's.
 *
 * `mthds_codegen` overwrites its own stamped output because the engine owns
 * those filenames. A method's files are the USER's and carry no stamp, so the
 * only evidence of ownership is the link file. Hence:
 *
 *  - no link, and nothing in the folder's tree but what this pull lands:
 *    written, since the link then claims the whole folder and the next save
 *    from it sends its whole tree; anything else in it, a stranger's bundle
 *    included, refuses the pull;
 *  - a link naming another method: refused outright, because it is somebody
 *    else's work;
 *  - a link naming THIS method: compared destination by destination —
 *    identical writes nothing and only refreshes the link; different while the
 *    draft has NOT moved means the local files are work this folder never
 *    saved, so the pull is refused and says it would be lost; different AFTER
 *    the draft has moved means the tool cannot tell whose change it is looking
 *    at, so it refuses unless `overwrite` was sent — which the caller sends
 *    only after asking the user.
 *
 * A destination that is simply ABSENT is none of those three: writing it
 * destroys nothing, so it is not compared against anything. Nor is a
 * destination whose local bytes the catalog already stores elsewhere (see
 * {@link storedElsewhere}): the draft's own file, when the pull brings a
 * version, or the file of the version the folder was last synced with, when
 * it brings something else.
 *
 * Every refusal is `client.target_exists` at `output_dir`, the folder holding
 * what this pull will not write over, and writes nothing at all.
 */
async function planPull(
  // output_dir as the caller wrote it, for the refusals.
  shown: string,
  stored: MethodData,
  destinations: readonly Destination[],
  observed: readonly ObservedFile[],
  overwrite: boolean,
  link: LinkRead,
  elsewhere: StoredElsewhere,
  // The files of the folder's tree that the pull does not land, listed as a
  // save from the folder would list them.
  othersHere: () => Promise<{ names: string[]; complete: boolean }>,
): Promise<PullPlan> {
  if (link.kind === "unreadable") {
    return refusePull(
      shown,
      `\`${LINK_FILE_NAME}\` is there but cannot be read: ${link.reason}.`,
      "Something already claims this folder. Fix or remove that file, or point output_dir at an empty folder.",
    );
  }

  if (link.kind === "none") {
    // "Is anything this pull would land on already here" — asked of the write
    // set itself.
    const occupied = await existingDestinations(destinations);
    if (occupied.length > 0) {
      return refusePull(
        shown,
        `it already holds ${occupied.map((name) => `\`${name}\``).join(", ")} and no ${LINK_FILE_NAME}, so it is somebody else's work.`,
        "Point output_dir at an empty or dedicated folder. A folder becomes linked by being saved from, or pulled into, by these tools.",
      );
    }
    // The link this pull writes claims the WHOLE folder: the next save from it
    // sends every file of its tree. So a folder whose tree holds anything this
    // pull does not land is refused rather than turned into a method that
    // holds them: a project's own files above all with output_dir ".", and a
    // stranger's `their_bundle.mthds` beside which the pull would land and
    // then claim both bundles with one link.
    const refusal = unlinkedOthersRefusal(shown, await othersHere());
    return refusal === undefined ? { kind: "write" } : { kind: "refuse", problem: refusal };
  }

  // Compared bare: a link records the bare id, and the pull of `mt_x@3` is a
  // pull of `mt_x`.
  if (readMethodSelector(link.link.method_id).methodId !== stored.method_id) {
    return refusePull(
      shown,
      `it is linked to a different method (\`${link.link.method_id}\` — ${link.link.name} on ${link.link.api_host}).`,
      "Point output_dir at a folder of its own. Overwriting another method's folder would silently replace the files a teammate is working on.",
    );
  }

  const local = compareDestinations(destinations, observed);
  // Where `overwrite` already decides — an interrupted pull, or a draft that
  // moved since the sync — the files the catalog stores elsewhere change
  // nothing, so no version is read to find them.
  if (
    overwrite &&
    local.differing.length > 0 &&
    (link.link.partial_pull === true || link.link.synced_updated_at !== stored.updated_at)
  ) {
    return { kind: "write" };
  }
  const unsaved = await storedElsewhere(local.differing, link.link, elsewhere);

  if (link.link.partial_pull === true) {
    // An earlier pull of THIS method died between two files, and the failure
    // told the caller to call again — so a destination that is absent, or
    // already identical, or holding bytes the catalog stores, is resumed
    // without ceremony: completing it destroys nothing. What the marker does
    // NOT license is writing over bytes that have since CHANGED: it is
    // persisted JSON in a file the user is told to commit, so it can be stale
    // or planted.
    if (unsaved.length === 0 || overwrite) {
      return { kind: "write" };
    }
    return refusePull(
      shown,
      `an earlier pull of this method was interrupted here, and ${unsaved.map((name) => `\`${name}\``).join(", ")} changed after it landed.`,
      `Resuming would overwrite those bytes. Save them with ${WORKSHOP_TOOL_NAMES.saveMethod}, or move them aside, then pull again — or pass overwrite: true if the stored version wins.`,
    );
  }

  if (unsaved.length === 0) {
    if (local.differing.length === 0 && local.missing.length === 0) {
      // Identical: nothing is written, and only the link's sync moves.
      return { kind: "link-only" };
    }
    // Absent destinations, or bytes the catalog stores. Nothing here is lost
    // by writing them.
    return { kind: "write" };
  }

  if (link.link.synced_updated_at === stored.updated_at) {
    // The draft has not moved since this folder synced, so the local
    // differences are work nobody has saved. No flag opens this: `overwrite`
    // answers "whose change is this", and here there is no question.
    return refusePull(
      shown,
      `it holds changes to ${unsaved.map((name) => `\`${name}\``).join(", ")} that were never saved — the draft has not moved since this folder last synced with it.`,
      `Those edits exist only here, so pulling would destroy them. Save them with ${WORKSHOP_TOOL_NAMES.saveMethod}, or move them aside, then pull again.`,
    );
  }

  if (!overwrite) {
    // State only what was MEASURED: a folder the user never touched looks
    // exactly like this the moment a teammate saves.
    return refusePull(
      shown,
      `its copy of ${unsaved.map((name) => `\`${name}\``).join(", ")} differs from the stored one, and the draft has moved since this folder last synced (draft updated_at ${stored.updated_at}, last synced ${link.link.synced_updated_at}). That is what a teammate's save looks like, and it is also what a local edit looks like.`,
      "This tool records no per-file state, so it cannot tell which of the two it is looking at. Inside a git repository `git status` answers it. Ask the user, and pass overwrite: true only if they say the stored version wins.",
    );
  }

  return { kind: "write" };
}

/**
 * The differing destinations whose local bytes the catalog does NOT already
 * store — the ones a write would destroy.
 *
 * A local file whose hash is the draft's file's at the same path is stored (a
 * pull of a version, over a folder holding the draft); so is one whose hash is
 * the file's of the version the link says this folder was last synced with (a
 * pull of anything else, over a folder holding that version). The version is
 * read only when something is still in question, and a version that cannot be
 * read stores nothing — so this only ever narrows a refusal on evidence, and
 * never on a guess. An unreadable local file is never matched.
 */
async function storedElsewhere(
  differing: readonly LocalFile[],
  link: MethodLink,
  elsewhere: StoredElsewhere,
): Promise<string[]> {
  let remaining = differing.filter(
    (file) => file.sha256 === undefined || elsewhere.draft?.get(file.name) !== file.sha256,
  );
  const synced = link.synced_version;
  if (remaining.length > 0 && synced !== undefined && synced !== elsewhere.target) {
    const version = await elsewhere.readVersion(synced);
    if (version !== undefined) {
      remaining = remaining.filter(
        (file) => file.sha256 === undefined || version.get(file.name) !== file.sha256,
      );
    }
  }
  return remaining.map((file) => file.name);
}

/** Names shown by name up to a handful, the rest counted. */
function listedNames(names: readonly string[]): string {
  const shown = names.slice(0, 5).map((name) => `\`${name}\``);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * The refusal of a pull into a folder with no link whose tree holds files the
 * pull does not land, or cannot be listed, or `undefined` when it holds none.
 * Asked when the pull plans and again inside the landing's turn.
 */
function unlinkedOthersRefusal(
  shown: string,
  others: {
    names: readonly string[];
    complete: boolean;
  },
): Problem | undefined {
  if (!others.complete) {
    return refuseOutputDir(
      shown,
      `it holds no ${LINK_FILE_NAME}, and what else its tree holds could not be listed (it is past the limits, or holds a file no method tree takes), so this pull cannot tell that the folder holds nothing but this method.`,
      "Pull into a fresh folder of its own: a pull links the whole folder, and the next save from it sends every file of its tree.",
    );
  }
  if (others.names.length > 0) {
    return refuseOutputDir(
      shown,
      `it holds no ${LINK_FILE_NAME} and its tree holds files this method does not have: ${listedNames(others.names)}. A pull links the whole folder, so the next save from it would send those files as the method's own.`,
      "Pull into a fresh folder of its own, such as a new subfolder, or move those files out first.",
    );
  }
  return undefined;
}

function refusePull(shown: string, message: string, remedy: string): PullPlan {
  return { kind: "refuse", problem: refuseOutputDir(shown, message, remedy) };
}

/** A pull refused for what `output_dir` already holds, which it will not write over. */
function refuseOutputDir(shown: string, message: string, remedy: string): Problem {
  return workshopProblem(
    "client.target_exists",
    { path: shown },
    {
      field: "output_dir",
      message: `output_dir was not written: ${message} Nothing was written.`,
      remedy,
    },
  );
}

/** A destination present on disk with bytes other than the pull's; `sha256` is absent when unreadable. */
interface LocalFile {
  name: string;
  sha256?: string;
}

/**
 * How each destination's bytes on disk stand against what would be written,
 * told apart three ways rather than two. `missing` is separate from
 * `differing` because they lead to opposite decisions: a file that is not
 * there holds nothing to lose, while a file that is there and differs is work
 * this tool cannot account for. Anything unreadable — a permission error, a
 * directory or a symlink in its place — counts as differing, not missing.
 */
interface LocalComparison {
  /** Present, and not what the pull brings — with the hash, so it can be matched against the catalog. */
  differing: LocalFile[];
  /** Not there at all. */
  missing: string[];
}

/** What one destination held when the pull looked: a regular file's hash, nothing, or something unreadable. */
type ObservedFile =
  | { kind: "bytes"; sha256: string }
  | { kind: "missing" }
  | { kind: "unreadable" };

/**
 * What each destination holds, hashed once. The plan decides on these reads,
 * and the landing writes only while every destination still holds what was
 * read here ({@link changedDestinations}).
 */
async function observeDestinations(
  destinations: readonly { absolute: string }[],
): Promise<ObservedFile[]> {
  const observed: ObservedFile[] = [];
  for (const destination of destinations) {
    observed.push(await observeFile(destination.absolute));
  }
  return observed;
}

/** One destination's state: a regular file is streamed through SHA-256, never read whole, and never through a link. */
async function observeFile(absolute: string): Promise<ObservedFile> {
  try {
    const entry = await fs.lstat(absolute);
    if (!entry.isFile()) return { kind: "unreadable" };
  } catch (err) {
    return isMissingPathError(err) ? { kind: "missing" } : { kind: "unreadable" };
  }
  let handle;
  try {
    handle = await fs.open(absolute, "r");
  } catch {
    return { kind: "unreadable" };
  }
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { kind: "bytes", sha256: hash.digest("hex") };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close();
  }
}

function compareDestinations(
  destinations: readonly Destination[],
  observed: readonly ObservedFile[],
): LocalComparison {
  const differing: LocalFile[] = [];
  const missing: string[] = [];
  for (const [index, destination] of destinations.entries()) {
    const seen = observed[index] ?? { kind: "unreadable" };
    if (seen.kind === "missing") {
      missing.push(destination.name);
    } else if (seen.kind === "unreadable") {
      differing.push({ name: destination.name });
    } else if (seen.sha256 !== destination.file.sha256) {
      differing.push({ name: destination.name, sha256: seen.sha256 });
    }
  }
  return { differing, missing };
}

/**
 * The destinations that no longer hold what the plan read. The plan reads the
 * files, may then wait on the platform for a version's listing and the
 * download, and only then lands; an edit made meanwhile moves no link, so the
 * link's compare-and-swap cannot see it, and the plan's verdict that a file
 * held stored bytes would overwrite the edit. Read again inside the landing
 * turn, so the window left is that turn's.
 */
async function changedDestinations(
  destinations: readonly { name: string; absolute: string }[],
  observed: readonly ObservedFile[],
): Promise<string[]> {
  const now = await observeDestinations(destinations);
  return destinations.flatMap((destination, index) => {
    const before = observed[index];
    const after = now[index];
    const same =
      before !== undefined &&
      after !== undefined &&
      before.kind === after.kind &&
      (before.kind !== "bytes" || (after.kind === "bytes" && before.sha256 === after.sha256));
    return same ? [] : [destination.name];
  });
}

/**
 * A pull of a method that holds no file: the method's package, which whoever
 * saves into it fixes, and a different answer from an unknown id, which is the
 * catalog's `pipelex.catalog.not_found`.
 */
function emptyTreeError(context: CatalogWriteContext, version: number | "draft"): GetMethodResult {
  return getError(
    context,
    workshopProblem(
      "method.package_invalid",
      { reason: "empty_tree" },
      {
        field: "method_id",
        message:
          version === "draft"
            ? "The stored method's draft holds no file yet."
            : `Version ${version} of the stored method holds no file.`,
        remedy: `The method exists but is empty — a different answer from an unknown id, which the catalog reports as pipelex.catalog.not_found. Open it in the Pipelex webapp and save into it, or save a folder into it from here with ${WORKSHOP_TOOL_NAMES.saveMethod} and this method_id.`,
      },
    ),
  );
}

/** A pull that produced no result: its one problem, and the problem's summary. */
function getError(context: { apiNotes?: ApiNotes }, problem: Problem): GetMethodResult {
  return {
    structuredContent: { status: "error", problem },
    summary: problemSummary(problem, context.apiNotes),
  };
}

// ── the folder's link ───────────────────────────────────────────────

/** What a folder says about itself before anything is written to the catalog. */
type DirectoryClaim =
  | { kind: "link"; dir: string; link: MethodLink }
  | { kind: "unreadable"; dir: string; reason: string };

/** A folder's link as read: where, and exactly what was there. */
interface LinkAt {
  /** As the caller wrote it, for messages. */
  dir: string;
  absolute: string;
  read: LinkRead;
}

/**
 * A pull's output folder's link, read WITHOUT creating anything.
 *
 * `resolveSaveDir` is the write path's routine and it makes the directory it
 * contains; this question is asked before the method is read, where making a
 * directory in order to decide whether to refuse would be a side effect of a
 * refusal. So the path is contained lexically, what is there is read, and
 * anything that cannot be resolved answers `undefined` — the write that
 * follows asks again with the real routine and reports its own refusal.
 */
async function linkAt(
  context: CatalogWriteContext,
  requested: string | undefined,
): Promise<LinkAt | undefined> {
  if (requested === undefined || context.saveRoot === undefined) {
    return undefined;
  }
  const absolute = path.resolve(context.saveRoot, requested);
  if (absolute !== context.saveRoot && !isInsideRoot(context.saveRoot, absolute)) {
    return undefined;
  }
  const relative = path.relative(context.saveRoot, absolute);
  return { dir: relative === "" ? "." : relative, absolute, read: await readMethodLink(absolute) };
}

/**
 * What a folder already claims: its link, or a link file nobody can read.
 *
 * `unreadable` is kept rather than folded into `undefined`, and that IS the
 * question the create arm asks. `readMethodLink` reports a malformed, truncated
 * or symlinked link file as `unreadable` precisely because something claims the
 * folder; flattening it to "no link" let the create run, mint a second
 * method, and only then have the link write refuse — a duplicate this tool
 * cannot delete. Not knowing whether a folder is claimed is not the same as
 * knowing it is free.
 */
function claimOf(at: LinkAt | undefined): DirectoryClaim | undefined {
  if (at === undefined || at.read.kind === "none") {
    return undefined;
  }
  return at.read.kind === "link"
    ? { kind: "link", dir: at.dir, link: at.read.link }
    : { kind: "unreadable", dir: at.dir, reason: at.read.reason };
}

// ── tool results ────────────────────────────────────────────────────

export function saveMethodToolResult(result: SaveMethodResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary),
    isError: result.structuredContent.status === "error",
  };
}

export function getMethodToolResult(result: GetMethodResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary),
    isError: result.structuredContent.status === "error",
  };
}
