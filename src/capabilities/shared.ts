import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  PipelineRequestError,
} from "@pipelex/sdk";
import { z } from "zod";

export const DEFAULT_API_URL = "https://api.pipelex.com";

/**
 * The submitted-files shape every capability shares on its MCP input. The API
 * routes spell the provenance label differently (`uri` on `/v1/validate`,
 * `source` on the `/v1/build/*` envelope); the MCP surface always says `uri`
 * and each capability adapts at its own boundary.
 */
export const filesInputSchema = z
  .array(
    z.object({
      content: z.string().describe("The full .mthds file contents."),
      uri: z.string().nullable().optional().describe("Optional provenance URI for diagnostics."),
    }),
  )
  .describe("One or more submitted MTHDS files forming the method closure.");

export interface SubmittedFile {
  content: string;
  uri?: string | null;
}

export const errorClassSchema = z.enum(["input_domain", "config", "runtime"]);

export type ErrorClass = z.infer<typeof errorClassSchema>;

export const toolErrorSchema = z.object({
  class: errorClassSchema,
  location: z.string().optional(),
  message: z.string(),
  hint: z.string().optional(),
});

export interface ToolError {
  class: ErrorClass;
  location?: string;
  message: string;
  hint?: string;
}

/** The env-derived API coordinates every capability context starts from. */
export interface ApiConfig {
  baseUrl: string;
  apiKey?: string;
}

interface ApiEnv {
  PIPELEX_BASE_URL?: string;
  PIPELEX_API_KEY?: string;
}

export function buildApiConfig(env: ApiEnv = process.env): ApiConfig {
  return {
    baseUrl: env.PIPELEX_BASE_URL || DEFAULT_API_URL,
    apiKey: env.PIPELEX_API_KEY || undefined,
  };
}

/** Request-shape checks on the shared submitted-files input. */
export function validateRequest(files: SubmittedFile[]): ToolError[] {
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
    if (file.content.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `files[${index}].content`,
        message: "File content must not be empty.",
        hint: "Submit the full .mthds file contents.",
      });
    }

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

/**
 * Route-specific texture for {@link classifyError}. The classification itself
 * (which HTTP status or SDK error maps to which `ErrorClass`) is shared; only
 * the locator and hint of a 400/422 rejection and the route named in the 404
 * hint differ per capability.
 */
export interface ClassifyErrorOptions {
  /** The API route the capability calls, named in the 404 hint. */
  route?: string;
  /** Locator + hint for a 400/422 no-verdict rejection. */
  badRequest?: {
    location?: string;
    hint: string;
  };
}

const DEFAULT_BAD_REQUEST = {
  location: "files",
  hint: "Check the submitted file contents and provenance fields.",
};

export function classifyError(err: unknown, options: ClassifyErrorOptions = {}): ToolError {
  if (err instanceof ApiUnreachableError) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: err.message,
      hint: "Start pipelex-api locally or set PIPELEX_BASE_URL to a reachable host-only API base URL.",
    };
  }

  if (err instanceof ClientAuthenticationError) {
    return {
      class: "config",
      location: "PIPELEX_API_KEY",
      message: err.message,
      hint: "Check the API key for the configured Pipelex API.",
    };
  }

  if (err instanceof ApiResponseError) {
    return classifyApiResponseError(err, options);
  }

  if (err instanceof PipelineRequestError) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: err.message,
      hint: "Check PIPELEX_BASE_URL and the submitted request.",
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
    message: "Unknown failure.",
    hint: "Inspect the MCP server logs and local pipelex-api logs.",
  };
}

function classifyApiResponseError(err: ApiResponseError, options: ClassifyErrorOptions): ToolError {
  const message = err.serverMessage ?? err.message;
  const badRequest = options.badRequest ?? DEFAULT_BAD_REQUEST;
  const route = options.route ?? "the Pipelex API";

  if (err.status === 400 || err.status === 422) {
    return {
      class: "input_domain",
      ...(badRequest.location === undefined ? {} : { location: badRequest.location }),
      message,
      hint: badRequest.hint,
    };
  }

  if (err.status === 401 || err.status === 403) {
    return {
      class: "config",
      location: "PIPELEX_API_KEY",
      message,
      hint: "Check PIPELEX_API_KEY for the configured API.",
    };
  }

  if (err.status === 404) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message,
      hint: `Check that PIPELEX_BASE_URL points to a host serving ${route}.`,
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
