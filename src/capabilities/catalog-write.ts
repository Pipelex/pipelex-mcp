import { promises as fs } from "node:fs";
import path from "node:path";

import { EmptyMethodSourceError, PipelexApiClient } from "@pipelex/sdk";
import type { MethodData, MethodWriteInput } from "@pipelex/sdk";
import type { MethodFile } from "mthds/protocol";
import { parseMethodFiles, serializeMethodFiles } from "mthds/protocol";
import { z } from "zod";

import {
  LINK_FILE_NAME,
  apiHostOf,
  buildMethodLink,
  containedInDir,
  existingDestinations,
  foreignEntryReason,
  readMethodLink,
  writeMethodLink,
} from "./catalog-link.js";
import type { LinkFileReport, LinkRead } from "./catalog-link.js";
import {
  buildApiConfig,
  classifyError,
  filesInputSchema,
  resolveSubmittedFiles,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
} from "./shared.js";
import type {
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
import {
  checkDeepestExistingAncestor,
  errorMessage,
  isInsideRoot,
  resolveSaveDir,
} from "./workspace-boundary.js";

/**
 * The catalog's write half — `mthds_save_method` and `mthds_get_method`, both
 * registered on the local workshop only.
 *
 * They complete the loop `mthds_list_methods` opened: the listing says which
 * methods exist, and these two say what a method *is* and let a workshop
 * session change it. The per-shell split is not the `output_dir` precedent
 * widened — `mthds_codegen` advertises its write argument on both shells
 * because writing is optional there, whereas here the filesystem is not
 * optional on either side. A console save would submit files the console
 * rejects and would leave no link file, so the next save would duplicate the
 * method: a materially different act under the same name, which is the one
 * invariant the per-shell split exists to protect.
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
    .describe(
      "The catalog name. Required on a create AND on an update, because the platform's write rewrites the whole row; on an update a name different from the stored one IS the rename gesture.",
    ),
  method_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absent creates a new method; present updates THAT method. There is no create/update flag — the difference is the presence of this one argument.",
    ),
  python: pythonFilesInputSchema.optional(),
  expected_updated_at: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The stored updated_at this save believes it is overwriting. Given, the tool reads the method first and refuses the save when it has moved, writing nothing. The check is best-effort, not atomic: the platform offers no compare-and-swap, so a save landing between that read and the write is still overwritten. Ignored on a create.",
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
  method_id: z.string().min(1).describe("The registered method's catalog id (mt_…)."),
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

export const mthdsSaveMethodOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean().optional(),
  is_runnable: z.boolean().optional(),
  pending_signatures: z.array(z.string()).optional(),
  method_id: z.string().optional(),
  name: z.string().optional(),
  saved: z.enum(["created", "updated", "renamed"]).optional(),
  updated_at: z.string().optional(),
  api_host: z.string().optional(),
  link_file: linkFileSchema.optional(),
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
  updated_at: z.string().optional(),
  api_host: z.string().optional(),
  files: z.array(sourceFileSchema).optional(),
  python: z.array(sourceFileSchema).optional(),
  output_dir: z.string().optional(),
  link_file: linkFileSchema.optional(),
  truncated: z.boolean().optional(),
  errors: z.array(toolErrorSchema).optional(),
});

// ── TypeScript surfaces ─────────────────────────────────────────────

export interface MthdsSaveMethodInput {
  files: SubmittedFileInput[];
  name: string;
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
  api_host?: string;
  link_file?: LinkFileReport;
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
  updated_at: string;
  api_host: string;
  files: SourceFile[];
  python: SourceFile[];
  output_dir?: string;
  link_file?: LinkFileReport;
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

/** The narrow SDK seam these tools call (test seam). */
export interface CatalogWriteClient {
  getMethod(methodId: string): Promise<MethodData>;
  createMethod(input: MethodWriteInput): Promise<MethodData>;
  updateMethod(methodId: string, input: MethodWriteInput): Promise<MethodData>;
}

export interface CatalogWriteContext {
  baseUrl: string;
  apiKey?: string;
  client?: CatalogWriteClient;
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

function catalogWriteClient(context: CatalogWriteContext): CatalogWriteClient {
  return (
    context.client ?? new PipelexApiClient({ baseUrl: context.baseUrl, apiKey: context.apiKey })
  );
}

// ── error options ───────────────────────────────────────────────────

const CREATE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/methods",
  badRequest: {
    location: "files",
    hint: "The API rejected the method payload. Check that the bundle validates and that name is non-empty; if the error mentions organization context, mint a key in the intended organization.",
  },
};

const UPDATE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/methods/{id}",
  badRequest: {
    location: "method_id",
    hint: "The API rejected the update. Check the method_id as the catalog returned it; if the error mentions organization context, mint a key in the intended organization.",
  },
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. The catalog is org-scoped, so a method from another organization reads exactly like a miss — check the api_host recorded in pipelex-method.json against the API this server is configured for.",
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
        hint: "Send files (root file first) and a non-empty name; add method_id to update an existing method.",
        retryable: false,
      })),
    );
  }

  // Resolve ONCE. The bytes that are validated are the bytes that are saved:
  // splitting the two — validate in the skill, save in a second call — would
  // read the files twice and the saved bytes would not be provably the
  // validated ones.
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

  const bundleDir = bundleDirectoryOf(bundle.files);
  // Where the link file may go is a different question from what the files are
  // NAMED relative to — see {@link linkDirectoryOf}.
  const linkDir = linkDirectoryOf(parsed.data.files);
  const named = nameFiles(bundle.files, bundleDir, "method", ".mthds", "files");
  if (!named.ok) {
    return saveError("The method was not saved: request input is invalid.", [named.error]);
  }
  const namedPython =
    python === undefined ? undefined : nameFiles(python.files, bundleDir, "funcs", ".py", "python");
  if (namedPython !== undefined && !namedPython.ok) {
    return saveError("The method was not saved: request input is invalid.", [namedPython.error]);
  }

  // Validate through the same capability mthds_validate uses, on the resolved
  // bytes (already inline, so the validate leg re-reads nothing).
  const verdict = await validateMthds({ files: bundle.files }, context.validation);
  const validation = verdict.structuredContent;
  if (validation.status === "error") {
    return saveError(
      "The method was not saved: the bundle produced no validation verdict.",
      validation.errors ?? [],
    );
  }
  if (!validation.is_valid) {
    // An invalid bundle is a produced verdict, not a no-verdict: `status: "ok"`
    // discriminated on `is_valid`, and NOTHING is written anywhere.
    return {
      structuredContent: {
        status: "ok",
        is_valid: false,
        is_runnable: validation.is_runnable,
        pending_signatures: validation.pending_signatures,
        ...(validation.validation_errors === undefined
          ? {}
          : { validation_errors: validation.validation_errors }),
      },
      summary:
        "The bundle is NOT valid, so nothing was saved and the catalog is unchanged. " +
        "Fix the validation errors and call mthds_save_method again — the same call validates and saves.",
    };
  }

  const writeInput: MethodWriteInput = {
    name: parsed.data.name,
    mthds: serializeMethodFiles(named.files),
    // Omitted preserves the stored Python; [] clears it; a non-empty set
    // replaces it. The tool never merges, and a bundle with no .py file sends
    // nothing — so a save from a directory the user has not changed cannot
    // silently erase stored Python.
    ...(namedPython === undefined ? {} : { python: namedPython.files }),
  };

  const client = catalogWriteClient(context);
  let stored: MethodData;
  let saved: "created" | "updated" | "renamed";

  if (parsed.data.method_id === undefined) {
    let created: MethodData;
    try {
      created = await client.createMethod(writeInput);
    } catch (err) {
      return saveError(
        summaryForToolError(
          classifyError(err, { ...CREATE_ERROR_OPTIONS, auth: context.authError }),
          SAVE_ERROR_SUMMARIES,
        ),
        [
          notRetryableCreate(
            classifyError(err, { ...CREATE_ERROR_OPTIONS, auth: context.authError }),
          ),
        ],
      );
    }
    stored = created;
    saved = "created";
  } else {
    // The read comes first and does double duty: it is the expected_updated_at
    // check, and it carries `input_data` forward. The platform's PUT rewrites
    // the whole row and keeps only `python` on omission, so an update that
    // omitted input_data would erase the form inputs a webapp user had saved.
    //
    // The check is CHECK-THEN-ACT, and cannot be anything else here: the
    // platform offers no compare-and-swap (`MethodWriteInput` carries no
    // version, `updateMethod` sends no `If-Match`), so a save that lands
    // between this read and the PUT below is overwritten. The window is small
    // and the tool says so rather than promising an atomicity it does not have.
    let previous: MethodData;
    try {
      previous = await client.getMethod(parsed.data.method_id);
    } catch (err) {
      const error = classifyError(err, { ...UPDATE_ERROR_OPTIONS, auth: context.authError });
      return saveError(summaryForToolError(error, SAVE_ERROR_SUMMARIES), [error]);
    }

    if (
      parsed.data.expected_updated_at !== undefined &&
      previous.updated_at !== parsed.data.expected_updated_at
    ) {
      return saveError(
        "The method was not saved: it has changed since this directory last synced with it.",
        [
          {
            class: "input_domain",
            location: "expected_updated_at",
            message: `The stored method was last updated at ${previous.updated_at}, not ${parsed.data.expected_updated_at}. Nothing was written.`,
            hint: "Somebody else saved this method since this directory synced. Pull it with mthds_get_method to see their version, then decide what to keep — or save again without expected_updated_at to overwrite it knowingly.",
            retryable: false,
          },
        ],
      );
    }

    try {
      stored = await client.updateMethod(parsed.data.method_id, {
        ...writeInput,
        input_data: previous.input_data,
      });
    } catch (err) {
      const error = classifyError(err, { ...UPDATE_ERROR_OPTIONS, auth: context.authError });
      return saveError(summaryForToolError(error, SAVE_ERROR_SUMMARIES), [error]);
    }
    saved = previous.name === parsed.data.name ? "updated" : "renamed";
  }

  const apiHost = apiHostOf(context.baseUrl);
  const linkFile = await writeLinkForSave(context, parsed.data.link_dir, linkDir, {
    apiHost,
    methodId: stored.method_id,
    name: stored.name,
    syncedUpdatedAt: stored.updated_at,
  });

  const structuredContent: SaveMethodSuccess = {
    status: "ok",
    is_valid: true,
    is_runnable: validation.is_runnable,
    pending_signatures: validation.pending_signatures,
    method_id: stored.method_id,
    name: stored.name,
    saved,
    updated_at: stored.updated_at,
    api_host: apiHost,
    ...(linkFile === undefined ? {} : { link_file: linkFile }),
  };

  return { structuredContent, summary: saveSummary(structuredContent) };
}

