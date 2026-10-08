import { promises as fs } from "node:fs";
import path from "node:path";

import { ApiResponseError, EmptyMethodSourceError } from "@pipelex/sdk";
import type {
  MethodData,
  MethodDraftInput,
  MethodPublishInput,
  MethodPublishResult,
  MethodRenameInput,
  MethodVersion,
  MethodWriteInput,
} from "@pipelex/sdk";
import type { MethodFile } from "mthds/protocol";
import { parseMethodFiles, serializeMethodFiles } from "mthds/protocol";
import { z } from "zod";

import {
  LINK_FILE_NAME,
  apiHostOf,
  buildMethodLink,
  bundleFilesIn,
  existingDestinations,
  foreignEntryReason,
  readMethodLink,
  writeMethodLink,
} from "./catalog-link.js";
import type { LinkFileReport, LinkRead, MethodLink } from "./catalog-link.js";
import { methodVersionsSupport, readMethodSelector, versionReaderOf } from "./method-versions.js";
import type {
  MethodSelector,
  MethodVersionsMemory,
  MethodVersionsSupport,
} from "./method-versions.js";
import {
  PRUNED_DIRECTORIES,
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
  filesInputSchema,
  resolveSubmittedFiles,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
} from "./shared.js";
import type {
  ApiConfig,
  AuthErrorTexture,
  ClassifyErrorOptions,
  ErrorSummaries,
  FileResolver,
  SubmittedFile,
  SubmittedFileInput,
  ToolError,
} from "./shared.js";
import { validateMthds } from "./validate.js";
import type { ValidationContext } from "./validate.js";
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
 * session change it. Unlike `mthds_codegen`, whose `output_dir` is optional,
 * both need the filesystem: a save without its files' directory would leave
 * no link file, so the next save would duplicate the method — a materially
 * different act under the same name.
 *
 * **A save writes the method's DRAFT.** A saved method has a draft, replaced
 * by every save and never validated on write, and immutable published
 * versions numbered from 1, which only a publish adds. The draft write is a
 * compare-and-swap on the draft's token (`updated_at`), which the link file
 * records, so a save never replaces a draft that moved since this directory
 * synced with it — the webapp autosaves the same draft. A pull reads the draft
 * by default and a published version on `mt_…@<n>`.
 */

// ── the inline budget ───────────────────────────────────────────────

/**
 * The whole-set budget for the inline arm of `mthds_get_method`, applied by
 * WHOLE FILE in order — the codegen streams rule, for the same reason: half a
 * `.mthds` file is worse than none, because a truncated bundle reads as a
 * complete one that fails to parse.
 */
export const MAX_INLINE_SOURCE_BYTES = 256 * 1024;

const utf8 = new TextEncoder();

// ── input schemas ───────────────────────────────────────────────────

const pythonFilesInputSchema = z
  .array(
    z.union([
      z.object({
        content: z.string().describe("The full .py file contents."),
        uri: z.string().nullable().optional().describe("Optional provenance URI for diagnostics."),
      }),
      z.object({
        path: z
          .string()
          .describe(
            "Filesystem path to a .py file, resolved by the local workshop server relative to its working directory.",
          ),
      }),
    ]),
  )
  .describe(
    "The bundle's custom-PipeFunc .py files, REPLACED as a set. Omit to preserve whatever Python is stored; send [] to clear it.",
  );

export const mthdsSaveMethodInputSchema = {
  files: filesInputSchema.describe(
    "The bundle's .mthds files, ROOT FILE FIRST — the one carrying the bundle's `domain`. The platform derives the method's listed description from the first file, so the order is load-bearing and this tool does not reorder or guess.",
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
  python: pythonFilesInputSchema.optional(),
  expected_updated_at: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The draft token this save believes it is replacing; the platform refuses the save when the draft has moved since, atomically, and nothing is written. Omitted, the linked directory's pipelex-method.json synced_updated_at is used, and only a save from an unlinked directory replaces whatever the draft holds. Pass the draft's current updated_at only to replace a draft that moved, after the user said to. Ignored on a create.",
    ),
  link_dir: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Where to write pipelex-method.json, relative to the working directory. Omitted, it goes beside the root file. An inline-only submission with no link_dir writes no link file.",
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
      "Write the method's sources here, relative to the working directory, with the link file beside them — no source passes through the conversation. Omitted, the sources come back inline.",
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      "Only meaningful with output_dir, and only for a directory already linked to THIS method whose files differ after the stored method has moved. Send it after asking the user, never by reflex.",
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
    "never_published: the method has no published version. draft_unchanged: the draft is identical to the latest published version. draft_ahead: the draft differs from it, so a publish would add a version.",
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
      "The draft's new token — what pipelex-method.json now records, and what the next save sends as expected_updated_at and a publish as expected_draft_updated_at.",
    ),
  latest_version: latestVersionSchema.optional(),
  publish_state: publishStateSchema.optional(),
  api_host: z.string().optional(),
  link_file: linkFileSchema.optional(),
  rename_error: toolErrorSchema
    .optional()
    .describe(
      "Present when the draft was saved but the requested rename failed: the name is unchanged.",
    ),
  validation_errors: z.array(z.unknown()).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

const sourceFileSchema = z.object({
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  content: z.string().optional(),
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
      "The draft's token as of this read, whichever content was read — what pipelex-method.json records and what a later save or publish sends.",
    ),
  latest_version: latestVersionSchema.optional(),
  publish_state: publishStateSchema.optional(),
  api_host: z.string().optional(),
  files: z.array(sourceFileSchema).optional(),
  python: z.array(sourceFileSchema).optional(),
  output_dir: z.string().optional(),
  link_file: linkFileSchema.optional(),
  unmanaged: z.array(z.string()).optional(),
  unmanaged_truncated: z.boolean().optional(),
  truncated: z.boolean().optional(),
  errors: z.array(toolErrorSchema).optional(),
});

// ── TypeScript surfaces ─────────────────────────────────────────────

export interface MthdsSaveMethodInput {
  files: SubmittedFileInput[];
  name?: string;
  method_id?: string;
  python?: SubmittedFileInput[];
  expected_updated_at?: string;
  link_dir?: string;
}

export interface MthdsGetMethodInput {
  method_id: string;
  output_dir?: string;
  overwrite?: boolean;
}

export interface SourceFile {
  name: string;
  bytes: number;
  content?: string;
  written_to?: string;
}

export interface SaveMethodSuccess {
  status: "ok";
  is_valid: boolean;
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
  rename_error?: ToolError;
  validation_errors?: unknown[];
}

export interface SaveMethodFailure {
  status: "error";
  errors: ToolError[];
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
  files: SourceFile[];
  python: SourceFile[];
  output_dir?: string;
  link_file?: LinkFileReport;
  /**
   * Source files in the directory that this method does not have — present
   * only on the written arm, and only when there are any.
   */
  unmanaged?: string[];
  unmanaged_truncated?: boolean;
  truncated?: boolean;
}

export interface GetMethodFailure {
  status: "error";
  errors: ToolError[];
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
 * reads as "could not tell" without sending anything.
 */
export interface CatalogWriteClient {
  getMethod(methodId: string): Promise<MethodData>;
  createMethod(input: MethodWriteInput): Promise<MethodData>;
  writeDraft(methodId: string, input: MethodDraftInput): Promise<MethodData>;
  renameMethod(methodId: string, input: MethodRenameInput): Promise<MethodData>;
  getMethodVersion(methodId: string, version: number): Promise<MethodVersion>;
  publishMethod(methodId: string, input: MethodPublishInput): Promise<MethodPublishResult>;
  version?(): Promise<unknown>;
}

export interface CatalogWriteContext extends ApiConfig {
  client?: CatalogWriteClient;
  /** The workshop's shared memory of whether the platform resolves version selectors. */
  methodVersions?: MethodVersionsMemory;
  /** Fills `{ path }` items of `files` — `.mthds` only. */
  resolver?: FileResolver;
  /** Fills `{ path }` items of `python` — `.py` only. */
  pythonResolver?: FileResolver;
  /**
   * The workshop's working directory. Both tools are registered only where this
   * exists, so its absence is a deployment fault rather than a caller's.
   */
  saveRoot?: string;
  /** The validation capability these saves run the bundle through — `mthds_validate`'s own. */
  validation: ValidationContext;
  authError?: AuthErrorTexture;
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
  return methodVersionsSupport(context.methodVersions, versionReaderOf(client));
}

/**
 * How the draft stands against the latest published version, read from a
 * method the platform answered. `undefined` when the answer carries neither
 * field, as a platform that predates versions answers.
 */
export function publishStateOf(method: MethodData): PublishState | undefined {
  if (method.latest_version === null) return "never_published";
  if (typeof method.latest_version !== "number") return undefined;
  const latest = method.latest_published;
  if (latest === null || latest === undefined || typeof method.draft_digest !== "string") {
    return undefined;
  }
  return method.draft_digest === latest.source_digest ? "draft_unchanged" : "draft_ahead";
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
    return `It has never been published, so the bare \`${id}\` answers method_not_published${where} until it is.`;
  }
  if (state === "draft_unchanged") {
    return `The draft is identical to version ${latest}, the latest published, which callers of the bare \`${id}\` run${where}.`;
  }
  return `Callers of the bare \`${id}\` still run version ${latest}${where}; this draft is ahead of it until it is published.`;
}

// ── error options ───────────────────────────────────────────────────

const CREATE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/methods",
  badRequest: {
    location: "files",
    hint: "The API rejected the method payload. Check that name is non-empty and the files are the bundle's .mthds sources; if the error mentions organization context, mint a key in the intended organization.",
  },
};

const NOT_FOUND_ON_SAVE = {
  location: "method_id",
  hint: "No registered method with this id is visible to the API key's organization. The catalog is org-scoped, so a method from another organization reads exactly like a miss — check the api_host recorded in pipelex-method.json against the API this server is configured for.",
};

/**
 * The draft write. A stale token is the platform's own compare-and-swap
 * refusing the write, located at the field that carried the token; the hint
 * is the save's, and the message is rebuilt with both tokens once the stored
 * one has been read (see {@link draftConflictError}).
 */
