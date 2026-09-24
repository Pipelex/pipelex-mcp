import { ApiResponseError } from "@pipelex/sdk";
import type { UploadGrant, UploadGrantInput } from "@pipelex/sdk";
import { z } from "zod";

import {
  asOneLine,
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
} from "./shared.js";
import type {
  ApiConfig,
  AuthErrorTexture,
  ClassifyErrorOptions,
  ErrorSummaries,
  ToolError,
} from "./shared.js";
import { UPLOAD_GRANT_META_KEY, narrowUploadGrant } from "./upload-grant-shape.js";

/**
 * `pipelex_request_upload` — the console's run form asks for an upload grant
 * for a file the user picked, and then sends the file itself.
 *
 * The console's views hold the user's file and no credential; this server holds
 * the user's credential and never the file. A grant joins the two without either
 * crossing to the other side: the view calls this tool with the file's name,
 * type and size — never its bytes — this capability asks the platform for a
 * presigned, create-only `PUT` (`POST /v1/upload/grant`) under the caller's own
 * identity, and the view sends the file straight to the app bucket with
 * `@pipelex/sdk/upload`'s `uploadWithGrant`. The bytes never pass through the
 * model, the host's relay, this server or the API gateway, which is also what
 * lifts the gateway's 7.5 MiB ceiling from this path. See
 * `wip/run-form-direct-upload/design.md` in the workspace.
 *
 * **The grant is a bearer capability, so it rides `_meta` and nowhere else**
 * (under `UPLOAD_GRANT_META_KEY`, named like the repo's other view-only
 * payloads, `graph_spec` and `input_form`).
 * Whoever holds it can write that one object, once, until it expires. The model
 * reads `structuredContent` and `content`, so neither carries the URL or its
 * signed headers; `_meta` reaches the view and never the model. Nothing here
 * logs it, and nothing may.
 *
 * App-only and console-only: the tool is declared with `ui.visibility: ["app"]`
 * so a host that honours the MCP Apps standard never offers it to the model, and
 * the workshop, which has no views, uploads local files through the SDK instead.
 */

export const pipelexRequestUploadInputSchema = {
  filename: z
    .string()
    .describe("The picked file's name, with its extension; the stored object keeps the extension."),
  content_type: z
    .string()
    .optional()
    .describe(
      "The file's MIME type as the browser reports it. Omit it when the browser reports none.",
    ),
  size: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "The file's exact size in bytes. The grant accepts a body of this size and no other.",
    ),
};

const uploadGrantStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  uri: z
    .string()
    .optional()
    .describe(
      "The pipelex-storage:// reference the file will carry once the run form has sent it. It names nothing until then.",
    ),
  expires_at: z
    .string()
    .optional()
    .describe("ISO-8601 UTC instant after which storage refuses the upload."),
  max_bytes: z.number().optional().describe("The largest file any grant allows, in bytes."),
  errors: z.array(toolErrorSchema).optional(),
});

export const pipelexRequestUploadOutputSchema = uploadGrantStructuredContentSchema;

export interface PipelexRequestUploadInput {
  filename: string;
  content_type?: string;
  size: number;
}

export interface UploadGrantStructuredContent {
  status: "ok" | "error";
  uri?: string;
  expires_at?: string;
  max_bytes?: number;
  errors?: ToolError[];
}

export interface UploadGrantResult {
  structuredContent: UploadGrantStructuredContent;
  summary: string;
  /** The grant itself, for `_meta` only. Present exactly on a produced grant. */
  grant?: UploadGrant;
}

/** The slice of `PipelexApiClient` this capability calls (test seam). */
export interface UploadGrantClient {
  requestUploadGrant(
    input: UploadGrantInput,
    options?: { signal?: AbortSignal },
  ): Promise<UploadGrant>;
}

