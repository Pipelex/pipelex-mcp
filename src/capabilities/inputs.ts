import { PipelexApiClient } from "@pipelex/sdk";
import type {
  BuildInputsRequest,
  BuildInputsResponse,
  BuildInputsValidReport,
  MthdsFileItem,
  ValidationErrorItem,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  METHOD_REF_GRAMMAR,
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

const inputsTemplateFormatSchema = z.enum(["json", "toml"]);

export type InputsTemplateFormat = z.infer<typeof inputsTemplateFormatSchema>;

export const mthdsInputsInputSchema = {
  files: filesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR}. Resolved server-side (the repository is fetched at the tag); no bundle enters the conversation. Supply exactly ONE of files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      "Catalog id (mt_…) of a registered method. Projects the template from the method's CURRENT stored content — requires an API key (the catalog is org-scoped). Supply exactly ONE of files / method_ref / method_id.",
    ),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      "The pipe to project, as a qualified domain.pipe_code — the same value mthds_run takes as pipe_code (the name mirrors each route: the build routes say pipe_ref, the run routes say pipe_code). Omit to default to the closure's declared main_pipe.",
    ),
  explicit: z
    .boolean()
    .optional()
    .describe(
      "Emit the ceremonial {concept, content} envelope per input, showing each input's declared concept and canonical content shape. Defaults to true. Pass false for the light shape (bare example values).",
    ),
  format: inputsTemplateFormatSchema
    .optional()
    .describe(
      'Template encoding. "json" (default) returns a parsed object in `inputs`; "toml" returns raw TOML text in `inputs_toml`, preserving concept comments and key order.',
    ),
};

const inputsStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  pipe_ref: z
    .string()
    .optional()
    .describe("The resolved qualified pipe (domain.pipe_code) whose inputs were projected."),
  format: inputsTemplateFormatSchema.optional(),
  explicit: z.boolean().optional(),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The fill-in inputs template, as a parsed object (format "json").'),
  inputs_toml: z
    .string()
    .optional()
    .describe('The fill-in inputs template, as raw TOML text (format "toml").'),
  validation_errors: z.array(z.unknown()).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsInputsOutputSchema = inputsStructuredContentSchema;

export interface MthdsInputsInput {
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  explicit?: boolean;
  format?: InputsTemplateFormat;
}

/** The inputs request after `{ path }` resolution — what the checks and the API call consume. */
interface ResolvedInputsRequest {
  files: SubmittedFile[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  explicit?: boolean;
  format?: InputsTemplateFormat;
}

export interface InputsStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  format?: InputsTemplateFormat;
  explicit?: boolean;
  inputs?: Record<string, unknown>;
  inputs_toml?: string;
  validation_errors?: unknown[];
  errors?: ToolError[];
}

export interface InputsResult {
  structuredContent: InputsStructuredContent;
  summary: string;
}

/** The slice of `PipelexApiClient` the inputs capability calls (test seam). */
interface InputsClient extends MethodFetchClient {
  buildInputs(request: BuildInputsRequest): Promise<BuildInputsResponse>;
}

export interface InputsContext {
  baseUrl: string;
  apiKey?: string;
  client?: InputsClient;
  /** Fills `{ path }` items from disk (local workshop); absent on the hosted console. */
  resolver?: FileResolver;
  /** Deployment-specific auth-failure texture (the hosted console overrides it per request); default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildInputsContext(env = process.env): InputsContext {
  return buildApiConfig(env);
}

const INPUTS_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/build/inputs",
  // A malformed closure is a produced 200 verdict on this route, so a 400/422
  // rejection is almost always the pipe selector: an unknown pipe_ref, an
  // unqualified one, or an unresolvable main_pipe default.
  badRequest: {
    location: "pipe_ref",
    hint: "Pass pipe_ref as a qualified domain.pipe_code; omitting it requires the closure to declare exactly one main_pipe.",
  },
};

/**
 * Classify options for an address-shaped request: a 400/422 can now be the
 * ref (parse/fetch/ambiguity) as well as the pipe selector, a 404 is the
 * runner's no-matching-package refusal, and a 501 is the reserved registry
 * form — all the caller's own selector, located at `method_ref` (except the
 * pipe selector, which the hint still covers).
 */
const INPUTS_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/build/inputs",
  badRequest: {
    location: "method_ref",
    hint: `Check the address and tag — ${METHOD_REF_GRAMMAR} — and that the tag is a git tag on the repository. If the address resolved, check pipe_ref is a qualified domain.pipe_code declared by the package.`,
  },
  notFound: {
    location: "method_ref",
    hint: "The repository was fetched but holds no package matching this address by manifest identity. Check the package selector against the repository's METHODS.toml manifests.",
  },
  notImplemented: {
    location: "method_ref",
    hint: `Only address-form refs are supported (${METHOD_REF_GRAMMAR}); registry references are reserved until a method registry exists.`,
  },
};

// Constructed inside each caught block (mirroring run.ts's runClient): the SDK
// constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
function inputsClient(context: InputsContext): InputsClient {
  return (
    context.client ??
    new PipelexApiClient({
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    })
  );
}