const DRAFT_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/methods/{id}/draft",
  badRequest: {
    location: "method_id",
    hint: "The API rejected the draft. Check the method_id as the catalog returned it; if the error mentions organization context, mint a key in the intended organization.",
  },
  notFound: NOT_FOUND_ON_SAVE,
  conflict: {
    location: "expected_updated_at",
    hint: `Somebody saved this method's draft since this directory synced with it — the webapp saves as it edits. Pull it with ${WORKSHOP_TOOL_NAMES.getMethod} into a directory of its own to compare, then decide with the user what to keep. To replace their draft knowingly, save again with expected_updated_at set to the draft's current updated_at. If that updated_at is your own last save's (one whose link write failed), pull the method into this directory to refresh the link.`,
  },
  tooLarge: {
    location: "files",
    hint: "The draft is larger than the catalog stores in one method. Make the bundle smaller, or split it.",
  },
};

const RENAME_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/methods/{id}",
  badRequest: {
    location: "name",
    hint: "The API rejected the name. Pass a non-empty name.",
  },
  notFound: NOT_FOUND_ON_SAVE,
  tooLarge: {
    location: "name",
    hint: "That name would leave the method too large to publish. Choose a shorter one.",
  },
};

const GET_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/methods/{id}",
  badRequest: {
    location: "method_id",
    hint: "The API rejected the read. Check the method_id as the catalog returned it.",
  },
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. The catalog is org-scoped, so a method from another organization reads exactly like a miss — check the id with mthds_list_methods.",
  },
};

const SAVE_ERROR_SUMMARIES: ErrorSummaries = {
  config: "The method was not saved: the Pipelex API or catalog access is misconfigured.",
  input_domain: "The method was not saved: the request was rejected.",
  runtime: "The method was not saved: the Pipelex API returned an error.",
  paywall: "The method was not saved: the organization's Pipelex plan does not cover this call.",
};

const GET_ERROR_SUMMARIES: ErrorSummaries = {
  config: "The method was not fetched: the Pipelex API or catalog access is misconfigured.",
  input_domain: "The method was not fetched: the request was rejected.",
  runtime: "The method was not fetched: the Pipelex API returned an error.",
  paywall: "The method was not fetched: the organization's Pipelex plan does not cover this call.",
};

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
  refuseVersion: (selector: Extract<MethodSelector, { form: "version" }>) => ToolError,
): { ok: true; methodId: string; selector: MethodSelector } | { ok: false; error: ToolError } {
  const selector = readMethodSelector(value);
  if (selector.form === "version") {
    return { ok: false, error: refuseVersion(selector) };
  }
  if (selector.form === "opaque" && value.includes("@")) {
    return {
      ok: false,
      error: {
        class: "input_domain",
        location: "method_id",
        message: `\`${value}\` is not a method id: a catalog id is mt_… with at most one suffix, @<n> for a published version or @draft for the draft.`,
        hint: "Pass the id as mthds_list_methods or pipelex-method.json gives it.",
        retryable: false,
      },
    };
  }
  return { ok: true, methodId: selector.methodId, selector };
}

// ── mthds_save_method ───────────────────────────────────────────────

