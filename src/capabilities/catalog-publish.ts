import type { MethodData, MethodPublishResult } from "@pipelex/sdk";
import { z } from "zod";

import { apiHostOf } from "./catalog-link.js";
import {
  catalogVersionsSupport,
  catalogWriteClient,
  latestVersionOf,
  methodRouteId,
  publishStateOf,
  publishStateSchema,
} from "./catalog-write.js";
import type { CatalogWriteClient, CatalogWriteContext, PublishState } from "./catalog-write.js";
import type { MethodVersionsSupport } from "./method-versions.js";
import {
  asOneLine,
  asRecord,
  classifyError,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
} from "./shared.js";
import type { ClassifyErrorOptions, ErrorSummaries, ToolError } from "./shared.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";

/**
 * `mthds_publish_method` — publish a saved method's draft as its next
 * immutable version, which is what callers of its bare id run.
 *
 * Publishing is the deployment gesture of the catalog, and it is the user's:
 * an agent saves drafts freely, and publishes only when the user asks for a
 * publish. The tool cannot tell who asked, so its description says it, and the
 * platform makes the other half of the rule a property of the call: a publish
 * names the draft token its caller last saw, and a draft that moved since is
 * refused, so a publish never takes a draft nobody here has seen.
 *
 * Every arm of the platform's answer is a verdict about the draft's content,
 * so each is `status: "ok"`, discriminated on `outcome`: `published` with the
 * new version, `unchanged` when the draft equals the latest version, and
 * `refused` with the validation verdict that refused it. `status: "error"` is
 * a publish that produced no verdict: a stale token, an unknown method, a
 * runner the platform could not reach.
 */

export const mthdsPublishMethodInputSchema = {
  method_id: z
    .string()
    .min(1)
    .describe(
      "The method to publish, by its catalog id (mt_…); mt_…@draft is the same thing. A publish always publishes the draft, so a version suffix (mt_…@<n>) is refused.",
    ),
  expected_draft_updated_at: z
    .string()
    .min(1)
    .describe(
      `The draft token you last saw: the updated_at your last ${WORKSHOP_TOOL_NAMES.saveMethod} or ${WORKSHOP_TOOL_NAMES.getMethod} of this method reported, or pipelex-method.json's synced_updated_at. A draft that moved since is refused and nothing is published.`,
    ),
};

export const mthdsPublishMethodInputObjectSchema = z.object(mthdsPublishMethodInputSchema);

export const mthdsPublishMethodOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  outcome: z
    .enum(["published", "unchanged", "refused"])
    .optional()
    .describe(
      "published: the draft became a new version. unchanged: the draft equals the latest version, so nothing was added. refused: the draft does not validate, or does not run yet, so nothing was published.",
    ),
  method_id: z.string().optional(),
  name: z.string().optional(),
  version: z
    .number()
    .int()
    .optional()
    .describe(
      "published: the new version's number. unchanged: the latest version's, which the draft equals.",
    ),
  published_at: z.string().optional(),
  crate_fingerprint: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The version's crate fingerprint, what generated client code is checked against; null when the runner could not compute one.",
    ),
  reason: z
    .enum(["invalid", "not_runnable"])
    .optional()
    .describe(
      "refused only: the draft does not validate, or validates with pending signatures and does not run yet.",
    ),
  message: z.string().optional(),
  is_valid: z.boolean().optional(),
  is_runnable: z.boolean().optional(),
  pending_signatures: z.array(z.string()).optional(),
  validation_errors: z.array(z.unknown()).optional(),
  updated_at: z.string().optional().describe("The draft's token, which a publish never moves."),
  latest_version: z.number().int().nullable().optional(),
  publish_state: publishStateSchema.optional(),
  api_host: z.string().optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export interface MthdsPublishMethodInput {
  method_id: string;
  expected_draft_updated_at: string;
}

export interface PublishMethodSuccess {
  status: "ok";
  outcome: "published" | "unchanged" | "refused";
  method_id: string;
  name: string;
  version?: number;
  published_at?: string;
  crate_fingerprint?: string | null;
  reason?: "invalid" | "not_runnable";
  message?: string;
  is_valid?: boolean;
  is_runnable?: boolean;
  pending_signatures?: string[];
  validation_errors?: unknown[];
  updated_at: string;
  latest_version?: number | null;
  publish_state?: PublishState;
  api_host: string;
}

export interface PublishMethodFailure {
  status: "error";
  errors: ToolError[];
}

export type PublishMethodStructuredContent = PublishMethodSuccess | PublishMethodFailure;

export interface PublishMethodResult {
  structuredContent: PublishMethodStructuredContent;
  summary: string;
}