export interface UploadGrantContext extends ApiConfig {
  client?: UploadGrantClient;
  /** Deployment-specific auth-failure texture (the hosted console overrides it per request); default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildUploadGrantContext(env = process.env): UploadGrantContext {
  return buildApiConfig(env);
}

export async function requestPipelexUpload(
  input: PipelexRequestUploadInput,
  context: UploadGrantContext = buildUploadGrantContext(),
): Promise<UploadGrantResult> {
  const requestErrors = validateUploadGrantRequest(input);
  if (requestErrors.length > 0) {
    return errorResult(ERROR_SUMMARIES.input_domain, requestErrors);
  }

  const contentType = input.content_type?.trim();
  let arrived: UploadGrant;
  try {
    // Constructed inside the caught block, like every sibling: the SDK
    // constructor throws on a malformed base URL, and that must classify to a
    // config ToolError rather than reject the MCP handler.
    const client = context.client ?? createPipelexApiClient(context);
    arrived = await client.requestUploadGrant({
      filename: input.filename,
      // A browser reports "" for a type it does not know, and the grant route
      // reads an empty type as none; omitting it says the same thing plainly.
      ...(contentType ? { content_type: contentType } : {}),
      size: input.size,
    });
  } catch (err) {
    const error = classifyError(err, uploadGrantErrorOptions(err, context));
    return errorResult(summaryForToolError(error, ERROR_SUMMARIES), [error]);
  }

  // What arrives is handed to a browser that will send a user's file to it, so
  // it is checked rather than trusted, as every report here is.
  const grant = narrowUploadGrant(arrived);
  if (grant === undefined) {
    const error: ToolError = {
      class: "runtime",
      message: "The Pipelex API answered the upload grant request with a malformed grant.",
      hint: "Inspect the platform's /v1/upload/grant route; nothing was uploaded.",
      retryable: false,
    };
    return errorResult(ERROR_SUMMARIES.runtime, [error]);
  }

  return {
    structuredContent: {
      status: "ok",
      uri: grant.uri,
      expires_at: grant.expires_at,
      max_bytes: grant.max_bytes,
    },
    summary: grantSummary(input, grant),
    grant,
  };
}

export function validateUploadGrantRequest(input: PipelexRequestUploadInput): ToolError[] {
  if (input.filename.trim() === "") {
    return [
      {
        class: "input_domain",
        location: "filename",
        message: "filename must not be empty.",
        hint: "Pass the picked file's name with its extension; the stored object keeps the extension.",
        retryable: false,
      },
    ];
  }
  return [];
}

/**
 * The grant route's refusals, picked by status because the two 4xx the route
 * answers are about different things. A `400` is the platform's
 * `require_active_org`: the credential acts for no organization, and no file
 * the caller picks changes that, so it is `config` at the credential. A `422`
 * is the request body failing validation — a name over the route's length
 * limit, a type it cannot sign — which is about the file.
 */
export function uploadGrantErrorOptions(
  err: unknown,
  context: Pick<UploadGrantContext, "authError">,
): ClassifyErrorOptions {
  const orgless = err instanceof ApiResponseError && err.status === 400;
  return {
    route: "/v1/upload/grant",
    badRequest: orgless
      ? {
          class: "config",
          location: context.authError?.location ?? "PIPELEX_API_KEY",
          hint: "Uploading to Pipelex storage needs an active organization. Use a credential bound to the organization that will run the method, then retry.",
        }
      : {
          hint: "Pipelex storage refused the file's name, type or size as given. Rename the file, or pick another one.",
        },
    tooLarge: {
      location: "size",
      hint: "Pick a smaller file, or reference the file by an http(s) URL instead.",
    },
    auth: context.authError,
  };
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config:
    "No upload grant: the Pipelex API is unreachable or misconfigured, or refused the credential.",
  input_domain: "No upload grant: the file's description was refused.",
  runtime: "No upload grant: the Pipelex API returned an error.",
  paywall: "No upload grant: the organization's Pipelex plan does not cover uploads.",
};

// The model reads this only on a host that ignores `ui.visibility`; there it
// learns what the tool is for and where a chat attachment goes instead. The
// grant's URL and headers are deliberately absent: they are on `_meta` alone.
function grantSummary(input: PipelexRequestUploadInput, grant: UploadGrant): string {
  return [
    "# Upload grant",
    `Issued a one-time upload grant for "${asOneLine(input.filename)}" (${input.size} bytes), valid until ${grant.expires_at}. ` +
      `The console's run form sends the file straight to Pipelex storage with it; once stored, the file is \`${grant.uri}\`.`,
    "This tool serves the run form, which holds the file. To use a file the user attached in the chat, call mthds_upload_attachments.",
  ].join("\n\n");
}

function errorResult(summary: string, errors: ToolError[]): UploadGrantResult {
  return { structuredContent: { status: "error", errors }, summary };
}

export function requestUploadToolResult(result: UploadGrantResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
    ...(result.grant === undefined ? {} : { _meta: { [UPLOAD_GRANT_META_KEY]: result.grant } }),
  };
}