export async function saveMthdsMethod(
  input: MthdsSaveMethodInput,
  context: CatalogWriteContext,
): Promise<SaveMethodResult> {
  const parsed = mthdsSaveMethodInputObjectSchema.safeParse(input);
  if (!parsed.success) {
    return saveError(
      "The method was not saved: request input is invalid.",
      parsed.error.issues.map((issue) => ({
        class: "input_domain" as const,
        ...(issue.path.length === 0 ? {} : { location: issue.path.join(".") }),
        message: issue.message,
        hint: "Send files (root file first), and a name on a create; add method_id to save an existing method's draft.",
        retryable: false,
      })),
    );
  }

  if (parsed.data.method_id === undefined && parsed.data.name === undefined) {
    return saveError("The method was not saved: request input is invalid.", [
      {
        class: "input_domain",
        location: "name",
        message: "name is required to create a method.",
        hint: "Pass the name the method is listed under. To save an existing method's draft instead, pass its method_id (from pipelex-method.json beside the bundle).",
        retryable: false,
      },
    ]);
  }

  // The id the method routes take. A version is immutable, so a save aimed at
  // one is refused rather than silently retargeted at the draft.
  let targetId: string | undefined;
  if (parsed.data.method_id !== undefined) {
    const routeId = methodRouteId(parsed.data.method_id, (selector) => ({
      class: "input_domain",
      location: "method_id",
      message: `\`${parsed.data.method_id}\` names published version ${selector.version}, which never changes: a save writes the method's draft.`,
      hint: `Pass method_id "${selector.methodId}" to save these files as the draft of that method.`,
      retryable: false,
    }));
    if (!routeId.ok) {
      return saveError("The method was not saved: request input is invalid.", [routeId.error]);
    }
    targetId = routeId.methodId;
  }

  // The bundle directory is read off the SUBMITTED items, before a single file
  // is opened, because it is what bounds where the `{ path }` arms may read
  // from — see {@link pathsOutsideBundle}.
  const bundleDir = bundleDirectoryOf(parsed.data.files);
  // The READ boundary is the directory a real `{ path }` item names, which is
  // `linkDirectoryOf`'s question and not `bundleDirectoryOf`'s — see
  // {@link pathsOutsideBundle} for why handing it to an inline `uri` published
  // a workspace's secrets.
  const readRoot = linkDirectoryOf(parsed.data.files);
  const outside = [
    ...(await pathsOutsideBundle(parsed.data.files, readRoot, "files", context.saveRoot)),
    ...(await pathsOutsideBundle(parsed.data.python, readRoot, "python", context.saveRoot)),
  ];
  if (outside.length > 0) {
    return saveError("The method was not saved: request input is invalid.", outside);
  }

  // Resolve ONCE. The bytes that are validated are the bytes that are saved:
  // splitting the two — validate in the skill, save in a second call — would
  // read the files twice and the verdict would not be provably about the saved
  // bytes.
  const bundle = await resolveSubmittedFiles(parsed.data.files, context.resolver);
  if (bundle.errors.length > 0) {
    return saveError("The method was not saved: request input is invalid.", bundle.errors);
  }
  if (bundle.files.length === 0) {
    return saveError("The method was not saved: request input is invalid.", [
      {
        class: "input_domain",
        location: "files",
        message: "files must not be empty.",
        hint: "Submit the bundle's .mthds files with the root file — the one carrying the bundle's `domain` — first.",
        retryable: false,
      },
    ]);
  }

  const python =
    parsed.data.python === undefined
      ? undefined
      : await resolveSubmittedFiles(parsed.data.python, context.pythonResolver);
  if (python !== undefined && python.errors.length > 0) {
    return saveError(
      "The method was not saved: request input is invalid.",
      python.errors.map((error) => ({
        ...error,
        // resolveSubmittedFiles locates at `files[i]`; this set is `python`.
        ...(error.location === undefined
          ? {}
          : { location: error.location.replace(/^files\[/, "python[") }),
      })),
    );
  }

  // Where the link file may go is a different question from what the files are
  // NAMED relative to — see {@link linkDirectoryOf}.
  const linkDir = linkDirectoryOf(parsed.data.files);
  const named = nameFiles(bundle.files, bundleDir, "method", ".mthds", "files");
  if (!named.ok) {
    return saveError("The method was not saved: request input is invalid.", [named.error]);
  }
  // `serializeMethodFiles` drops whitespace-only entries, and an all-blank set
  // serializes to `""` — which is the platform's CLEAR sentinel. So
  // `python: [{ path: "empty.py" }]` reported "updated" and erased the stored
  // Python, the exact hazard the omitted-versus-empty rule below exists to
  // prevent. A blank `.mthds` is already refused in the validation leg; this is
  // the same refusal for the arm nothing validates.
  const blankPython = (python?.files ?? []).flatMap((file, index) =>
    file.content.trim() === ""
      ? [
          {
            class: "input_domain" as const,
            location: `python[${index}].content`,
            message: "File content must not be empty.",
            hint: "An empty .py file is dropped on the way to the catalog, and a set of nothing but empty files would erase the stored Python. Remove it, or give it content.",
            retryable: false,
          },
        ]
      : [],
  );
  if (blankPython.length > 0) {
    return saveError("The method was not saved: request input is invalid.", blankPython);
  }

  const namedPython =
    python === undefined ? undefined : nameFiles(python.files, bundleDir, "funcs", ".py", "python");
  if (namedPython !== undefined && !namedPython.ok) {
    return saveError("The method was not saved: request input is invalid.", [namedPython.error]);
  }

  // Across BOTH arms, because a name is a destination and the two arms write
  // into one directory: an inline `files` item carrying `uri: "helper.py"` and
  // a `python` item of the same name are two sources for one path.
  const unwritable = unwritableNames([
    ...named.files.map((file) => ({ file, location: "files" as const })),
    ...(namedPython?.files ?? []).map((file) => ({ file, location: "python" as const })),
  ]);
  if (unwritable !== undefined) {
    return saveError("The method was not saved: request input is invalid.", [unwritable]);
  }

  // Validate through the same capability mthds_validate uses, on the resolved
  // bytes (already inline, so the validate leg re-reads nothing). The verdict
  // rides beside the save and no longer gates it: a draft may be invalid, an
  // agent's work in progress often is, and the verdict is what tells it so. A
  // publish is where validity is required.
  const verdict = await validateMthds({ files: bundle.files }, context.validation);
  const validation = verdict.structuredContent;
  if (validation.status === "error") {
    return saveError(
      "The method was not saved: the bundle produced no validation verdict.",
      validation.errors ?? [],
    );
  }

  const mthds = serializeMethodFiles(named.files);
  // Omitted preserves the stored Python; [] clears it; a non-empty set replaces
  // it. The tool never merges, and a bundle with no .py file sends nothing — so
  // a save from a directory the user has not changed cannot silently erase
  // stored Python.
  const pythonField = namedPython === undefined ? {} : { python: namedPython.files };

  const client = catalogWriteClient(context);
  let stored: MethodData;
  let saved: "created" | "updated" | "renamed";
  let renameError: ToolError | undefined;
  let previousName: string | undefined;

  // Read ONCE, before either arm touches the catalog, because both arms are
  // irreversible in the same way: a create that ran first left a duplicate,
  // and a draft write that ran first left a different method's draft replaced
  // — per SPEC.md delete is admin-only, and a replaced draft is gone.
  const claim = await linkedMethodAt(context, parsed.data.link_dir ?? linkDir);

  if (targetId === undefined) {
    // Preventing a duplicate is the link file's whole purpose, and it was
    // consulted too late to serve it: the create ran first, and only afterwards
    // did the link write refuse to re-point — reporting `link_file.written:
    // false` about a SECOND method that already existed.
    if (claim !== undefined) {
      return saveError("The method was not saved: that directory is already claimed.", [
        claim.kind === "link"
          ? {
              class: "input_domain",
              location: "method_id",
              message: `\`${claim.dir}\` is linked to \`${claim.link.method_id}\` (${claim.link.name} on ${claim.link.api_host}), and this call names no method_id, so it would have created a SECOND method for the same directory.`,
              hint: `Pass method_id: "${claim.link.method_id}" to save the draft of the method this directory is linked to, or point link_dir at a directory of its own to create a genuinely new method.`,
              retryable: false,
            }
          : {
              class: "input_domain",
              location: "link_dir",
              message: `\`${claim.dir}\` holds a \`${LINK_FILE_NAME}\` that cannot be read (${claim.reason}), so something already claims this directory. Creating a method from here would leave a SECOND method that this tool cannot delete.`,
              hint: `Repair or remove \`${LINK_FILE_NAME}\` in that directory — if it names the method you meant, pass its method_id — or point link_dir at a directory of its own to create a genuinely new method.`,
              retryable: false,
            },
      ]);
    }

    const writeInput: MethodWriteInput = {
      // Present: the create arm was refused above without one.
      name: parsed.data.name ?? "",
      mthds,
      ...pythonField,
    };
    try {
      stored = await client.createMethod(writeInput);
    } catch (err) {
      const error = classifyError(err, { ...CREATE_ERROR_OPTIONS, auth: context.authError });
      return saveError(summaryForToolError(error, SAVE_ERROR_SUMMARIES), [
        notRetryableCreate(err, error),
      ]);
    }
    saved = "created";
  } else {
    // The create arm reads the link BEFORE creating because a duplicate cannot
    // be undone; this arm has the same irreversibility. A method_id read from
    // the wrong place, or a stale one pasted by a user, would write THIS
    // directory's bundle into that method's draft, and only afterwards would
    // the link write report the mismatch — leaving the wrong draft replaced and
    // the directory still linked to the right method. The ids are compared
    // bare, since the link records the bare id and `@draft` names the same
    // method.
    if (claim?.kind === "link" && readMethodSelector(claim.link.method_id).methodId !== targetId) {
      return saveError("The method was not saved: that directory is linked to another method.", [
        {
          class: "input_domain",
          location: "method_id",
          message: `\`${claim.dir}\` is linked to \`${claim.link.method_id}\` (${claim.link.name} on ${claim.link.api_host}), but this call names method_id \`${parsed.data.method_id}\`. Saving would have replaced a different method's draft with this directory's bundle, and a replaced draft cannot be given back.`,
          hint: `Pass method_id: "${claim.link.method_id}" to save the draft of the method this directory is linked to. If you really mean to save this bundle as \`${targetId}\`, point link_dir at a directory of its own so the two stop sharing one link file.`,
          retryable: false,
        },
      ]);
    }

    // The platform's own compare-and-swap on the draft token: a draft that
    // moved since the token is refused atomically and nothing is written. The
    // token is the caller's when given, and otherwise the link file's — the
    // claim above already proved it names this method — so a save from a
    // linked directory never replaces a draft somebody saved since this
    // directory synced, the webapp's autosave included. Only a save from an
    // unlinked directory, or an inline one, is last-writer-wins. `input_data`
    // is omitted, which keeps the form inputs a webapp user saved, and so is
    // the name: a rename is its own call below.
    const token =
      parsed.data.expected_updated_at ??
      (claim?.kind === "link" ? claim.link.synced_updated_at : undefined);
    const draftInput: MethodDraftInput = {
      mthds,
      ...pythonField,
      ...(token === undefined ? {} : { expected_updated_at: token }),
    };
    try {
      stored = await client.writeDraft(targetId, draftInput);
    } catch (err) {
      const error = classifyError(err, { ...DRAFT_ERROR_OPTIONS, auth: context.authError });
      const reported =
        error.location === "expected_updated_at" && token !== undefined
          ? await draftConflictError(error, client, targetId, {
              token,
              fromLink: parsed.data.expected_updated_at === undefined,
            })
          : error;
      return saveError(summaryForToolError(reported, SAVE_ERROR_SUMMARIES), [reported]);
    }
    saved = "updated";

    // The rename changes the name alone and moves no token, so it runs after
    // the draft write, whose token check is what licenses touching this
    // method at all. A rename that fails leaves a saved draft behind, which the
    // result reports as saved, with the rename's error beside it.
    const name = parsed.data.name;
    if (name !== undefined && name !== stored.name) {
      previousName = stored.name;
      try {
        stored = await client.renameMethod(targetId, { name });
        saved = "renamed";
      } catch (err) {
        renameError = classifyError(err, { ...RENAME_ERROR_OPTIONS, auth: context.authError });
      }
    }
  }

  const apiHost = apiHostOf(context.baseUrl);
  const linkFile = await writeLinkForSave(context, parsed.data.link_dir, linkDir, {
    apiHost,
    methodId: stored.method_id,
    name: stored.name,
    syncedUpdatedAt: stored.updated_at,
  });

  const latestVersion = latestVersionOf(stored);
  const publishState = publishStateOf(stored);
  const structuredContent: SaveMethodSuccess = {
    status: "ok",
    is_valid: validation.is_valid,
    is_runnable: validation.is_runnable,
    pending_signatures: validation.pending_signatures,
    method_id: stored.method_id,
    name: stored.name,
    saved,
    updated_at: stored.updated_at,
    ...(latestVersion === undefined ? {} : { latest_version: latestVersion }),
    ...(publishState === undefined ? {} : { publish_state: publishState }),
    api_host: apiHost,
    ...(linkFile === undefined ? {} : { link_file: linkFile }),
    ...(renameError === undefined ? {} : { rename_error: renameError }),
    ...(validation.validation_errors === undefined
      ? {}
      : { validation_errors: validation.validation_errors }),
  };

  const support = await catalogVersionsSupport(context, client);
  return {
    structuredContent,
    summary: saveSummary(structuredContent, {
      linkedAnyway: claim?.kind === "link",
      previousName,
      callers: bareIdCallersSentence(stored, support),
    }),
  };
}

/**
 * The draft write's stale-token refusal, carrying both tokens. The platform's
 * refusal names neither, and the caller needs both: the stored one to tell a
 * teammate's save from this session's own (a save whose link write failed
 * leaves the link a token behind), the one it sent to see which sync it was.
 * The read is best-effort — when it fails, the refusal stands as the platform
 * worded it.
 */
async function draftConflictError(
  error: ToolError,
  client: CatalogWriteClient,
  methodId: string,
  sent: { token: string; fromLink: boolean },
): Promise<ToolError> {
  let current: MethodData;
  try {
    current = await client.getMethod(methodId);
  } catch {
    return error;
  }
  const source = sent.fromLink
    ? ` as this directory's ${LINK_FILE_NAME} records (synced_updated_at)`
    : "";
  return {
    ...error,
    message: `The method's draft was last saved at ${current.updated_at}, not ${sent.token}${source}. Nothing was written.`,
  };
}

/**
 * A create whose response was lost cannot be replayed safely: `POST /v1/methods`
 * honours an `Idempotency-Key` and `@pipelex/sdk` exposes no way to send one, so
 * the retry mints a SECOND method under the same name. A create-side transport
 * fault is therefore reported as not retryable, with the cure that does work.
 * This overrides the SDK's `retryable` on purpose, as `classifyStartError`
 * (`run.ts`) does for a start: the SDK's verdict says whether asking again can
 * succeed, never whether it is safe. A draft write has no such hazard — `PUT`
 * replaces the draft and is idempotent by construction — so its faults keep the
 * SDK's verdict.
 *
 * A 2xx the SDK could not read gets the warning too, although the SDK calls it
 * final: the create was accepted and only its answer was lost, so the method
 * exists and a second save without its id would mint another.
 *
 * When the SDK gains the key, this function goes.
 */
function notRetryableCreate(err: unknown, error: ToolError): ToolError {
  const accepted = err instanceof ApiResponseError && err.status >= 200 && err.status < 300;
  if (!error.retryable && !accepted) {
    return error;
  }
  return {
    ...error,
    retryable: false,
    hint: `${error.hint} This was a CREATE, and it must not be retried blindly: the API accepts an idempotency key but the SDK cannot send one, so a create whose response was lost would be minted twice. List the catalog with mthds_list_methods first — if the method is there, save again with its method_id, which writes its draft.`,
  };
}

async function writeLinkForSave(
  context: CatalogWriteContext,
  linkDir: string | undefined,
  bundleDir: string | undefined,
  fields: { apiHost: string; methodId: string; name: string; syncedUpdatedAt: string },
): Promise<LinkFileReport | undefined> {
  const requested = linkDir ?? bundleDir;
  if (requested === undefined) {
    // An inline-only submission has no directory to put the link in. Say so:
    // without a link the next save creates a second method unless the caller
    // passes the id.
    return {
      path: LINK_FILE_NAME,
      written: false,
      reason:
        "the submission was inline only and no link_dir was given, so there is no directory to link",
    };
  }
  if (context.saveRoot === undefined) {
    return {
      path: LINK_FILE_NAME,
      written: false,
      reason: "this deployment has no working directory to write into",
    };
  }

  const target = await resolveSaveDir(context.saveRoot, requested, "link_dir");
  if (!target.ok) {
    return { path: LINK_FILE_NAME, written: false, reason: target.error.message };
  }

  // The pull path refuses a directory linked to a different method; the save
  // path used to write straight over it. The link file is COMMITTED, so the
  // takeover was durable and silent: the teammate's next save from that
  // directory would write this new method's draft instead of theirs.
  const existing = await readMethodLink(target.dir);
  if (
    existing.kind === "link" &&
    readMethodSelector(existing.link.method_id).methodId !== fields.methodId
  ) {
    return {
      path: path.relative(target.root, path.join(target.dir, LINK_FILE_NAME)),
      written: false,
      reason: `it is already linked to a different method (\`${existing.link.method_id}\` — ${existing.link.name} on ${existing.link.api_host}), and re-pointing it would send a teammate's next save to this method instead of theirs`,
    };
  }
  // A link nobody can parse is not an empty slot. The pull path already refuses
  // this exact state — something claims the directory and following it would be
  // guesswork — while the save path fell through and TRUNCATED the file, after
  // the catalog write, destroying whatever it held: a hand-edited link, another
  // tool's file of the same name, a teammate's association. `foreignEntryReason`
  // stops a symlink or a directory; an ordinary file with the wrong contents
  // reached `writeFile` unopposed.
  if (existing.kind === "unreadable") {
    return {
      path: path.relative(target.root, path.join(target.dir, LINK_FILE_NAME)),
      written: false,
      reason: `it is there but cannot be read (${existing.reason}), and overwriting it would destroy whatever it holds`,
    };
  }

  // A save makes the directory the draft, so the link records no published
  // version, whatever an earlier pull of one left there.
  return writeMethodLink(target.root, target.dir, buildMethodLink(fields));
}

function saveSummary(
  result: SaveMethodSuccess,
  notes: { linkedAnyway: boolean; previousName?: string; callers?: string },
): string {
  const id = result.method_id ?? "";
  const lines: string[] = [];
  if (result.saved === "created") {
    lines.push(
      `Method **${result.name}** created on ${result.api_host} (method_id: \`${id}\`, updated_at ${result.updated_at}), holding this bundle as its draft.`,
    );
  } else {
    lines.push(
      `The draft of **${result.name}** was saved on ${result.api_host} (method_id: \`${id}\`, updated_at ${result.updated_at})${result.saved === "renamed" && notes.previousName !== undefined ? `, and the method was renamed from **${notes.previousName}**` : ""}.`,
    );
  }
  if (result.rename_error !== undefined) {
    lines.push(
      `The rename to the requested name FAILED, so the method keeps its name: ${result.rename_error.message} The draft itself was saved; save again with the same name to retry the rename alone.`,
    );
  }

  if (!result.is_valid) {
    lines.push(
      "The bundle is NOT valid. It was saved anyway, as a draft may be, and a publish refuses it until it validates: fix the validation errors and save again.",
    );
  } else if (result.is_runnable === false) {
    const pending = result.pending_signatures ?? [];
    lines.push(
      pending.length === 0
        ? "The bundle is valid but does not run yet, and a publish refuses it until it does."
        : `The bundle is valid but does not run yet — these signatures are still pending: ${pending.map((ref) => `\`${ref}\``).join(", ")}. A publish refuses it until they resolve.`,
    );
  }

  if (notes.callers !== undefined) {
    lines.push(notes.callers);
  }
  lines.push(
    `To validate or run what you just saved, pass method_id \`${id}@draft\`. Publish it only when the user asks for a publish: ${WORKSHOP_TOOL_NAMES.publishMethod} with method_id \`${id}\` and expected_draft_updated_at ${result.updated_at}.`,
  );

  if (result.link_file === undefined) {
    return lines.join("\n");
  }
  // The pull path learned this first: saying "NOT linked" about a linked
  // directory was the worst of the three answers, because it told the caller to
  // pass a method_id they did not need — and the id it named was this method,
  // about a directory whose surviving link names another. Following that advice
  // overwrote the teammate's method. The save path kept the two-way version;
  // this is the pull path's three-way answer, said here too.
  lines.push(
    result.link_file.written
      ? `Linked by \`${result.link_file.path}\` — commit it, so a teammate saves this same method instead of creating a second one.`
      : notes.linkedAnyway
        ? `The directory IS linked to this method, but \`${result.link_file.path}\` could not be refreshed (${result.link_file.reason}), so it still records an out-of-date synced_updated_at, and the next save from here will be refused as stale. Fix that and pull this method into the directory, which refreshes the link alone while the files match.`
        : `The directory is NOT linked (${result.link_file.reason}), so the next save would create a SECOND method unless it passes method_id \`${id}\`.`,
  );
  return lines.join("\n");
}

