import { PipelexApiClient } from "@pipelex/sdk";
import type {
  MthdsFile,
  PipelexValidationResult,
  PipelexValidationReport,
  PipelexInvalidReport,
  ValidateFilesOptions,
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
  validateFilesOrMethodIdRequest,
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

export const mthdsValidateInputSchema = {
  files: filesInputSchema.optional(),
  method_id: z
    .string()
    .optional()
    .describe(
      "Catalog id (mt_…) of a registered method. Validates the method's CURRENT stored content — requires an API key (the catalog is org-scoped). With files also present, the files win and method_id is ignored. Provide files or method_id.",
    ),
  include_graph: z
    .boolean()
    .optional()
    .describe("Whether to include graph_spec in successful responses. Defaults to true."),
};

/**
 * Identifiers of the renderable views this result can drive. The model never
 * sees `_meta`, so this list is how it learns a view is available to surface.
 * `"dry_run_graph"` is the method graph produced by a `/validate` dry run,
 * whose spec rides the tool result's `_meta.graph_spec`; `"input_form"` is the
 * fill-in form for the main pipe's declared inputs, driven by the wire
 * input-form descriptor riding `_meta.input_form` with the per-pipe IO
 * contracts beside it on `_meta.pipe_io_contracts` (only on a runnable verdict
 * that carries both — a form that cannot submit, or cannot derive its fields,
 * is not a view worth advertising). Extend the enum when a new view kind
 * ships.
 */
const viewSpecSchema = z.enum(["dry_run_graph", "input_form"]);

const validationStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  is_runnable: z.boolean(),
  pending_signatures: z.array(z.string()),
  available_view_specs: z
    .array(viewSpecSchema)
    .describe(
      'Renderable views available for this result. Contains "dry_run_graph" when an interactive method graph (from the validation dry run) is available to display, and "input_form" when a fill-in form for the main pipe\'s inputs (with a Run button) is available on a runnable verdict; empty otherwise.',
    ),
  validation_errors: z.array(z.unknown()).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsValidateOutputSchema = validationStructuredContentSchema;

export interface MthdsValidateInput {
  files?: SubmittedFileInput[];
  method_id?: string;
  include_graph?: boolean;
}

/** The validate request after `{ path }` resolution — what the checks and the fetch-or-call step consume. */
interface ResolvedValidateRequest {
  files: SubmittedFile[];
  method_id?: string;
  include_graph?: boolean;
}

export type ViewSpec = z.infer<typeof viewSpecSchema>;

export interface ValidationStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  available_view_specs: ViewSpec[];
  validation_errors?: unknown[];
  errors?: ToolError[];
}

export interface ValidationResult {
  structuredContent: ValidationStructuredContent;
  summary: string;
  /**
   * Graph payload for the Skybridge view only. It rides the tool result's
   * `_meta` (never `structuredContent`), so the model never pays its tokens —
   * the agent acts on the verdict in `structuredContent` and the Markdown
   * summary, never the raw graph. Opaque (`unknown`) here; the view casts it to
   * `@pipelex/mthds-ui`'s `GraphSpec`. Populated only on a valid verdict when
   * `include_graph !== false` and the invoking shell has a registered view.
   */
  graphSpec?: unknown;
  /**
   * Per-pipe IO contracts for the Skybridge view only, keyed by namespaced
   * `pipe_ref` (`domain.code`) — what `@pipelex/mthds-ui`'s `RunPanel` needs
   * to render the input form. Same channel discipline as `graphSpec`: rides
   * `_meta`, never `structuredContent`. Opaque here; `@pipelex/mthds-form`
   * owns the type. Populated only on a valid **and runnable** verdict when the
   * invoking shell has a registered view.
   */
  pipeIoContracts?: unknown;
  /**
   * The wire input-form descriptor (the report's `input_form`, requested via
   * `views: ["input_form"]`) — the contracts' ordered sibling artifact. Since
   * kernel 0.5.0 the descriptor IS the form derivation (`RunPanel` requires
   * it and renders nothing without it), so it is populated together with
   * `pipeIoContracts` and the form view is advertised only when both arrived.
   * Same channel discipline: rides `_meta`, never `structuredContent`; opaque
   * here, `mthds/protocol` owns the type.
   */
  inputForm?: unknown;
  /**
   * The bundle's main pipe as a namespaced `pipe_ref`, derived from
   * `bundle_blueprint`, so the view can pick the default contract without
   * parsing the blueprint itself. Absent when the blueprint declares no
   * `main_pipe` (the API returns no graph in that case either).
   */
  mainPipeRef?: string;
}

