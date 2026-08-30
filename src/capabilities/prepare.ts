import { InputPreparationError } from "@pipelex/sdk";
import type {
  BuildInputsRequest,
  BuildInputsResponse,
  MthdsFileItem,
  PrepareInputsRequest,
  PreparedInputs,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  buildApiConfig,
  classifyError,
  summaryForToolError,
  fetchMethodFiles,
  filesInputSchema,
  resolveSubmittedFiles,
  toolErrorSchema,
  toolResultContent,
  validateMethodSelectorRequest,
} from "./shared.js";
import type {
  AuthErrorTexture,
  ClassifyErrorOptions,
  FileResolver,
  MethodFetchClient,
  SubmittedFile,
  SubmittedFileInput,
  ErrorSummaries,
  ToolError,
} from "./shared.js";
import { MAX_UPLOAD_BYTES, SizeGuardedPipelexApiClient, formatMib } from "./upload-ceiling.js";

export const mthdsPrepareInputsInputSchema = {
  files: filesInputSchema.optional(),
  method_id: z
    .string()
    .optional()
    .describe(
      "Catalog id (mt_…) of a registered method — the signature source. Uses the method's CURRENT stored content and requires an API key (the catalog is org-scoped). Supply exactly ONE of files / method_id — never both.",
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
  method_id?: string;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

/** The prepare request after `{ path }` resolution — what the checks and the prepare step consume. */
interface ResolvedPrepareRequest {
  files: SubmittedFile[];
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

/** The slice of `PipelexApiClient` the prepare capability calls (test seam). */
interface PrepareClient extends MethodFetchClient {
  buildInputs(request: BuildInputsRequest): Promise<BuildInputsResponse>;
  prepareInputs(request: PrepareInputsRequest): Promise<PreparedInputs>;
}

export interface PrepareContext {
  baseUrl: string;
  apiKey?: string;
  client?: PrepareClient;
  /** Fills `{ path }` closure items from disk (local workshop); absent on the hosted console. */
  resolver?: FileResolver;
  /**
   * The per-deployment asset boundary (analogous to {@link resolver}): the
   * local workshop uploads file-bearing inputs (`true`), the hosted console is
   * pass-through only (`false`, the default). When `false` the capability never
   * hands raw inputs to the SDK's `prepareInputs` — a bare-path value would make
   * the SDK read the *server's* filesystem before failing (LFI / DoS / existence
   * oracle on a public endpoint). It resolves the signature itself and refuses
   * any upload-needing input up front instead.
   */
  allowUpload?: boolean;
  /** Deployment-specific auth-failure texture (the hosted console overrides it per request); default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildPrepareContext(env = process.env): PrepareContext {
  return buildApiConfig(env);
}

const PREPARE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/build/inputs",
  // The signature comes from the internal buildInputs (explicit) call; a
  // 400/422 there (or the base InputPreparationError for an unresolvable
  // closure) is almost always the pipe selector.
  badRequest: {
    location: "pipe_ref",
    hint: "Pass pipe_ref as a qualified domain.pipe_code; omitting it requires the closure to declare exactly one main_pipe. If the bundle itself is invalid, repair it with mthds_validate.",
  },
  // Name the real ceiling. `POST /v1/upload` sits behind an AWS gateway whose
  // 10 MiB request quota, divided by base64's 4/3 inflation, is the actual
  // wall — NOT the app-level 50 MiB MAX_UPLOAD_MIB, which is unreachable
  // through the public gateway and must never be quoted to a caller.
  asset: {
    hint: `Pipelex storage accepts uploads up to ${formatMib(MAX_UPLOAD_BYTES)}. Shrink the file, or reference it by an http(s) URL instead.`,
  },
};

/**
 * The console (pass-through only) found a file-bearing input that would require
 * an upload. Not an SDK error and deliberately not an `InputPreparationError`,
 * so `classifyError` never grabs it — the capability catches it explicitly to
 * compose the bespoke refusal that names the workshop and the alternatives.
 */
class UploadNotAllowedError extends Error {
  public readonly inputName: string;
  public readonly kind: string;

  constructor(inputName: string, kind: string) {
    super(`Input "${inputName}" is ${kind}, which this hosted console cannot upload.`);
    this.name = "UploadNotAllowedError";
    this.inputName = inputName;
    this.kind = kind;
  }
}

// Constructed inside each caught block (mirroring inputs.ts / run.ts): the SDK
// constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
export function prepareClient(context: PrepareContext): PrepareClient {
  return (
    context.client ??
    // Size-guarded: the workshop's upload walk (delegated to the SDK's
    // prepareInputs) would otherwise learn an asset is too big only from the
    // gateway's 413, after the whole payload had crossed the wire — and with a
    // server message that cannot name the real limit. See upload-ceiling.ts.
    new SizeGuardedPipelexApiClient({
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    })
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

  // By-id expansion: the build/prepare surface has no by-id support (the
  // hosted tooling selector deliberately excludes it — SPEC.md → Method
  // Selectors), so an id request expands the stored method via the
  // SDK-canonical getMethodClosure leg and forwards its current source as the
  // closure files (each labeled with the method id as provenance). One shared
  // by-id expansion path across inputs-template / prepare, one place that
  // maps EmptyMethodSourceError / 404. There is deliberately no method_ref on
  // this tool: preparation is a client-side signature walk over a closure the
  // caller supplies, and an address's files live server-side.
  let files = request.files;
  if (request.method_id !== undefined) {
    const fetched = await fetchMethodFiles(() => prepareClient(context), request.method_id, {
      authError: context.authError,
      noSourceHint:
        "Add MTHDS content to the method (e.g. in the webapp editor) before preparing its inputs, or submit files instead.",
    });
    if (!fetched.ok) {
      const summary =
        fetched.reason === "no_source"
          ? "Inputs were not prepared: the stored method has no MTHDS source."
          : summaryForError(fetched.error);
      return errorResult(summary, [fetched.error]);
    }
    files = fetched.files;
  }

  const envelope = {
    files: toMthdsFileItems(files),
    pipe_ref: request.pipe_ref,
    inputs: request.inputs,
  };

  let prepared: PreparedInputs;
  try {
    prepared =
      context.allowUpload === true
        ? await prepareWithUpload(prepareClient(context), envelope)
        : await preparePassThrough(prepareClient(context), envelope);
  } catch (err) {
    // The console's own pass-through refusal is not an SDK error — surface it as
    // the instructive input_domain@inputs no-verdict, ahead of classifyError.
    if (err instanceof UploadNotAllowedError) {
      const error = uploadRefusedError(err);
      return errorResult(summaryForError(error), [error]);
    }
    const error = classifyError(err, { ...PREPARE_ERROR_OPTIONS, auth: context.authError });
    return errorResult(summaryForError(error), [error]);
  }

  return prepareInputsResult(prepared, request.pipe_ref);
}

/** The resolved closure + pipe + filled inputs the prepare step consumes. */
interface PrepareEnvelope {
  files: MthdsFileItem[];
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

/**
 * Workshop path: delegate the whole upload walk to the SDK's `prepareInputs`
 * (files only — the by-id closure is already resolved to files above).
 */
function prepareWithUpload(
  client: PrepareClient,
  envelope: PrepareEnvelope,
): Promise<PreparedInputs> {
  return client.prepareInputs({
    files: envelope.files,
    ...(envelope.pipe_ref === undefined ? {} : { pipe_ref: envelope.pipe_ref }),
    inputs: envelope.inputs,
  });
}

const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Console path (pass-through only): resolve the pipe's declared signature via
 * `buildInputs` (explicit), then walk the caller's inputs against it — exactly
 * the SDK's `prepareInputs` walk minus the upload. Only http(s) URLs and
 * existing `pipelex-storage://` URIs pass through; any upload-needing value
 * (a `data:` URL, inline bytes, a local path) is refused up front. This never
 * calls `uploadFile` / `readLocalPath`, so a bare-path value never triggers a
 * server-side filesystem read on the public console.
 */
async function preparePassThrough(
  client: PrepareClient,
  envelope: PrepareEnvelope,
): Promise<PreparedInputs> {
  const report = await client.buildInputs({
    files: envelope.files,
    ...(envelope.pipe_ref === undefined ? {} : { pipe_ref: envelope.pipe_ref }),
    format: "json",
    explicit: true,
  });

  if (!report.is_valid) {
    const first = report.validation_errors[0]?.message ?? report.message;
    throw new InputPreparationError(
      `Cannot prepare inputs: the method signature did not resolve — ${first}`,
    );
  }
  if (report.format !== "json" || report.inputs == null) {
    throw new InputPreparationError(
      "Cannot prepare inputs: the signature route did not return a JSON inputs template.",
    );
  }
  const template = report.inputs;

  const rewritten: Record<string, unknown> = { ...envelope.inputs };
  for (const [name, callerValue] of Object.entries(envelope.inputs)) {
    const entry = template[name];
    if (!isPlainObject(entry) || !("content" in entry)) {
      // Not a declared input (or an unexpected envelope) — pass through untouched.
      continue;
    }
    if (isExplicitEnvelope(callerValue)) {
      // The caller filled the explicit `{ concept, content }` template: walk the inner
      // content against the compact signature, then re-wrap so the concept annotation
      // rides through to the run (the runtime accepts the envelope). SDK parity.
      const walked = resolveNodePassThrough(entry.content, callerValue.content, name);
      rewritten[name] = { ...callerValue, content: walked };
      continue;
    }
    rewritten[name] = resolveNodePassThrough(entry.content, callerValue, name);
  }

  return { inputs: rewritten, uploads: [] };
}

/** Strict plain-object test — excludes arrays, typed arrays, and other exotics (SDK parity). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * The explicit-template envelope: a plain object whose keys are EXACTLY `concept` and
 * `content` (SDK parity, mirroring the runtime's own collision rule) — so a declared
 * structured concept that merely happens to carry both fields is not misread as one.
 */
function isExplicitEnvelope(value: unknown): value is { concept: unknown; content: unknown } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && "concept" in value && "content" in value;
}

/** A canonical Image/Document content is a plain object carrying a `url` key (SDK parity). */
function isFileContent(node: unknown): node is Record<string, unknown> {
  return isPlainObject(node) && "url" in node;
}

/** Template-guided walk (SDK parity): a template node that is file content marks a file position. */
function resolveNodePassThrough(
  templateNode: unknown,
  callerValue: unknown,
  name: string,
): unknown {
  if (isFileContent(templateNode)) {
    return resolveFilePositionPassThrough(callerValue, name);
  }
  if (Array.isArray(templateNode) && templateNode.length > 0) {
    const elementTemplate = templateNode[0];
    if (Array.isArray(callerValue)) {
      return callerValue.map((item) => resolveNodePassThrough(elementTemplate, item, name));
    }
    return callerValue; // shape mismatch — leave it for the run to reject
  }
  if (isPlainObject(templateNode) && isPlainObject(callerValue)) {
    const result: Record<string, unknown> = { ...callerValue };
    for (const key of Object.keys(templateNode)) {
      if (key in callerValue) {
        result[key] = resolveNodePassThrough(templateNode[key], callerValue[key], name);
      }
    }
    return result;
  }
  return callerValue; // scalar or shape mismatch — pass through
}

/** Rewrite a file-position value to canonical `{ url }` content — but only if the source is pass-through. */
function resolveFilePositionPassThrough(callerValue: unknown, name: string): unknown {
  if (isFileContent(callerValue)) {
    return { ...callerValue, url: passThroughSource(callerValue.url, name) };
  }
  return { url: passThroughSource(callerValue, name) };
}

/** Accept an http(s) / pipelex-storage:// reference; refuse anything that would need an upload. */
function passThroughSource(source: unknown, name: string): string {
  if (typeof source === "string") {
    if (source.startsWith(PIPELEX_STORAGE_SCHEME) || HTTP_URL_RE.test(source)) {
      return source;
    }
    if (source.startsWith("data:")) {
      throw new UploadNotAllowedError(name, "a data: URL");
    }
    throw new UploadNotAllowedError(name, "a local file path");
  }
  throw new UploadNotAllowedError(name, "inline bytes");
}

export function validatePrepareInputsRequest(input: ResolvedPrepareRequest): ToolError[] {
  const errors = validateMethodSelectorRequest(input.files, input, {
    rule: "one_selector",
    acceptsMethodRef: false,
  });

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

function uploadRefusedError(err: UploadNotAllowedError): ToolError {
  return {
    class: "input_domain",
    location: "inputs",
    message: err.message,
    hint: "The hosted console is pass-through only: pass an http(s) URL or an existing pipelex-storage:// reference, or use the local workshop server (npx @pipelex/mcp), which uploads local files, bytes, and data: URLs.",
    retryable: false,
  };
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
