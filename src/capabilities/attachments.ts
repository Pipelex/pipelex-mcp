import type { UploadFileOptions, UploadRecord, UploadableAsset } from "@pipelex/sdk";
import { z } from "zod";

import { MAX_ATTACHMENT_BYTES, httpAttachmentFetcher } from "./attachment-fetch.js";
import type { AttachmentFetchFailure, AttachmentFetcher } from "./attachment-fetch.js";
import { buildApiConfig, classifyError, toolErrorSchema, toolResultContent } from "./shared.js";
import type { AuthErrorTexture, ClassifyErrorOptions, ToolError } from "./shared.js";
import { SizeGuardedPipelexApiClient, formatMib } from "./upload-ceiling.js";

/**
 * The host attachment object, declared with EXACTLY four properties and
 * exactly this required/optional split. The shape is mandated, not chosen: any
 * field named in a tool's `_meta["openai/fileParams"]` must declare it or
 * OpenAI's app-review "Scan Tools" step fails. It is also a RUNTIME gate — the
 * host substitutes the user's attachment only into a field whose declared
 * schema matches — so a deliberately lenient variant is not a fallback, it is
 * invisible to the mechanism and would never be populated.
 *
 * Declared here rather than imported from `skybridge/server`'s equivalent
 * `FileRef`: the capability core is Skybridge-free by construction, and
 * importing it would drag Skybridge into the tsup-bundled workshop binary.
 * A local Zod object emits a byte-identical JSON Schema, so this costs nothing.
 */
export const hostAttachmentSchema = z.object({
  download_url: z.string().describe("The signed HTTPS URL the host supplies for the attachment."),
  file_id: z.string().describe("The host's identifier for the attached file."),
  mime_type: z.string().optional().describe("The attachment's MIME type, when the host knows it."),
  file_name: z.string().optional().describe("The attachment's filename, when the host knows it."),
});

export const mthdsUploadAttachmentsInputSchema = {
  attachments: z
    .array(hostAttachmentSchema)
    .describe(
      "The file(s) the user attached in this conversation. Reference the user's attachment here — the ChatGPT host rewrites that reference into the signed-URL object; never construct one yourself.",
    ),
};

const ingestedAttachmentSchema = z.object({
  file_id: z.string(),
  file_name: z.string().optional(),
  uri: z
    .string()
    .optional()
    .describe("The pipelex-storage:// reference for the uploaded attachment, on success."),
  content_type: z.string().optional(),
  size: z.number().optional().describe("Decoded size in bytes."),
  error: toolErrorSchema.optional().describe("Present when this attachment could not be ingested."),
});

const attachmentsStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean().describe("True only when EVERY attachment was ingested."),
  attachments: z.array(ingestedAttachmentSchema).optional(),
  uploads: z
    .array(z.string())
    .optional()
    .describe("The pipelex-storage:// uris of the attachments ingested this call."),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsUploadAttachmentsOutputSchema = attachmentsStructuredContentSchema;

export interface HostAttachment {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface MthdsUploadAttachmentsInput {
  attachments: HostAttachment[];
}

export interface IngestedAttachment {
  file_id: string;
  file_name?: string;
  uri?: string;
  content_type?: string;
  size?: number;
  error?: ToolError;
}

export interface AttachmentsStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  attachments?: IngestedAttachment[];
  uploads?: string[];
  errors?: ToolError[];
}

export interface AttachmentsResult {
  structuredContent: AttachmentsStructuredContent;
  summary: string;
}

/** The slice of `PipelexApiClient` this capability calls (test seam). */
export interface AttachmentUploadClient {
  uploadFile(asset: UploadableAsset, options?: UploadFileOptions): Promise<UploadRecord>;
}

