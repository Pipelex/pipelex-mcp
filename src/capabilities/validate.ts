import { PipelexApiClient } from "@pipelex/sdk";
import type {
  MthdsFile,
  PipelexValidationResult,
  PipelexValidationReport,
  PipelexInvalidReport,
  ValidateFilesOptions,
  ValidateMethodSelector,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  METHOD_REF_GRAMMAR,
  buildApiConfig,
  classifyError,
  summaryForToolError,
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
  SubmittedFile,
  SubmittedFileInput,
  ErrorSummaries,
  ToolError,
} from "./shared.js";

export const mthdsValidateInputSchema = {
  files: filesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR}. Resolved server-side: the repository is fetched at the tag and the package's own file names label the diagnostics; no bundle enters the conversation. Supply exactly ONE of files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      "Catalog id (mt_…) of a registered method. Validates the method's CURRENT stored content server-side — requires an API key (the catalog is org-scoped). Supply exactly ONE of files / method_ref / method_id.",
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
  method_ref?: string;
  method_id?: string;
  include_graph?: boolean;
}

/** The validate request after `{ path }` resolution — what the checks and the API call consume. */
interface ResolvedValidateRequest {
  files: SubmittedFile[];
  method_ref?: string;
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

interface ValidationClient {
  validateFiles(
    files: MthdsFile[],
    options?: ValidateFilesOptions,
  ): Promise<PipelexValidationResult>;
  /**
   * The selector arm of `POST /v1/validate` — the SDK's low-level `validate`
   * with a `{ method_ref }` / `{ method_id }` source (mthds_sources must stay
   * undefined for selectors: labels come from the package's, or the stored
   * method's, real file names).
   */
  validate(
    source: ValidateMethodSelector,
    allowSignatures?: boolean,
    mthdsSources?: string[],
    render?: string[],
    views?: string[],
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

/**
 * Classify options for an address-shaped request. The runner's `method_ref`
 * failures keep their class names as distinct error types over the wire: a
 * ref that does not parse or fetch, or an ambiguous one, is a 422; no package
 * matching the address is a 404; the reserved registry form is a 501 — all the
 * caller's own selector, located at `method_ref`. (The structures-refusal 403
 * is classified route-independently in `classifyError`.)
 */
const VALIDATE_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
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
};

/**
 * Classify options for an id-shaped request. The hosted platform resolves the
 * id and injects the stored source before the runner sees the request; an
 * unknown or foreign-org id is a 404 (indistinguishable by design), a stored
 * method with no MTHDS source is a 422, and a deployment with no catalog (a
 * bare pipelex-api runner, or a hosted plane that predates the tooling
 * selector) rejects the request-shape too — the 422 hint covers all three.
 */
const VALIDATE_BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
  badRequest: {
    location: "method_id",
    hint: "The stored method may have no MTHDS source yet, or this deployment may not resolve method_id on /v1/validate — the selector is hosted-only (a bare pipelex-api runner has no catalog). Submit files or a method_ref instead if it persists.",
  },
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. Check the id as the catalog returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss.",
  },
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
  const inputErrors = validateMethodSelectorRequest(request.files, request, {
    rule: "one_selector",
  });
  if (inputErrors.length > 0) {
    return errorResult("Validation was not run: request input is invalid.", inputErrors);
  }

  // Classify options follow the request's selector shape — each failure
  // locates at the field that caused it.
  const classifyOptions =
    request.files.length > 0
      ? VALIDATE_ERROR_OPTIONS
      : request.method_ref !== undefined
        ? VALIDATE_BY_REF_ERROR_OPTIONS
        : VALIDATE_BY_ID_ERROR_OPTIONS;

  let report: PipelexValidationResult;
  try {
    // `views` is the structured-view opt-in (the `render` sibling): the
    // descriptor spec keeps `input_form` off the report unless a caller asks.
    // Tokens are lenient — a runner that predates the field simply returns no
    // `input_form`, and the form view is then not advertised. A selector is a
    // SERVER pass-through on `POST /v1/validate` itself: the runner resolves
    // an address, the hosted platform resolves an id — nothing is expanded
    // client-side, and `mthds_sources` stays undefined (labels come from the
    // package's, or the stored method's, real file names).
    const client = validationClient(context);
    if (request.files.length > 0) {
      report = await client.validateFiles(toMthdsFiles(request.files), {
        allowSignatures: true,
        render: ["markdown"],
        views: ["input_form"],
      });
    } else if (request.method_ref !== undefined) {
      report = await client.validate(
        { method_ref: request.method_ref },
        true,
        undefined,
        undefined,
        ["input_form"],
      );
    } else if (request.method_id !== undefined) {
      report = await client.validate({ method_id: request.method_id }, true, undefined, undefined, [
        "input_form",
      ]);
    } else {
      // Unreachable: the selector checks above guarantee a source.
      throw new Error("No method selector survived request validation.");
    }
  } catch (err) {
    const error = classifyError(err, { ...classifyOptions, auth: context.authError });
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
