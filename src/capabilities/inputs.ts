import { buildProblem, formatItem } from "@pipelex/sdk";
import type { PipeIORequest, PipeIOResponse, PipeIOValidReport } from "@pipelex/sdk";
import { z } from "zod";

import { inputsTemplateFor } from "./inputs-template.js";
import type { ProjectedInputsTemplate } from "./inputs-template.js";
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
  argumentProblem,
  asOneLine,
  buildApiConfig,
  createPipelexApiClient,
  faultsProblem,
  filesSentSchema,
  methodDirInputSchema,
  methodFilesInputSchema,
  problemItemSchema,
  problemOf,
  problemSchema,
  problemSummary,
  resolveMethodSource,
  toolResultContent,
  validateMethodSelectorRequest,
  withFilesSent,
  failedBeforeSending,
  markUnsent,
} from "./shared.js";
import type {
  ApiConfig,
  ApiNotes,
  FileResolver,
  MethodTreeToSend,
  Problem,
  ProblemItem,
  SubmittedFileInput,
} from "./shared.js";
import { methodTreeLimitsOf } from "./tree-limits.js";
import type { TreeLimitsAware } from "./tree-limits.js";

/**
 * `mthds_inputs_template` — the workshop's fill-in template for one pipe's
 * declared inputs.
 *
 * It reads one `POST /v1/pipe-io` for the one pipe, with no dry run, and
 * projects the template client-side from the pipe's `input_form` descriptor
 * through `inputs-template.ts`'s `inputsTemplateFor`. Every selector is a
 * server pass-through: the runner resolves an address, and the hosted platform
 * resolves a catalog id. The route picks the pipe too, so the template is for
 * the pipe `mthds_prepare_inputs` would prepare and a run naming none would
 * execute.
 */

const inputsTemplateFormatSchema = z.enum(["json", "toml"]);

export type InputsTemplateFormat = z.infer<typeof inputsTemplateFormatSchema>;

export const mthdsInputsInputSchema = {
  method_dir: methodDirInputSchema("one_selector"),
  files: methodFilesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR}. Resolved server-side (the repository is fetched at the tag); no bundle enters the conversation. Supply exactly ONE of method_dir / files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      `Catalog id (mt_…) of a registered method, resolved server-side — requires an API key (the catalog is org-scoped). ${METHOD_ID_SELECTOR_SENTENCE} Supply exactly ONE of method_dir / files / method_ref / method_id.`,
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
  files_sent: filesSentSchema,
  errors: z
    .array(problemItemSchema)
    .optional()
    .describe(
      "An invalid verdict's faults about the method, one problem item each, with its own code, detail and location; absent on a valid verdict.",
    ),
  problem: problemSchema
    .optional()
    .describe("Why no template could be produced; present exactly when status is error."),
});

export const mthdsInputsOutputSchema = inputsStructuredContentSchema;

export interface MthdsInputsInput {
  method_dir?: string;
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  explicit?: boolean;
  format?: InputsTemplateFormat;
}

