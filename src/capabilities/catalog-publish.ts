import { formatItem } from "@pipelex/sdk";
import type { MethodData, MethodPublishResult, PipelexValidationResult } from "@pipelex/sdk";
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
  argumentProblem,
  asOneLine,
  faultsProblem,
  problemItemSchema,
  problemOf,
  problemSchema,
  problemSummary,
  toolResultContent,
} from "./shared.js";
import type { Problem, ProblemItem } from "./shared.js";
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
 * a publish that produced no verdict, with its one problem: a stale token, an
 * unknown method, a runner the platform could not reach.
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
      `The draft token you last saw: the updated_at your last ${WORKSHOP_TOOL_NAMES.saveMethod} of this method, or your last ${WORKSHOP_TOOL_NAMES.getMethod} of its draft, reported, or .pipelex/method.json's synced_updated_at when it records no synced_version. A read of a version reports the draft's token without its content, so never publish under that one. A draft that moved since is refused and nothing is published.`,
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
  validation_errors: z
    .array(problemItemSchema)
    .optional()
    .describe("refused, invalid only: the validation verdict's errors, one problem item each."),
  updated_at: z.string().optional().describe("The draft's token, which a publish never moves."),
  latest_version: z.number().int().nullable().optional(),
  publish_state: publishStateSchema.optional(),
  api_host: z.string().optional(),
  problem: problemSchema
    .optional()
    .describe("Present with status error: why nothing was published, and what to do."),
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
  validation_errors?: ProblemItem[];
  updated_at: string;
  latest_version?: number | null;
  publish_state?: PublishState;
  api_host: string;
}

export interface PublishMethodFailure {
  status: "error";
  problem: Problem;
}

export type PublishMethodStructuredContent = PublishMethodSuccess | PublishMethodFailure;

export interface PublishMethodResult {
  structuredContent: PublishMethodStructuredContent;
  summary: string;
}

export async function publishMthdsMethod(
  input: MthdsPublishMethodInput,
  context: CatalogWriteContext,
): Promise<PublishMethodResult> {
  const parsed = mthdsPublishMethodInputObjectSchema.safeParse(input);
  if (!parsed.success) {
    return publishError(
      faultsProblem(
        parsed.error.issues.map((issue) =>
          argumentProblem(
            issue.path.length === 0 ? "arguments" : issue.path.join("."),
            issue.code,
            issue.message,
            "Pass the method's catalog id and the draft token you last saw (the updated_at of your last save of it, or of your last pull of its draft).",
          ),
        ),
      ),
      context,
    );
  }

  const routeId = methodRouteId(parsed.data.method_id, (selector) =>
    argumentProblem(
      "method_id",
      "version_suffix",
      `\`${parsed.data.method_id}\` names version ${selector.version}, which is already published and never changes: a publish publishes the draft.`,
      `Pass method_id "${selector.methodId}" to publish its draft. To publish version ${selector.version}'s content again as the next version, pull it into the bundle's directory, save it as the draft, and publish that.`,
    ),
  );
  if (!routeId.ok) {
    return publishError(routeId.problem, context);
  }
  const methodId = routeId.methodId;
  const expected = parsed.data.expected_draft_updated_at;

  let client: CatalogWriteClient | undefined;
  let support: Promise<MethodVersionsSupport> = Promise.resolve("unknown");
  let result: MethodPublishResult;
  try {
    client = catalogWriteClient(context);
    // Asked beside the publish rather than after it: it never rejects, and
    // only a published result's sentence about callers waits on it.
    support = catalogVersionsSupport(context, client);
    result = await client.publishMethod(methodId, { expected_draft_updated_at: expected });
  } catch (err) {
    const problem = problemOf(err);
    const reported =
      problem.code === STALE_TOKEN_CODE && client
        ? await staleTokenProblem(problem, client, methodId, expected)
        : problem;
    return publishError(reported, context);
  }

  const apiHost = apiHostOf(context.baseUrl);
  const structuredContent = publishContent(result, apiHost);
  const answer = result.outcome === "published" ? await support : "unknown";
  return { structuredContent, summary: publishSummary(structuredContent, answer) };
}

/** The platform's refusal of a draft that moved since the token the publish sent. */
const STALE_TOKEN_CODE = "pipelex.catalog.update_conflict";

/**
 * The stale-token refusal, carrying the draft's current token beside the one
 * the call sent in this server's `message`, so the caller can tell its own
 * unrecorded save from somebody else's, and that a publish under the new
 * token is the user's to ask for: the platform's problem names neither token,
 * and its code, domain and retry stand. Best-effort: when the read fails, the
 * refusal stands as the platform worded it.
 */
async function staleTokenProblem(
  problem: Problem,
  client: CatalogWriteClient,
  methodId: string,
  expected: string,
): Promise<Problem> {
  let current: MethodData;
  try {
    current = await client.getMethod(methodId);
  } catch {
    return problem;
  }
  return {
    ...problem,
    message: `The method's draft was last saved at ${current.updated_at}, not ${expected}, so nothing was published. Read it with ${WORKSHOP_TOOL_NAMES.getMethod} and tell the user what it now holds; publish it under its new updated_at only if they still want to.`,
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
 * relays and the SDK reads as `validate` does: `is_valid`, then the invalid
 * arm's `errors` as problem items. The other members are still read
 * defensively, being the runner's shape, and one that is not what it should
 * be is left out rather than guessed at.
 */
function validationVerdictOf(
  validation: PipelexValidationResult,
): Pick<
  PublishMethodSuccess,
  "is_valid" | "is_runnable" | "pending_signatures" | "validation_errors"
> {
  const pending: unknown = validation.pending_signatures;
  const runnable: unknown = validation.is_runnable;
  return {
    is_valid: validation.is_valid,
    ...(typeof runnable === "boolean" ? { is_runnable: runnable } : {}),
    ...(Array.isArray(pending) && pending.every((item) => typeof item === "string")
      ? { pending_signatures: pending as string[] }
      : {}),
    ...(validation.is_valid || validation.errors.length === 0
      ? {}
      : { validation_errors: validation.errors }),
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

/** One validation fault as a Markdown bullet: its code, its detail and where it happened. */
function validationErrorLine(item: ProblemItem): string {
  return `- ${asOneLine(formatItem(item))}`;
}

/** A publish that produced no verdict: its one problem, and that problem as the summary. */
function publishError(problem: Problem, context: CatalogWriteContext): PublishMethodResult {
  return {
    structuredContent: { status: "error", problem },
    summary: problemSummary(problem, context.apiNotes),
  };
}

export function publishMethodToolResult(result: PublishMethodResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary),
    isError: result.structuredContent.status === "error",
  };
}
