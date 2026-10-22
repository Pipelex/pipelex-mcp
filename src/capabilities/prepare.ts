import { InputPreparationError } from "@pipelex/sdk";
import type { MethodTreeSource, PrepareInputsRequest, PreparedInputs } from "@pipelex/sdk";
import { z } from "zod";

import { LINK_FILE_NAME, apiHostOf, readMethodLink } from "./catalog-link.js";
import {
  METHOD_ID_SELECTOR_SENTENCE,
  methodVersionReportSchema,
  methodVersionsOf,
  planById,
  selectorFailure,
  withMethodContent,
} from "./method-versions.js";
import type { MethodVersionReport, MethodVersionsAware, SelectorPlan } from "./method-versions.js";
import {
  METHOD_REF_GRAMMAR,
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
  filesSentSchema,
  inputsPathSchema,
  methodDirInputSchema,
  methodFilesInputSchema,
  resolveInputsSource,
  resolveMethodSource,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateMethodSelectorRequest,
  withFilesSent,
  failedBeforeSending,
  treeSentInlineHeavy,
  markUnsent,
} from "./shared.js";
import type {
  ApiConfig,
  AuthErrorTexture,
  BaseUrlSourceTexture,
  ClassifyErrorOptions,
  ErrorSummaries,
  FileResolver,
  MethodTreeToSend,
  SubmittedFileInput,
  ToolError,
} from "./shared.js";
import { methodTreeLimitsOf } from "./tree-limits.js";
import type { TreeLimitsAware } from "./tree-limits.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";
import { MAX_UPLOAD_BYTES, SizeGuardedPipelexApiClient, formatMib } from "./upload-ceiling.js";

/** What an upload is recorded as: a member's file, or a test input made for one method. */
export const UPLOAD_KINDS = ["uploaded", "test"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/**
 * What every upload of one preparation is recorded as, in the shape of
 * `@pipelex/sdk`'s `UploadKindOptions`: the prepare request's `upload` member,
 * which the SDK sends with each `POST /v1/upload` of the walk. A test file
 * names the bare id of the method it was made for.
 */
export interface UploadMarking {
  kind: UploadKind;
  method_id?: string;
}

export const mthdsPrepareInputsInputSchema = {
  method_dir: methodDirInputSchema("one_selector"),
  files: methodFilesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR} — the signature source. Resolved server-side (the repository is fetched at the tag); no bundle enters the conversation. Supply exactly ONE of method_dir / files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      `Catalog id (mt_…) of a registered method — the signature source, resolved server-side and requiring an API key (the catalog is org-scoped). ${METHOD_ID_SELECTOR_SENTENCE} Supply exactly ONE of method_dir / files / method_ref / method_id.`,
    ),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      "The pipe whose declared signature identifies the file-bearing inputs, as a qualified domain.pipe_code — the same value mthds_run takes as pipe_code and mthds_inputs_template as pipe_ref. Omit to default to the closure's main_pipe.",
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The caller's FILLED inputs (the mthds_inputs_template output, populated). File-bearing values are uploaded to Pipelex storage and rewritten to pipelex-storage://; http(s) URLs and existing pipelex-storage:// URIs pass through. An empty object uploads nothing. Supply exactly ONE of inputs / inputs_path.",
    ),
  inputs_path: inputsPathSchema,
  kind: z
    .enum(UPLOAD_KINDS)
    .optional()
    .describe(
      `What the files this call uploads are recorded as in the organization's files: uploaded (the default, a member's file) or test (a test input made for this method, listed as its test file). test needs the method's saved id, so name the method by method_id, or by a method_dir that ${WORKSHOP_TOOL_NAMES.saveMethod} linked to its saved method (${LINK_FILE_NAME}). Values that pass through are not uploaded and keep what they are.`,
    ),
};

const prepareStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      "Echoed only when the caller supplied it (the resolved main_pipe default is not returned).",
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The prepared (rewritten) inputs — ready to hand to mthds_run."),
  uploads: z
    .array(z.string())
    .optional()
    .describe(
      "The pipelex-storage:// uris of the assets uploaded this call; [] when all inputs pass through.",
    ),
  kind: z
    .enum(UPLOAD_KINDS)
    .optional()
    .describe("Echoed only when the caller supplied it: what the uploads were recorded as."),
  test_method_id: z
    .string()
    .optional()
    .describe(
      "With kind test: the bare id of the method the uploads were recorded as test files of.",
    ),
  method_version: methodVersionReportSchema,
  files_sent: filesSentSchema,
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsPrepareInputsOutputSchema = prepareStructuredContentSchema;

export interface MthdsPrepareInputsInput {
  method_dir?: string;
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs?: Record<string, unknown>;
  inputs_path?: string;
  kind?: UploadKind;
}

/** The prepare request once its method and `inputs_path` are resolved — what the checks and the prepare step consume. */
interface ResolvedPrepareRequest {
  /** The method's tree, from `method_dir` or `files`. */
  tree?: MethodTreeToSend;
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
  kind?: UploadKind;
}

export interface PrepareStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  inputs?: Record<string, unknown>;
  uploads?: string[];
  /** Echoed when the caller supplied it. */
  kind?: UploadKind;
  /** With `kind: "test"`: the bare id of the method the uploads are test files of. */
  test_method_id?: string;
  /** By-id calls only: the content whose signature the inputs were prepared against, when this server can tell. */
  method_version?: MethodVersionReport;
  /** Calls on a tree, from `method_dir` or `files`: every file sent. */
  files_sent?: string[];
  errors?: ToolError[];
}

export interface PrepareResult {
  structuredContent: PrepareStructuredContent;
  summary: string;
}

/**
 * The slice of `PipelexApiClient` the prepare capability calls (test seam): the
 * SDK's `prepareInputs`, handed the selector as given. Nothing here expands a
 * selector or reads a signature client-side, which is why there is no
 * `getMethodClosure` and no `pipeIo` here: the SDK reads the signature from
 * one `POST /v1/pipe-io` itself.
 */
interface PrepareClient {
  prepareInputs(
    request: PrepareInputsRequest & { upload?: UploadMarking },
  ): Promise<PreparedInputs>;
  /** `GET /v1/version`, read to learn whether a bare id names the draft or a version; optional on a test seam. */
  version?(): Promise<unknown>;
}

/**
 * `mthds_prepare_inputs` always uploads: the workshop is co-located with the
 * user's files.
 */
export interface PrepareContext extends ApiConfig, MethodVersionsAware, TreeLimitsAware {
  client?: PrepareClient;
  /** Reads `{ path }` items and `method_dir` from disk (local workshop). */
  resolver?: FileResolver;
  /** Reads `inputs_path` from disk (local workshop, `.json` only); without one `inputs_path` is refused. */
  inputsResolver?: FileResolver;
  /** Deployment-specific auth-failure texture; default env-var wording when absent. */
  authError?: AuthErrorTexture;
  /** Where the base URL came from, added to a failure at `PIPELEX_BASE_URL`; that variable alone when absent. */
  baseUrlSource?: BaseUrlSourceTexture;
}

export function buildPrepareContext(env = process.env): PrepareContext {
  return buildApiConfig(env);
}

/**
 * Name the real ceiling. `POST /v1/upload` sits behind an AWS gateway whose
 * 10 MiB request quota, divided by base64's 4/3 inflation, is the actual wall
 * — NOT the app-level 50 MiB MAX_UPLOAD_MIB, which is unreachable through the
 * public gateway and must never be quoted to a caller. Shared by all three
 * shapes: an oversize asset is the caller's input value whatever named the
 * method.
 */
const PREPARE_ASSET_TEXTURE: NonNullable<ClassifyErrorOptions["asset"]> = {
  hint: `Pipelex storage accepts uploads up to ${formatMib(MAX_UPLOAD_BYTES)}. Shrink the file, or reference it by an http(s) URL instead.`,
};