/**
 * A create whose response was lost cannot be replayed safely: `POST /v1/methods`
 * honours an `Idempotency-Key` and `@pipelex/sdk` exposes no way to send one, so
 * the retry mints a SECOND method under the same name. A create-side transport
 * fault is therefore reported as not retryable, with the cure that does work.
 * An update has no such hazard — `PUT` is idempotent by construction — so its
 * faults keep whatever `classifyError` decided.
 *
 * When the SDK gains the key, this function goes.
 */
function notRetryableCreate(error: ToolError): ToolError {
  if (!error.retryable) {
    return error;
  }
  return {
    ...error,
    retryable: false,
    hint: `${error.hint} This was a CREATE, and it must not be retried blindly: the API accepts an idempotency key but the SDK cannot send one, so a create whose response was lost would be minted twice. List the catalog with mthds_list_methods first — if the method is there, save again with its method_id, which updates.`,
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
  // directory would update this new method instead of theirs.
  const existing = await readMethodLink(target.dir);
  if (existing.kind === "link" && existing.link.method_id !== fields.methodId) {
    return {
      path: path.relative(target.root, path.join(target.dir, LINK_FILE_NAME)),
      written: false,
      reason: `it is already linked to a different method (\`${existing.link.method_id}\` — ${existing.link.name} on ${existing.link.api_host}), and re-pointing it would send a teammate's next save to this method instead of theirs`,
    };
  }

  return writeMethodLink(target.root, target.dir, buildMethodLink(fields));
}

function saveSummary(result: SaveMethodSuccess): string {
  const verb =
    result.saved === "created" ? "created" : result.saved === "renamed" ? "renamed" : "updated";
  const lines = [
    `Method **${result.name}** ${verb} on ${result.api_host} (method_id: \`${result.method_id}\`, updated_at ${result.updated_at}).`,
  ];

  if (result.is_runnable === false) {
    const pending = result.pending_signatures ?? [];
    lines.push(
      pending.length === 0
        ? "The bundle is valid but does not run yet."
        : `The bundle is valid but does not run yet — these signatures are still pending: ${pending.map((ref) => `\`${ref}\``).join(", ")}.`,
    );
  }

  if (result.link_file === undefined) {
    return lines.join("\n");
  }
  lines.push(
    result.link_file.written
      ? `Linked by \`${result.link_file.path}\` — commit it, so a teammate updates this same method instead of creating a second one.`
      : `The directory is NOT linked (${result.link_file.reason}), so the next save would create a SECOND method unless it passes method_id \`${result.method_id}\`.`,
  );
  return lines.join("\n");
}

