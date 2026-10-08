import type {
  MthdsFileItem,
  PipeIORequest,
  PipeIOResponse,
  PipeIOValidReport,
  ValidationErrorItem,
} from "@pipelex/sdk";
import { z } from "zod";

import { inputsTemplateFor } from "./inputs-template.js";
import type { ProjectedInputsTemplate } from "./inputs-template.js";
import {
  METHOD_ID_SELECTOR_SENTENCE,
  methodVersionReportSchema,
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

/**
 * `mthds_inputs_template` — the workshop's fill-in template for one pipe's
 * declared inputs.
 *
 * It reads one `POST /v1/pipe-io` for the one pipe, with no dry run, and
 * projects the template client-side from the pipe's `input_form` descriptor
 * through `inputs-template.ts`'s `inputsTemplateFor`. All three selectors are
 * server pass-throughs: the runner resolves an address, and the hosted platform
 * resolves a catalog id. The route picks the pipe too, so the template is for
 * the pipe `mthds_prepare_inputs` would prepare and a run naming none would
 * execute.
 */

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
      `Catalog id (mt_…) of a registered method, resolved server-side — requires an API key (the catalog is org-scoped). ${METHOD_ID_SELECTOR_SENTENCE} Supply exactly ONE of files / method_ref / method_id.`,
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
  method_version: methodVersionReportSchema,
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
  /** By-id calls only: the content the template was projected from, when this server can tell. */
  method_version?: MethodVersionReport;
  validation_errors?: unknown[];
  errors?: ToolError[];
}

export interface InputsResult {
  structuredContent: InputsStructuredContent;
  summary: string;
}

/** The template's two options, defaulted: the shape and the serialization. */
export interface InputsTemplateChoice {
  explicit: boolean;
  format: InputsTemplateFormat;
}

/** The slice of `PipelexApiClient` the inputs capability calls (test seam): one `POST /v1/pipe-io`. */
interface InputsClient {
  pipeIo(request: PipeIORequest): Promise<PipeIOResponse>;
  /** `GET /v1/version`, read to learn whether a bare id names the draft or a version; optional on a test seam. */
  version?(): Promise<unknown>;
}

export interface InputsContext extends ApiConfig, MethodVersionsAware {
  client?: InputsClient;
  /** Fills `{ path }` items from disk; the workshop always sets it, and without one every `{ path }` is refused. */
  resolver?: FileResolver;
  /** Deployment-specific auth-failure texture; default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildInputsContext(env = process.env): InputsContext {
  return buildApiConfig(env);
}

/** The route this tool reads, named by the classification of a 404 that has no texture of its own. */
const INPUTS_ROUTE = "/v1/pipe-io";

/**
 * The route's refusal of a pipe selection — a `pipe_ref` naming no pipe, a
 * method with no entry pipe, or several — is a typed `422` about the pipe,
 * whatever named the method, so every shape locates it at `pipe_ref`, with
 * the route's own reason, which names the candidates where there are some.
 */
const INPUTS_SELECTION_TEXTURE: NonNullable<ClassifyErrorOptions["selection"]> = {
  location: "pipe_ref",
  hint: "Pass pipe_ref as a qualified domain.pipe_code the method declares; omitting it requires the method to settle exactly one entry pipe — a package manifest's main_pipe, else a single main_pipe declaration.",
};

/**
 * Classify options for a files-shaped request. With the selection refusals
 * typed and located at `pipe_ref`, a bare `400`/`422` from the route is the
 * request itself: too many files, or one over the size limit.
 */
const INPUTS_BY_FILES_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: INPUTS_ROUTE,
  methodLocation: "files",
  badRequest: {
    location: "files",
    hint: "Check the submitted files against the route's limits on their number and size, and pass pipe_ref, when you name one, as a qualified domain.pipe_code.",
  },
  selection: INPUTS_SELECTION_TEXTURE,
};