/**
 * The signature texture, and the reason every shape carries it unchanged: the
 * SDK refuses an unqualified `pipe_ref` before any request, and turns the
 * route's typed refusals of a selection (an unknown `pipe_ref`, a method that
 * settles no entry pipe, or several) into an `InputPreparationError` carrying
 * the server's reason. Each really is a question about the pipe, whatever
 * named the method — which is why it rides `preparation` rather than
 * `badRequest`, whose locator follows the selector the caller actually typed.
 */
const PREPARE_SIGNATURE_TEXTURE: NonNullable<ClassifyErrorOptions["preparation"]> = {
  location: "pipe_ref",
  hint: "Pass pipe_ref as a qualified domain.pipe_code the method declares; omitting it requires the method to settle exactly one entry pipe.",
};

/** Classify options for a files-shaped request. */
const PREPARE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/pipe-io",
  methodLocation: "files",
  // No `badRequest` override on purpose: a files request names no selector
  // field, so the default `files` locator is already right. It must NOT be the
  // signature texture, which is what it was while this tool still sent
  // `pipe_ref` to `/v1/build/inputs`: the route's refusals of a selection are
  // typed, and the SDK turns them into an `InputPreparationError`, which
  // reaches `preparation`, so a bare 400 or 422 is never about the pipe.
  preparation: PREPARE_SIGNATURE_TEXTURE,
  asset: PREPARE_ASSET_TEXTURE,
};

/**
 * Classify options for an address-shaped request — the `mthds_validate`
 * textures, since the address is resolved by the runner the same way. The
 * route fetches a package's `.mthds` files alone, so the execution-locus gate
 * does not apply and a package shipping Python prepares on any deployment, as
 * it answers on `mthds_inputs_template` and `mthds_codegen`; its run is still
 * refused at the start off a sandbox-hosted deployment. A runner too old to
 * serve `/v1/pipe-io` answers a bare 404, which the SDK reads as the
 * deployment's rather than the address's, so it keeps the missing-route arm
 * here and on the id shape.
 */
const PREPARE_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/pipe-io",
  methodLocation: "method_ref",
  badRequest: {
    location: "method_ref",
    hint: `Check the address and tag — ${METHOD_REF_GRAMMAR}. The tag must be a git tag on the repository (branches do not pin), and the ref must be resolvable by an anonymous clone.`,
  },
  preparation: PREPARE_SIGNATURE_TEXTURE,
  notFound: {
    location: "method_ref",
    hint: "The repository was fetched but holds no package matching this address by manifest identity. Check the package selector against the repository's METHODS.toml manifests.",
  },
  notImplemented: {
    location: "method_ref",
    hint: `Only address-form refs are supported (${METHOD_REF_GRAMMAR}); registry references are reserved until a method registry exists.`,
  },
  asset: PREPARE_ASSET_TEXTURE,
};

/**
 * Classify options for an id-shaped request. The hosted platform resolves the
 * id and injects the stored source before the runner sees the request, so the
 * failures are `mthds_validate`'s: an unknown or foreign-org id is a 404
 * (indistinguishable by design), and a stored method with no MTHDS source is a
 * 422 — which is where a source-less method now surfaces, the fail-fast
 * `EmptyMethodSourceError` having gone out with the client-side expansion.
 */
const PREPARE_BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/pipe-io",
  methodLocation: "method_id",
  badRequest: {
    location: "method_id",
    hint: "The stored method may have no MTHDS source yet, or this deployment may not resolve method_id on /v1/pipe-io — the selector is hosted-only (a bare pipelex-api runner has no catalog).",
  },
  preparation: PREPARE_SIGNATURE_TEXTURE,
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. Check the id as the catalog returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss.",
  },
  asset: PREPARE_ASSET_TEXTURE,
};