function saveError(summary: string, errors: ToolError[]): SaveMethodResult {
  return { structuredContent: { status: "error", errors }, summary };
}

// ── mthds_get_method ────────────────────────────────────────────────

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

  let stored: MethodData;
  try {
    stored = await catalogWriteClient(context).getMethod(parsed.data.method_id);
  } catch (err) {
    if (err instanceof EmptyMethodSourceError) {
      return emptySourceError();
    }
    const error = classifyError(err, { ...GET_ERROR_OPTIONS, auth: context.authError });
    return getError(summaryForToolError(error, GET_ERROR_SUMMARIES), [error]);
  }

  const sources = storedSourceFiles(stored);
  if (sources.length === 0) {
    // The row exists but has no runnable source yet — a produced failure, and a
    // different answer from "no such method", which is a 404 at the same field.
    return emptySourceError();
  }
  const python = (stored.python ?? []).filter((file) => file.content.trim() !== "");
  const apiHost = apiHostOf(context.baseUrl);

  if (parsed.data.output_dir === undefined) {
    return inlineResult(stored, sources, python, apiHost);
  }
  return writtenResult(context, parsed.data, stored, sources, python, apiHost);
}

/**
 * The stored source, as NAMED files.
 *
 * `MethodData.mthds` is polymorphic: the named `[{ name, content }]` array the
 * webapp editor writes, or raw `.mthds` text from before that form existed.
 * `parseMethodFiles` reads the first and throws on the second by design, and
 * the SDK's `methodSourceToContents` reads both but returns contents alone — so
 * neither hands this tool a filename on the legacy shape. A method saved from
 * this workshop is always in the named form, so the fallback below is reachable
 * only for one written before the editor existed.
 */