const PUBLISH_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/methods/{id}/publish",
  badRequest: {
    location: "method_id",
    hint: "The platform refused to publish this draft as it stands: it has no .mthds file, or two of its files share a name a run cannot tell apart. Fix the bundle, save the draft, and publish again when the user asks.",
  },
  notFound: {
    location: "method_id",
    hint: `No registered method with this id is visible to the API key's organization. The catalog is org-scoped, so a method from another organization reads exactly like a miss — check the id with ${WORKSHOP_TOOL_NAMES.listMethods}.`,
  },
  conflict: {
    location: "expected_draft_updated_at",
    hint: `The draft changed since that token — somebody saved it, and the webapp saves as it edits — so nothing was published. Read it with ${WORKSHOP_TOOL_NAMES.getMethod} and tell the user what it now holds; publish it, with its new updated_at, only if they still want to.`,
  },
  tooLarge: {
    location: "method_id",
    hint: "The draft is too large to publish as a version. Make the bundle smaller, save it, and publish again.",
  },
};

const PUBLISH_ERROR_SUMMARIES: ErrorSummaries = {
  config: "The method was not published: the Pipelex API or catalog access is misconfigured.",
  input_domain: "The method was not published: the request was rejected.",
  runtime: "The method was not published: the Pipelex API returned an error.",
  paywall:
    "The method was not published: the organization's Pipelex plan does not cover this call.",
};

export async function publishMthdsMethod(
  input: MthdsPublishMethodInput,
  context: CatalogWriteContext,
): Promise<PublishMethodResult> {
  const parsed = mthdsPublishMethodInputObjectSchema.safeParse(input);
  if (!parsed.success) {
    return publishError(
      "The method was not published: request input is invalid.",
      parsed.error.issues.map((issue) => ({
        class: "input_domain" as const,
        ...(issue.path.length === 0 ? {} : { location: issue.path.join(".") }),
        message: issue.message,
        hint: "Pass the method's catalog id and the draft token you last saw (the updated_at of your last save or pull of it).",
        retryable: false,
      })),
    );
  }

  const routeId = methodRouteId(parsed.data.method_id, (selector) => ({
    class: "input_domain",
    location: "method_id",
    message: `\`${parsed.data.method_id}\` names version ${selector.version}, which is already published and never changes: a publish publishes the draft.`,
    hint: `Pass method_id "${selector.methodId}" to publish its draft. To publish version ${selector.version}'s content again as the next version, pull it into the bundle's directory, save it as the draft, and publish that.`,
    retryable: false,
  }));
  if (!routeId.ok) {
    return publishError("The method was not published: request input is invalid.", [routeId.error]);
  }
  const methodId = routeId.methodId;
  const expected = parsed.data.expected_draft_updated_at;

  let client: CatalogWriteClient;
  let result: MethodPublishResult;
  try {
    client = catalogWriteClient(context);
    result = await client.publishMethod(methodId, { expected_draft_updated_at: expected });
  } catch (err) {
    const error = classifyError(err, { ...PUBLISH_ERROR_OPTIONS, auth: context.authError });
    const reported =
      error.location === "expected_draft_updated_at"
        ? await staleTokenError(error, context, methodId, expected)
        : error;
    return publishError(summaryForToolError(reported, PUBLISH_ERROR_SUMMARIES), [reported]);
  }

  const apiHost = apiHostOf(context.baseUrl);
  const structuredContent = publishContent(result, apiHost);
  const support =
    result.outcome === "published" ? await catalogVersionsSupport(context, client) : "unknown";
  return { structuredContent, summary: publishSummary(structuredContent, support) };
}

/**
 * The stale-token refusal, carrying the draft's current token beside the one
 * the call sent, so the caller can tell its own unrecorded save from somebody
 * else's. Best-effort: when the read fails, the refusal stands as worded.
 */
async function staleTokenError(
  error: ToolError,
  context: CatalogWriteContext,
  methodId: string,
  expected: string,
): Promise<ToolError> {
  let current: MethodData;
  try {
    current = await catalogWriteClient(context).getMethod(methodId);
  } catch {
    return error;
  }
  return {
    ...error,
    message: `The method's draft was last saved at ${current.updated_at}, not ${expected}, so nothing was published.`,
  };
}

/** The structured content of a produced verdict, one arm per outcome. */
function publishContent(result: MethodPublishResult, apiHost: string): PublishMethodSuccess {
  const method = result.method;
  const latestVersion = latestVersionOf(method);
  const publishState = publishStateOf(method);
  const shared = {
    method_id: method.method_id,
    name: method.name,
    updated_at: method.updated_at,
    ...(latestVersion === undefined ? {} : { latest_version: latestVersion }),
    ...(publishState === undefined ? {} : { publish_state: publishState }),
    api_host: apiHost,
  };

  if (result.outcome === "refused") {
    const verdict = validationVerdictOf(result.validation);
    return {
      status: "ok",
      outcome: "refused",
      ...shared,
      reason: result.reason,
      message: result.message,
      ...verdict,
    };
  }

  return {
    status: "ok",
    outcome: result.outcome,
    ...shared,
    version: result.version.version,
    published_at: result.version.published_at,
    crate_fingerprint: result.version.crate_fingerprint,
  };
}