// Constructed inside each caught block (mirroring inputs.ts / run.ts): the SDK
// constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
export function prepareClient(context: PrepareContext): PrepareClient {
  return (
    context.client ??
    // Size-guarded: the upload walk (delegated to the SDK's prepareInputs)
    // would otherwise learn an asset is too big only from the gateway's 413,
    // after the whole payload had crossed the wire — and with a server message
    // that cannot name the real limit. See upload-ceiling.ts.
    createPipelexApiClient(context, SizeGuardedPipelexApiClient)
  );
}

export async function prepareMthdsInputs(
  input: MthdsPrepareInputsInput,
  context: PrepareContext = buildPrepareContext(),
): Promise<PrepareResult> {
  const resolution = await resolveMethodSource(input, context.resolver, "one_selector", () =>
    methodTreeLimitsOf(context, () => prepareClient(context)),
  );
  const inputsResolution = await resolveInputsSource(input, context.inputsResolver, {
    required: true,
  });
  const resolutionErrors = [...resolution.errors, ...inputsResolution.errors];
  if (resolutionErrors.length > 0) {
    return errorResult("Inputs were not prepared: request input is invalid.", resolutionErrors);
  }

  // `inputs_path` is settled into `inputs` here and goes no further: the rest
  // of the flow cannot tell a loaded file from an inline object.
  const { inputs_path: _inputsPath, method_dir: _methodDir, files: _files, ...selection } = input;
  const request: ResolvedPrepareRequest = {
    ...selection,
    ...(resolution.tree === undefined ? {} : { tree: resolution.tree }),
    inputs: inputsResolution.inputs ?? {},
  };
  const inputErrors = validatePrepareInputsRequest(request);
  if (inputErrors.length > 0) {
    return errorResult("Inputs were not prepared: request input is invalid.", inputErrors);
  }
  const marking = await uploadMarkingOf(request, context);
  if (!marking.ok) {
    return errorResult("Inputs were not prepared: request input is invalid.", [marking.error]);
  }

  return withFilesSent(await requestPreparedInputs(request, marking.upload, context), request.tree);
}

/**
 * What the request's uploads are recorded as, decided before anything is sent.
 *
 * `uploaded` is what the platform records when told nothing, so it sends
 * nothing. A test file names the method it was made for, by its bare id, and
 * the method is the one the request names: a `method_id`, its version suffix
 * dropped, since a test file is the method's whatever version it tests, or the
 * saved method a `method_dir` is linked to, read from its link file. Neither a
 * list of files nor a published address names a saved method, so a test
 * upload from one is refused here, at `kind`, rather than by the platform
 * after the method's signature was read.
 *
 * A link recorded against another API than the one this call goes to names a
 * method of another plane, which the upload would answer as unknown, so it is
 * refused too, naming both hosts.
 */
async function uploadMarkingOf(
  request: ResolvedPrepareRequest,
  context: PrepareContext,
): Promise<{ ok: true; upload?: UploadMarking } | { ok: false; error: ToolError }> {
  if (request.kind !== "test") return { ok: true };
  const refuse = (message: string, hint: string) => ({
    ok: false as const,
    error: { class: "input_domain" as const, location: "kind", message, hint, retryable: false },
  });
  if (request.method_id !== undefined) {
    const bare = request.method_id.trim().split("@")[0] ?? "";
    if (!/^[A-Za-z0-9_-]+$/.test(bare)) {
      return {
        ok: false,
        error: {
          class: "input_domain",
          location: "method_id",
          message: `method_id ${JSON.stringify(request.method_id)} names no saved method that test files could belong to.`,
          hint: `Pass a saved method's catalog id (mt_…), as ${WORKSHOP_TOOL_NAMES.listMethods} returns it.`,
          retryable: false,
        },
      };
    }
    return { ok: true, upload: { kind: "test", method_id: bare } };
  }
  const folder = request.tree?.folder;
  if (folder === undefined) {
    return refuse(
      "kind test records each upload as a test file of a saved method, and a list of files or a published address names none.",
      `Name the method by its saved id as method_id, or by a method_dir linked to its saved method (${LINK_FILE_NAME}, which ${WORKSHOP_TOOL_NAMES.saveMethod} writes); or omit kind to upload the files as the organization's own.`,
    );
  }
  const read = await readMethodLink(folder);
  switch (read.kind) {
    case "none":
      return refuse(
        "kind test records each upload as a test file of a saved method, and this method_dir is not linked to one: it holds no " +
          `${LINK_FILE_NAME}.`,
        `Save the method with ${WORKSHOP_TOOL_NAMES.saveMethod}, which links its folder, then prepare again; or omit kind to upload the files as the organization's own.`,
      );
    case "unreadable":
      return refuse(
        `The method_dir's ${LINK_FILE_NAME} cannot be read, so the saved method its test files belong to is unknown: ${read.reason}.`,
        `Repair or remove ${LINK_FILE_NAME} (a save with ${WORKSHOP_TOOL_NAMES.saveMethod} writes it again), or name the method by its saved id as method_id.`,
      );
    case "link": {
      const apiHost = apiHostOf(context.baseUrl);
      if (read.link.api_host !== apiHost) {
        return refuse(
          `The method_dir is linked to \`${read.link.method_id}\` on ${read.link.api_host}, and this call goes to ${apiHost}, where that method does not exist.`,
          `Prepare against the API the method was saved on, or save the method on ${apiHost} with ${WORKSHOP_TOOL_NAMES.saveMethod} first.`,
        );
      }
      return { ok: true, upload: { kind: "test", method_id: read.link.method_id } };
    }
  }
}

