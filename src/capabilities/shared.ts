import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  MissingMainStuffError,
  PipelineRequestError,
  RunLifecycleUnavailableError,
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
  retryable: z
    .boolean()
    .describe("True when retrying the same call may succeed; false for permanent conditions."),
});

export interface ToolError {
  class: ErrorClass;
  location?: string;
  message: string;
  hint?: string;
  /**
   * Whether retrying the same call may succeed. Decided where the concrete
   * SDK error / HTTP status is still known ({@link classifyError}): the
   * `class`+`location` pair alone is too coarse — an unreachable API and a
   * permanently missing run lifecycle both classify as `config` at
   * `PIPELEX_BASE_URL`, yet only the former is worth retrying.
   */
  retryable: boolean;
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
      retryable: false,
    });
  }

  for (const [index, file] of files.entries()) {
    if (file.content.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `files[${index}].content`,
        message: "File content must not be empty.",
        hint: "Submit the full .mthds file contents.",
        retryable: false,
      });
    }

    if (file.uri !== undefined && file.uri !== null && file.uri.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `files[${index}].uri`,
        message: "File uri must not be empty when supplied.",
        hint: "Omit uri for inline content or provide a stable path or URI.",
        retryable: false,
      });
    }
  }

  return errors;
}

/** Request-shape check on a run id (format stays server-owned). */
export function validateRunIdRequest(runId: string): ToolError[] {
  if (runId.trim() === "") {
    return [
      {
        class: "input_domain",
        location: "run_id",
        message: "run_id must not be empty.",
        hint: "Pass the durable run id returned by mthds_run.",
        retryable: false,
      },
    ];
  }
  return [];
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
  /**
   * Per-route 404 override. By default a 404 means the route itself is
   * missing (`config` — wrong base URL). Routes keyed by a resource id (the
   * run routes) set this so a 404 classifies as `input_domain` ("no run with
   * this id") instead. The SDK separates the missing-route case up front by
   * throwing `RunLifecycleUnavailableError`, so an `ApiResponseError` 404 on
   * those routes really is an unknown id.
   */
  notFound?: {
    location?: string;
    hint: string;
  };
  /**
   * Per-route 5xx hint override. Use it when a route is known to report
   * request-caused failures as a generic server error (the hosted `/v1/start`
   * answers 503 "Failed to start pipeline" for an invalid bundle), so the
   * agent gets a recovery pointer instead of "inspect server logs".
   */
  serverError?: {
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
      retryable: true,
    };
  }

  if (err instanceof ClientAuthenticationError) {
    return {
      class: "config",
      location: "PIPELEX_API_KEY",
      message: err.message,
      hint: "Check the API key for the configured Pipelex API.",
      retryable: false,
    };
  }

  if (err instanceof ApiResponseError) {
    return classifyApiResponseError(err, options);
  }

  // The SDK raises this when the configured base URL serves the protocol
  // routes but not the durable run lifecycle (a bare pipelex-api runner).
  if (err instanceof RunLifecycleUnavailableError) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: err.message,
      hint: "Durable runs need the hosted Pipelex API; point PIPELEX_BASE_URL at a deployment serving /v1/runs/* (a bare pipelex-api runner does not).",
      retryable: false,
    };
  }

  // A completed run that delivers no main output is a reachable contract
  // violation — the API answered, but its report is malformed.
  if (err instanceof MissingMainStuffError) {
    return {
      class: "runtime",
      message: err.message,
      hint: "The API reported the run completed but delivered no main output; inspect the run on the platform.",
      retryable: false,
    };
  }

  if (err instanceof PipelineRequestError) {
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: err.message,
      hint: "Check PIPELEX_BASE_URL and the submitted request.",
      retryable: false,
    };
  }

  // Unknown faults stay retryable: for the poll loops, wrongly stopping a
  // live follow is worse than one more read against a fault we can't name.
  if (err instanceof Error) {
    return {
      class: "runtime",
      message: err.message,
      hint: "Inspect the MCP server logs and local pipelex-api logs.",
      retryable: true,
    };
  }

  return {
    class: "runtime",
    message: "Unknown failure.",
    hint: "Inspect the MCP server logs and local pipelex-api logs.",
    retryable: true,
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
      retryable: false,
    };
  }

  if (err.status === 401 || err.status === 403) {
    return {
      class: "config",
      location: "PIPELEX_API_KEY",
      message,
      hint: "Check PIPELEX_API_KEY for the configured API.",
      retryable: false,
    };
  }

  if (err.status === 404) {
    if (options.notFound) {
      return {
        class: "input_domain",
        ...(options.notFound.location === undefined ? {} : { location: options.notFound.location }),
        message,
        hint: options.notFound.hint,
        retryable: false,
      };
    }
    return {
      class: "config",
      location: "PIPELEX_BASE_URL",
      message,
      hint: `Check that PIPELEX_BASE_URL points to a host serving ${route}.`,
      retryable: false,
    };
  }

  if (err.status >= 500) {
    return {
      class: "runtime",
      message,
      hint:
        options.serverError?.hint ??
        "The Pipelex API returned a server error; inspect pipelex-api logs.",
      retryable: true,
    };
  }

  return {
    class: "runtime",
    message,
    hint: `The Pipelex API returned HTTP ${err.status}.`,
    retryable: false,
  };
}