/**
 * Classify options for an address-shaped request: a `400`/`422` is the ref
 * (parse, fetch, ambiguity), a `404` is the runner's no-matching-package
 * refusal, and a `501` is the reserved registry form — all the caller's own
 * selector, located at `method_ref`. The route fetches a package's `.mthds`
 * files alone, so the execution-locus gate never fires here. A runner too old
 * to serve the route answers a bare `404` too, which the SDK reads as the
 * deployment's rather than the caller's, so it keeps the missing-route arm
 * here and on the id shape.
 */
const INPUTS_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: INPUTS_ROUTE,
  methodLocation: "method_ref",
  badRequest: {
    location: "method_ref",
    hint: `Check the address and tag — ${METHOD_REF_GRAMMAR}. The tag must be a git tag on the repository (branches do not pin), and the ref must be resolvable by an anonymous clone.`,
  },
  notFound: {
    location: "method_ref",
    hint: "The repository was fetched but holds no package matching this address by manifest identity. Check the package selector against the repository's METHODS.toml manifests.",
  },
  notImplemented: {
    location: "method_ref",
    hint: `Only address-form refs are supported (${METHOD_REF_GRAMMAR}); registry references are reserved until a method registry exists.`,
  },
  selection: INPUTS_SELECTION_TEXTURE,
};

/**
 * Classify options for an id-shaped request. The hosted platform resolves the
 * id against the key's organization and forwards the stored files, so an
 * unknown or foreign-org id is a `404` (indistinguishable by design), and a
 * stored method with no MTHDS source is a `422` from the same resolution.
 */
const INPUTS_BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: INPUTS_ROUTE,
  methodLocation: "method_id",
  badRequest: {
    location: "method_id",
    hint: "The stored method may have no MTHDS source yet, or this deployment may not resolve method_id on /v1/pipe-io — the selector is hosted-only (a bare pipelex-api runner has no catalog).",
  },
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. Check the id as the catalog returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss.",
  },
  selection: INPUTS_SELECTION_TEXTURE,
};

/** Classify options follow the selector, so each failure locates at the field that named the method. */
function inputsErrorOptions(request: ResolvedInputsRequest): ClassifyErrorOptions {
  if (request.method_ref !== undefined) return INPUTS_BY_REF_ERROR_OPTIONS;
  if (request.method_id !== undefined) return INPUTS_BY_ID_ERROR_OPTIONS;
  return INPUTS_BY_FILES_ERROR_OPTIONS;
}