/** The SDK's `prepareInputs` for a request that passed its checks, and the projection of what it prepared. */
async function requestPreparedInputs(
  request: ResolvedPrepareRequest,
  upload: UploadMarking | undefined,
  context: PrepareContext,
): Promise<PrepareResult> {
  // Classify options follow the request's selector shape, exactly as
  // mthds_validate and mthds_codegen do — each failure locates at the field
  // that caused it.
  const classifyOptions =
    request.tree !== undefined
      ? PREPARE_ERROR_OPTIONS
      : request.method_ref !== undefined
        ? PREPARE_BY_REF_ERROR_OPTIONS
        : PREPARE_BY_ID_ERROR_OPTIONS;

  let prepared: PreparedInputs;
  let plan: SelectorPlan | undefined;
  let client: PrepareClient | undefined;
  try {
    client = prepareClient(context);
    let sent = request;
    if (request.method_id !== undefined) {
      // A bare id reads the draft on a platform that does not resolve version
      // selectors yet, and the latest published version on one that does: the
      // platform is asked beside the request, which never waits on it, and the
      // result says whose signature the inputs were prepared against
      // (`method-versions.ts`).
      plan = planById(request.method_id, methodVersionsOf(context), client, {
        needBareReport: true,
      });
      sent = { ...request, method_id: plan.send };
    }
    // Built inside the try for the same reason the client is: the selector
    // narrowing throws on its own unreachable arm, and that must classify as a
    // ToolError rather than reject the MCP handler.
    const envelope: PrepareEnvelope = {
      selector: prepareSelectorOf(sent),
      ...(request.pipe_ref === undefined ? {} : { pipe_ref: request.pipe_ref }),
      inputs: request.inputs,
      ...(upload === undefined ? {} : { upload }),
    };
    prepared = await prepareWithUpload(client, envelope);
  } catch (err) {
    // An input the storage service refuses as too large is a
    // `RejectedAssetError`, which the `asset` texture takes whatever named the
    // method; a refusal of the tree is read as about the files it sent.
    const classified = classifyError(err, {
      ...classifyOptions,
      auth: context.authError,
      baseUrlSource: context.baseUrlSource,
      methodTree: request.tree !== undefined,
      treeInline: await treeSentInlineHeavy(err, request.tree, client),
    });
    const error = await selectorFailure(err, classified, plan, methodVersionsOf(context));
    const failed = errorResult(summaryForError(error), [error]);
    // A client that could not be built, or an argument refused before
    // sending, sent no file of the tree.
    return client === undefined || failedBeforeSending(err) ? markUnsent(failed) : failed;
  }

  return await withMethodContent(
    prepareInputsResult(prepared, request.pipe_ref, { kind: request.kind, upload }),
    plan,
    "prepared the inputs against the signature of",
  );
}

