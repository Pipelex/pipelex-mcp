import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  MthdsApiClient,
  PipelineRequestError,
} from "mthds";
import type {
  MthdsFile,
  PipelexValidationResult,
  PipelexValidationReport,
  PipelexInvalidReport,
  ValidateFilesOptions,
} from "mthds";
import { z } from "zod";

const DEFAULT_LOCAL_API_URL = "http://localhost:8081";

export const mthdsValidateInputSchema = {
  files: z
    .array(
      z.object({
        content: z.string().describe("The full .mthds file contents."),
        uri: z.string().nullable().optional().describe("Optional provenance URI for diagnostics."),
      }),
    )
    .describe("One or more submitted MTHDS files to validate."),
  include_graph: z
    .boolean()
    .optional()
    .describe("Whether to include graph_spec in successful responses. Defaults to true."),
};

const errorClassSchema = z.enum(["input_domain", "config", "runtime"]);

const validationErrorSchema = z.object({
  class: errorClassSchema,
  location: z.string().optional(),
  message: z.string(),
  hint: z.string().optional(),
});

const validationStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  is_runnable: z.boolean(),
  pending_signatures: z.array(z.string()),
  validation_errors: z.array(z.unknown()).optional(),
  graph_spec: z.unknown().optional(),
  errors: z.array(validationErrorSchema).optional(),
});

export const mthdsValidateOutputSchema = validationStructuredContentSchema;

export interface MthdsValidateInput {
  files: Array<{ content: string; uri?: string | null }>;
  include_graph?: boolean;
}

type ErrorClass = z.infer<typeof errorClassSchema>;

export interface ToolError {
  class: ErrorClass;
  location?: string;
  message: string;
  hint?: string;
}

export interface ValidationStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  validation_errors?: unknown[];
  graph_spec?: unknown;
  errors?: ToolError[];
}

export interface ValidationResult {
  structuredContent: ValidationStructuredContent;
  summary: string;
}

interface ValidationClient {
  validateFiles(
    files: MthdsFile[],
    options?: ValidateFilesOptions,
  ): Promise<PipelexValidationResult>;
}

export interface ValidationContext {
  apiUrl: string;
  apiKey?: string;
  client?: ValidationClient;
}

interface ValidationEnv {
  MTHDS_API_URL?: string;
  MTHDS_API_KEY?: string;
}

export function buildValidationContext(env: ValidationEnv = process.env): ValidationContext {
  return {
    apiUrl: env.MTHDS_API_URL ?? DEFAULT_LOCAL_API_URL,
    apiKey: env.MTHDS_API_KEY || undefined,
  };
}

export async function validateMthds(
  input: MthdsValidateInput,
  context: ValidationContext = buildValidationContext(),
): Promise<ValidationResult> {
  const inputErrors = validateRequest(input.files);
  if (inputErrors.length > 0) {
    return errorResult("Validation was not run: request input is invalid.", inputErrors);
  }

  try {
    const client =
      context.client ??
      new MthdsApiClient({
        baseUrl: context.apiUrl,
        apiToken: context.apiKey,
      });
    const report = await client.validateFiles(toMthdsFiles(input.files), {
      allowSignatures: true,
      render: ["markdown"],
    });

    return validationResult(report, input.include_graph !== false);
  } catch (err) {
    return errorResult("Validation could not start: the Pipelex API is unreachable.", [classifyError(err)]);
  }
}

export function toolResult(structuredContent: ValidationStructuredContent, summary: string) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text: summary }],
    isError: structuredContent.status === "error",
  };
}

export function validateRequest(
  files: Array<{ content: string; uri?: string | null }>,
): ToolError[] {
  const errors: ToolError[] = [];

  if (files.length === 0) {
    errors.push({
      class: "input_domain",
      location: "files",
      message: "At least one MTHDS file must be submitted.",
      hint: "Pass files as [{ content, uri? }].",
    });
  }

  for (const [index, file] of files.entries()) {
    if (file.uri !== undefined && file.uri !== null && file.uri.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `files[${index}].uri`,
        message: "File uri must not be empty when supplied.",
        hint: "Omit uri for inline content or provide a stable path or URI.",
      });
    }
  }

  return errors;
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
  };

  if (report.is_valid) {
    const validReport = report as PipelexValidationReport;
    if (includeGraph) {
      structuredContent.graph_spec = validReport.graph_spec;
    }
  } else {
    const invalidReport = report as PipelexInvalidReport;
    structuredContent.validation_errors = invalidReport.validation_errors;
  }

  if (report.rendered_markdown == null) {
    throw new Error("Validation report did not include rendered markdown.");
  }

  return {
    structuredContent,
    summary: report.rendered_markdown,
  };
}

export function classifyError(err: unknown): ToolError {
  if (err instanceof ApiUnreachableError) {
    return {
      class: "config",
      location: "MTHDS_API_URL",
      message: err.message,
      hint: "Start pipelex-api locally or set MTHDS_API_URL to a reachable host-only API base URL.",
    };
  }

  if (err instanceof ClientAuthenticationError) {
    return {
      class: "config",
      location: "MTHDS_API_KEY",
      message: err.message,
      hint: "Check the API key for the configured Pipelex API.",
    };
  }

  if (err instanceof ApiResponseError) {
    return classifyApiResponseError(err);
  }

  if (err instanceof PipelineRequestError) {
    return {
      class: "config",
      location: "MTHDS_API_URL",
      message: err.message,
      hint: "Check MTHDS_API_URL and the submitted validation request.",
    };
  }

  if (err instanceof Error) {
    return {
      class: "runtime",
      message: err.message,
      hint: "Inspect the MCP server logs and local pipelex-api logs.",
    };
  }

  return {
    class: "runtime",
    message: "Unknown validation failure.",
    hint: "Inspect the MCP server logs and local pipelex-api logs.",
  };
}

function toMthdsFiles(files: Array<{ content: string; uri?: string | null }>): MthdsFile[] {
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
      errors,
    },
    summary,
  };
}

function classifyApiResponseError(err: ApiResponseError): ToolError {
  const message = err.serverMessage ?? err.message;

  if (err.status === 400 || err.status === 422) {
    return {
      class: "input_domain",
      location: "files",
      message,
      hint: "Check the submitted file contents and provenance fields.",
    };
  }

  if (err.status === 401 || err.status === 403) {
    return {
      class: "config",
      location: "MTHDS_API_KEY",
      message,
      hint: "Check MTHDS_API_KEY for the configured API.",
    };
  }

  if (err.status === 404) {
    return {
      class: "config",
      location: "MTHDS_API_URL",
      message,
      hint: "Check that MTHDS_API_URL points to a host serving /v1/validate.",
    };
  }

  if (err.status >= 500) {
    return {
      class: "runtime",
      message,
      hint: "The Pipelex API returned a server error; inspect pipelex-api logs.",
    };
  }

  return {
    class: "runtime",
    message,
    hint: `The Pipelex API returned HTTP ${err.status}.`,
  };
}