function saveError(summary: string, errors: ToolError[]): SaveMethodResult {
  return { structuredContent: { status: "error", errors }, summary };
}

// ── mthds_get_method ────────────────────────────────────────────────

/**
 * What a pull brings back: the method's draft, or one of its published
 * versions, as named files. A version carries no name of its own, so the
 * method's name always comes from the method read.
 */
interface PulledContent {
  /** `"draft"`, or the published version's number. */
  version: number | "draft";
  sources: MethodFile[];
  python: MethodFile[];
  /** The single `.mthds` name is this tool's invention: the stored source predates the named form. */
  synthesizedName: boolean;
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
      "The method was not fetched: request input is invalid.",
      parsed.error.issues.map((issue) => ({
        class: "input_domain" as const,
        ...(issue.path.length === 0 ? {} : { location: issue.path.join(".") }),
        message: issue.message,
        hint: "Pass method_id as the catalog returned it; add output_dir to write the sources to disk.",
        retryable: false,
      })),
    );
  }

  // A bare id and `@draft` read the draft; `@<n>` reads that version. The
  // method read itself always takes the bare id, and it runs either way: it
  // carries the name, the draft's token the link records, and the latest
  // version's number.
  const selector = readMethodSelector(parsed.data.method_id);
  if (selector.form === "opaque" && parsed.data.method_id.includes("@")) {
    return getError("The method was not fetched: request input is invalid.", [
      {
        class: "input_domain",
        location: "method_id",
        message: `\`${parsed.data.method_id}\` is not a method id: a catalog id is mt_… with at most one suffix, @<n> for a published version or @draft for the draft.`,
        hint: "Pass the id as mthds_list_methods or pipelex-method.json gives it.",
        retryable: false,
      },
    ]);
  }
  const methodId = selector.methodId;
  const wanted: number | "draft" = selector.form === "version" ? selector.version : "draft";

  let client: CatalogWriteClient;
  let stored: MethodData;
  let version: MethodVersion | undefined;
  try {
    client = catalogWriteClient(context);
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
    if (err instanceof EmptyMethodSourceError) {
      return emptySourceError();
    }
    const error = classifyError(err, { ...GET_ERROR_OPTIONS, auth: context.authError });
    return getError(summaryForToolError(error, GET_ERROR_SUMMARIES), [error]);
  }

  const content = pulledContent(stored, version);
  if (content.sources.length === 0) {
    // The row exists but has no runnable source yet — a produced failure, and a
    // different answer from "no such method", which is a 404 at the same field.
    return emptySourceError();
  }
  const apiHost = apiHostOf(context.baseUrl);
  const support = await catalogVersionsSupport(context, client);

  if (parsed.data.output_dir === undefined) {
    return inlineResult(stored, content, apiHost, support);
  }
  return writtenResult(context, client, parsed.data, stored, content, apiHost, support);
}

/** The draft's files, or the version's, as named files. */
function pulledContent(stored: MethodData, version: MethodVersion | undefined): PulledContent {
  const source = version ?? stored;
  const sources = storedSourceFiles({ mthds: source.mthds, name: stored.name });
  const python = (source.python ?? []).filter((file) => file.content.trim() !== "");
  return {
    version: version === undefined ? "draft" : version.version,
    sources,
    python,
    synthesizedName: nameIsSynthesized(source.mthds),
    ...(version === undefined ? {} : { publishedAt: version.published_at }),
  };
}

/**
 * A version read the platform refused. A version the method never published
 * says what the method does have, from the method read beside it.
 */
function versionReadError(
  err: unknown,
  stored: MethodData,
  wanted: number,
  context: CatalogWriteContext,
): GetMethodResult {
  const error = classifyError(err, { ...GET_ERROR_OPTIONS, auth: context.authError });
  if (!(err instanceof ApiResponseError) || err.code !== "method_version_not_found") {
    return getError(summaryForToolError(error, GET_ERROR_SUMMARIES), [error]);
  }
  const latest = latestVersionOf(stored);
  const has =
    latest === null
      ? "it has never been published, so it has only its draft"
      : typeof latest === "number"
        ? `its latest published version is ${latest}`
        : "it has no such version";
  return getError(GET_ERROR_SUMMARIES.input_domain, [
    {
      ...error,
      message: `\`${stored.method_id}\` has no version ${wanted}: ${has}.`,
      hint: `Pull its draft with method_id "${stored.method_id}"${typeof latest === "number" ? `, or a version from 1 to ${latest} as "${stored.method_id}@<n>"` : ""}.`,
    },
  ]);
}

/**
 * The stored source, as NAMED files.
 *
 * `mthds` is polymorphic, on the draft and on a version alike: the named
 * `[{ name, content }]` array the webapp editor writes, or raw `.mthds` text
 * from before that form existed. `parseMethodFiles` reads the first and throws
 * on the second by design, and the SDK's `methodSourceToContents` reads both
 * but returns contents alone — so neither hands this tool a filename on the
 * legacy shape. A method saved from this workshop is always in the named form,
 * so the fallback below is reachable only for one written before the editor
 * existed. The method's `name` is what the fallback's filename is made from.
 */
export function storedSourceFiles(stored: Pick<MethodData, "mthds" | "name">): MethodFile[] {
  let named: MethodFile[];
  try {
    named = parseMethodFiles(stored.mthds);
  } catch {
    const raw = stored.mthds.trim();
    return raw === "" ? [] : [{ name: `${slugify(stored.name)}.mthds`, content: stored.mthds }];
  }
  return named;
}