interface ValidationClient extends MethodFetchClient {
  validateFiles(
    files: MthdsFile[],
    options?: ValidateFilesOptions,
  ): Promise<PipelexValidationResult>;
}

export interface ValidationContext {
  baseUrl: string;
  apiKey?: string;
  client?: ValidationClient;
  /** Fills `{ path }` items from disk (local workshop); absent on the hosted console. */
  resolver?: FileResolver;
  /** Whether this shell can render the graph carried on the view-only channel. */
  viewsAvailable?: boolean;
  /** Deployment-specific auth-failure texture (the hosted console overrides it per request); default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildValidationContext(env = process.env): ValidationContext {
  return buildApiConfig(env);
}

const VALIDATE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
};

// Constructed inside each caught block (mirroring run.ts's runClient): the SDK
// constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
function validationClient(context: ValidationContext): ValidationClient {
  return (
    context.client ??
    new PipelexApiClient({
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    })
  );
}

export async function validateMthds(
  input: MthdsValidateInput,
  context: ValidationContext = buildValidationContext(),
): Promise<ValidationResult> {
  const resolution = await resolveSubmittedFiles(input.files ?? [], context.resolver);
  if (resolution.errors.length > 0) {
    return errorResult("Validation was not run: request input is invalid.", resolution.errors);
  }

  const request: ResolvedValidateRequest = { ...input, files: resolution.files };
  const inputErrors = validateFilesOrMethodIdRequest(request.files, request.method_id);
  if (inputErrors.length > 0) {
    return errorResult("Validation was not run: request input is invalid.", inputErrors);
  }

  // Fetch-and-forward: /v1/validate has no by-id support, so an id-only
  // request fetches the stored method and forwards its current source as the
  // submitted files (each labeled with the method id as provenance). Inline
  // files win — with both supplied, method_id is ignored (no linkage concept
  // on this route, unlike /v1/start).
  let files = request.files;
  if (files.length === 0 && request.method_id !== undefined) {
    const fetched = await fetchMethodFiles(() => validationClient(context), request.method_id, {
      authError: context.authError,
      noSourceHint:
        "Add MTHDS content to the method (e.g. in the webapp editor) before validating it, or submit files instead.",
    });
    if (!fetched.ok) {
      const summary =
        fetched.reason === "no_source"
          ? "Validation was not run: the stored method has no MTHDS source."
          : summaryForError(fetched.error);
      return errorResult(summary, [fetched.error]);
    }
    files = fetched.files;
  }

  let report: PipelexValidationResult;
  try {
    // `views` is the structured-view opt-in (the `render` sibling): the
    // descriptor spec keeps `input_form` off the report unless a caller asks.
    // Tokens are lenient — a runner that predates the field simply returns no
    // `input_form`, and the form view is then not advertised.
    report = await validationClient(context).validateFiles(toMthdsFiles(files), {
      allowSignatures: true,
      render: ["markdown"],
      views: ["input_form"],
    });
  } catch (err) {
    const error = classifyError(err, { ...VALIDATE_ERROR_OPTIONS, auth: context.authError });
    return errorResult(summaryForError(error), [error]);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (e.g. missing rendered_markdown) is a reachable
  // contract violation, surfaced as a runtime no-verdict error.
  try {
    return validationResult(
      report,
      input.include_graph !== false,
      context.viewsAvailable !== false,
    );
  } catch (err) {
    return errorResult(
      "Validation produced no verdict: the Pipelex API returned a malformed report.",
      [
        {
          class: "runtime",
          message:
            err instanceof Error
              ? err.message
              : "The Pipelex API returned a malformed validation report.",
          hint: "The API responded but its report was missing required fields; inspect pipelex-api logs.",
          retryable: false,
        },
      ],
    );
  }
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "Validation could not start: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Validation was not run: the Pipelex API rejected the request.",
  runtime: "Validation could not be completed: the Pipelex API returned an error.",
  paywall: "Validation could not start: the organization's Pipelex plan does not cover this call.",
};

function summaryForError(error: ToolError): string {
  return summaryForToolError(error, ERROR_SUMMARIES);
}

export function toolResult(result: ValidationResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
    // View-only channel: the graph rides `_meta`, never `structuredContent`, so
    // the model never pays its tokens. `_meta` still travels on the raw MCP
    // result, so a non-LLM programmatic consumer can read it off the wire —
    // `_meta` only withholds it from the model's context. The Skybridge view
    // reads it back as `useToolInfo().responseMetadata.graph_spec`. The IO
    // contracts, their input-form descriptor, and the main pipe ref ride the
    // same channel for the input form.
    _meta: {
      graph_spec: result.graphSpec,
      pipe_io_contracts: result.pipeIoContracts,
      input_form: result.inputForm,
      main_pipe_ref: result.mainPipeRef,
    },
  };
}

export function validationResult(
  report: PipelexValidationResult,
  includeGraph: boolean,
  viewsAvailable = true,
): ValidationResult {
  const structuredContent: ValidationStructuredContent = {
    status: "ok",
    is_valid: report.is_valid,
    is_runnable: report.is_runnable,
    pending_signatures: report.pending_signatures,
    available_view_specs: [],
  };

  let graphSpec: unknown;
  let pipeIoContracts: unknown;
  let inputForm: unknown;
  let mainPipeRef: string | undefined;
  if (report.is_valid) {
    const validReport = report as PipelexValidationReport;
    if (includeGraph && viewsAvailable) {
      graphSpec = validReport.graph_spec;
    }
    // The input form is only worth advertising when the method can actually
    // run: a pending-signature verdict would render a form whose Run button
    // can only fail. It also needs BOTH artifacts — since kernel 0.5.0 the
    // wire descriptor drives the derivation and `RunPanel` renders nothing
    // without it — so a runner that ignored the `views` token (no `input_form`
    // on the report) advertises no form rather than a dead one. Independent of
    // `include_graph`.
    if (
      viewsAvailable &&
      report.is_runnable &&
      hasEntries(validReport.pipe_io_contracts) &&
      hasEntries(validReport.input_form)
    ) {
      pipeIoContracts = validReport.pipe_io_contracts;
      inputForm = validReport.input_form;
      mainPipeRef = mainPipeRefOf(validReport.bundle_blueprint);
    }
  } else {
    const invalidReport = report as PipelexInvalidReport;
    structuredContent.validation_errors = invalidReport.validation_errors;
  }

  if (report.rendered_markdown == null) {
    throw new Error("Validation report did not include rendered markdown.");
  }

  let summary = report.rendered_markdown;

  // Advertise the dry-run graph view to the model only when a graph spec was
  // actually produced (valid verdict + include_graph). The spec itself rides
  // `_meta`, which the model never sees — `available_view_specs` is the
  // structured signal, and the Markdown note is the prose one for agents that
  // read the summary more reliably than the structured fields.
  if (graphSpec != null) {
    structuredContent.available_view_specs.push("dry_run_graph");
  }
  if (inputForm != null) {
    structuredContent.available_view_specs.push("input_form");
  }
  if (structuredContent.available_view_specs.length > 0) {
    summary += `\n\n## Views\n\n${viewsNote(structuredContent.available_view_specs)}`;
  }

  return {
    structuredContent,
    summary,
    graphSpec,
    pipeIoContracts,
    inputForm,
    mainPipeRef,
  };
}

/** The prose counterpart of `available_view_specs`, for agents that read the summary. */
function viewsNote(specs: ViewSpec[]): string {
  const hasGraph = specs.includes("dry_run_graph");
  const hasForm = specs.includes("input_form");
  if (hasGraph && hasForm) {
    return "The validation result includes a graph view of the method (dry run) and an input form the user can fill in to run it.";
  }
  if (hasForm) {
    return "The validation result includes an input form the user can fill in to run the method.";
  }
  return "The validation result includes a graph view of the method (dry run).";
}

/** A non-empty record — the presence test for both per-pipe artifacts. */
function hasEntries(artifact: unknown): boolean {
  return typeof artifact === "object" && artifact !== null && Object.keys(artifact).length > 0;
}

/**
 * `domain.main_pipe` from the batch's primary blueprint, or undefined when the
 * blueprint declares no main pipe. Both fields are plain strings on the
 * blueprint; anything else is treated as absent rather than guessed at.
 */
function mainPipeRefOf(blueprint: Record<string, unknown>): string | undefined {
  const domain = blueprint.domain;
  const mainPipe = blueprint.main_pipe;
  if (typeof mainPipe !== "string" || mainPipe.length === 0) {
    return undefined;
  }
  return typeof domain === "string" && domain.length > 0 ? `${domain}.${mainPipe}` : mainPipe;
}

function toMthdsFiles(files: SubmittedFile[]): MthdsFile[] {
  return files.map((file) => {
    if (file.uri === undefined || file.uri === null) {
      return { content: file.content };
    }
    return { content: file.content, uri: file.uri };
  });
}

function errorResult(summary: string, errors: ToolError[]): ValidationResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      is_runnable: false,
      pending_signatures: [],
      available_view_specs: [],
      errors,
    },
    summary,
  };
}