export interface AttachmentsContext {
  baseUrl: string;
  apiKey?: string;
  client?: AttachmentUploadClient;
  /** The fetch boundary; the real https fetcher unless a test injects one. */
  fetcher?: AttachmentFetcher;
  /** Deployment-specific auth-failure texture (the hosted console overrides it per request); default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildAttachmentsContext(env = process.env): AttachmentsContext {
  return buildApiConfig(env);
}

const UPLOAD_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/upload",
};

// Constructed inside the caught block (mirroring the sibling capabilities): the
// SDK constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
export function uploadClient(context: AttachmentsContext): AttachmentUploadClient {
  return (
    context.client ??
    new SizeGuardedPipelexApiClient({ baseUrl: context.baseUrl, apiKey: context.apiKey })
  );
}

export async function uploadMthdsAttachments(
  input: MthdsUploadAttachmentsInput,
  context: AttachmentsContext = buildAttachmentsContext(),
): Promise<AttachmentsResult> {
  const requestErrors = validateAttachmentsRequest(input);
  if (requestErrors.length > 0) {
    return errorResult("No attachments were uploaded: request input is invalid.", requestErrors);
  }

  const fetcher = context.fetcher ?? httpAttachmentFetcher;
  const ingested: IngestedAttachment[] = [];

  // Sequential rather than concurrent: each attachment can hold up to the
  // per-item cap in memory, and the whole walk fits the request budget easily
  // (~6 s end-to-end at the cap, against a ~305 s signed-URL lifetime).
  for (const [index, attachment] of input.attachments.entries()) {
    ingested.push(await ingestOne(attachment, index, fetcher, context));
  }

  return attachmentsResult(ingested);
}

async function ingestOne(
  attachment: HostAttachment,
  index: number,
  fetcher: AttachmentFetcher,
  context: AttachmentsContext,
): Promise<IngestedAttachment> {
  const identity: IngestedAttachment = {
    file_id: attachment.file_id,
    ...(attachment.file_name === undefined ? {} : { file_name: attachment.file_name }),
  };

  const fetched = await fetcher.fetch(attachment.download_url);
  if (!fetched.ok) {
    return { ...identity, error: fetchError(fetched.failure, index) };
  }

  const filename = uploadFilename(attachment);
  const contentType = attachment.mime_type ?? fetched.attachment.contentType;

  let record: UploadRecord;
  try {
    record = await uploadClient(context).uploadFile(fetched.attachment.bytes, {
      filename,
      ...(contentType === undefined ? {} : { contentType }),
    });
  } catch (err) {
    return {
      ...identity,
      error: classifyError(err, {
        ...UPLOAD_ERROR_OPTIONS,
        auth: context.authError,
        // A backstop: the fetch boundary's own cap should already have refused
        // anything this big, so a 413 here means the ceiling moved under us.
        asset: {
          location: `attachments[${index}]`,
          hint: `Pipelex storage refused the attachment. Attachments ingested this way are capped at ${formatMib(MAX_ATTACHMENT_BYTES)}; ask the user for a smaller file, or for an http(s) URL to it.`,
        },
      }),
    };
  }

  return {
    ...identity,
    uri: record.uri,
    content_type: record.contentType,
    size: record.size,
  };
}

/**
 * The upload filename. The host's `file_name` is ultimately user-supplied, so
 * it is reduced to a bare, printable basename before it becomes a stored
 * asset's name — a path-shaped or control-character name has no business
 * reaching storage.
 */
function uploadFilename(attachment: HostAttachment): string {
  const raw = attachment.file_name ?? "";
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const sanitized = (raw.split(/[\\/]/).pop() ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return sanitized === "" ? "attachment.bin" : sanitized;
}

/** Every fetch-boundary refusal locates at the attachment's own download_url. */
function fetchError(failure: AttachmentFetchFailure, index: number): ToolError {
  return {
    class: failure.class,
    location: `attachments[${index}].download_url`,
    message: failure.message,
    hint: failure.hint,
    retryable: failure.retryable,
  };
}

export function validateAttachmentsRequest(input: MthdsUploadAttachmentsInput): ToolError[] {
  const errors: ToolError[] = [];

  if (input.attachments.length === 0) {
    errors.push({
      class: "input_domain",
      location: "attachments",
      message: "Provide at least one attachment.",
      hint: "Reference the file the user attached in this conversation; the ChatGPT host fills in its signed URL. If the user attached nothing, ask them to attach the file or to give an http(s) URL to it.",
      retryable: false,
    });
    return errors;
  }

  for (const [index, attachment] of input.attachments.entries()) {
    if (attachment.download_url.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `attachments[${index}].download_url`,
        message: "download_url must not be empty.",
        hint: "The host supplies this URL when you reference the user's attachment; it is never one to construct.",
        retryable: false,
      });
    }
    if (attachment.file_id.trim() === "") {
      errors.push({
        class: "input_domain",
        location: `attachments[${index}].file_id`,
        message: "file_id must not be empty.",
        hint: "The host supplies this id when you reference the user's attachment.",
        retryable: false,
      });
    }
  }

  return errors;
}

/**
 * Verdict discipline, consistent with every other tool here: once the per-item
 * walk has run the result is PRODUCED (`status: "ok"`), discriminated on
 * `is_valid` — true only when every attachment ingested. Partial success is a
 * produced verdict, not an error: the successful uploads already exist in
 * storage, and discarding them because a sibling failed would waste them and
 * strand the model with nothing to run.
 */
export function attachmentsResult(ingested: IngestedAttachment[]): AttachmentsResult {
  const uploads = ingested
    .map((item) => item.uri)
    .filter((uri): uri is string => uri !== undefined);

  return {
    structuredContent: {
      status: "ok",
      is_valid: uploads.length === ingested.length,
      attachments: ingested,
      uploads,
    },
    summary: attachmentsSummary(ingested, uploads.length),
  };
}

// The upload surface returns no rendered_markdown, so the summary is composed
// here. The storage uris are deliberately repeated in the prose (the
// mthds_inputs_template pattern): they are the small payload the model must
// carry into the inputs template, and some hosts read prose more reliably than
// structured fields. Per-item failures ride here too — they are not in the
// top-level errors[], so this is the only place the agent reads them.
function attachmentsSummary(ingested: IngestedAttachment[], succeeded: number): string {
  const parts = ["# Attachments"];
  parts.push(
    succeeded === ingested.length
      ? `Uploaded ${succeeded} attachment(s) to Pipelex storage. Fill these \`pipelex-storage://\` references into the \`mthds_inputs_template\` output and call \`mthds_run\` — a storage reference is already run-ready, so \`mthds_prepare_inputs\` can be skipped.`
      : `Uploaded ${succeeded} of ${ingested.length} attachment(s) to Pipelex storage. The successful ones are ready to use; the failures are listed below.`,
  );

  const lines = ingested.map((item) => {
    const name = item.file_name ?? item.file_id;
    if (item.uri !== undefined) {
      return `- \`${name}\` → \`${item.uri}\``;
    }
    const hint = item.error?.hint === undefined ? "" : ` *Hint: ${item.error.hint}*`;
    return `- \`${name}\` — failed: ${item.error?.message ?? "unknown failure"}${hint}`;
  });
  parts.push(lines.join("\n"));

  return parts.join("\n\n");
}

export function attachmentsToolResult(result: AttachmentsResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
  };
}

function errorResult(summary: string, errors: ToolError[]): AttachmentsResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      errors,
    },
    summary,
  };
}
