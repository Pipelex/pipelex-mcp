import { promises as fs } from "node:fs";
import path from "node:path";

import { EmptyMethodSourceError } from "@pipelex/sdk";
import type { MethodData, MethodWriteInput } from "@pipelex/sdk";
import type { MethodFile } from "mthds/protocol";
import { parseMethodFiles, serializeMethodFiles } from "mthds/protocol";
import { z } from "zod";

import {
  LINK_FILE_NAME,
  apiHostOf,
  buildMethodLink,
  bundleFilesIn,
  containedInDir,
  existingDestinations,
  foreignEntryReason,
  readMethodLink,
  writeMethodLink,
} from "./catalog-link.js";
import type { LinkFileReport, LinkRead, MethodLink } from "./catalog-link.js";
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
import {
  checkDeepestExistingAncestor,
  errorMessage,
  isInsideRoot,
  isMissingPathError,
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
  unmanaged: z.array(z.string()).optional(),
  unmanaged_truncated: z.boolean().optional(),
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

/** The narrow SDK seam these tools call (test seam). */
export interface CatalogWriteClient {
  getMethod(methodId: string): Promise<MethodData>;
  createMethod(input: MethodWriteInput): Promise<MethodData>;
  updateMethod(methodId: string, input: MethodWriteInput): Promise<MethodData>;
}

export interface CatalogWriteContext extends ApiConfig {
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
  return context.client ?? createPipelexApiClient(context);
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

  // Read ONCE, before either arm touches the catalog, because both arms are
  // irreversible in the same way: a create that ran first left a duplicate, an
  // update that ran first left a different method overwritten, and per SPEC.md
  // delete is admin-only so neither is something the caller can undo.
  const claim = await linkedMethodAt(context, parsed.data.link_dir ?? linkDir);

  if (parsed.data.method_id === undefined) {
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
              hint: `Pass method_id: "${claim.link.method_id}" to update the method this directory is linked to, or point link_dir at a directory of its own to create a genuinely new method.`,
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
    // The create arm reads the link BEFORE creating because a duplicate cannot
    // be undone; this arm has the same irreversibility and did not have the
    // check. A method_id read from the wrong place, or a stale one pasted by a
    // user, updated that method with THIS directory's bundle and name, and only
    // afterwards did the link write report the mismatch — leaving the wrong
    // method overwritten, the directory still linked to the right one, and no
    // version in the catalog to restore. The mismatch costs one local file read
    // to see, and that read is already in hand.
    if (claim?.kind === "link" && claim.link.method_id !== parsed.data.method_id) {
      return saveError("The method was not saved: that directory is linked to another method.", [
        {
          class: "input_domain",
          location: "method_id",
          message: `\`${claim.dir}\` is linked to \`${claim.link.method_id}\` (${claim.link.name} on ${claim.link.api_host}), but this call names method_id \`${parsed.data.method_id}\`. Saving would have overwritten a different method with this directory's bundle and name, and the catalog keeps no earlier version to restore.`,
          hint: `Pass method_id: "${claim.link.method_id}" to update the method this directory is linked to. If you really mean to save this bundle as \`${parsed.data.method_id}\`, point link_dir at a directory of its own so the two stop sharing one link file.`,
          retryable: false,
        },
      ]);
    }

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

  return { structuredContent, summary: saveSummary(structuredContent, claim?.kind === "link") };
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

  return writeMethodLink(target.root, target.dir, buildMethodLink(fields));
}

function saveSummary(result: SaveMethodSuccess, linkedAnyway: boolean): string {
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
  // The pull path learned this first: saying "NOT linked" about a linked
  // directory was the worst of the three answers, because it told the caller to
  // pass a method_id they did not need — and the id it named was this method,
  // about a directory whose surviving link names another. Following that advice
  // overwrote the teammate's method. The save path kept the two-way version;
  // this is the pull path's three-way answer, said here too.
  lines.push(
    result.link_file.written
      ? `Linked by \`${result.link_file.path}\` — commit it, so a teammate updates this same method instead of creating a second one.`
      : linkedAnyway
        ? `The directory IS linked to this method, but \`${result.link_file.path}\` could not be refreshed (${result.link_file.reason}), so it still records an out-of-date synced_updated_at. Fix that and save again; a save from here still updates this method.`
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
  const claimed = new Map<string, string>();
  for (const file of all) {
    const absolute = containedInDir(dir, file.name);
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
  const plan = await planPull(dir, stored, destinations, input.overwrite === true, link);
  if (plan.kind === "refuse") {
    return getError("The method was not written: output_dir holds work this pull would lose.", [
      plan.error,
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
    // retry this failure advertises impossible to perform. It is rewritten
    // without the marker once every file has landed.
    provisional = await writeMethodLink(
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
    method_id: stored.method_id,
    name: stored.name,
    updated_at: stored.updated_at,
    api_host: apiHost,
    files: sources.map(project),
    python: python.map(project),
    output_dir: relativeDir,
    link_file: linkFile,
    ...(unmanaged.length === 0 ? {} : { unmanaged }),
    ...(unmanagedComplete ? {} : { unmanaged_truncated: true }),
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
  // What a failed link write means depends on what is already on disk, and
  // saying "NOT linked" about a linked directory was the worst of the three: it
  // told the caller to pass a method_id they did not need, about a directory
  // that would have updated the right method on its own. A link this pull wrote
  // provisionally still carries the interrupted-pull marker, and one written by
  // an earlier pull still carries that pull's synced_updated_at — neither is
  // the refresh this pull owed, and both leave the directory linked.
  const linkedAnyway = provisional?.written === true || link.kind === "link";
  lines.push(
    linkFile.written
      ? `Linked by \`${linkFile.path}\` — commit it, so a save from this directory updates this method instead of creating a second one.`
      : linkedAnyway
        ? `The files are written and the directory IS linked to this method, but \`${linkFile.path}\` could not be refreshed (${linkFile.reason}), so it still records an out-of-date synced_updated_at${provisional?.written === true ? " and this pull's interrupted-pull marker" : ""}. Fix that and pull again; a save from here still updates this method.`
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
 * What a pull decided to do, rather than merely whether it was allowed to.
 *
 * `link-only` is the third answer the old boolean shape could not carry: a
 * directory whose every destination already matches needs no write at all, and
 * saying so here is what keeps a pure link refresh out of `writeFile`.
 */
type PullPlan = { kind: "refuse"; error: ToolError } | { kind: "write" } | { kind: "link-only" };

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
 *    refreshes the link; different while the stored method has NOT moved means
 *    the local files are work this directory never saved, so the pull is
 *    refused and says it would be lost; different AFTER the stored method has
 *    moved means the tool cannot tell whose change it is looking at, so it
 *    refuses unless `overwrite` was sent — which the caller sends only after
 *    asking the user.
 *
 * A destination that is simply ABSENT is none of those three: writing it
 * destroys nothing, so it is not compared against anything. Counting it as a
 * difference told a user who had deleted one file that the directory held
 * "changes that were never saved", named the file they had deleted, and then
 * refused every pull that would have restored it, with no flag to open it.
 *
 * Every refusal is `input_domain` at `output_dir` and writes nothing at all.
 */
async function planPull(
  dir: string,
  stored: MethodData,
  destinations: readonly { name: string; file: MethodFile; absolute: string }[],
  overwrite: boolean,
  link: LinkRead,
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

  if (link.link.method_id !== stored.method_id) {
    return refusePull(
      `it is linked to a different method (\`${link.link.method_id}\` — ${link.link.name} on ${link.link.api_host}).`,
      "Point output_dir at a directory of its own. Overwriting another method's directory would silently replace the bundle a teammate is working on.",
    );
  }

  const local = await compareDestinations(destinations);

  if (link.link.partial_pull === true) {
    // An earlier pull of THIS method died between two files, and the failure
    // told the caller to call again — so a destination that is absent, or
    // already byte-identical, is resumed without ceremony: what is there came
    // from the catalog moments ago and completing it destroys nothing.
    //
    // What the marker does NOT license is writing over bytes that have since
    // CHANGED. It says a pull was interrupted and nothing more, it is persisted
    // JSON in a file the user is told to commit — so it can be stale or planted
    // — and read as blanket authority it destroyed an edit made between the
    // failure and the retry, silently, with no flag and no mention in the
    // result.
    if (local.differing.length === 0 || overwrite) {
      return { kind: "write" };
    }
    return refusePull(
      `an earlier pull of this method was interrupted here, and ${local.differing.map((name) => `\`${name}\``).join(", ")} changed after it landed.`,
      "Resuming would overwrite those bytes. Save them with mthds_save_method, or move them aside, then pull again — or pass overwrite: true if the stored version wins.",
    );
  }

  if (local.differing.length === 0) {
    if (local.missing.length === 0) {
      // Identical: nothing is written, and only the link's synced_updated_at
      // moves.
      return { kind: "link-only" };
    }
    // Absent destinations only. Nothing here is lost by writing them.
    return { kind: "write" };
  }

  if (link.link.synced_updated_at === stored.updated_at) {
    // The stored method has not moved since this directory synced, so the local
    // differences are work nobody has saved. No flag opens this: `overwrite`
    // answers "whose change is this", and here there is no question.
    return refusePull(
      `it holds changes to ${local.differing.map((name) => `\`${name}\``).join(", ")} that were never saved — the stored method has not moved since this directory last synced with it.`,
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
      `its copy of ${local.differing.map((name) => `\`${name}\``).join(", ")} differs from the stored one, and the stored method has moved since this directory last synced (stored updated_at ${stored.updated_at}, last synced ${link.link.synced_updated_at}). That is what a teammate's save looks like, and it is also what a local edit looks like.`,
      "This tool records no source hashes, so it cannot tell which of the two it is looking at. Inside a git repository `git status` answers it. Ask the user, and pass overwrite: true only if they say the stored version wins.",
    );
  }

  return { kind: "write" };
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
  /** Present, and not what the catalog holds. */
  differing: string[];
  /** Not there at all. */
  missing: string[];
}

async function compareDestinations(
  destinations: readonly { name: string; file: MethodFile; absolute: string }[],
): Promise<LocalComparison> {
  const differing: string[] = [];
  const missing: string[] = [];
  for (const destination of destinations) {
    try {
      if ((await fs.readFile(destination.absolute, "utf8")) !== destination.file.content) {
        differing.push(destination.name);
      }
    } catch (err) {
      (isMissingPathError(err) ? missing : differing).push(destination.name);
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
