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
  filesInputSchema,
  resolveSubmittedFiles,
  toolErrorSchema,
  validateRequest,
} from "./shared.js";
import type {
  ClassifyErrorOptions,
  FileResolver,
  SubmittedFile,
  SubmittedFileInput,
  ToolError,
} from "./shared.js";

export const mthdsValidateInputSchema = {
  files: filesInputSchema,
  include_graph: z
    .boolean()
    .optional()
    .describe("Whether to include graph_spec in successful responses. Defaults to true."),
};

/**
 * Identifiers of the renderable views this result can drive. The model never
 * sees `_meta`, so this list is how it learns a view is available to surface.
 * For now the only kind is `"dry_run_graph"` — the method graph produced by a
 * `/validate` dry run, whose spec rides the tool result's `_meta.graph_spec`.
 * Extend the enum when a new view kind ships.
 */
const viewSpecSchema = z.enum(["dry_run_graph"]);

const validationStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  is_runnable: z.boolean(),
  pending_signatures: z.array(z.string()),
  available_view_specs: z
    .array(viewSpecSchema)
    .describe(
      'Renderable views available for this result. Contains "dry_run_graph" when an interactive method graph (from the validation dry run) is available to display; empty otherwise.',
    ),
  validation_errors: z.array(z.unknown()).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsValidateOutputSchema = validationStructuredContentSchema;

export interface MthdsValidateInput {
  files: SubmittedFileInput[];
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
   * `include_graph !== false`.
   */
  graphSpec?: unknown;
}

interface ValidationClient {
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
}

export function buildValidationContext(env = process.env): ValidationContext {
  return buildApiConfig(env);
}

const VALIDATE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
};

export async function validateMthds(
  input: MthdsValidateInput,
  context: ValidationContext = buildValidationContext(),
): Promise<ValidationResult> {
  const resolution = await resolveSubmittedFiles(input.files, context.resolver);
  if (resolution.errors.length > 0) {
    return errorResult("Validation was not run: request input is invalid.", resolution.errors);
  }

  const files = resolution.files;
  const inputErrors = validateRequest(files);
  if (inputErrors.length > 0) {
    return errorResult("Validation was not run: request input is invalid.", inputErrors);
  }

  let report: PipelexValidationResult;
  try {
    const client =
      context.client ??
      new PipelexApiClient({
        baseUrl: context.baseUrl,
        apiKey: context.apiKey,
      });
    report = await client.validateFiles(toMthdsFiles(files), {
      allowSignatures: true,
      render: ["markdown"],
    });
  } catch (err) {
    const error = classifyError(err, VALIDATE_ERROR_OPTIONS);
    return errorResult(summaryForError(error), [error]);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (e.g. missing rendered_markdown) is a reachable
  // contract violation, surfaced as a runtime no-verdict error.
  try {
    return validationResult(report, input.include_graph !== false);
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

function summaryForError(error: ToolError): string {
  switch (error.class) {
    case "config":
      return "Validation could not start: the Pipelex API is unreachable or misconfigured.";
    case "input_domain":
      return "Validation was not run: the Pipelex API rejected the request.";
    case "runtime":
      return "Validation could not be completed: the Pipelex API returned an error.";
  }
}

export function toolResult(result: ValidationResult) {
  return {
    structuredContent: result.structuredContent,
    content: [{ type: "text" as const, text: result.summary }],
    isError: result.structuredContent.status === "error",
    // View-only channel: the graph rides `_meta`, never `structuredContent`, so
    // the model never pays its tokens. `_meta` still travels on the raw MCP
    // result, so a non-LLM programmatic consumer can read it off the wire —
    // `_meta` only withholds it from the model's context. The Skybridge view
    // reads it back as `useToolInfo().responseMetadata.graph_spec`.
    _meta: { graph_spec: result.graphSpec },
  };
}

export function validationResult(
  report: PipelexValidationResult,
  includeGraph: boolean,
): ValidationResult {
  const structuredContent: ValidationStructuredContent = {
    status: "ok",
    is_valid: report.is_valid,
    is_runnable: report.is_runnable,
    pending_signatures: report.pending_signatures,
    available_view_specs: [],
  };

  let graphSpec: unknown;
  if (report.is_valid) {
    const validReport = report as PipelexValidationReport;
    if (includeGraph) {
      graphSpec = validReport.graph_spec;
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
    structuredContent.available_view_specs = ["dry_run_graph"];
    summary +=
      "\n\n## Views\n\nThe validation result includes a graph view of the method (dry run).";
  }

  return {
    structuredContent,
    summary,
    graphSpec,
  };
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