// Constructed inside the caught block (mirroring run.ts's runClient): the SDK
// constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
function inputsClient(context: InputsContext): InputsClient {
  return context.client ?? createPipelexApiClient(context);
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

  let report: PipeIOResponse;
  let plan: SelectorPlan | undefined;
  try {
    const client = inputsClient(context);
    let sent = request;
    if (request.method_id !== undefined) {
      // A bare id reads the draft on a platform that does not resolve version
      // selectors yet, and the latest published version on one that does: the
      // selector is planned against the platform's answer, and the result says
      // which content the template came from (`method-versions.ts`).
      const planned = await planById(request.method_id, context.methodVersions, client, {
        needBareReport: true,
      });
      if (!planned.ok) {
        return errorResult(planned.summary, [planned.error]);
      }
      plan = planned.plan;
      sent = { ...request, method_id: plan.send };
    }
    report = await client.pipeIo(toPipeIoRequest(sent));
  } catch (err) {
    const classified = classifyError(err, {
      ...inputsErrorOptions(request),
      auth: context.authError,
    });
    const error = selectorFailure(err, classified, plan, context.methodVersions);
    return errorResult(summaryForError(error), [error]);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed answer (a valid arm with no resolved pipe, or no
  // descriptor the projection can walk for it) is a reachable contract
  // violation, surfaced as a runtime no-verdict error.
  try {
    const result = inputsResult(report, {
      explicit: request.explicit ?? true,
      format: request.format ?? "json",
    });
    return withMethodContent(result, plan, "projected the template from");
  } catch (err) {
    return errorResult(
      "Inputs template produced no verdict: the Pipelex API returned a malformed report.",
      [
        {
          class: "runtime",
          message:
            err instanceof Error
              ? err.message
              : "The Pipelex API returned a malformed pipe I/O answer.",
          hint: "The API responded but its answer was missing required fields; inspect pipelex-api logs.",
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

/**
 * Project the route's answer. The invalid arm is a produced verdict about the
 * closure and passes its `validation_errors[]` through. The valid arm is keyed
 * by exactly the `pipe_ref` it resolved, so the template is projected from
 * that pipe's descriptor; an answer that resolved no pipe, or carries no
 * descriptor the projection can walk for it, throws for the caller to report
 * as a malformed answer.
 */
export function inputsResult(report: PipeIOResponse, choice: InputsTemplateChoice): InputsResult {
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

  const pipeRef = resolvedPipeRef(report);
  const template = inputsTemplateFor(report.input_form, pipeRef, choice);
  if (template === undefined) {
    throw new Error(
      `The pipe I/O answer carries no input-form descriptor a template can be projected from for "${pipeRef}".`,
    );
  }

  return {
    structuredContent: {
      status: "ok",
      is_valid: true,
      pipe_ref: pipeRef,
      format: template.format,
      explicit: template.explicit,
      ...(template.format === "json"
        ? { inputs: template.inputs }
        : { inputs_toml: template.text }),
    },
    summary: validSummary(pipeRef, template),
  };
}

/** The pipe the route resolved, which a request without `all_pipes` always answers with. */
function resolvedPipeRef(report: PipeIOValidReport): string {
  const pipeRef: unknown = report.pipe_ref;
  if (typeof pipeRef !== "string" || pipeRef.trim() === "") {
    throw new Error("The pipe I/O answer resolved no pipe_ref.");
  }
  return pipeRef;
}

// What to do with the template once it is filled. It is said here, where it
// matters, rather than in the tool description or the server instructions:
// both are held under the length a host shows, and this is the one layer that
// reaches the model exactly when it has a template in hand. Both tools take
// `inputs` as a JSON object, so a TOML template has to be converted first — a
// model told to pass the TOML text on would send a string the schema refuses.
function nextStep(format: InputsTemplateFormat): string {
  const fill =
    format === "json"
      ? "Fill it in, then call"
      : "Fill it in and convert it to a JSON object for `inputs`, then call";
  return `${fill} \`mthds_prepare_inputs\` to make file-bearing values run-ready — or pass it straight to \`mthds_run\` when every file value is already an http(s) URL or a pipelex-storage:// reference.`;
}

// The route returns no `rendered_markdown`, so the summary is composed here.
// Unlike validation, the template is deliberately duplicated into the summary:
// it is the payload the model must read, and some hosts read prose more
// reliably than structured fields. The fence carries the standard's own
// rendering, which keeps a float placeholder's decimal point.
function validSummary(pipeRef: string, template: ProjectedInputsTemplate): string {
  const fence = "```" + template.format + "\n" + template.text.trimEnd() + "\n```";

  return [
    "# Inputs template",
    `Resolved pipe: \`${pipeRef}\``,
    fence,
    nextStep(template.format),
  ].join("\n\n");
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

// The method crosses as exactly one selector — the route's own XOR, which the
// request checks already enforced — each passed through for the server to
// resolve, with the caller's pipe when they named one.
function toPipeIoRequest(input: ResolvedInputsRequest): PipeIORequest {
  const selector: PipeIORequest =
    input.method_ref !== undefined
      ? { method_ref: input.method_ref }
      : input.method_id !== undefined
        ? { method_id: input.method_id }
        : { files: toMthdsFileItems(input.files) };
  return input.pipe_ref === undefined ? selector : { ...selector, pipe_ref: input.pipe_ref };
}

// The MCP surface spells the provenance label `uri` (mirroring mthds_validate);
// the SDK's crate envelope spells it `source` (`MthdsFileItem`). Adapt here.
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