/**
 * The method selector as the SDK spells it — one of the three, already proved
 * to be exactly one by {@link validatePrepareInputsRequest}. The SDK takes it
 * as-is: nothing here resolves an address or an id, the route does.
 */
type PrepareSelector = { tree: MethodTreeSource } | { method_ref: string } | { method_id: string };

function prepareSelectorOf(request: ResolvedPrepareRequest): PrepareSelector {
  if (request.tree !== undefined) {
    return { tree: request.tree.source };
  }
  if (request.method_ref !== undefined) {
    return { method_ref: request.method_ref };
  }
  if (request.method_id !== undefined) {
    return { method_id: request.method_id };
  }
  // Unreachable: `validateMethodSelectorRequest` has already refused a request
  // carrying no selector. Throwing rather than defaulting is the point — a
  // placeholder would put a blank selector on the wire if the invariant ever
  // broke, and this lands in the capability's own catch as a classified
  // no-verdict instead.
  throw new InputPreparationError(
    "Cannot prepare inputs: no method selector. Supply exactly one of method_dir, files, method_ref or method_id.",
  );
}

/** The resolved selector + pipe + filled inputs the prepare step consumes. */
interface PrepareEnvelope {
  selector: PrepareSelector;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
  /** What the walk's uploads are recorded as, when not the platform's default. */
  upload?: UploadMarking;
}

/**
 * Hand the whole request to the SDK's `prepareInputs`, selector included. Since
 * `@pipelex/sdk` 0.17.0 that call takes the method, a `method_ref` or a
 * `method_id`, and since 0.27.0 it resolves each, with the `pipe_ref` if one
 * was named, through one `POST /v1/pipe-io` for that one pipe, with no dry run
 * — which is why this repo does not expand a stored method into files before
 * calling it. The method travels as its tree, inline or by hash.
 */
function prepareWithUpload(
  client: PrepareClient,
  envelope: PrepareEnvelope,
): Promise<PreparedInputs> {
  // Spelled out per selector rather than spread-and-cast: `PrepareInputsRequest`
  // is an XOR that pins the other two members to `never`, and a cast on the one
  // call that reaches the SDK is exactly where a wrong shape would hide.
  const base = {
    ...(envelope.pipe_ref === undefined ? {} : { pipe_ref: envelope.pipe_ref }),
    inputs: envelope.inputs,
    ...(envelope.upload === undefined ? {} : { upload: envelope.upload }),
  };
  if ("tree" in envelope.selector) {
    return client.prepareInputs({ ...base, tree: envelope.selector.tree });
  }
  if ("method_ref" in envelope.selector) {
    return client.prepareInputs({ ...base, method_ref: envelope.selector.method_ref });
  }
  return client.prepareInputs({ ...base, method_id: envelope.selector.method_id });
}

export function validatePrepareInputsRequest(input: ResolvedPrepareRequest): ToolError[] {
  const errors = validateMethodSelectorRequest(input.tree !== undefined, input, {
    rule: "one_selector",
  });

  if (input.pipe_ref !== undefined && input.pipe_ref.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "pipe_ref",
      message: "pipe_ref must not be empty when supplied.",
      hint: "Pass a qualified domain.pipe_code, or omit pipe_ref to default to the closure's main_pipe.",
      retryable: false,
    });
  } else if (input.pipe_ref !== undefined) {
    const refusal = pipeRefRefusal(input.pipe_ref.trim());
    if (refusal !== undefined) errors.push(refusal);
  }

  return errors;
}

/**
 * The SDK's `prepareInputs` refuses two spellings of `pipe_ref` before any
 * request (`normalizePipeRef`): an `alias->domain.pipe_code` ref, since
 * preparation covers the method's own pipes and not a dependency package's,
 * and a bare `pipe_code`, since a request names a pipe by its qualified ref.
 * Refused here first, with the SDK's reasons, so the refusal is the tool's own
 * request error: a folder's files are then known never to have left the
 * machine, where the SDK's `InputPreparationError` cannot say whether they did.
 */