/** Whether the name the written arm used is one this tool invented rather than the method's. */
function nameIsSynthesized(mthds: string): boolean {
  try {
    parseMethodFiles(mthds);
    return false;
  } catch {
    return mthds.trim() !== "";
  }
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

function inlineResult(
  stored: MethodData,
  content: PulledContent,
  apiHost: string,
  support: MethodVersionsSupport,
): GetMethodResult {
  // One budget over the whole set, spent by WHOLE FILE in order. A withheld
  // file keeps its name and byte size and carries no content.
  let spent = 0;
  let truncated = false;
  const take = (file: MethodFile): SourceFile => {
    const bytes = utf8.encode(file.content).length;
    if (truncated || spent + bytes > MAX_INLINE_SOURCE_BYTES) {
      truncated = true;
      return { name: file.name, bytes };
    }
    spent += bytes;
    return { name: file.name, bytes, content: file.content };
  };

  const structuredContent: GetMethodSuccess = {
    status: "ok",
    ...contentFields(stored, content, apiHost),
    files: content.sources.map(take),
    python: content.python.map(take),
    truncated,
  };

  const lines = [
    `${contentTitle(stored, content)} (${contentCoordinates(stored, content, apiHost)}): ${content.sources.length} .mthds file(s)${content.python.length === 0 ? "" : ` and ${content.python.length} .py file(s)`}, returned inline.`,
  ];
  if (content.version === "draft") {
    const callers = bareIdCallersSentence(stored, support);
    if (callers !== undefined) lines.push(callers);
  }
  if (truncated) {
    lines.push(
      "Some files were WITHHELD for size and carry no content — call again with output_dir to write the whole method to disk instead.",
    );
  }
  lines.push(
    "This arm exists for reading a method you cannot see on disk. To work on it, call again with output_dir so the sources are written and the directory is linked.",
  );

  return { structuredContent, summary: lines.join("\n") };
}

async function writtenResult(
  context: CatalogWriteContext,
  client: CatalogWriteClient,
  input: { method_id: string; output_dir?: string; overwrite?: boolean },
  stored: MethodData,
  content: PulledContent,
  apiHost: string,
  support: MethodVersionsSupport,
): Promise<GetMethodResult> {
  if (context.saveRoot === undefined) {
    return getError("The method was not written: this deployment cannot write files.", [
      {
        class: "config",
        location: "deployment",
        message: "This deployment has no working directory to write into.",
        hint: "Use the local workshop server (npx @pipelex/mcp), which writes under the directory the host started it in.",
        retryable: false,
      },
    ]);
  }

  const target = await resolveSaveDir(context.saveRoot, input.output_dir, "output_dir");
  if (!target.ok) {
    return getError("The method was not written: output_dir cannot be used.", [target.error]);
  }
  const { root, dir } = target;

  // ── the write set, computed ONCE ──────────────────────────────────
  //
  // Everything below iterates this one list: the ownership guard, the symlink
  // inspection, the sub-directory creation and the write loop. That is the
  // whole point. The guard used to reason about `sources` while the loop landed
  // `[...sources, ...python]`, so a locally edited `.py` file was invisible to
  // every refusal and overwritten anyway; the emptiness test asked for
  // top-level `.mthds` files while the loop landed `.py` and nested paths. A
  // guard that inspects a narrower set than the action lands is not a guard.
  const all = [...content.sources, ...content.python];
  const destinations: { file: MethodFile; name: string; absolute: string }[] = [];
  const claimed = new Map<string, string>();
  for (const file of all) {
    const absolute = containedPath(dir, file.name);
    if (absolute === undefined) {
      return storedNameRefusal(file.name, "it leaves the output directory");
    }
    const refused = storedNameReason(file.name);
    if (refused !== undefined) {
      return storedNameRefusal(file.name, refused);
    }
    // Two stored names can resolve to ONE destination — `a.mthds` beside
    // `./a.mthds`, or `Bundle.mthds` beside `bundle.mthds` on a
    // case-insensitive filesystem, which this tool's own save produces because
    // `nameFiles` keeps both as distinct names. Written in sequence one
    // replaces the other, both are reported as written, and the next pull
    // refuses the directory for holding changes nobody made. Compare folded, so
    // the check answers for the filesystem the write lands on.
    const key = absolute.toLowerCase();
    const taken = claimed.get(key);
    if (taken !== undefined) {
      return storedNameRefusal(
        file.name,
        `it lands on the same file as \`${taken}\`, so one would silently replace the other`,
      );
    }
    claimed.set(key, file.name);
    destinations.push({ file, name: file.name, absolute });
  }

  const link = await readMethodLink(dir);
  const plan = await planPull(dir, stored, destinations, input.overwrite === true, link, {
    target: content.version,
    // A version pull may land over the draft's own files, which are stored,
    // so writing over them loses nothing. For a draft pull the target IS the
    // draft, and a file differing from it is by definition not the draft.
    ...(content.version === "draft"
      ? {}
      : { draft: filesByName(pulledContent(stored, undefined)) }),
    readVersion: (number) => readVersionFiles(client, stored, number),
  });
  if (plan.kind === "refuse") {
    return getError("The method was not written: output_dir holds work this pull would lose.", [
      plan.error,
    ]);
  }

  // `containedPath` is lexical — it joins and compares strings. A destination
  // that is a symlink passes it and then sends `writeFile` to the link's
  // target, which is how a pull wrote outside the workspace entirely. Inspect
  // every destination on REAL entries before anything is created or written,
  // exactly as `codegen-writer.ts` does.
  for (const destination of destinations) {
    const foreign = await foreignEntryReason(destination.absolute);
    if (foreign !== undefined) {
      return getError("The method was not written: output_dir holds an entry it may not write.", [
        {
          class: "input_domain",
          location: "output_dir",
          message: `\`${destination.name}\` cannot be written: ${foreign}. No files were written.`,
          hint: "A method's files are written as ordinary files. Remove or move that entry aside, or point output_dir at a directory of its own.",
          retryable: false,
        },
      ]);
    }
  }

  // A pull whose destinations already match writes NOTHING and refreshes the
  // link alone. Rewriting identical bytes changed every mtime, woke every
  // watcher, and — where one source file was read-only — turned a pure link
  // refresh into a mid-write failure that marked the directory as an
  // interrupted pull having written nothing at all, which the next pull then
  // read as licence to overwrite.
  let provisional: LinkFileReport | undefined;
  if (plan.kind === "write") {
    // The link goes down BEFORE the files, marked `partial_pull`, so that a
    // failure between two files leaves the directory owned by this method
    // instead of looking like somebody else's bundle — which is what made the
    // retry this failure advertises impossible to perform. It keeps the sync
    // the directory had, since the files are not yet what this pull brings, and
    // is rewritten without the marker once every file has landed.
    provisional = await writeMethodLink(
      root,
      dir,
      buildMethodLink({
        apiHost,
        methodId: stored.method_id,
        name: stored.name,
        syncedUpdatedAt: link.kind === "link" ? link.link.synced_updated_at : "",
        ...(link.kind === "link" && link.link.synced_version !== undefined
          ? { syncedVersion: link.link.synced_version }
          : {}),
        partialPull: true,
      }),
    );

    const written: string[] = [];
    for (const destination of destinations) {
      const parent = path.dirname(destination.absolute);
      if (parent !== dir) {
        const escaped = await createSubdirectory(dir, parent);
        if (escaped !== undefined) {
          return getError("The method was only partly written.", [
            midWriteError(destination.name, escaped, written, provisional.written),
          ]);
        }
      }
      try {
        await fs.writeFile(destination.absolute, destination.file.content, "utf8");
      } catch (err) {
        return getError("The method was only partly written.", [
          midWriteError(destination.name, errorMessage(err), written, provisional.written),
        ]);
      }
      written.push(destination.name);
    }
  }

  // The link records the draft's token whichever content was pulled: it is
  // what a save from here sends, and a save from a directory holding a version
  // replaces the draft with it, which is how a version is restored. It records
  // the version too, so a later pull reads a file still holding that version's
  // bytes as stored rather than as unsaved work.
  const linkFile = await writeMethodLink(
    root,
    dir,
    buildMethodLink({
      apiHost,
      methodId: stored.method_id,
      name: stored.name,
      syncedUpdatedAt: stored.updated_at,
      ...(content.version === "draft" ? {} : { syncedVersion: content.version }),
    }),
  );

  // What is here that this method does not have. The pull writes the files the
  // catalog holds NOW, so a file a teammate removed from the stored method is
  // neither written nor noticed — and the link was refreshed to the new
  // updated_at anyway, leaving the directory certifying a sync it does not
  // have, with a bundle that validates and runs differently from the catalog's.
  //
  // This tool records no per-file state, so it cannot tell a file the catalog
  // dropped from one the user simply keeps here, and deleting on a guess is the
  // one thing it must not do. So it names them and says which two things they
  // might be. Telling them apart needs the link to record what it manages,
  // which is a change to the link's format and is filed rather than guessed at.
  const { names: unmanaged, complete: unmanagedComplete } = await unmanagedSources(
    dir,
    destinations,
  );

  const relativeDir = path.relative(root, dir) === "" ? "." : path.relative(root, dir);
  const project = (file: MethodFile): SourceFile => ({
    name: file.name,
    bytes: utf8.encode(file.content).length,
    written_to: path.join(relativeDir, file.name),
  });

  const structuredContent: GetMethodSuccess = {
    status: "ok",
    ...contentFields(stored, content, apiHost),
    files: content.sources.map(project),
    python: content.python.map(project),
    output_dir: relativeDir,
    link_file: linkFile,
    ...(unmanaged.length === 0 ? {} : { unmanaged }),
    ...(unmanagedComplete ? {} : { unmanaged_truncated: true }),
    truncated: false,
  };

  const lines = [
    `${contentTitle(stored, content)} written to \`${relativeDir}\` (${contentCoordinates(stored, content, apiHost)}).`,
  ];
  if (content.version === "draft") {
    const callers = bareIdCallersSentence(stored, support);
    if (callers !== undefined) lines.push(callers);
  } else {
    lines.push(
      `The directory now holds version ${content.version}, not the draft. A save from it replaces the draft (updated_at ${stored.updated_at}) with these files, which is how a version is restored; it publishes nothing.`,
    );
  }
  if (content.synthesizedName) {
    lines.push(
      `The stored method carries no file names — it predates the catalog's named form — so \`${content.sources[0]?.name}\` is a name this tool invented, not the method's. Rename it if you like, but the next save sends whatever name is on disk.`,
    );
  }
  // What a failed link write means depends on what is already on disk, and
  // saying "NOT linked" about a linked directory was the worst of the three: it
  // told the caller to pass a method_id they did not need, about a directory
  // that would have saved the right method on its own. A link this pull wrote
  // provisionally still carries the interrupted-pull marker, and one written by
  // an earlier pull still carries that pull's synced_updated_at — neither is
  // the refresh this pull owed, and both leave the directory linked.
  const linkedAnyway = provisional?.written === true || link.kind === "link";
  lines.push(
    linkFile.written
      ? `Linked by \`${linkFile.path}\` — commit it, so a save from this directory writes this method's draft instead of creating a second method.`
      : linkedAnyway
        ? `The files are written and the directory IS linked to this method, but \`${linkFile.path}\` could not be refreshed (${linkFile.reason}), so it still records an out-of-date synced_updated_at${provisional?.written === true ? " and this pull's interrupted-pull marker" : ""}. Fix that and pull again; a save from here still writes this method's draft.`
        : `The directory is NOT linked (${linkFile.reason}), so a save from it would create a SECOND method unless it passes method_id \`${stored.method_id}\`.`,
  );

  if (unmanaged.length > 0) {
    lines.push(
      `The directory also holds ${unmanaged.map((name) => `\`${name}\``).join(", ")}, which this method does not. Either somebody removed ${unmanaged.length === 1 ? "it" : "them"} from the stored method, or ${unmanaged.length === 1 ? "it is" : "they are"} yours — this tool cannot tell, and deletes nothing. Check before saving from here, which would add ${unmanaged.length === 1 ? "it" : "them"} back to the catalog.`,
    );
  } else if (!unmanagedComplete) {
    lines.push(
      `This tool could not finish reading what else \`${relativeDir}\` holds — a directory it could not open, or more entries than it looks at — so it is NOT saying the directory holds only this method's files. It is saying it does not know. Check before saving from here.`,
    );
  }

  return { structuredContent, summary: lines.join("\n") };
}

