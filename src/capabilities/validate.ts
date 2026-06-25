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
  ValidateFilesOptions,
} from "mthds";
import { z } from "zod";

const DEFAULT_LOCAL_API_URL = "http://localhost:8081";

export const mthdsValidateInputSchema = {
  files: z
    .array(
      z.object({
        content: z.string().describe("The full .mthds file contents."),
        uri: z
          .string()
          .nullable()
          .optional()
          .describe("Optional provenance URI for diagnostics."),
      }),
    )
    .describe("One or more submitted MTHDS files to validate."),
  bundle_uri: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional provenance URI for the intended bundle entry. Must match a submitted file uri.",
    ),
  allow_signatures: z
    .boolean()
    .optional()
    .describe(
      "Whether unresolved pipe signatures are accepted as pending instead of invalid.",
    ),
  include_graph: z
    .boolean()
    .optional()
    .describe("Whether to include graph_spec in successful responses. Defaults to true."),
  render_markdown: z
    .boolean()
    .optional()
    .describe("Whether to request rendered markdown from the local API."),
};

const errorClassSchema = z.enum(["input_domain", "config", "runtime"]);

const validationErrorSchema = z.object({
  class: errorClassSchema,
  location: z.string().optional(),
  message: z.string(),
  hint: z.string().optional(),
});

const validationDataSchema = z.object({
  is_valid: z.boolean(),
  is_runnable: z.boolean(),
  pending_signatures: z.array(z.string()),
  validation_errors: z.array(z.unknown()).optional(),
  pipe_io_contracts: z.record(z.string(), z.unknown()).optional(),
  graph_spec: z.unknown().optional(),
  rendered_markdown: z.string().optional(),
});

export const mthdsValidateOutputSchema = {
  status: z.enum(["ok", "error"]),
  summary: z.string(),
  data: validationDataSchema.optional(),
  errors: z.array(validationErrorSchema).optional(),
};

export interface MthdsValidateInput {
  files: Array<{ content: string; uri?: string | null }>;
  bundle_uri?: string | null;
  allow_signatures?: boolean;
  include_graph?: boolean;
  render_markdown?: boolean;
}

type ErrorClass = z.infer<typeof errorClassSchema>;

export interface ToolError {
  class: ErrorClass;
  location?: string;
  message: string;
  hint?: string;
}

export interface ValidationEnvelope {
  status: "ok" | "error";
  summary: string;
  data?: {
    is_valid: boolean;
    is_runnable: boolean;
    pending_signatures: string[];
    validation_errors?: unknown[];
    pipe_io_contracts?: Record<string, unknown>;
    graph_spec?: unknown;
    rendered_markdown?: string;
  };
  errors?: ToolError[];
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

export function buildValidationContext(
  env: ValidationEnv = process.env,
): ValidationContext {
  return {
    apiUrl: env.MTHDS_API_URL ?? DEFAULT_LOCAL_API_URL,
    apiKey: env.MTHDS_API_KEY || undefined,
  };
}

export async function validateMthds(
  input: MthdsValidateInput,
  context: ValidationContext = buildValidationContext(),
): Promise<ValidationEnvelope> {
  const inputErrors = validateRequest(input.files, input.bundle_uri);
  if (inputErrors.length > 0) {
    return errorEnvelope(
      "Validation was not run: request input is invalid.",
      inputErrors,
    );
  }

  try {
    const client =
      context.client ??
      new MthdsApiClient({
        baseUrl: context.apiUrl,
        apiToken: context.apiKey,
      });
    const report = await client.validateFiles(toMthdsFiles(input.files), {
      allowSignatures: input.allow_signatures ?? false,
      render: input.render_markdown ? ["markdown"] : undefined,
    });

    return validationEnvelope(report, input.include_graph !== false);
  } catch (err) {
    return errorEnvelope("Validation did not produce a verdict.", [
      classifyError(err),
    ]);
  }
}

export function toolResult(envelope: ValidationEnvelope) {
  return {
    structuredContent: envelope,
    content: [{ type: "text" as const, text: envelope.summary }],
    isError: envelope.status === "error",
  };
}

export function validateRequest(
  files: Array<{ content: string; uri?: string | null }>,
  bundleUri?: string | null,
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

  if (bundleUri !== undefined && bundleUri !== null) {
    if (bundleUri.trim() === "") {
      errors.push({
        class: "input_domain",
        location: "bundle_uri",
        message: "bundle_uri must not be empty when supplied.",
        hint: "Omit bundle_uri or set it to one submitted file uri.",
      });
    } else {
      const submittedUris = new Set(
        files
          .map((file) => file.uri)
          .filter((uri): uri is string => uri !== undefined && uri !== null),
      );
      if (!submittedUris.has(bundleUri)) {
        errors.push({
          class: "input_domain",
          location: "bundle_uri",
          message: "bundle_uri must match one submitted file uri.",
          hint: "bundle_uri is provenance-only in v0.1 and does not select an entry file.",
        });
      }
    }
  }

  return errors;
}

export function validationEnvelope(
  report: PipelexValidationResult,
  includeGraph: boolean,
): ValidationEnvelope {
  if (!report.is_valid) {
    const errorCount = report.validation_errors.length;
    const data: NonNullable<ValidationEnvelope["data"]> = {
      is_valid: false,
      is_runnable: false,
      pending_signatures: [],
      validation_errors: report.validation_errors,
    };
    if (typeof report.rendered_markdown === "string") {
      data.rendered_markdown = report.rendered_markdown;
    }
    return {
      status: "ok",
      summary: `Validation completed and found ${errorCount} ${plural(
        errorCount,
        "error",
      )}.`,
      data,
    };
  }

  const pendingCount = report.pending_signatures.length;
  const data: NonNullable<ValidationEnvelope["data"]> = {
    is_valid: true,
    is_runnable: report.is_runnable,
    pending_signatures: report.pending_signatures,
    pipe_io_contracts: report.pipe_io_contracts,
  };

  if (includeGraph) {
    data.graph_spec = report.graph_spec;
  }
  if (typeof report.rendered_markdown === "string") {
    data.rendered_markdown = report.rendered_markdown;
  }

  if (!report.is_runnable) {
    return {
      status: "ok",
      summary: `Validation passed with ${pendingCount} pending ${plural(
        pendingCount,
        "signature",
      )}; the bundle is not runnable yet.`,
      data,
    };
  }

  return {
    status: "ok",
    summary: "Validation passed; the bundle is runnable.",
    data,
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
      hint: "Check the API key for the configured MTHDS API.",
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

function toMthdsFiles(
  files: Array<{ content: string; uri?: string | null }>,
): MthdsFile[] {
  return files.map((file) => {
    if (file.uri === undefined || file.uri === null) {
      return { content: file.content };
    }
    return { content: file.content, uri: file.uri };
  });
}

function errorEnvelope(
  summary: string,
  errors: ToolError[],
): ValidationEnvelope {
  return {
    status: "error",
    summary,
    errors,
  };
}

function classifyApiResponseError(
  err: ApiResponseError,
): ToolError {
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
      hint: "The MTHDS API returned a server error; inspect pipelex-api logs.",
    };
  }

  return {
    class: "runtime",
    message,
    hint: `The MTHDS API returned HTTP ${err.status}.`,
  };
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