export async function buildMthdsInputs(
  input: MthdsInputsInput,
  context: InputsContext = buildInputsContext(),
): Promise<InputsResult> {
  const resolution = await resolveSubmittedFiles(input.files ?? [], context.resolver);
  if (resolution.errors.length > 0) {
    return errorResult("Inputs template was not run: request input is invalid.", resolution.errors);
  }

  const request: ResolvedInputsRequest = { ...input, files: resolution.files };
  const inputErrors = validateInputsRequest(request);
  if (inputErrors.length > 0) {
    return errorResult("Inputs template was not run: request input is invalid.", inputErrors);
  }

  // By-id expansion: the build routes take no method_id (the hosted tooling
  // selector deliberately excludes them — SPEC.md → Method Selectors), so an
  // id request expands the stored method via the SDK-canonical
  // getMethodClosure leg and forwards its current source as the submitted
  // files (each labeled with the method id as provenance, which crosses into
  // the build envelope's `source` via toMthdsFileItems). An address needs no
  // expansion — `method_ref` rides the build envelope itself and the runner
  // resolves it.
  let files = request.files;
  if (request.method_id !== undefined) {
    const fetched = await fetchMethodFiles(() => inputsClient(context), request.method_id, {
      authError: context.authError,
      noSourceHint:
        "Add MTHDS content to the method (e.g. in the webapp editor) before projecting its inputs template, or submit files instead.",
    });
    if (!fetched.ok) {
      const summary =
        fetched.reason === "no_source"
          ? "Inputs template was not run: the stored method has no MTHDS source."
          : summaryForError(fetched.error);
      return errorResult(summary, [fetched.error]);
    }
    files = fetched.files;
  }

  const classifyOptions =
    request.method_ref !== undefined ? INPUTS_BY_REF_ERROR_OPTIONS : INPUTS_ERROR_OPTIONS;

  let report: BuildInputsResponse;
  try {
    report = await inputsClient(context).buildInputs(toBuildInputsRequest({ ...request, files }));
  } catch (err) {
    const error = classifyError(err, { ...classifyOptions, auth: context.authError });
    return errorResult(summaryForError(error), [error]);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (e.g. a valid arm missing its template field) is a
  // reachable contract violation, surfaced as a runtime no-verdict error.
  try {
    return inputsResult(report);
  } catch (err) {
    return errorResult(
      "Inputs template produced no verdict: the Pipelex API returned a malformed report.",
      [
        {
          class: "runtime",
          message:
            err instanceof Error
              ? err.message
              : "The Pipelex API returned a malformed inputs report.",
          hint: "The API responded but its report was missing required fields; inspect pipelex-api logs.",
          retryable: false,
        },
      ],
    );
  }
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "Inputs template could not start: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Inputs template was not run: the Pipelex API rejected the request.",
  runtime: "Inputs template could not be completed: the Pipelex API returned an error.",
  paywall:
    "Inputs template could not start: the organization's Pipelex plan does not cover this call.",
};

function summaryForError(error: ToolError): string {
  return summaryForToolError(error, ERROR_SUMMARIES);
}

export function inputsToolResult(result: InputsResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
  };
}

export function validateInputsRequest(input: ResolvedInputsRequest): ToolError[] {
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

export function inputsResult(report: BuildInputsResponse): InputsResult {
  if (!report.is_valid) {
    return {
      structuredContent: {
        status: "ok",
        is_valid: false,
        validation_errors: report.validation_errors,
      },
      summary: invalidSummary(report.message, report.validation_errors),
    };
  }

  return {
    structuredContent: {
      status: "ok",
      is_valid: true,
      pipe_ref: report.pipe_ref,
      format: report.format,
      explicit: report.explicit,
      ...templateFields(report),
    },
    summary: validSummary(report),
  };
}

function templateFields(
  report: BuildInputsValidReport,
): Pick<InputsStructuredContent, "inputs" | "inputs_toml"> {
  if (report.format === "json") {
    if (report.inputs == null) {
      throw new Error("Inputs report did not include the json template.");
    }
    return { inputs: report.inputs };
  }
  if (report.inputs_toml == null) {
    throw new Error("Inputs report did not include the toml template.");
  }
  return { inputs_toml: report.inputs_toml };
}

// The build routes return a plain `message` rather than `rendered_markdown`,
// so the summary is composed here. Unlike validation, the template is
// deliberately duplicated into the summary: it is the payload the model must
// read, and some hosts read prose more reliably than structured fields.
function validSummary(report: BuildInputsValidReport): string {
  const fence =
    report.format === "json"
      ? "```json\n" + JSON.stringify(report.inputs, null, 2) + "\n```"
      : "```toml\n" + (report.inputs_toml ?? "").trimEnd() + "\n```";

  return ["# Inputs template", report.message, `Resolved pipe: \`${report.pipe_ref}\``, fence].join(
    "\n\n",
  );
}

function invalidSummary(message: string, validationErrors: ValidationErrorItem[]): string {
  const lines = validationErrors.map((error) => {
    const source = error.source ? ` (${error.source})` : "";
    return `- **${error.category}** — ${error.message}${source}`;
  });

  return [
    "# Inputs template not produced",
    message,
    ...(lines.length > 0 ? [lines.join("\n")] : []),
  ].join("\n\n");
}

// The closure crosses as EITHER inline files OR the address — the build
// envelope's own XOR. An id-shaped request was already expanded to files.
function toBuildInputsRequest(input: ResolvedInputsRequest): BuildInputsRequest {
  return {
    ...(input.method_ref !== undefined
      ? { method_ref: input.method_ref }
      : { files: toMthdsFileItems(input.files) }),
    ...(input.pipe_ref === undefined ? {} : { pipe_ref: input.pipe_ref }),
    format: input.format ?? "json",
    explicit: input.explicit ?? true,
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

function errorResult(summary: string, errors: ToolError[]): InputsResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      errors,
    },
    summary,
  };
}