/**
 * The verdict fields of the runner's validation answer, which the platform
 * relays verbatim. Read defensively: it is the runner's shape, and a field
 * that is not what it should be is left out rather than guessed at.
 */
function validationVerdictOf(
  validation: unknown,
): Pick<
  PublishMethodSuccess,
  "is_valid" | "is_runnable" | "pending_signatures" | "validation_errors"
> {
  const record = asRecord(validation);
  if (record === undefined) return {};
  const pending = record.pending_signatures;
  return {
    ...(typeof record.is_valid === "boolean" ? { is_valid: record.is_valid } : {}),
    ...(typeof record.is_runnable === "boolean" ? { is_runnable: record.is_runnable } : {}),
    ...(Array.isArray(pending) && pending.every((item) => typeof item === "string")
      ? { pending_signatures: pending as string[] }
      : {}),
    ...(Array.isArray(record.validation_errors)
      ? { validation_errors: record.validation_errors as unknown[] }
      : {}),
  };
}

/** How many validation errors the summary lists before it says how many more there are. */
const LISTED_VALIDATION_ERRORS = 10;

function publishSummary(result: PublishMethodSuccess, support: MethodVersionsSupport): string {
  const id = result.method_id;
  if (result.outcome === "published") {
    const callers =
      support === "supported"
        ? `Every caller of the bare \`${id}\` runs version ${result.version} from its next call.`
        : support === "unsupported"
          ? `This platform does not resolve versions yet, so the bare \`${id}\` still reads the draft; once it does, it reads version ${result.version}.`
          : `Wherever the platform resolves versions, every caller of the bare \`${id}\` runs version ${result.version} from its next call.`;
    return [
      `Published the draft of **${result.name}** as version ${result.version} on ${result.api_host} (method_id: \`${id}\`).`,
      `\`${id}@${result.version}\` names this version for good: pin it where a caller must not move when the method is published again. ${callers}`,
    ].join("\n");
  }

  if (result.outcome === "unchanged") {
    return `Nothing new to publish: the draft of **${result.name}** is identical to version ${result.version}, its latest published version (method_id: \`${id}\` on ${result.api_host}). No version was added.`;
  }

  const lines = [
    `**${result.name}** was NOT published (method_id: \`${id}\` on ${result.api_host}): ${result.message ?? "the platform refused the draft."}`,
  ];
  if (result.reason === "not_runnable") {
    const pending = result.pending_signatures ?? [];
    lines.push(
      pending.length === 0
        ? "The draft validates but does not run yet, so it stays a draft until it does."
        : `The draft validates but does not run yet — these signatures are still pending: ${pending.map((ref) => `\`${ref}\``).join(", ")}. It stays a draft until they resolve.`,
    );
  } else {
    const errors = result.validation_errors ?? [];
    lines.push(
      `The draft does not validate. Fix the bundle, save the draft with ${WORKSHOP_TOOL_NAMES.saveMethod}, and publish again when the user asks.`,
    );
    const listed = errors.slice(0, LISTED_VALIDATION_ERRORS).map(validationErrorLine);
    if (listed.length > 0) {
      lines.push(listed.join("\n"));
    }
    if (errors.length > LISTED_VALIDATION_ERRORS) {
      lines.push(
        `…and ${errors.length - LISTED_VALIDATION_ERRORS} more in validation_errors. ${WORKSHOP_TOOL_NAMES.validate} on the bundle's files gives the full verdict.`,
      );
    }
  }
  return lines.join("\n");
}

/** One runner diagnostic as a Markdown bullet, every field read defensively. */
function validationErrorLine(item: unknown): string {
  const record = asRecord(item);
  if (record === undefined) return `- ${asOneLine(String(item))}`;
  const category = typeof record.category === "string" ? `**${record.category}** — ` : "";
  const message = typeof record.message === "string" ? asOneLine(record.message) : "(no message)";
  const source =
    typeof record.source === "string" && record.source !== "" ? ` (${record.source})` : "";
  return `- ${category}${message}${source}`;
}

function publishError(summary: string, errors: ToolError[]): PublishMethodResult {
  return { structuredContent: { status: "error", errors }, summary };
}

export function publishMethodToolResult(result: PublishMethodResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(
      result.summary,
      result.structuredContent.status === "error" ? result.structuredContent.errors : undefined,
    ),
    isError: result.structuredContent.status === "error",
  };
}