function pipeRefRefusal(pipeRef: string): ToolError | undefined {
  if (pipeRef.includes("->")) {
    return {
      class: "input_domain",
      location: "pipe_ref",
      message: `pipe_ref "${pipeRef}" names a dependency package's pipe; preparation covers the method's own pipes.`,
      hint: "Name one of the method's own pipes as domain.pipe_code, or omit pipe_ref to default to the method's main_pipe.",
      retryable: false,
    };
  }
  if (!pipeRef.includes(".")) {
    return {
      class: "input_domain",
      location: "pipe_ref",
      message: `pipe_ref must be qualified (domain.pipe_code), got the bare "${pipeRef}".`,
      hint: "Qualify the pipe with its domain, as domain.pipe_code, or omit pipe_ref to default to the method's main_pipe.",
      retryable: false,
    };
  }
  return undefined;
}

export function prepareInputsResult(
  prepared: PreparedInputs,
  pipeRef: string | undefined,
  marking: { kind?: UploadKind; upload?: UploadMarking } = {},
): PrepareResult {
  const uploads = prepared.uploads.map((record) => record.uri);
  const testMethodId = marking.upload?.kind === "test" ? marking.upload.method_id : undefined;
  return {
    structuredContent: {
      status: "ok",
      is_valid: true,
      ...(pipeRef === undefined ? {} : { pipe_ref: pipeRef }),
      inputs: prepared.inputs,
      uploads,
      ...(marking.kind === undefined ? {} : { kind: marking.kind }),
      ...(testMethodId === undefined ? {} : { test_method_id: testMethodId }),
    },
    summary: prepareSummary(pipeRef, prepared.inputs, uploads, testMethodId),
  };
}

// The build/prepare surface returns no rendered_markdown, so the summary is
// composed here. The prepared inputs are deliberately duplicated into the
// summary (the mthds_inputs_template pattern): they are the small payload the
// model must carry to mthds_run, and some hosts read prose more reliably than
// structured fields.
function prepareSummary(
  pipeRef: string | undefined,
  inputs: Record<string, unknown>,
  uploads: string[],
  testMethodId: string | undefined,
): string {
  const parts = ["# Prepared inputs"];
  if (pipeRef !== undefined) {
    parts.push(`Resolved pipe: \`${pipeRef}\``);
  }
  const recorded =
    testMethodId === undefined ? "" : `, recorded as test files of \`${testMethodId}\``;
  parts.push(
    uploads.length === 0
      ? "No assets required uploading — all inputs pass through unchanged. Hand these inputs to `mthds_run`."
      : `Uploaded ${uploads.length} asset(s) to Pipelex storage${recorded} (rewritten to \`pipelex-storage://\` references). Hand these inputs to \`mthds_run\`.`,
  );
  parts.push("```json\n" + JSON.stringify(inputs, null, 2) + "\n```");
  return parts.join("\n\n");
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "Inputs could not be prepared: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Inputs were not prepared: the request could not be prepared as submitted.",
  runtime: "Inputs could not be prepared: the Pipelex API returned an error.",
  paywall:
    "Inputs could not be prepared: the organization's Pipelex plan does not cover this call.",
  auth: "Inputs could not be prepared: the Pipelex API key is missing or was refused.",
  role: "Inputs could not be prepared: your role in this organization does not allow this.",
};

function summaryForError(error: ToolError): string {
  return summaryForToolError(error, ERROR_SUMMARIES);
}

export function prepareInputsToolResult(result: PrepareResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(
      result.summary,
      result.structuredContent.errors,
      result.structuredContent.files_sent,
    ),
    isError: result.structuredContent.status === "error",
  };
}

function errorResult(summary: string, errors: ToolError[]): PrepareResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      errors,
    },
    summary,
  };
}