/** A pull's files keyed by name: the `.mthds` sources and the Python alike. */
function filesByName(content: Pick<PulledContent, "sources" | "python">): Map<string, string> {
  return new Map([...content.sources, ...content.python].map((file) => [file.name, file.content]));
}

/**
 * A published version's files by name, or `undefined` when it cannot be read —
 * which the pull then treats as knowing nothing about it, so it refuses more,
 * never less.
 */
async function readVersionFiles(
  client: CatalogWriteClient,
  stored: MethodData,
  version: number,
): Promise<Map<string, string> | undefined> {
  try {
    return filesByName(
      pulledContent(stored, await client.getMethodVersion(stored.method_id, version)),
    );
  } catch {
    return undefined;
  }
}

/** How far the unmanaged-source walk goes before it stops looking. */
const UNMANAGED_WALK_ENTRIES = 512;
const UNMANAGED_WALK_DEPTH = 8;

/**
 * The directory's `.mthds` and `.py` files that are not this method's.
 *
 * Bounded rather than exhaustive, and it reports nothing when it hits a bound:
 * a partial list read as a complete one would be worse than none, since the
 * point of the line it feeds is "here is everything here that the catalog does
 * not have". Symlinked directories are not followed, for the reason every walk
 * in this repo does not follow them.
 *
 * It reports its own completeness for the same reason `imageFieldPaths` does:
 * "nothing to report" and "I could not finish looking" are different answers,
 * and rendered as the same absent line the second reads as the first.
 */
async function unmanagedSources(
  dir: string,
  destinations: readonly { absolute: string }[],
): Promise<{ names: string[]; complete: boolean }> {
  const managed = new Set(destinations.map((destination) => destination.absolute.toLowerCase()));
  const found: string[] = [];
  let budget = UNMANAGED_WALK_ENTRIES;

  const walk = async (current: string, depth: number): Promise<boolean> => {
    if (depth > UNMANAGED_WALK_DEPTH) {
      return false;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      // A directory nobody can read is a directory nobody has looked in. This
      // answered "complete", which is how an unreadable subtree shortened the
      // list while the line above kept claiming it named everything — the one
      // thing this walk's own contract forbids.
      return false;
    }
    for (const entry of entries) {
      if (budget-- <= 0) {
        return false;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // A pruned or dot-leading directory holds nothing this method could
        // own: `storedNameReason` refuses to WRITE a dotted component or
        // anything a vendored tree contains, so no managed destination lands
        // in one. Descending them spent the budget inside `node_modules` and
        // listed `.venv/...`/`.git/...` files as sources "this method does
        // not have" — and the link file is designed to be committed, so a
        // repository at `output_dir` is the expected case, not a corner.
        if (PRUNED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        if (!(await walk(absolute, depth + 1))) {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (extension !== ".mthds" && extension !== ".py") {
        continue;
      }
      if (!managed.has(absolute.toLowerCase())) {
        found.push(path.relative(dir, absolute));
      }
    }
    return true;
  };

  const complete = await walk(dir, 0);
  // Reporting nothing rather than a partial list is the contract; saying so is
  // what makes it readable. An empty list alone renders as the absence of the
  // line, which a reader cannot tell from "there is nothing else here".
  return { names: complete ? found.sort() : [], complete };
}

/**
 * Why this stored file name may not be written here, or `undefined` when it may.
 *
 * Containment is not enough, because the catalog is an untrusted source of
 * paths: a method's names come from whoever saved it, `nameFiles` takes an
 * inline item's name straight from a caller-supplied `uri`, and `output_dir`
 * may be the workspace root. The occupancy guard only refuses paths that
 * already EXIST, so every previously absent path was planted unopposed — a
 * stored method could leave `.github/workflows/…` or an agent's configuration
 * file behind it in a workspace that had neither.
 *
 * So the pull writes method sources and nothing else:
 *
 *  - the extension is `.mthds` or `.py`, the two things a method is made of,
 *    and the two `nameFiles` stamps on every name it invents;
 *  - no path component begins with a dot, which is where a workspace keeps the
 *    files that configure its tools rather than its code;
 *  - the link file's own name is reserved, because writing it is the pull's
 *    LAST act: a stored file of that name is overwritten by the link, reported
 *    as written with contents that are not on disk, and the directory then
 *    refuses every later pull for holding a change nobody made.
 */
function storedNameReason(name: string): string | undefined {
  const segments = toPosix(name).split("/");
  if (segments.some((segment) => segment.startsWith("."))) {
    return "it has a path component beginning with a dot, and a pull writes a method's sources, not a workspace's configuration";
  }
  const base = segments[segments.length - 1] ?? "";
  if (base === LINK_FILE_NAME) {
    return `\`${LINK_FILE_NAME}\` is the link file this tool writes last, so the pull would overwrite it and report it as written anyway`;
  }
  const extension = path.posix.extname(base).toLowerCase();
  if (extension !== ".mthds" && extension !== ".py") {
    return "it is neither a `.mthds` nor a `.py` file, and a method is made of those two";
  }
  return undefined;
}

/**
 * The name policy the SAVE side owes the PULL side — the same predicate, asked
 * before the bytes leave rather than after they come back.
 *
 * `storedNameReason` refuses a stored name the written pull will not place, and
 * it was added without a matching rule here. So a save took a caller-supplied
 * `uri` verbatim — `notes.md`, `pipelex-method.json`, `.drafts/x.mthds`, or two
 * names differing only in case — stored it, and every later
 * `mthds_get_method({ method_id, output_dir })` refused the WHOLE written arm
 * with no flag to bypass it. The bytes come back from the inline arm, so this
 * is not quite a method lost; above `MAX_INLINE_SOURCE_BYTES` it is, because
 * the inline arm withholds the content and names the written arm as the cure.
 *
 * One predicate, asked at both ends, is what stops the two from drifting again.
 */
function unwritableNames(
  entries: readonly { file: MethodFile; location: "files" | "python" }[],
): ToolError | undefined {
  const seen = new Map<string, string>();
  for (const { file, location } of entries) {
    const reason = storedNameReason(file.name);
    if (reason !== undefined) {
      return {
        class: "input_domain",
        location,
        message: `\`${file.name}\` is a name this method could not be pulled back to disk under — ${reason}.`,
        hint: "Rename the file, or give the item a uri that names it as it should be stored. A method's files are the `.mthds` and `.py` files it is made of, named relative to the bundle's root.",
        retryable: false,
      };
    }
    const folded = file.name.toLowerCase();
    const clash = seen.get(folded);
    if (clash !== undefined) {
      return {
        class: "input_domain",
        location,
        message: `\`${file.name}\` and \`${clash}\` differ only in case, so they are one destination on a case-insensitive filesystem and this method could not be pulled back to disk.`,
        hint: "Give the two files names that differ by more than case.",
        retryable: false,
      };
    }
    seen.set(folded, file.name);
  }
  return undefined;
}

function storedNameRefusal(name: string, reason: string): GetMethodResult {
  return getError("The method was not written: a stored file name may not be written here.", [
    {
      class: "runtime",
      message: `The stored method names a file this pull will not write: \`${name}\` — ${reason}.`,
      hint: "No files were written. A method's file names come from whoever saved it, and output_dir may hold more than this method; fix the name in the webapp editor, or pull without output_dir to read the sources inline.",
      retryable: false,
    },
  ]);
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
 * The mid-write failure, and the cure that actually works.
 *
 * The hint used to say "call again with the same output_dir", which the
 * ownership guard then refused as somebody else's bundle. It is true now
 * because the link file goes down first: the directory is this method's, marked
 * as an interrupted pull, and the retry is let through.
 */
function midWriteError(
  name: string,
  reason: string,
  written: readonly string[],
  linked: boolean,
): ToolError {
  const landed =
    written.length === 0
      ? "No files were written."
      : `Written before the failure: ${written.map((each) => `\`${each}\``).join(", ")}.`;
  return {
    class: "runtime",
    message: `Could not write ${name}: ${reason}. ${landed}`,
    hint: linked
      ? "The directory is linked to this method and marked as an interrupted pull, so calling again with the same output_dir resumes it once the cause is fixed. Check the directory's permissions first."
      : "The link file could not be written either, so calling again would be refused as somebody else's bundle. Check the directory's permissions, then pull into an empty directory instead.",
    retryable: linked,
  };
}

/**
 * What a pull decided to do, rather than merely whether it was allowed to.
 *
 * `link-only` is the third answer the old boolean shape could not carry: a
 * directory whose every destination already matches needs no write at all, and
 * saying so here is what keeps a pure link refresh out of `writeFile`.
 */
type PullPlan = { kind: "refuse"; error: ToolError } | { kind: "write" } | { kind: "link-only" };

/**
 * What the catalog holds besides the content being pulled — the other places
 * a local file's bytes may already be stored, so that writing over them loses
 * nothing.
 */
interface StoredElsewhere {
  /** The content being pulled: `"draft"`, or a published version's number. */
  target: number | "draft";
  /** The draft's files by name, when the pull's target is a version. */
  draft?: ReadonlyMap<string, string>;
  /** Reads a published version's files by name; `undefined` when it cannot. */
  readVersion: (version: number) => Promise<ReadonlyMap<string, string> | undefined>;
}

/**
 * What this pull should do with `output_dir` — write, refresh the link alone,
 * or refuse — and why the rule is not the codegen writer's.
 *
 * `mthds_codegen` overwrites its own stamped output because the engine owns
 * those filenames. A method's sources are the USER's files and carry no stamp,
 * so the only evidence of ownership is the link file. Hence:
 *
 *  - nothing of this method here and no bundle of anyone else's: written;
 *  - a bundle with no link, or a link naming another method: refused outright,
 *    because it is somebody else's work;
 *  - a link naming THIS method: compared destination by destination, with the
 *    three outcomes of the design's box R — identical writes nothing and only
 *    refreshes the link; different while the draft has NOT moved means the
 *    local files are work this directory never saved, so the pull is refused
 *    and says it would be lost; different AFTER the draft has moved means the
 *    tool cannot tell whose change it is looking at, so it refuses unless
 *    `overwrite` was sent — which the caller sends only after asking the user.
 *
 * A destination that is simply ABSENT is none of those three: writing it
 * destroys nothing, so it is not compared against anything. Counting it as a
 * difference told a user who had deleted one file that the directory held
 * "changes that were never saved", named the file they had deleted, and then
 * refused every pull that would have restored it, with no flag to open it.
 *
 * Nor is a destination whose local bytes the catalog already stores elsewhere
 * (see {@link storedElsewhere}): the draft's own file, when the pull brings a
 * version, or the file of the version the directory was last synced with,
 * when it brings something else. Writing over a copy of stored bytes loses
 * nothing, and without this a directory that pulled version 3 could never pull
 * the draft back, its files reading as unsaved work against an unmoved draft.
 *
 * Every refusal is `input_domain` at `output_dir` and writes nothing at all.
 */
async function planPull(
  dir: string,
  stored: MethodData,
  destinations: readonly { name: string; file: MethodFile; absolute: string }[],
  overwrite: boolean,
  link: LinkRead,
  elsewhere: StoredElsewhere,
): Promise<PullPlan> {
  if (link.kind === "unreadable") {
    return refusePull(
      `\`${LINK_FILE_NAME}\` is there but cannot be read: ${link.reason}.`,
      "Something already claims this directory. Fix or remove that file, or point output_dir at an empty directory.",
    );
  }

  if (link.kind === "none") {
    // "Is anything this pull would land on already here" — asked of the write
    // set itself, not of the top-level `.mthds` files, which is how a
    // directory holding the user's `helpers.py` or a nested bundle read as
    // empty and was written over.
    const occupied = await existingDestinations(destinations);
    if (occupied.length > 0) {
      return refusePull(
        `it already holds ${occupied.map((name) => `\`${name}\``).join(", ")} and no ${LINK_FILE_NAME}, so it is somebody else's work.`,
        "Point output_dir at an empty or dedicated directory. A directory becomes linked by being saved from, or pulled into, by these tools.",
      );
    }
    // And the other half of the same question, which asking about the write set
    // alone does not answer: a directory holding a bundle of its OWN, under
    // names this method does not use, is still somebody else's work. Landing
    // beside a stranger's `their_bundle.mthds` and then claiming the whole
    // directory with a link file is exactly what the link file exists to stop.
    const foreign = await bundleFilesIn(dir);
    if (foreign.length > 0) {
      return refusePull(
        `it already holds ${foreign.map((name) => `\`${name}\``).join(", ")} and no ${LINK_FILE_NAME}, so it is somebody else's bundle.`,
        "Point output_dir at an empty or dedicated directory. Writing this method here would leave two bundles in one directory and link it to only one of them.",
      );
    }
    return { kind: "write" };
  }

  // Compared bare: a link records the bare id, and the pull of `mt_x@3` is a
  // pull of `mt_x`.
  if (readMethodSelector(link.link.method_id).methodId !== stored.method_id) {
    return refusePull(
      `it is linked to a different method (\`${link.link.method_id}\` — ${link.link.name} on ${link.link.api_host}).`,
      "Point output_dir at a directory of its own. Overwriting another method's directory would silently replace the bundle a teammate is working on.",
    );
  }

  const local = await compareDestinations(destinations);
  const unsaved = await storedElsewhere(local.differing, link.link, elsewhere);

  if (link.link.partial_pull === true) {
    // An earlier pull of THIS method died between two files, and the failure
    // told the caller to call again — so a destination that is absent, or
    // already byte-identical, or holding bytes the catalog stores, is resumed
    // without ceremony: completing it destroys nothing.
    //
    // What the marker does NOT license is writing over bytes that have since
    // CHANGED. It says a pull was interrupted and nothing more, it is persisted
    // JSON in a file the user is told to commit — so it can be stale or planted
    // — and read as blanket authority it destroyed an edit made between the
    // failure and the retry, silently, with no flag and no mention in the
    // result.
    if (unsaved.length === 0 || overwrite) {
      return { kind: "write" };
    }
    return refusePull(
      `an earlier pull of this method was interrupted here, and ${unsaved.map((name) => `\`${name}\``).join(", ")} changed after it landed.`,
      "Resuming would overwrite those bytes. Save them with mthds_save_method, or move them aside, then pull again — or pass overwrite: true if the stored version wins.",
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
    // The draft has not moved since this directory synced, so the local
    // differences are work nobody has saved. No flag opens this: `overwrite`
    // answers "whose change is this", and here there is no question.
    return refusePull(
      `it holds changes to ${unsaved.map((name) => `\`${name}\``).join(", ")} that were never saved — the draft has not moved since this directory last synced with it.`,
      "Those edits exist only here, so pulling would destroy them. Save them with mthds_save_method, or move them aside, then pull again.",
    );
  }

  if (!overwrite) {
    // State only what was MEASURED. This used to say "both this directory and
    // the stored method have changed", which asserts a local edit nothing
    // checked: with no source hashes recorded, a directory the user never
    // touched looks exactly like this the moment a teammate saves, and the
    // message named files they had not edited as if it knew.
    return refusePull(
      `its copy of ${unsaved.map((name) => `\`${name}\``).join(", ")} differs from the stored one, and the draft has moved since this directory last synced (draft updated_at ${stored.updated_at}, last synced ${link.link.synced_updated_at}). That is what a teammate's save looks like, and it is also what a local edit looks like.`,
      "This tool records no source hashes, so it cannot tell which of the two it is looking at. Inside a git repository `git status` answers it. Ask the user, and pass overwrite: true only if they say the stored version wins.",
    );
  }

  return { kind: "write" };
}