export function storedSourceFiles(stored: MethodData): MethodFile[] {
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
function nameIsSynthesized(stored: MethodData): boolean {
  try {
    parseMethodFiles(stored.mthds);
    return false;
  } catch {
    return stored.mthds.trim() !== "";
  }
}

function inlineResult(
  stored: MethodData,
  sources: MethodFile[],
  python: MethodFile[],
  apiHost: string,
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
    method_id: stored.method_id,
    name: stored.name,
    updated_at: stored.updated_at,
    api_host: apiHost,
    files: sources.map(take),
    python: python.map(take),
    truncated,
  };

  const lines = [
    `Method **${stored.name}** on ${apiHost} (method_id: \`${stored.method_id}\`, updated_at ${stored.updated_at}): ${sources.length} .mthds file(s)${python.length === 0 ? "" : ` and ${python.length} .py file(s)`}, returned inline.`,
  ];
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
  input: { method_id: string; output_dir?: string; overwrite?: boolean },
  stored: MethodData,
  sources: MethodFile[],
  python: MethodFile[],
  apiHost: string,
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
  const all = [...sources, ...python];
  const destinations: { file: MethodFile; name: string; absolute: string }[] = [];
  for (const file of all) {
    const absolute = containedInDir(dir, file.name);
    if (absolute === undefined) {
      return getError("The method was not written: a stored file name leaves output_dir.", [
        {
          class: "runtime",
          message: `The stored method names a file that leaves the output directory: ${file.name}`,
          hint: "No files were written. A method's file names come from whoever saved it; fix the name in the webapp editor, or pull without output_dir to read the sources inline.",
          retryable: false,
        },
      ]);
    }
    destinations.push({ file, name: file.name, absolute });
  }

  const link = await readMethodLink(dir);
  const guard = await guardOutputDir(stored, destinations, input.overwrite === true, link);
  if (guard !== undefined) {
    return getError("The method was not written: output_dir holds work this pull would lose.", [
      guard,
    ]);
  }

  // `containedInDir` is lexical — it joins and compares strings. A destination
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

  // The link goes down BEFORE the files, marked `partial_pull`, so that a
  // failure between two files leaves the directory owned by this method instead
  // of looking like somebody else's bundle — which is what made the retry this
  // failure advertises impossible to perform. It is rewritten without the
  // marker once every file has landed.
  const provisional = await writeMethodLink(
    root,
    dir,
    buildMethodLink({
      apiHost,
      methodId: stored.method_id,
      name: stored.name,
      syncedUpdatedAt: link.kind === "link" ? link.link.synced_updated_at : "",
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

  const linkFile = await writeMethodLink(
    root,
    dir,
    buildMethodLink({
      apiHost,
      methodId: stored.method_id,
      name: stored.name,
      syncedUpdatedAt: stored.updated_at,
    }),
  );

  const relativeDir = path.relative(root, dir) === "" ? "." : path.relative(root, dir);
  const project = (file: MethodFile): SourceFile => ({
    name: file.name,
    bytes: utf8.encode(file.content).length,
    written_to: path.join(relativeDir, file.name),
  });

  const structuredContent: GetMethodSuccess = {
    status: "ok",
    method_id: stored.method_id,
    name: stored.name,
    updated_at: stored.updated_at,
    api_host: apiHost,
    files: sources.map(project),
    python: python.map(project),
    output_dir: relativeDir,
    link_file: linkFile,
    truncated: false,
  };

  const lines = [
    `Method **${stored.name}** written to \`${relativeDir}\` (method_id: \`${stored.method_id}\`, updated_at ${stored.updated_at} on ${apiHost}).`,
  ];
  if (nameIsSynthesized(stored)) {
    lines.push(
      `The stored method carries no file names — it predates the catalog's named form — so \`${sources[0]?.name}\` is a name this tool invented, not the method's. Rename it if you like, but the next save sends whatever name is on disk.`,
    );
  }
  lines.push(
    linkFile.written
      ? `Linked by \`${linkFile.path}\` — commit it, so a save from this directory updates this method instead of creating a second one.`
      : `The directory is NOT linked (${linkFile.reason}), so a save from it would create a SECOND method unless it passes method_id \`${stored.method_id}\`.`,
  );

  return { structuredContent, summary: lines.join("\n") };
}

/**
 * Create a destination's parent, refusing a symlinked component first.
 *
 * `mkdir -p dir/link/sub`, with `link` a symlink pointing out of `dir`, creates
 * `sub` at the link's target — so the real-path check has to run BEFORE the
 * creation, not after, where it would report an escape it had already made.
 * Same rule, same routine, as `resolveSaveDir` and `codegen-writer.ts`.
 */
async function createSubdirectory(dir: string, parent: string): Promise<string | undefined> {
  const escaped = `its directory \`${path.relative(dir, parent)}\` resolves outside output_dir`;

  const ancestor = await checkDeepestExistingAncestor(dir, parent);
  if (!ancestor.ok) {
    return ancestor.reason === "escape" ? escaped : errorMessage(ancestor.err);
  }
  try {
    await fs.mkdir(parent, { recursive: true });
    // Closes the window between the check and the creation.
    return isInsideRoot(dir, await fs.realpath(parent)) ? undefined : escaped;
  } catch (err) {
    return errorMessage(err);
  }
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
 * Whether this directory may be written into — the refusal rule, and why it is
 * not the codegen writer's.
 *
 * `mthds_codegen` overwrites its own stamped output because the engine owns
 * those filenames. A method's sources are the USER's files and carry no stamp,
 * so the only evidence of ownership is the link file. Hence:
 *
 *  - no `.mthds` file at all: written;
 *  - `.mthds` files with no link, or a link naming another method: refused
 *    outright, because it is somebody else's bundle;
 *  - a link naming THIS method: compared file by file, with the three outcomes
 *    of the design's box R — identical writes nothing and only refreshes the
 *    link; different while the stored method has NOT moved means the local
 *    files are work this directory never saved, so the pull is refused and says
 *    it would be lost; different AFTER the stored method has moved means the
 *    tool cannot tell whose change it is looking at, so it refuses unless
 *    `overwrite` was sent — which the caller sends only after asking the user.
 *
 * Every refusal is `input_domain` at `output_dir` and writes nothing at all.
 */
async function guardOutputDir(
  stored: MethodData,
  destinations: readonly { name: string; file: MethodFile; absolute: string }[],
  overwrite: boolean,
  link: LinkRead,
): Promise<ToolError | undefined> {
  if (link.kind === "unreadable") {
    return refuseOutputDir(
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
    if (occupied.length === 0) {
      return undefined;
    }
    return refuseOutputDir(
      `it already holds ${occupied.map((name) => `\`${name}\``).join(", ")} and no ${LINK_FILE_NAME}, so it is somebody else's work.`,
      "Point output_dir at an empty or dedicated directory. A directory becomes linked by being saved from, or pulled into, by these tools.",
    );
  }

  if (link.link.method_id !== stored.method_id) {
    return refuseOutputDir(
      `it is linked to a different method (\`${link.link.method_id}\` — ${link.link.name} on ${link.link.api_host}).`,
      "Point output_dir at a directory of its own. Overwriting another method's directory would silently replace the bundle a teammate is working on.",
    );
  }

  if (link.link.partial_pull === true) {
    // An earlier pull of THIS method died between two files. Whatever is here
    // came from the catalog moments ago, so completing it destroys nothing the
    // catalog does not already hold — and refusing would strand the caller,
    // since the failure told them to call again.
    return undefined;
  }

  const differing = await differingFiles(destinations);
  if (differing.length === 0) {
    // Identical: nothing is written, and only the link's synced_updated_at
    // moves. Returning undefined re-writes byte-identical files, which is the
    // same outcome for a fraction of the reasoning.
    return undefined;
  }

  if (link.link.synced_updated_at === stored.updated_at) {
    // The stored method has not moved since this directory synced, so the local
    // differences are work nobody has saved. No flag opens this: `overwrite`
    // answers "whose change is this", and here there is no question.
    return refuseOutputDir(
      `it holds changes to ${differing.map((name) => `\`${name}\``).join(", ")} that were never saved — the stored method has not moved since this directory last synced with it.`,
      "Those edits exist only here, so pulling would destroy them. Save them with mthds_save_method, or move them aside, then pull again.",
    );
  }

  if (!overwrite) {
    // State only what was MEASURED. This used to say "both this directory and
    // the stored method have changed", which asserts a local edit nothing
    // checked: with no source hashes recorded, a directory the user never
    // touched looks exactly like this the moment a teammate saves, and the
    // message named files they had not edited as if it knew.
    return refuseOutputDir(
      `its copy of ${differing.map((name) => `\`${name}\``).join(", ")} differs from the stored one, and the stored method has moved since this directory last synced (stored updated_at ${stored.updated_at}, last synced ${link.link.synced_updated_at}). That is what a teammate's save looks like, and it is also what a local edit looks like.`,
      "This tool records no source hashes, so it cannot tell which of the two it is looking at. Inside a git repository `git status` answers it. Ask the user, and pass overwrite: true only if they say the stored version wins.",
    );
  }

  return undefined;
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

/**
 * The destinations whose bytes on disk differ from what would be written; a
 * missing or unreadable file counts as differing.
 *
 * It takes the destinations the write loop landed — `.py` files included —
 * rather than the `.mthds` sources alone. A comparison narrower than the write
 * is how an edited `funcs.py` passed a guard that then overwrote it.
 */
async function differingFiles(
  destinations: readonly { name: string; file: MethodFile; absolute: string }[],
): Promise<string[]> {
  const differing: string[] = [];
  for (const destination of destinations) {
    try {
      if ((await fs.readFile(destination.absolute, "utf8")) !== destination.file.content) {
        differing.push(destination.name);
      }
    } catch {
      differing.push(destination.name);
    }
  }
  return differing;
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
export function bundleDirectoryOf(files: readonly SubmittedFile[]): string | undefined {
  const first = files[0]?.uri;
  if (first === undefined || first === null || first.trim() === "") {
    return undefined;
  }
  const dir = path.dirname(first);
  return dir === "" ? "." : dir;
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