/** The inputs request once its method is resolved — what the checks and the API call consume. */
interface ResolvedInputsRequest {
  /** The method's tree, from `method_dir` or `files`. */
  tree?: MethodTreeToSend;
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
  /** Calls on a tree, from `method_dir` or `files`: every file sent. */
  files_sent?: string[];
  /** An invalid verdict's faults, the API's problem items as it sent them. */
  errors?: ProblemItem[];
  /** The one problem of a call that produced no template. */
  problem?: Problem;
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

export interface InputsContext extends ApiConfig, MethodVersionsAware, TreeLimitsAware {
  client?: InputsClient;
  /** Fills `{ path }` items from disk; the workshop always sets it, and without one every `{ path }` is refused. */
  resolver?: FileResolver;
  /** Where the call's key and base URL came from, for a failed request's summary; the variables' names when absent. */
  apiNotes?: ApiNotes;
}

export function buildInputsContext(env = process.env): InputsContext {
  return buildApiConfig(env);
}

// Constructed inside the caught block (mirroring run.ts's runClient): the SDK
// constructor throws on a malformed base URL, and that must become the
// result's problem, not reject the MCP handler.
function inputsClient(context: InputsContext): InputsClient {
  return context.client ?? createPipelexApiClient(context);
}

export async function buildMthdsInputs(
  input: MthdsInputsInput,
  context: InputsContext = buildInputsContext(),
): Promise<InputsResult> {
  const resolution = await resolveMethodSource(input, context.resolver, "one_selector", () =>
    methodTreeLimitsOf(context, () => inputsClient(context)),
  );
  if (resolution.faults.length > 0) {
    return errorResult(faultsProblem(resolution.faults), context);
  }

  const { method_dir: _methodDir, files: _files, ...selection } = input;
  const request: ResolvedInputsRequest = {
    ...selection,
    ...(resolution.tree === undefined ? {} : { tree: resolution.tree }),
  };
  const inputFaults = validateInputsRequest(request);
  if (inputFaults.length > 0) {
    return errorResult(faultsProblem(inputFaults), context);
  }

  return withFilesSent(await requestInputsTemplate(request, context), request.tree);
}

/** One `POST /v1/pipe-io` for a request that passed its checks, and the projection of its answer. */
async function requestInputsTemplate(
  request: ResolvedInputsRequest,
  context: InputsContext,
): Promise<InputsResult> {
  let report: PipeIOResponse;
  let plan: SelectorPlan | undefined;
  let client: InputsClient | undefined;
  try {
    client = inputsClient(context);
    let sent = request;
    if (request.method_id !== undefined) {
      // A bare id reads the draft on a platform that does not resolve version
      // selectors yet, and the latest published version on one that does: the
      // platform is asked beside the request, which never waits on it, and the
      // result says which content the template came from (`method-versions.ts`).
      plan = planById(request.method_id, methodVersionsOf(context), client, {
        needBareReport: true,
      });
      sent = { ...request, method_id: plan.send };
    }
    report = await client.pipeIo(toPipeIoRequest(sent));
  } catch (err) {
    // The SDK's problem, as it read the answer or the failure: its code, its
    // domain and its retry verdict are relayed, never overridden. A refused
    // pipe selection is the route's own typed problem, located at pipe_ref.
    const problem = await selectorFailure(problemOf(err), plan, methodVersionsOf(context));
    const failed = errorResult(problem, context);
    // A client that could not be built, or an argument refused before
    // sending, sent no file of the tree.
    return client === undefined || failedBeforeSending(err) ? markUnsent(failed) : failed;
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed answer (a valid arm with no resolved pipe, or no
  // descriptor the projection can walk for it) is an answer the workshop
  // cannot read, `client.response_unreadable` of the 200 it came on.
  try {
    const result = inputsResult(report, {
      explicit: request.explicit ?? true,
      format: request.format ?? "json",
    });
    return await withMethodContent(result, plan, "projected the template from");
  } catch (err) {
    return errorResult(
      buildProblem(
        "client.response_unreadable",
        { status: 200 },
        {
          extra: {
            message: `${err instanceof Error ? err.message : "The Pipelex API returned a malformed pipe I/O answer."} The API answered, but its answer was missing required fields.`,
          },
        },
      ),
      context,
    );
  }
}

export function inputsToolResult(result: InputsResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.files_sent),
    isError: result.structuredContent.status === "error",
  };
}

export function validateInputsRequest(input: ResolvedInputsRequest): Problem[] {
  const faults = validateMethodSelectorRequest(input.tree !== undefined, input, {
    rule: "one_selector",
  });

  if (input.pipe_ref !== undefined && input.pipe_ref.trim() === "") {
    faults.push(
      argumentProblem(
        "pipe_ref",
        "empty",
        "pipe_ref must not be empty when supplied.",
        "Pass a qualified domain.pipe_code, or omit pipe_ref to default to the closure's main_pipe.",
      ),
    );
  }

  return faults;
}

/**
 * Project the route's answer. The invalid arm is a produced verdict about the
 * closure and relays its faults, one problem item each, as `errors`. The valid arm is keyed
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
        errors: report.errors,
      },
      summary: invalidSummary(report.message, report.errors),
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

function invalidSummary(message: string, errors: readonly ProblemItem[]): string {
  const lines = errors.map((item) => `- ${asOneLine(formatItem(item))}`);

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
        : { tree: input.tree?.source };
  return input.pipe_ref === undefined ? selector : { ...selector, pipe_ref: input.pipe_ref };
}

/** A call that produced no template: its one problem, and the problem's summary. */
function errorResult(problem: Problem, context: { apiNotes?: ApiNotes }): InputsResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      problem,
    },
    summary: problemSummary(problem, context.apiNotes),
  };
}