/**
 * The differing destinations whose local bytes the catalog does NOT already
 * store — the ones a write would destroy.
 *
 * A local file equal to the draft's file of the same name is stored (a pull of
 * a version, over a directory holding the draft); so is one equal to the file
 * of the version the link says this directory was last synced with (a pull of
 * anything else, over a directory holding that version). The version is read
 * only when something is still in question, and a version that cannot be read
 * stores nothing — so this only ever narrows a refusal on evidence, and never
 * on a guess. An unreadable local file is never matched: its bytes cannot be
 * seen.
 */
async function storedElsewhere(
  differing: readonly LocalFile[],
  link: MethodLink,
  elsewhere: StoredElsewhere,
): Promise<string[]> {
  let remaining = differing.filter(
    (file) => file.content === undefined || elsewhere.draft?.get(file.name) !== file.content,
  );
  const synced = link.synced_version;
  if (remaining.length > 0 && synced !== undefined && synced !== elsewhere.target) {
    const version = await elsewhere.readVersion(synced);
    if (version !== undefined) {
      remaining = remaining.filter(
        (file) => file.content === undefined || version.get(file.name) !== file.content,
      );
    }
  }
  return remaining.map((file) => file.name);
}

function refusePull(message: string, hint: string): PullPlan {
  return { kind: "refuse", error: refuseOutputDir(message, hint) };
}

function refuseOutputDir(message: string, hint: string): ToolError {
  return {
    class: "input_domain",
    location: "output_dir",
    message: `output_dir was not written: ${message} Nothing was written.`,
    hint,
    retryable: false,
  };
}

/** A destination present on disk with bytes other than the pull's; `content` is absent when unreadable. */
interface LocalFile {
  name: string;
  content?: string;
}

/**
 * How each destination's bytes on disk stand against what would be written,
 * told apart three ways rather than two.
 *
 * It takes the destinations the write loop lands — `.py` files included —
 * rather than the `.mthds` sources alone. A comparison narrower than the write
 * is how an edited `funcs.py` passed a guard that then overwrote it.
 *
 * `missing` is separate from `differing` because they lead to opposite
 * decisions. A file that is not there holds nothing to lose, so writing it is
 * free; a file that is there and differs is work this tool cannot account for.
 * Collapsing the two told a user who had deleted one source that the directory
 * held "changes that were never saved" and then refused every pull, `overwrite`
 * included. Anything unreadable — a permission error, a directory in its place
 * — counts as differing, not missing: the bytes cannot be seen, so they must
 * not be assumed absent.
 */
interface LocalComparison {
  /** Present, and not what the pull brings — with the bytes, so they can be matched against the catalog. */
  differing: LocalFile[];
  /** Not there at all. */
  missing: string[];
}

async function compareDestinations(
  destinations: readonly { name: string; file: MethodFile; absolute: string }[],
): Promise<LocalComparison> {
  const differing: LocalFile[] = [];
  const missing: string[] = [];
  for (const destination of destinations) {
    try {
      const content = await fs.readFile(destination.absolute, "utf8");
      if (content !== destination.file.content) {
        differing.push({ name: destination.name, content });
      }
    } catch (err) {
      if (isMissingPathError(err)) {
        missing.push(destination.name);
      } else {
        differing.push({ name: destination.name });
      }
    }
  }
  return { differing, missing };
}

function emptySourceError(): GetMethodResult {
  return getError("The method was not fetched: it has no MTHDS source yet.", [
    {
      class: "input_domain",
      location: "method_id",
      message: "The stored method has no MTHDS source yet.",
      hint: "The method exists but is empty — a different answer from an unknown id, which is a 404 at this same field. Open it in the Pipelex webapp and save a bundle into it, or save one from here with mthds_save_method and this method_id.",
      retryable: false,
    },
  ]);
}

function getError(summary: string, errors: ToolError[]): GetMethodResult {
  return { structuredContent: { status: "error", errors }, summary };
}

// ── naming ──────────────────────────────────────────────────────────

/**
 * The bundle's directory, from the first file's provenance — which is what
 * `link_dir` defaults to and what every file's catalog name is relative to.
 * `undefined` for an inline-only submission, which has no directory at all.
 */
export function bundleDirectoryOf(files: readonly SubmittedFileInput[]): string | undefined {
  const first = files[0];
  if (first === undefined) {
    return undefined;
  }
  // First-match union semantics, as `resolveSubmittedFiles` applies them. It
  // reads the SUBMITTED item rather than the resolved one — the same answer,
  // since a `{ path }` item resolves to that path as its `uri` — because the
  // boundary it feeds has to be known BEFORE anything is opened.
  const label = "content" in first ? first.uri : first.path;
  if (label === undefined || label === null || label.trim() === "") {
    return undefined;
  }
  const dir = path.dirname(label);
  return dir === "" ? "." : dir;
}

