import { InputPreparationError } from "@pipelex/sdk";
import type { MthdsFileItem, PrepareInputsRequest, PreparedInputs } from "@pipelex/sdk";
import { z } from "zod";

import {
  METHOD_REF_GRAMMAR,
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
  filesInputSchema,
  resolveSubmittedFiles,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateMethodSelectorRequest,
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
import { MAX_UPLOAD_BYTES, SizeGuardedPipelexApiClient, formatMib } from "./upload-ceiling.js";

export const mthdsPrepareInputsInputSchema = {
  files: filesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR} — the signature source. Resolved server-side (the repository is fetched at the tag); no bundle enters the conversation. Supply exactly ONE of files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      "Catalog id (mt_…) of a registered method — the signature source. Uses the method's CURRENT stored content and requires an API key (the catalog is org-scoped). Supply exactly ONE of files / method_ref / method_id.",
    ),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      "The pipe whose declared signature identifies the file-bearing inputs, as a qualified domain.pipe_code — the same value mthds_run takes as pipe_code and mthds_inputs_template as pipe_ref. Omit to default to the closure's main_pipe.",
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .describe(
      "The caller's FILLED inputs (the mthds_inputs_template output, populated). File-bearing values are uploaded to Pipelex storage and rewritten to pipelex-storage://; http(s) URLs and existing pipelex-storage:// URIs pass through. An empty object uploads nothing.",
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
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsPrepareInputsOutputSchema = prepareStructuredContentSchema;

export interface MthdsPrepareInputsInput {
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

/** The prepare request after `{ path }` resolution — what the checks and the prepare step consume. */
interface ResolvedPrepareRequest {
  files: SubmittedFile[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

export interface PrepareStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  inputs?: Record<string, unknown>;
  uploads?: string[];
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
 * `getMethodClosure` and no `validate` here: the SDK reads the signature from
 * one `POST /v1/validate` itself.
 */
interface PrepareClient {
  prepareInputs(request: PrepareInputsRequest): Promise<PreparedInputs>;
}

/**
 * `mthds_prepare_inputs` is the workshop's alone, and it always uploads: the
 * workshop is co-located with the user's files. The console never had a use
 * for an upload walk it had to refuse at every leaf, so its pass-through copy
 * of the walk lives in `console-inputs.ts`, where `pipelex_run` calls it.
 */
export interface PrepareContext extends ApiConfig {
  client?: PrepareClient;
  /** Fills `{ path }` closure items from disk (local workshop). */
  resolver?: FileResolver;
  /** Deployment-specific auth-failure texture; default env-var wording when absent. */
  authError?: AuthErrorTexture;
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
 * The signature texture, and the reason every shape carries it unchanged: an
 * unqualified `pipe_ref`, an unknown one and a closure with no single default
 * pipe are all refused **client-side** by the SDK, as an
 * `InputPreparationError` raised before any request. Each really is a question
 * about the pipe, whatever named the method — which is why it rides
 * `preparation` rather than `badRequest`, whose locator follows the selector
 * the caller actually typed.
 */
const PREPARE_SIGNATURE_TEXTURE: NonNullable<ClassifyErrorOptions["preparation"]> = {
  location: "pipe_ref",
  hint: "Pass pipe_ref as a qualified domain.pipe_code; omitting it requires the closure to declare exactly one main_pipe.",
};

/** Classify options for a files-shaped request. */
const PREPARE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
  methodLocation: "files",
  // No `badRequest` override on purpose: a files request names no selector
  // field, so the default `files` locator is already right, and it is the very
  // texture `mthds_validate` gets for the very same body on the very same
  // route. It must NOT be the signature texture, which is what it was while
  // this tool still sent `pipe_ref` to `/v1/build/inputs`: pipe selection is
  // client-side now, so `/v1/validate` can never be complaining about it.
  preparation: PREPARE_SIGNATURE_TEXTURE,
  asset: PREPARE_ASSET_TEXTURE,
};

/**
 * Classify options for an address-shaped request — the `mthds_validate`
 * textures, because this tool now reaches the very same route with the very
 * same selector. Note the address travels through `/v1/validate` and therefore
 * through the execution-locus gate, so a fetched package shipping any `.py` is
 * a 403 here off a deployment that is not sandbox-hosted, while the same
 * address still answers on `mthds_inputs_template` and `mthds_codegen`, which
 * reach their crate another way. Both of the gate's refusals are classified
 * route-independently in `classifyError`, off the `error_type` the runner
 * declares, and both land at `methodLocation` — never in the generic 401/403
 * arm, which sent a caller with a perfectly good credential to mint a key.
 */
const PREPARE_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
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
  route: "/v1/validate",
  methodLocation: "method_id",
  badRequest: {
    location: "method_id",
    hint: "The stored method may have no MTHDS source yet, or this deployment may not resolve method_id on /v1/validate — the selector is hosted-only (a bare pipelex-api runner has no catalog).",
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
  const resolution = await resolveSubmittedFiles(input.files ?? [], context.resolver);
  if (resolution.errors.length > 0) {
    return errorResult("Inputs were not prepared: request input is invalid.", resolution.errors);
  }

  const request: ResolvedPrepareRequest = { ...input, files: resolution.files };
  const inputErrors = validatePrepareInputsRequest(request);
  if (inputErrors.length > 0) {
    return errorResult("Inputs were not prepared: request input is invalid.", inputErrors);
  }

  // Classify options follow the request's selector shape, exactly as
  // mthds_validate and mthds_codegen do — each failure locates at the field
  // that caused it.
  const classifyOptions =
    request.files.length > 0
      ? PREPARE_ERROR_OPTIONS
      : request.method_ref !== undefined
        ? PREPARE_BY_REF_ERROR_OPTIONS
        : PREPARE_BY_ID_ERROR_OPTIONS;

  let prepared: PreparedInputs;
  try {
    // Built inside the try for the same reason the client is: the selector
    // narrowing throws on its own unreachable arm, and that must classify as a
    // ToolError rather than reject the MCP handler.
    const envelope: PrepareEnvelope = {
      selector: prepareSelectorOf(request),
      ...(request.pipe_ref === undefined ? {} : { pipe_ref: request.pipe_ref }),
      inputs: request.inputs,
    };
    prepared = await prepareWithUpload(prepareClient(context), envelope);
  } catch (err) {
    const error = classifyError(err, { ...classifyOptions, auth: context.authError });
    return errorResult(summaryForError(error), [error]);
  }

  return prepareInputsResult(prepared, request.pipe_ref);
}

/**
 * The method selector as the SDK spells it — one of the three, already proved
 * to be exactly one by {@link validatePrepareInputsRequest}. The SDK takes it
 * as-is: nothing here resolves an address or an id, the route does.
 */
type PrepareSelector = { files: MthdsFileItem[] } | { method_ref: string } | { method_id: string };

function prepareSelectorOf(request: ResolvedPrepareRequest): PrepareSelector {
  if (request.files.length > 0) {
    return { files: toMthdsFileItems(request.files) };
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
    "Cannot prepare inputs: no method selector. Supply exactly one of files, method_ref or method_id.",
  );
}

/** The resolved selector + pipe + filled inputs the prepare step consumes. */
interface PrepareEnvelope {
  selector: PrepareSelector;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

/**
 * Hand the whole request to the SDK's `prepareInputs`, selector included. Since `@pipelex/sdk` 0.17.0 that call takes `files`, `method_ref`
 * or `method_id` and resolves each through one `POST /v1/validate` with
 * `views: ["input_form"]` — which is why this repo no longer expands a stored
 * method into files before calling it.
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
  };
  if ("files" in envelope.selector) {
    return client.prepareInputs({ ...base, files: envelope.selector.files });
  }
  if ("method_ref" in envelope.selector) {
    return client.prepareInputs({ ...base, method_ref: envelope.selector.method_ref });
  }
  return client.prepareInputs({ ...base, method_id: envelope.selector.method_id });
}

export function validatePrepareInputsRequest(input: ResolvedPrepareRequest): ToolError[] {
  const errors = validateMethodSelectorRequest(input.files, input, { rule: "one_selector" });

  if (input.pipe_ref !== undefined && input.pipe_ref.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "pipe_ref",
      message: "pipe_ref must not be empty when supplied.",
      hint: "Pass a qualified domain.pipe_code, or omit pipe_ref to default to the closure's main_pipe.",
      retryable: false,
    });
  }

  return errors;
}

export function prepareInputsResult(
  prepared: PreparedInputs,
  pipeRef: string | undefined,
): PrepareResult {
  const uploads = prepared.uploads.map((record) => record.uri);
  return {
    structuredContent: {
      status: "ok",
      is_valid: true,
      ...(pipeRef === undefined ? {} : { pipe_ref: pipeRef }),
      inputs: prepared.inputs,
      uploads,
    },
    summary: prepareSummary(pipeRef, prepared.inputs, uploads),
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
): string {
  const parts = ["# Prepared inputs"];
  if (pipeRef !== undefined) {
    parts.push(`Resolved pipe: \`${pipeRef}\``);
  }
  parts.push(
    uploads.length === 0
      ? "No assets required uploading — all inputs pass through unchanged. Hand these inputs to `mthds_run`."
      : `Uploaded ${uploads.length} asset(s) to Pipelex storage (rewritten to \`pipelex-storage://\` references). Hand these inputs to \`mthds_run\`.`,
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
};

function summaryForError(error: ToolError): string {
  return summaryForToolError(error, ERROR_SUMMARIES);
}

export function prepareInputsToolResult(result: PrepareResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
  };
}

// The MCP surface spells the provenance label `uri` (mirroring mthds_validate);
// the SDK's build envelope spells it `source` (`MthdsFileItem`). Adapt here.
function toMthdsFileItems(files: SubmittedFile[]): MthdsFileItem[] {
  return files.map((file) => {
    if (file.uri === undefined || file.uri === null) {
      return { content: file.content };
    }
    return { content: file.content, source: file.uri };
  });
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