/**
 * Which submitted `{ path }` items sit outside the bundle directory — asked
 * BEFORE the resolver opens any of them.
 *
 * `nameFiles` already refuses a file above the bundle directory, but it does so
 * after the bytes are in hand, which is too late for the `python` arm: that arm
 * reads a `.py` file and then UPLOADS it to the organization's catalog. The
 * extension gate bounds WHAT may be opened; this bounds WHERE, and only both
 * together close the injection vector.
 *
 * The directory that bounds a read is {@link linkDirectoryOf}'s, NOT
 * {@link bundleDirectoryOf}'s, and the difference is the whole fix. A file's
 * NAME inside the method may legitimately come from an inline item's `uri`,
 * which is documented as provenance and may be any label at all. Letting that
 * label bound a READ handed the caller the boundary: `{ content, uri:
 * "app/config/x.mthds" }` beside `{ path: "app/config/settings.py" }` declared
 * the secrets' own directory to be the bundle root, and the file went to the
 * catalog with its keys in it. Only a `{ path }` item names a directory that is
 * really there, so only a `{ path }` item may establish one — and a bundle
 * submitted inline establishes none, which makes every `{ path }` beside it a
 * refusal rather than a read.
 *
 * And the comparison is on REAL paths, not on the submitted strings. A lexical
 * `path.relative` accepts `bundle/helpers.py` whatever it points at, while the
 * resolver follows symlinks and contains only against the WORKSPACE — so
 * `bundle/helpers.py -> ../.env` cleared this gate, cleared the extension gate
 * (which reads the submitted NAME, never the resolved target), and uploaded the
 * workspace's secrets to the organization's catalog as the method's Python,
 * where nothing validates them and no delete from this tool reaches them. The
 * `python` arm is the live one for exactly that reason. Both checks are kept:
 * the lexical one names the ordinary mistake in the caller's own words, and the
 * real-path one is the boundary.
 */
async function pathsOutsideBundle(
  submitted: readonly SubmittedFileInput[] | undefined,
  bundleDir: string | undefined,
  location: "files" | "python",
  // The directory submitted paths are relative TO — the same `rootDir` the
  // resolver was built with, which `buildLocalToolContexts` takes from one
  // argument for both. Resolving against `process.cwd()` instead would compare
  // real paths that are not the ones the resolver will open, and on any root
  // but the process's own it would find nothing and quietly check nothing.
  // Absent, there is no resolver either and every `{ path }` is refused below.
  base: string | undefined,
): Promise<ToolError[]> {
  if (submitted === undefined) {
    return [];
  }
  const errors: ToolError[] = [];
  // Resolved once. When the directory is not on disk there is nothing to
  // contain anything, and every `{ path }` under it fails the resolver's own
  // "File not found" — so the lexical answer stands alone rather than inventing
  // a second refusal for a directory that was never there.
  const bundleReal =
    bundleDir === undefined || base === undefined
      ? undefined
      : await realPathOrUndefined(path.resolve(base, bundleDir));
  for (const [index, item] of submitted.entries()) {
    // The resolver reports a blank path and an unreadable one for itself.
    if ("content" in item || item.path.trim() === "") {
      continue;
    }
    if (bundleDir === undefined) {
      errors.push({
        class: "input_domain",
        location: `${location}[${index}].path`,
        message: `\`${item.path}\` has no bundle directory to sit under: the first submitted file is inline, so nothing names a directory on disk.`,
        hint: "Submit the bundle's root file as a { path } item, which is what establishes the directory the others are read from — or send this file inline too. A uri is provenance for diagnostics and never decides what may be opened.",
        retryable: false,
      });
      continue;
    }
    const relative = toPosix(path.relative(bundleDir, item.path));
    if (relative === "" || relative.startsWith("../")) {
      errors.push({
        class: "input_domain",
        location: `${location}[${index}].path`,
        message: `\`${item.path}\` is outside the bundle directory \`${bundleDir}\`, so it is not part of this method.`,
        hint: "Every submitted file must live at or under the directory of the first one, which is the bundle's root. Move it in, or submit the bundle from its own directory.",
        retryable: false,
      });
      continue;
    }
    if (bundleReal === undefined) {
      continue;
    }
    const itemReal =
      base === undefined ? undefined : await realPathOrUndefined(path.resolve(base, item.path));
    if (itemReal === undefined) {
      // Missing, or unreadable for a reason of its own. The resolver reports
      // both for itself, in the words it has always used.
      continue;
    }
    if (!isInsideRoot(bundleReal, itemReal)) {
      errors.push({
        class: "input_domain",
        location: `${location}[${index}].path`,
        message: `\`${item.path}\` resolves to \`${itemReal}\`, which is outside the bundle directory \`${bundleDir}\`. A symlink does not make a file part of the method.`,
        hint: "Every submitted file must REALLY live at or under the directory of the bundle's root file. Copy the file into the bundle if it belongs to the method, or send its contents inline as { content, uri? }.",
        retryable: false,
      });
    }
  }
  return errors;
}

/** The real path, or `undefined` when there is not one to have. */
async function realPathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch {
    return undefined;
  }
}

/** What a directory says about itself before anything is written to the catalog. */
type DirectoryClaim =
  | { kind: "link"; dir: string; link: MethodLink }
  | { kind: "unreadable"; dir: string; reason: string };

/**
 * What a directory already claims, read WITHOUT creating anything.
 *
 * `resolveSaveDir` is the write path's routine and it makes the directory it
 * contains; this question is asked before a create, where making a directory in
 * order to decide whether to refuse would be a side effect of a refusal. So the
 * path is contained lexically, what is there is read, and anything that cannot
 * be resolved answers `undefined` — the link write that follows asks again with
 * the real routine and reports its own refusal.
 *
 * `unreadable` is kept rather than folded into `undefined`, and that IS the
 * question the create arm asks. `readMethodLink` reports a malformed, truncated
 * or symlinked link file as `unreadable` precisely because something claims the
 * directory; flattening it to "no link" let the create run, mint a second
 * method, and only then have the link write refuse — the very ordering the
 * create arm's own comment says was fixed, and a duplicate this tool cannot
 * delete. Not knowing whether a directory is claimed is not the same as knowing
 * it is free.
 */
async function linkedMethodAt(
  context: CatalogWriteContext,
  requested: string | undefined,
): Promise<DirectoryClaim | undefined> {
  if (requested === undefined || context.saveRoot === undefined) {
    return undefined;
  }
  const absolute = path.resolve(context.saveRoot, requested);
  if (absolute !== context.saveRoot && !isInsideRoot(context.saveRoot, absolute)) {
    return undefined;
  }
  const read = await readMethodLink(absolute);
  if (read.kind === "none") {
    return undefined;
  }
  const relative = path.relative(context.saveRoot, absolute);
  const dir = relative === "" ? "." : relative;
  return read.kind === "link"
    ? { kind: "link", dir, link: read.link }
    : { kind: "unreadable", dir, reason: read.reason };
}

/**
 * The directory the link file goes in when no `link_dir` was given — and the
 * reason it is NOT {@link bundleDirectoryOf}.
 *
 * The two look like the same question and are not. `bundleDirectoryOf` reads
 * the resolved `uri`, which is the right base for a file's NAME inside the
 * method: an inline item may legitimately carry `sub/x.mthds` as provenance and
 * be named for it. But `uri` is documented as provenance for diagnostics and
 * may be any label at all, so using it as a DIRECTORY meant a caller sending
 * `uri: "memory://draft.mthds"` had a directory called `memory:` created in
 * their workspace, and `uri: "bundle.mthds"` put the link at the workspace root
 * where it could replace an unrelated one. Only a `{ path }` item names a real
 * directory, which is also what SPEC.md's rule says: an inline-only submission
 * with no `link_dir` writes no link file.
 */
export function linkDirectoryOf(files: readonly SubmittedFileInput[]): string | undefined {
  const first = files[0];
  // First-match union semantics, as `resolveSubmittedFiles` applies them.
  if (first === undefined || "content" in first || first.path.trim() === "") {
    return undefined;
  }
  const dir = path.dirname(first.path);
  return dir === "" ? "." : dir;
}

type NamedFiles = { ok: true; files: MethodFile[] } | { ok: false; error: ToolError };

/**
 * Name each resolved file for the catalog: its path relative to the bundle
 * directory, root file first, which is what makes a method saved from here open
 * in the webapp's editor as the same files.
 *
 * A file ABOVE the bundle directory is refused rather than flattened: its
 * relative name would start with `..`, which is not a path the catalog or a
 * later pull can place, and flattening it would silently collide two files with
 * the same basename.
 */
function nameFiles(
  files: readonly SubmittedFile[],
  bundleDir: string | undefined,
  fallbackStem: string,
  extension: string,
  // The caller's own argument, so a refusal locates at the field the caller
  // actually sent. Hard-coding `files` here made a stray `.py` file blame the
  // bundle the caller had got right.
  location: "files" | "python",
): NamedFiles {
  const named: MethodFile[] = [];
  for (const [index, file] of files.entries()) {
    const uri = file.uri ?? undefined;
    if (uri === null || uri === undefined || uri.trim() === "") {
      named.push({
        name: index === 0 ? `${fallbackStem}${extension}` : `${fallbackStem}-${index}${extension}`,
        content: file.content,
      });
      continue;
    }
    if (bundleDir === undefined) {
      named.push({ name: path.posix.basename(toPosix(uri)), content: file.content });
      continue;
    }
    const relative = toPosix(path.relative(bundleDir, uri));
    if (relative === "" || relative.startsWith("../")) {
      return {
        ok: false,
        error: {
          class: "input_domain",
          location,
          message: `\`${uri}\` is outside the bundle directory \`${bundleDir}\`, so it has no name inside the method.`,
          hint: "Every submitted file must live at or under the directory of the first one, which is the bundle's root. Move it in, or submit the bundle from its own directory.",
          retryable: false,
        },
      };
    }
    named.push({ name: relative, content: file.content });
  }
  return { ok: true, files: named };
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/** A filesystem-safe stem for a method whose stored source carries no file names. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "method" : slug;
}

// ── tool results ────────────────────────────────────────────────────

export function saveMethodToolResult(result: SaveMethodResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(
      result.summary,
      result.structuredContent.status === "error" ? result.structuredContent.errors : undefined,
    ),
    isError: result.structuredContent.status === "error",
  };
}

export function getMethodToolResult(result: GetMethodResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(
      result.summary,
      result.structuredContent.status === "error" ? result.structuredContent.errors : undefined,
    ),
    isError: result.structuredContent.status === "error",
  };
}
