import {
  ApiResponseError,
  ApiUnreachableError,
  collectArtifacts,
  isTerminalRunStatus,
  summarizeUsage,
} from "@pipelex/sdk";
import type {
  GetRunResultOptions,
  MethodProvenance,
  PipelexRunResultStart,
  PipelexStartOptions,
  PipeUsageSummary,
  RunRead,
  RunResultArtifact,
  RunResults,
  RunResultState,
  RunStatus,
  TokensUsageRecord,
  UsageSummary,
  UsageSummaryState,
  UsageTokenTotals,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  RUN_METHOD_ID_SELECTOR_SENTENCE,
  linkageSuffixError,
  noteMethodVersionsSupported,
  planById,
  runContentReport,
  runMethodVersionSchema,
  selectorFailure,
} from "./method-versions.js";
import type { MethodVersionsAware, RunContentReport, SelectorPlan } from "./method-versions.js";
import {
  MAX_IMAGE_CANDIDATE_ENTRIES,
  METHOD_REF_GRAMMAR,
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
  filesInputSchema,
  imageCandidatesOf,
  resolveSubmittedFiles,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateMethodSelectorRequest,
  validateRunIdRequest,
} from "./shared.js";
import type {
  ApiConfig,
  AuthErrorTexture,
  ClassifyErrorOptions,
  ErrorSummaries,
  FileResolver,
  SubmittedFile,
  SubmittedFileInput,
  ToolError,
} from "./shared.js";
import {
  START_MAY_HAVE_RUN_HINT,
  START_MAY_HAVE_RUN_SUMMARY,
  startMayHaveRunError,
} from "./start-outcome.js";
import {
  boundedFailureText,
  FAILURE_MESSAGE_MAX_CODE_POINTS,
  failureSummaryLines,
  runFailureOf,
} from "./run-failure.js";
import type { RunFailure } from "./run-failure.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";

/**
 * The hosted run lifecycle statuses. The `Record<RunStatus, true>` shape ties
 * this list to the SDK's `RunStatus` in both directions at compile time — a
 * status added or removed SDK-side fails the build here.
 */
const RUN_STATUS_SET: Record<RunStatus, true> = {
  PENDING: true,
  STARTED: true,
  RUNNING: true,
  COMPLETED: true,
  FAILED: true,
  CANCELLED: true,
  TERMINATED: true,
  TIMED_OUT: true,
};

export const runStatusSchema = z.enum(Object.keys(RUN_STATUS_SET) as [RunStatus, ...RunStatus[]]);

export const mthdsRunInputSchema = {
  files: filesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR}. Resolved server-side: the repository is fetched at the tag and the resolved commit SHA comes back as provenance. A complete run source of its own — it pairs with NOTHING (not files, not method_id).`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      `Catalog id (mt_…) of a registered method, resolved server-side and requiring an API key (the catalog is org-scoped). ${RUN_METHOD_ID_SELECTOR_SENTENCE} With files also present, the files run and method_id, which must then be bare, only files the run under its method. Provide files, method_ref, or method_id (files + method_id together is also legal).`,
    ),
  pipe_code: z
    .string()
    .optional()
    .describe(
      "The pipe to run, as a qualified domain.pipe_code — the same value mthds_inputs_template and mthds_prepare_inputs take as pipe_ref (the name mirrors each route: the run routes say pipe_code, the build routes say pipe_ref). Omit to run the bundle's declared main pipe (for a method_ref, the manifest's main_pipe).",
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Method inputs — fill the template returned by mthds_inputs_template. Binary inputs ride reachable https URLs.",
    ),
};

/** The input schema of the status and results tools alike, built afresh for each. */
function runIdInputSchema() {
  return {
    run_id: z.string().describe(`The durable run id returned by ${WORKSHOP_TOOL_NAMES.run}.`),
  };
}

export const mthdsRunStatusInputSchema = runIdInputSchema();

export const mthdsRunResultsInputSchema = runIdInputSchema();

/**
 * Identifiers of the renderable views a start result can name (same convention
 * as validate's view-spec list). The workshop renders no views, so a start
 * result always lists none; the enum stays because it is part of the output
 * schema `workshop.contract.json` pins.
 */
const runViewSpecSchema = z.enum(["live_run_status"]);

/**
 * Identifiers of the renderable views a results result can name. Always none
 * on the workshop, kept for the pinned output schema like `runViewSpecSchema`.
 */
const resultsViewSpecSchema = z.enum(["run_graph"]);

const methodProvenanceSchema = z.object({
  address: z.string().describe("The package's resolved full address."),
  tag: z
    .string()
    .nullable()
    .describe("The requested tag; null for a bare address (default branch at HEAD)."),
  commit_sha: z
    .string()
    .describe(
      "The commit that was actually fetched — what keeps the run explainable when a tag moves.",
    ),
});

export const mthdsRunOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  run_id: z
    .string()
    .optional()
    .describe(
      `The durable run id — the handle for ${WORKSHOP_TOOL_NAMES.runStatus} and ${WORKSHOP_TOOL_NAMES.runResults}.`,
    ),
  run_status: runStatusSchema
    .optional()
    .describe("Initial lifecycle state from the start ack, when the server includes one."),
  created_at: z.string().optional(),
  method_provenance: methodProvenanceSchema
    .optional()
    .describe("method_ref runs only — the address, tag, and resolved commit SHA that was fetched."),
  method_version: runMethodVersionSchema,
  available_view_specs: z
    .array(runViewSpecSchema)
    .describe(
      'Renderable views available for this result. Contains "live_run_status" when a live-following status card is available; empty otherwise.',
    ),
  errors: z.array(toolErrorSchema).optional(),
});

/**
 * Why a run failed, from the error report the runner stored on it: the
 * `failure` member of every failed arm in the run family (the status tool on a
 * terminal status other than COMPLETED, and the results, image and download
 * tools' `failed` state). Present only when the run stored a report; its fields
 * are each present only when the report carried them. The provider's raw
 * metadata is left out.
 */
export const runFailureSchema = z.object({
  run_id: z.string(),
  error_type: z
    .string()
    .optional()
    .describe("The runner's exception class name, for the support line; never match on it."),
  title: z.string().optional().describe("The stable human label of the error class."),
  message: z
    .string()
    .optional()
    .describe(
      "What went wrong, as the runner wrote it. It can quote the provider's raw text, so tell the user the title and the next step rather than this verbatim.",
    ),
  error_domain: z
    .string()
    .optional()
    .describe(
      'Who can fix it: "input" (the caller\'s method or inputs), "config" (a configuration change), "runtime" (nobody beforehand).',
    ),
  error_category: z
    .string()
    .optional()
    .describe("The finer class of an inference failure (transient, configuration, content, …)."),
  retryable: z
    .boolean()
    .optional()
    .describe(
      "Whether running it again unchanged can succeed, as the report states it. Absent: the report does not say, which is not false.",
    ),
  user_action: z
    .object({
      kind: z
        .string()
        .describe(
          "wait_and_retry, change_input, change_model, check_billing, check_credentials, contact_support or unknown.",
        ),
      detail: z
        .string()
        .describe(
          "The advice in words. A wait_and_retry kind carries this server's own sentence, since the runner's is worded for a run still retrying.",
        ),
    })
    .optional()
    .describe("The next step the report advises."),
  finished_at: z.string().optional().describe("When the run ended."),
});

const FAILURE_FIELD_DESCRIPTION =
  "Present when the run stored an error report: why it failed, what to do next, whether running it again can help, and what to give support.";

const runStatusStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  run_id: z.string().optional(),
  run_status: runStatusSchema.optional().describe("The coarse lifecycle state."),
  is_terminal: z
    .boolean()
    .optional()
    .describe("True when the run is done and will not transition again."),
  degraded: z
    .boolean()
    .optional()
    .describe("True when the status is the last-known value, not a freshly derived one."),
  retry_after_seconds: z
    .number()
    .nullable()
    .optional()
    .describe("Server backoff hint — check again after this many seconds."),
  created_at: z.string().optional(),
  finished_at: z.string().nullable().optional(),
  method_version: z
    .union([z.number().int(), z.literal("draft")])
    .optional()
    .describe(
      'Runs of a saved method by its id: the version that ran, or "draft". Absent for a run of files or of an address, and on a platform that does not record it.',
    ),
  failure: runFailureSchema
    .optional()
    .describe(`Terminal statuses other than COMPLETED only. ${FAILURE_FIELD_DESCRIPTION}`),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsRunStatusOutputSchema = runStatusStructuredContentSchema;

// Run-level usage only — a projection of the SDK's `summarizeUsage`. The
// per-pipe breakdown is deliberately NOT in this model-facing schema — it rides
// the view-only `_meta.usage_by_pipe` for a future detailed-cost surface (see
// completedResult).
const runUsageSchema = z.object({
  state: z
    .enum(["records", "no_inference", "unavailable"])
    .describe(
      'Which reading the totals describe — read it first: "records" (inference calls were recorded), "no_inference" (the run made no inference, so the cost is 0), "unavailable" (the run reported no usage; the totals are null and assembly_error says whether that is because usage assembly broke).',
    ),
  cost_usd: z
    .number()
    .nullable()
    .describe(
      'Σ per-call USD cost across the run, null-aware: under state "records", null when NO call was priced (own-GPU / mock / dry run); 0 under "no_inference"; null under "unavailable", where nothing is known.',
    ),
  cost_partial: z
    .boolean()
    .optional()
    .describe(
      "True when some calls were priced and others were not — cost_usd is then a lower bound.",
    ),
  tokens: z
    .number()
    .nullable()
    .describe(
      "The run's input tokens plus its output tokens; null when no call reported either. Cached-input and reasoning subsets are excluded to avoid double-counting.",
    ),
  calls: z.number().describe("Number of inference calls recorded (0 → the run did no inference)."),
  assembly_error: z
    .string()
    .nullable()
    .describe(
      "The runner's usage-assembly failure for this run (the SDK's usage_assembly_error); null when assembly did not fail.",
    ),
});

export const mthdsRunResultsOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  run_id: z.string().optional(),
  state: z
    .enum(["running", "completed", "failed"])
    .optional()
    .describe(
      'The result lookup outcome: "running" (no result yet), "completed" (main output below), "failed" (terminal non-COMPLETED).',
    ),
  retry_after_seconds: z
    .number()
    .nullable()
    .optional()
    .describe('State "running" only — check again after this many seconds.'),
  run_status: runStatusSchema
    .optional()
    .describe('State "failed" only — the terminal lifecycle status.'),
  failure_message: z
    .string()
    .optional()
    .describe('State "failed" only — the platform\'s one-sentence account of the ending.'),
  failure: runFailureSchema
    .optional()
    .describe(`State "failed" only. ${FAILURE_FIELD_DESCRIPTION}`),
  main_stuff: z
    .unknown()
    .optional()
    .describe(
      'State "completed" only — the resolved main output, bounded to a serialized cap (see truncated).',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe("True when main_stuff was bounded down; the full output rides the view-only _meta."),
  image_candidates: z
    .array(z.string())
    .optional()
    .describe(
      `State "completed" only, and only when the output references stored files — the pipelex-storage:// references whose storage key looks like an image, as they appear in the output. A free in-memory prefilter over the FULL output, so a reference pruned out of main_stuff still appears here; nothing was fetched and nothing was read, so this is a shortlist, not a verdict. Bounded — see image_candidates_omitted. Pass one of these (or its index in this list) to ${WORKSHOP_TOOL_NAMES.showImages} to see the picture.`,
    ),
  image_candidates_omitted: z
    .number()
    .optional()
    .describe(
      `State "completed" only, and only when something was left out — how many image candidates past the listed ones this result does not enumerate. They are still on the run: ${WORKSHOP_TOOL_NAMES.showImages} walks the full set.`,
    ),
  usage: runUsageSchema
    .optional()
    .describe(
      'State "completed" only — token and USD-cost aggregates for the run, always present: read its state first. The full per-call record list rides the view-only _meta.tokens_usages.',
    ),
  available_view_specs: z
    .array(resultsViewSpecSchema)
    .describe(
      'Renderable views available for this result. Contains "run_graph" when the executed method graph is available to display; empty otherwise.',
    ),
  errors: z.array(toolErrorSchema).optional(),
});

export interface MthdsRunInput {
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  pipe_code?: string;
  inputs?: Record<string, unknown>;
}

/** The run request after `{ path }` resolution — what the checks and the API call consume. */
interface ResolvedRunRequest {
  files: SubmittedFile[];
  method_ref?: string;
  method_id?: string;
  pipe_code?: string;
  inputs?: Record<string, unknown>;
}

export interface RunIdInput {
  run_id: string;
}

export type RunViewSpec = z.infer<typeof runViewSpecSchema>;
export type ResultsViewSpec = z.infer<typeof resultsViewSpecSchema>;

export interface RunStartStructuredContent {
  status: "ok" | "error";
  run_id?: string;
  run_status?: RunStatus;
  created_at?: string;
  /** `method_ref` runs only — the address, tag, and resolved commit SHA that was fetched. */
  method_provenance?: MethodProvenance;
  /** Runs by `method_id` alone: the version that runs, or `"draft"`. */
  method_version?: number | "draft";
  available_view_specs: RunViewSpec[];
  errors?: ToolError[];
}

export interface RunStatusStructuredContent {
  status: "ok" | "error";
  run_id?: string;
  run_status?: RunStatus;
  is_terminal?: boolean;
  degraded?: boolean;
  retry_after_seconds?: number | null;
  created_at?: string;
  finished_at?: string | null;
  /** Runs of a saved method by id: the version that ran, or `"draft"`, when the platform records it. */
  method_version?: number | "draft";
  /** Terminal statuses other than COMPLETED, when the run stored an error report. */
  failure?: RunFailure;
  errors?: ToolError[];
}

/** One `_meta.usage_by_pipe` row — a projection of the SDK's `PipeUsageSummary`. */
export interface PipeUsage {
  pipe_code: string | null;
  cost_usd: number | null;
  tokens: number | null;
  calls: number;
}

/** Run-level usage totals — the model-facing projection of the SDK's `UsageSummary`. */
export interface RunUsage {
  state: UsageSummaryState;
  cost_usd: number | null;
  cost_partial?: boolean;
  tokens: number | null;
  calls: number;
  assembly_error: string | null;
}

export interface RunResultsStructuredContent {
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";
  retry_after_seconds?: number | null;
  run_status?: RunStatus;
  failure_message?: string;
  /** State "failed" only, when the run stored an error report. */
  failure?: RunFailure;
  main_stuff?: unknown;
  truncated?: boolean;
  image_candidates?: string[];
  image_candidates_omitted?: number;
  usage?: RunUsage;
  available_view_specs: ResultsViewSpec[];
  errors?: ToolError[];
}

export interface RunStartResult {
  structuredContent: RunStartStructuredContent;
  summary: string;
}

export interface RunStatusResult {
  structuredContent: RunStatusStructuredContent;
  summary: string;
}

export interface RunResultsResult {
  structuredContent: RunResultsStructuredContent;
  summary: string;
  /**
   * The full, unbounded main output on raw MCP response metadata (rides
   * `_meta.main_stuff`). `structuredContent.main_stuff` is the bounded copy.
   * The model never reads `_meta`, so a programmatic consumer keeps the full
   * result without the model paying for it.
   */
  mainStuff?: unknown;
  /**
   * The full per-call token-usage record list on raw MCP response metadata
   * (rides `_meta.tokens_usages`). `structuredContent.usage` is the compact
   * run-level projection. Like `mainStuff`, it is carried so a programmatic
   * consumer keeps the full detail; the model never sees it (it is not in
   * `structuredContent`). Absent when the run reported no usage list.
   */
  tokensUsages?: TokensUsageRecord[];
  /**
   * The per-pipe usage rollup on raw MCP response metadata (rides
   * `_meta.usage_by_pipe`), projected from the SDK summary's `by_pipe` in its
   * order. Deliberately kept off the model-facing
   * `structuredContent.usage` (which is run-level only) so a future
   * detailed-cost surface can display per-pipe attribution without spending
   * model tokens on it now. Absent when the run reported no usage list.
   */
  usageByPipe?: PipeUsage[];
}

/** The slice of `PipelexApiClient` the run capabilities call (test seam). */
interface RunClient {
  start(options: PipelexStartOptions): Promise<PipelexRunResultStart>;
  getRunStatus(runId: string, options?: { signal?: AbortSignal }): Promise<RunRead>;
  getRunResult(runId: string, options?: GetRunResultOptions): Promise<RunResultState>;
  /** `GET /v1/version`, read only to word the hint of a refused suffix — a selector is always sent as given; optional on a test seam. */
  version?(): Promise<unknown>;
}

export interface RunContext extends ApiConfig, MethodVersionsAware {
  client?: RunClient;
  /** Fills `{ path }` items from disk; the workshop always sets it, and without one every `{ path }` is refused. */
  resolver?: FileResolver;
  /** Deployment-specific auth-failure texture; default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildRunContext(env = process.env): RunContext {
  return buildApiConfig(env);
}

// Live-checked (2026-07-15): the hosted /v1/start reports start-time
// rejections — including an invalid bundle — as a generic 503 "Failed to
// start pipeline", indistinguishable from real server trouble. Point the
// agent at the recoverable cause first.
const START_SERVER_ERROR = {
  hint: "The hosted API reports start-time rejections (e.g. an invalid bundle or bad inputs) as a generic server error. Validate the bundle with mthds_validate and check the inputs against mthds_inputs_template; if both pass, the platform itself may be having trouble.",
};

export const RUN_START_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/start",
  methodLocation: "files",
  badRequest: {
    location: "files",
    hint: "Check files, pipe_code, and inputs; validate the bundle with mthds_validate and fill the template from mthds_inputs_template first.",
  },
  serverError: START_SERVER_ERROR,
};

/**
 * Classify options for an id-only `/v1/start` request — the stored method is
 * the executed source, so both 400/422 and 404 locate at `method_id`. The
 * `notFound` override is safe on this route: a bare-runner missing-route 404
 * is intercepted earlier by the SDK as `RunLifecycleUnavailableError`, so any
 * `ApiResponseError` 404 that reaches classification is the platform's
 * structured unknown-method envelope.
 */
export const RUN_START_BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/start",
  methodLocation: "method_id",
  badRequest: {
    location: "method_id",
    hint: "The stored method may have no MTHDS source yet. If the error mentions organization context, the API key's org binding is the issue — mint a key in the right organization.",
  },
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. Check the id as the catalog returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss.",
  },
  serverError: START_SERVER_ERROR,
};

/**
 * Classify options for a mixed `/v1/start` request (files + `method_id`): the
 * files are the executed source and the id rides only as run-history linkage,
 * so a 400/422 keeps the files-only texture — but a 404 is still about the
 * linkage id, so the by-id unknown-method arm is retained.
 */
export const RUN_START_MIXED_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/start",
  // The files are the executed source, so the execution-locus gate is about
  // them and not the linkage id — the same split `badRequest` makes.
  methodLocation: "files",
  badRequest: RUN_START_ERROR_OPTIONS.badRequest,
  notFound: RUN_START_BY_ID_ERROR_OPTIONS.notFound,
  serverError: START_SERVER_ERROR,
};

/**
 * Classify options for an address-shaped `/v1/start` request. The runner's
 * `method_ref` failures keep their class names as distinct error types: a ref
 * that does not parse or fetch, or an ambiguous one, is a 422; no package
 * matching the address is a 404 (safe to locate at `method_ref` — a bare
 * runner's missing-route 404 was already intercepted as
 * `RunLifecycleUnavailableError`); the reserved registry form is a 501. All
 * are refused before anything executes, so no inference credit was spent.
 */
export const RUN_START_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/start",
  methodLocation: "method_ref",
  badRequest: {
    location: "method_ref",
    hint: `Check the address and tag — ${METHOD_REF_GRAMMAR}. The tag must be a git tag on the repository (branches do not pin). If the address resolved, check pipe_code and the inputs against mthds_inputs_template.`,
  },
  notFound: {
    location: "method_ref",
    hint: "The repository was fetched but holds no package matching this address by manifest identity. Check the package selector against the repository's METHODS.toml manifests.",
  },
  notImplemented: {
    location: "method_ref",
    hint: `Only address-form refs are supported (${METHOD_REF_GRAMMAR}); registry references are reserved until a method registry exists.`,
  },
  serverError: START_SERVER_ERROR,
};

/**
 * What an unknown run id means to the caller. The workshop's operator is its
 * user, so the deployment the key points at is theirs to check.
 */
const UNKNOWN_RUN_HINT = `No run with this id is known to the configured API. Check the run_id returned by ${WORKSHOP_TOOL_NAMES.run}, and that PIPELEX_BASE_URL points at the deployment that started it.`;

const MALFORMED_RUN_ID_HINT = `Pass the run_id exactly as returned by ${WORKSHOP_TOOL_NAMES.run}.`;

export const RUN_STATUS_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/runs/{id}/status",
  badRequest: { location: "run_id", hint: MALFORMED_RUN_ID_HINT },
  notFound: { location: "run_id", hint: UNKNOWN_RUN_HINT },
};

export const RUN_RESULTS_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/runs/{id}/results",
  badRequest: { location: "run_id", hint: MALFORMED_RUN_ID_HINT },
  notFound: { location: "run_id", hint: UNKNOWN_RUN_HINT },
};

/** Request-shape checks on the mthds_run input, after `{ path }` resolution. */
export function validateRunRequest(input: ResolvedRunRequest): ToolError[] {
  // The run rule: files + method_id is a legal pair (linkage), while
  // method_ref pairs with nothing — see SPEC.md → Method Selectors.
  const errors = validateMethodSelectorRequest(input.files, input, { rule: "run_source" });

  if (input.pipe_code !== undefined && input.pipe_code.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "pipe_code",
      message: "pipe_code must not be empty when supplied.",
      hint: "Pass the code of a pipe defined in the submitted bundle, or omit pipe_code to run the bundle's main pipe.",
      retryable: false,
    });
  }

  return errors;
}

// ── main_stuff bounding ─────────────────────────────────────────────

/**
 * Serialized-size cap for the model-facing copy of `main_stuff` (the
 * structured content and the fenced summary block). A tunable constant, not a
 * contract. The full output always rides the view-only `_meta`.
 */
export const MAIN_STUFF_CAP = 32 * 1024;

/** Marker spliced in wherever bounding removed content. */
export const ELLIPSIS_MARKER = "…";

interface PruneLimits {
  maxDepth: number;
  maxItems: number;
  maxStringLength: number;
}

// Progressively harsher pruning rounds, each applied to the ORIGINAL value so
// the outcome is deterministic and independent of prior rounds.
const PRUNE_LADDER: PruneLimits[] = [
  { maxDepth: 8, maxItems: 100, maxStringLength: 4096 },
  { maxDepth: 5, maxItems: 40, maxStringLength: 2048 },
  { maxDepth: 4, maxItems: 20, maxStringLength: 1024 },
  { maxDepth: 3, maxItems: 10, maxStringLength: 512 },
  { maxDepth: 2, maxItems: 5, maxStringLength: 256 },
  { maxDepth: 1, maxItems: 3, maxStringLength: 128 },
];

export interface BoundedMainStuff {
  value: unknown;
  truncated: boolean;
}

/**
 * Bound a polymorphic main output to roughly {@link MAIN_STUFF_CAP} serialized
 * characters: plain text keeps head+tail; JSON trees are pruned from the
 * deepest levels and longest collections first, with {@link ELLIPSIS_MARKER}
 * standing in for removed content. Deterministic for a given input.
 */
export function boundMainStuff(value: unknown): BoundedMainStuff {
  const serialized = JSON.stringify(value);
  // JSON.stringify(undefined) === undefined — an absent output is the caller's
  // contract violation to surface, not bounding's.
  if (serialized === undefined || serialized.length <= MAIN_STUFF_CAP) {
    return { value, truncated: false };
  }

  if (typeof value === "string") {
    return { value: headTail(value, MAIN_STUFF_CAP), truncated: true };
  }

  for (const limits of PRUNE_LADDER) {
    const pruned = prune(value, limits, 0);
    if (JSON.stringify(pruned).length <= MAIN_STUFF_CAP) {
      return { value: pruned, truncated: true };
    }
  }

  // Pathological tree even the harshest ladder rung could not shrink: fall
  // back to head+tail of the serialized form.
  return { value: headTail(serialized, MAIN_STUFF_CAP), truncated: true };
}

function prune(value: unknown, limits: PruneLimits, depth: number): unknown {
  if (typeof value === "string") {
    return value.length <= limits.maxStringLength ? value : headTail(value, limits.maxStringLength);
  }

  if (Array.isArray(value)) {
    if (depth >= limits.maxDepth) {
      return ELLIPSIS_MARKER;
    }
    const kept: unknown[] = value
      .slice(0, limits.maxItems)
      .map((item) => prune(item, limits, depth + 1));
    if (value.length > limits.maxItems) {
      kept.push(ELLIPSIS_MARKER);
    }
    return kept;
  }

  if (typeof value === "object" && value !== null) {
    if (depth >= limits.maxDepth) {
      return ELLIPSIS_MARKER;
    }
    const entries = Object.entries(value);
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, limits.maxItems)) {
      result[key] = prune(entryValue, limits, depth + 1);
    }
    if (entries.length > limits.maxItems) {
      result[ELLIPSIS_MARKER] = ELLIPSIS_MARKER;
    }
    return result;
  }

  return value;
}

function headTail(text: string, cap: number): string {
  const marker = `\n${ELLIPSIS_MARKER} [truncated] ${ELLIPSIS_MARKER}\n`;
  const budget = Math.max(cap - marker.length, 2);
  const headLength = Math.ceil(budget / 2);
  const tailLength = Math.floor(budget / 2);
  return text.slice(0, headLength) + marker + text.slice(text.length - tailLength);
}

// ── usage projection ────────────────────────────────────────────────

/*
 * The usage arithmetic is the SDK's `summarizeUsage` — null-aware cost, the
 * `input` / `output` token totals, the three states told apart on
 * `usage_assembly_error`, the per-pipe rollup and its order. What follows only
 * reshapes its answer into this tool's established fields: the model-facing
 * `structuredContent.usage` and the view-only `_meta.usage_by_pipe` rows.
 */

/**
 * The model-facing token figure: the SDK's two additive totals added, `null`
 * when neither was reported. The SDK keeps the pair apart; the model has always
 * been given one number, and a category no call reported counts as none here.
 */
function tokenFigure(tokens: UsageTokenTotals): number | null {
  if (tokens.input === null && tokens.output === null) return null;
  return (tokens.input ?? 0) + (tokens.output ?? 0);
}

/**
 * A blank assembly error is no error. The SDK relays the runner's
 * `usage_assembly_error` verbatim, while this tool's schema and SPEC both
 * define a non-null `assembly_error` as "usage assembly failed for this run" —
 * so a runner reporting `""` would be read here as a failure that never
 * happened. The MCP's own `summarizeUsage` narrowed it before this tool went
 * thin over the SDK, and the narrowing stays on this side of the projection.
 */
function narrowAssemblyError(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}

/** Project the SDK's run-level `UsageSummary` onto `structuredContent.usage`. */
export function projectRunUsage(summary: UsageSummary): RunUsage {
  const usage: RunUsage = {
    state: summary.state,
    cost_usd: summary.total_cost_usd,
    tokens: tokenFigure(summary.tokens),
    calls: summary.calls,
    assembly_error: narrowAssemblyError(summary.assembly_error),
  };
  if (summary.cost_partial) usage.cost_partial = true;
  return usage;
}

/** Project the SDK's `by_pipe` rollup onto the `_meta.usage_by_pipe` rows, keeping its order. */
export function projectUsageByPipe(rows: PipeUsageSummary[]): PipeUsage[] {
  return rows.map((row) => ({
    pipe_code: row.pipe_code,
    cost_usd: row.total_cost_usd,
    tokens: tokenFigure(row.tokens),
    calls: row.calls,
  }));
}

// ── projections ─────────────────────────────────────────────────────

/**
 * Default check-again suggestion (seconds) when the server sends no
 * `Retry-After` hint. Mirrors the SDK's base poll interval.
 */
const DEFAULT_RETRY_SECONDS = 2;

/** Narrow a start-ack extension field to a recognizable RunStatus. */
function narrowRunStatus(value: unknown): RunStatus | undefined {
  const parsed = runStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function narrowString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Narrow the start ack's `method_provenance` extension field. Populated by the
 * server for `method_ref` runs only; anything malformed is treated as absent
 * rather than guessed at (the run itself is unaffected).
 */
function narrowMethodProvenance(value: unknown): MethodProvenance | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.address !== "string" ||
    typeof record.commit_sha !== "string" ||
    (record.tag !== null && typeof record.tag !== "string")
  ) {
    return undefined;
  }
  return { address: record.address, tag: record.tag, commit_sha: record.commit_sha };
}

/**
 * Project a start ack. `state` and `created_at` are hosted extension fields on
 * the protocol's `RunResultStart` (typed `unknown`), so they are narrowed
 * defensively rather than trusted — as is `method_provenance`, the Pipelex-API
 * extension a `method_ref` run carries (the resolved commit SHA is what keeps
 * the run explainable when a tag moves, so it is surfaced to the model and
 * echoed in the summary). The workshop renders no views, so it advertises none.
 */
export function startResult(
  ack: PipelexRunResultStart,
  content?: RunContentReport,
): RunStartResult {
  const runStatus = narrowRunStatus(ack.state);
  const createdAt = narrowString(ack.created_at);
  const provenance = narrowMethodProvenance(ack.method_provenance);

  const structuredContent: RunStartStructuredContent = {
    status: "ok",
    run_id: ack.pipeline_run_id,
    ...(runStatus === undefined ? {} : { run_status: runStatus }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    ...(provenance === undefined ? {} : { method_provenance: provenance }),
    ...(content?.ran === undefined ? {} : { method_version: content.ran }),
    available_view_specs: [],
  };

  const summaryParts = [
    "# Run started",
    `The run was accepted; its durable id is \`${ack.pipeline_run_id}\`.`,
  ];
  if (content?.sentence !== undefined) {
    summaryParts.push(content.sentence);
  }
  if (provenance !== undefined) {
    summaryParts.push(
      `Resolved \`${provenance.address}\`${provenance.tag === null ? "" : ` at tag \`${provenance.tag}\``} to commit \`${provenance.commit_sha}\` — the run executes exactly that snapshot.`,
    );
  }
  summaryParts.push(
    `Check on it with \`${WORKSHOP_TOOL_NAMES.runStatus}\` (one cheap read — honor its retry hint instead of polling in a tight loop), and fetch the outcome with \`${WORKSHOP_TOOL_NAMES.runResults}\` once it is terminal.`,
  );

  return { structuredContent, summary: summaryParts.join("\n\n") };
}

/**
 * Project a self-healing status read. A terminal non-COMPLETED status is a
 * produced verdict, and it carries why the run ended: the status read is where
 * the platform serves the run's stored error report (`RunRead.error`), so the
 * `failure` object and the summary's sentences come from it. A read whose report
 * is `null` or malformed carries the status alone, and the summary says so.
 */
export function statusResult(read: RunRead): RunStatusResult {
  const isTerminal = isTerminalRunStatus(read.status);
  const ended = isTerminal && read.status !== "COMPLETED";
  const failure = ended
    ? runFailureOf(read.pipeline_run_id, read.error, read.finished_at)
    : undefined;
  // A hosted extension, narrowed rather than trusted like the ack's.
  const methodVersion =
    read.method_version === "draft" ||
    (typeof read.method_version === "number" &&
      Number.isSafeInteger(read.method_version) &&
      read.method_version >= 1)
      ? read.method_version
      : undefined;

  const structuredContent: RunStatusStructuredContent = {
    status: "ok",
    run_id: read.pipeline_run_id,
    run_status: read.status,
    is_terminal: isTerminal,
    degraded: read.degraded,
    ...(read.retry_after_seconds === undefined
      ? {}
      : { retry_after_seconds: read.retry_after_seconds }),
    created_at: read.created_at,
    ...(read.finished_at === undefined ? {} : { finished_at: read.finished_at }),
    ...(methodVersion === undefined ? {} : { method_version: methodVersion }),
    ...(failure === undefined ? {} : { failure }),
  };

  return { structuredContent, summary: statusSummary(read, isTerminal, failure) };
}

function statusSummary(
  read: RunRead,
  isTerminal: boolean,
  failure: RunFailure | undefined,
): string {
  const lines: string[] = [];

  if (isTerminal) {
    lines.push(
      read.status === "COMPLETED"
        ? `Run \`${read.pipeline_run_id}\` is COMPLETED. Fetch the output with \`${WORKSHOP_TOOL_NAMES.runResults}\`.`
        : failureSummaryLines(read.pipeline_run_id, read.status, failure, read.finished_at).join(
            "\n",
          ),
    );
  } else {
    const seconds = read.retry_after_seconds ?? DEFAULT_RETRY_SECONDS;
    lines.push(
      `Run \`${read.pipeline_run_id}\` is ${read.status} — not terminal yet. Check again in ~${seconds}s.`,
    );
  }

  if (read.degraded) {
    lines.push(
      "Note: this status is the last-known value — the platform's live view was temporarily unreachable. The run itself is unaffected.",
    );
  }

  return lines.join("\n\n");
}

/**
 * Project a one-shot result lookup. All three arms are produced verdicts
 * (`status: "ok"`): "no result yet" and "it failed" are answers, not errors.
 * A failed arm is projected with `failedRead`, the status read that follows it
 * (see {@link readFailedRun}), when the caller made one.
 */
export function resultsResult(state: RunResultState, failedRead?: RunRead): RunResultsResult {
  switch (state.state) {
    case "running":
      return runningResult(state.pipeline_run_id, state.retry_after_seconds);
    case "completed":
      return completedResult(state.pipeline_run_id, state.result);
    case "failed":
      return failedResult(state, failedRead);
  }
}

function runningResult(runId: string, retryAfterSeconds: number | null): RunResultsResult {
  const seconds = retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "running",
      retry_after_seconds: retryAfterSeconds,
      available_view_specs: [],
    },
    summary: `Run \`${runId}\` has no result yet — it is still running. Check again in ~${seconds}s.`,
  };
}

function completedResult(runId: string, result: RunResults): RunResultsResult {
  // The SDK guarantees a non-null main_stuff on a completed run (it throws
  // MissingMainStuffError otherwise); reaching here without one is a contract
  // violation the caller surfaces as a runtime no-verdict. A falsy-but-present
  // output (empty array, 0) is valid and passes.
  if (result.main_stuff == null) {
    throw new Error("Completed run results did not include main_stuff.");
  }

  const { value: bounded, truncated } = boundMainStuff(result.main_stuff);
  const usage = summarizeUsage(result);

  // Both walks read the FULL output, not the bounded copy: a reference pruned
  // out of the model-facing copy is still a file the workshop can save and a
  // picture mthds_show_images can fetch. Both are in-memory, so a completed
  // result pays no network call for either.
  const stored = collectArtifacts(result.main_stuff);
  const candidates = imageCandidatesOf(result.main_stuff);
  const listedCandidates = candidates.slice(0, MAX_IMAGE_CANDIDATE_ENTRIES);

  const structuredContent: RunResultsStructuredContent = {
    status: "ok",
    run_id: runId,
    state: "completed",
    main_stuff: bounded,
    truncated,
    // Absent — not empty — when the output references no stored file at all,
    // so a consumer can tell "nothing was produced" from "nothing looked like
    // an image", and a run with no files costs no field.
    //
    // Bounded, and bare references rather than `{ uri, key }` pairs. The walk
    // deliberately reads the FULL output, so an unbounded projection of it was
    // model-facing content outside the `MAIN_STUFF_CAP` discipline `main_stuff`
    // obeys two lines above — a method emitting a large `Image[]` could put
    // more here than the whole output budget. The key was a fixed-prefix strip
    // of the reference beside it, so it doubled the cost of the list and told
    // nobody anything the reference did not.
    ...(stored.length === 0
      ? {}
      : {
          image_candidates: listedCandidates.map((candidate) => candidate.uri),
          ...(candidates.length === listedCandidates.length
            ? {}
            : { image_candidates_omitted: candidates.length - listedCandidates.length }),
        }),
    usage: projectRunUsage(usage),
    available_view_specs: [],
  };

  return {
    structuredContent,
    // Usage is deliberately kept OUT of the prose summary — the run-level totals
    // ride structuredContent.usage; the per-pipe rollup rides _meta only.
    summary: completedSummary(runId, bounded, truncated, stored.length, candidates.length),
    mainStuff: result.main_stuff,
    // Both ride `_meta` like mainStuff: the full per-call list, and the
    // per-pipe rollup for a future detailed-cost surface. Kept off the
    // model-facing channels so they cost no model tokens now. Absent when the
    // run reported no usage list (state "unavailable").
    ...(result.tokens_usages == null
      ? {}
      : {
          tokensUsages: result.tokens_usages,
          usageByPipe: projectUsageByPipe(usage.by_pipe),
        }),
  };
}

// The main output is deliberately duplicated into the summary (the
// mthds_inputs_template pattern): it is the payload the model must read, and some hosts
// read prose more reliably than structured fields. Text outputs get a plain
// fence; everything else pretty-printed JSON.
function completedSummary(
  runId: string,
  bounded: unknown,
  truncated: boolean,
  storedFiles: number,
  imageCandidates: number,
): string {
  const fence =
    typeof bounded === "string"
      ? "```\n" + bounded + "\n```"
      : "```json\n" + JSON.stringify(bounded, null, 2) + "\n```";

  const parts = ["# Run results", `Run \`${runId}\` completed. Main output:`, fence];
  if (truncated) {
    parts.push(TRUNCATION_NOTE);
  }
  const stored = [
    storedFilesNote(storedFiles, imageCandidates),
    saveNote(storedFiles, truncated),
  ].filter((sentence): sentence is string => sentence !== undefined);
  if (stored.length > 0) parts.push(stored.join(" "));
  return parts.join("\n\n");
}

/**
 * What the model is told when the output was bounded. The rest is one call
 * away — the download tool writes the whole output to disk, where the agent
 * reads it with its own file tools — so the sentence says so rather than leave
 * a cut output looking like the last word.
 */
const TRUNCATION_NOTE =
  "The output shown above was truncated to fit the response. `mthds_download_artifacts` with this run id saves all of it to disk as `main_stuff.json`, verbatim; read it there in full.";

/**
 * The run's stored files: how many there are, how many look like images, and
 * how to see one. This tool itself never fetches a byte and never puts a
 * picture in the conversation, which is the whole point of naming
 * `mthds_show_images` here instead. Nothing is said when the output references
 * no stored file.
 */
function storedFilesNote(storedFiles: number, imageCandidates: number): string | undefined {
  if (storedFiles === 0) return undefined;

  const parts = [
    imageCandidates === 0
      ? `The output references ${storedFiles} stored file(s) (\`pipelex-storage://\` references); none of them looks like an image.`
      : `The output references ${storedFiles} stored file(s) (\`pipelex-storage://\` references), ${imageCandidates} of which look like images (listed as \`image_candidates\`).`,
  ];
  if (imageCandidates > 0) {
    parts.push(
      `To see one, call \`${WORKSHOP_TOOL_NAMES.showImages}\` with this run id — it returns the picture itself, which then stays in this conversation for every turn that follows, so ask for it when someone wants to look at it rather than by reflex.`,
    );
  }
  return parts.join(" ");
}

/**
 * How to keep the run. The results land here and nowhere else, so this is the
 * moment to say that the output can reach the disk without the model retyping
 * it — which costs output tokens in proportion to the result and can alter it
 * silently — and, when the output references stored files, that their
 * presigned links expire within the hour. The summary is the channel that
 * reaches the agent at the moment it matters, and a model that does not know
 * the download tool retypes the output. A truncated result's own sentence
 * already names the tool, so without files there is nothing left to add.
 */
function saveNote(storedFiles: number, truncated: boolean): string | undefined {
  if (storedFiles > 0) {
    return "To keep this run, call `mthds_download_artifacts` with this run id: it saves the output verbatim as `main_stuff.json` and the full files beside it, under `runs/<run_id>/` — the presigned `public_url` links in the output expire within the hour, where that tool resolves a fresh one every time.";
  }
  if (truncated) return undefined;
  return "To keep this output on disk, call `mthds_download_artifacts` with this run id: it writes it verbatim as `main_stuff.json` under `runs/<run_id>/`. Never retype it into a file yourself.";
}

function failedResult(state: FailedRunState, failedRead: RunRead | undefined): RunResultsResult {
  const runId = state.pipeline_run_id;
  const failure = failureOfFailedArm(state, failedRead);
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "failed",
      run_status: state.status,
      failure_message: failureMessageOf(state),
      ...(failure === undefined ? {} : { failure }),
      available_view_specs: [],
    },
    summary: [
      "# Run failed",
      failedArmSummaryLines(state, failure, failedRead).join("\n"),
      "No graph is available for failed runs.",
    ].join("\n\n"),
  };
}

/** The failed arm of the results read. */
export type FailedRunState = Extract<RunResultState, { state: "failed" }>;

/**
 * The failed arm's `message`, the platform's account of the ending, bounded like
 * the report's own message: once the platform relays the report on the `409`,
 * the account quotes that message whole.
 */
export function failureMessageOf(state: FailedRunState): string {
  return boundedFailureText(state.message, FAILURE_MESSAGE_MAX_CODE_POINTS);
}

/**
 * Why a run whose results read came back failed ended: the `failure` object
 * built from the report the failed arm carries, or, when it carries none, from
 * the one the status read that followed it served. The results route relays the
 * run's stored report only from the platform release that added it to its
 * `409`, while the status read has always served it, so a failed arm with no
 * report is not yet evidence that the run has none. The time the run ended comes
 * from the status read alone, since the failed arm does not carry it.
 */
export function failureOfFailedArm(
  state: FailedRunState,
  failedRead: RunRead | undefined,
): RunFailure | undefined {
  const finishedAt = failedRead?.finished_at;
  return (
    runFailureOf(state.pipeline_run_id, state.error, finishedAt) ??
    runFailureOf(state.pipeline_run_id, failedRead?.error, finishedAt)
  );
}

/**
 * The model's account of a failed results arm, from {@link failureOfFailedArm}'s
 * `failure`. When there is none and the status read that should have followed
 * failed, the report is said to be unknown rather than missing, since the arm
 * alone cannot tell a run that stored no report from a platform that does not
 * relay it.
 */
export function failedArmSummaryLines(
  state: FailedRunState,
  failure: RunFailure | undefined,
  failedRead: RunRead | undefined,
): string[] {
  return failureSummaryLines(
    state.pipeline_run_id,
    state.status,
    failure,
    failedRead?.finished_at,
    failedRead !== undefined,
  );
}

/**
 * How long the status read after a failed results arm may take before the
 * result goes out without it. Far under the SDK's own 30 s poll timeout, since
 * the read only adds to an answer already in hand.
 */
export const FAILED_RUN_READ_TIMEOUT_MS = 5_000;

/**
 * The one status read that follows a failed results arm, for the time the run
 * ended and for the report when the arm carried none. Best effort: a read that
 * fails, or takes longer than `timeoutMs`, leaves the failure to what the arm
 * itself carried, since the arm is already a verdict and a second request must
 * never turn it into an error or hold it back. The deadline both aborts the
 * request and stops waiting for it, so a client that ignores the signal cannot
 * hold the result either.
 */
export async function readFailedRun(
  client: { getRunStatus(runId: string, options?: { signal?: AbortSignal }): Promise<RunRead> },
  runId: string,
  timeoutMs: number = FAILED_RUN_READ_TIMEOUT_MS,
): Promise<RunRead | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      client.getRunStatus(runId, { signal: controller.signal }),
      deadline,
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// ── capabilities ────────────────────────────────────────────────────

function runClient(context: RunContext): RunClient {
  return context.client ?? createPipelexApiClient(context);
}

/** Start a durable run — fire-and-forget `POST /v1/start`, never blocking. */
export async function startMthdsRun(
  input: MthdsRunInput,
  context: RunContext = buildRunContext(),
): Promise<RunStartResult> {
  const resolution = await resolveSubmittedFiles(input.files ?? [], context.resolver);
  if (resolution.errors.length > 0) {
    return startErrorResult("Run was not started: request input is invalid.", resolution.errors);
  }

  const request: ResolvedRunRequest = { ...input, files: resolution.files };
  const inputErrors = validateRunRequest(request);
  if (inputErrors.length > 0) {
    return startErrorResult("Run was not started: request input is invalid.", inputErrors);
  }

  // Options follow the executed source: an address gets the by-ref texture;
  // id-only gets the full by-id texture; mixed (files + id) keeps the files
  // 400/422 texture but retains the by-id unknown-method 404; files-only
  // keeps today's options.
  const classifyOptions =
    request.method_ref !== undefined
      ? RUN_START_BY_REF_ERROR_OPTIONS
      : request.method_id === undefined
        ? RUN_START_ERROR_OPTIONS
        : request.files.length === 0
          ? RUN_START_BY_ID_ERROR_OPTIONS
          : RUN_START_MIXED_ERROR_OPTIONS;

  // Beside files, method_id is linkage only and must be bare; alone, it names
  // what runs, and its selector is planned against the platform's answer
  // (`method-versions.ts`).
  if (request.method_id !== undefined && request.files.length > 0) {
    const linkageError = linkageSuffixError(request.method_id);
    if (linkageError !== undefined) {
      return startErrorResult("Run was not started: request input is invalid.", [linkageError]);
    }
  }

  let plan: SelectorPlan | undefined;
  try {
    const client = runClient(context);
    let sent = request;
    if (request.method_id !== undefined && request.files.length === 0) {
      plan = planById(request.method_id, context.methodVersions, client, {
        needBareReport: false,
      });
      sent = { ...request, method_id: plan.send };
    }
    const ack = await client.start(toStartOptions(sent));
    if (plan === undefined) return startResult(ack);
    const content = runContentReport(plan, ack.method_version);
    // An acknowledgement naming the version that runs is the platform's own
    // word that it resolves selectors, worth more than any cached answer.
    if (content.proved) noteMethodVersionsSupported(context.methodVersions);
    return startResult(ack, content);
  } catch (err) {
    const classified = classifyStartError(err, { ...classifyOptions, auth: context.authError });
    const error = await selectorFailure(err, classified, plan, context.methodVersions);
    return startErrorResult(startSummaryForError(error), [error]);
  }
}

/**
 * Network codes that mean the start request never reached the server, so no
 * run can exist and a retry is safe. Anything else an unreachable API reports
 * (the SDK's own timeout, a reset connection, no code at all) may have come
 * after the server accepted the request.
 */
const START_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** HTTP statuses from `/v1/start` after which the run may exist; see {@link startMayHaveRun}. */
const START_MAY_HAVE_RUN_STATUSES: ReadonlySet<number> = new Set([500, 502, 504, 408]);

/**
 * Classify a failed start, refusing a retry when the run may exist. A start
 * creates a durable run that spends inference credit, and this client sends no
 * idempotency key, so retrying after a lost acknowledgement would start a second
 * run. That is the case for a timeout or a dropped connection after the request
 * went out; for a 502, a 504 or a 408, where something in front of the runner
 * answered for a request it may have accepted; and for a 500, which the platform
 * relays from the runner when its start call failed, and which can arrive after
 * Temporal has already recorded the start.
 *
 * This overrides the SDK's `retryable` on purpose, as `notRetryableCreate`
 * (`catalog-write.ts`) does for a method create: the SDK's verdict says whether
 * asking again can succeed, never whether it is safe, and it does not depend on
 * the route. A retry that succeeds here is the second paid run, so it stays
 * refused until the client can send an idempotency key. The warning does not
 * wait on the SDK's `retryable` either: the runner's catch-all 500 states
 * `retryable: false` whatever it interrupted, and a start it interrupted after
 * Temporal recorded the run must still say the run may exist.
 */
export function classifyStartError(err: unknown, options: ClassifyErrorOptions): ToolError {
  const error = classifyError(err, options);
  if (!startMayHaveRun(err)) return error;
  return { ...error, retryable: false, hint: START_MAY_HAVE_RUN_HINT };
}

function startMayHaveRun(err: unknown): boolean {
  if (err instanceof ApiUnreachableError) {
    return err.code === undefined || !START_NOT_SENT_CODES.has(err.code);
  }
  // A 408 is a request the server says it never received whole, but a proxy
  // may answer it for one it forwarded, and a wrong retry here is a second
  // paid run. A 500 is the runner's own failed start, relayed as it came since
  // pipelex-server#145 (a 502 before): the runner wraps a failed Temporal start
  // call in PipelexBridgeDispatchError whether or not the workflow began. A 429
  // is a throttle refusing the request before it runs, and a 503 a platform
  // that could not take it. A 2xx the SDK could not read is a start the server
  // accepted whose acknowledgement was lost, so the run exists.
  if (err instanceof ApiResponseError) {
    return (err.status >= 200 && err.status < 300) || START_MAY_HAVE_RUN_STATUSES.has(err.status);
  }
  return false;
}

/** One cheap self-healing status read — `GET /v1/runs/{id}/status`. */
export async function getMthdsRunStatus(
  input: RunIdInput,
  context: RunContext = buildRunContext(),
): Promise<RunStatusResult> {
  const inputErrors = validateRunIdRequest(input.run_id);
  if (inputErrors.length > 0) {
    return statusErrorResult("Run status was not read: request input is invalid.", inputErrors);
  }

  try {
    const read = await runClient(context).getRunStatus(input.run_id);
    return statusResult(read);
  } catch (err) {
    const error = classifyError(err, { ...RUN_STATUS_ERROR_OPTIONS, auth: context.authError });
    return statusErrorResult(statusSummaryForError(error), [error]);
  }
}

/**
 * The result artifacts a `run_results` read asks for — exactly what
 * `completedResult` projects, so the platform reads and re-signs nothing the
 * tool drops: the main output and the usage records (which bring
 * `usage_assembly_error`). The graph, its data artifacts and the working
 * memory are never read.
 */
export const RUN_RESULTS_ARTIFACTS: readonly RunResultArtifact[] = ["main_stuff", "tokens_usages"];

/** One-shot result lookup — `GET /v1/runs/{id}/results`. */
export async function getMthdsRunResults(
  input: RunIdInput,
  context: RunContext = buildRunContext(),
): Promise<RunResultsResult> {
  const inputErrors = validateRunIdRequest(input.run_id);
  if (inputErrors.length > 0) {
    return resultsErrorResult("Run results were not read: request input is invalid.", inputErrors);
  }

  let state: RunResultState;
  try {
    state = await runClient(context).getRunResult(input.run_id, {
      artifacts: RUN_RESULTS_ARTIFACTS,
    });
  } catch (err) {
    const error = classifyError(err, { ...RUN_RESULTS_ERROR_OPTIONS, auth: context.authError });
    return resultsErrorResult(resultsSummaryForError(error), [error]);
  }
  const failedRead =
    state.state === "failed"
      ? await readFailedRun(runClient(context), state.pipeline_run_id)
      : undefined;

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (a completed result missing main_stuff) is a
  // reachable contract violation, surfaced as a runtime no-verdict error.
  try {
    return resultsResult(state, failedRead);
  } catch (err) {
    return resultsErrorResult(
      "Run results produced no verdict: the Pipelex API returned a malformed report.",
      [
        {
          class: "runtime",
          message:
            err instanceof Error ? err.message : "The Pipelex API returned a malformed run result.",
          hint: "The API responded but its report was missing required fields; inspect the run on the platform.",
          retryable: false,
        },
      ],
    );
  }
}

// `/v1/start` takes no source labels — the MCP surface's `uri` feeds only our
// own request-shape errors, so only the contents cross the wire. `method_id` is
// a NAMED option (`PipelexStartOptions`), not an `extra` extension arg: since
// @pipelex/sdk 0.14.0 the client names it itself and refuses it on `extra`,
// which merges last into the body and would let one argument arrive by two
// paths with different validation. That refusal is a runtime throw rather than
// a type error, so the old `extra: { method_id }` shape compiled and failed
// only against the live API. The meaning is unchanged: alone it resolves the
// stored method server-side; beside files it becomes the run-history linkage
// while the inline contents are what runs.
function toStartOptions(input: ResolvedRunRequest): PipelexStartOptions {
  return {
    ...(input.files.length === 0
      ? {}
      : { mthds_contents: input.files.map((file) => file.content) }),
    ...(input.pipe_code === undefined ? {} : { pipe_code: input.pipe_code }),
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
    // `method_ref` is the SDK's named Pipelex-API run-source extension
    // (PipelexApiRunExtensions), resolved by the runner; the request-shape
    // checks already rejected the illegal pairings, mirroring the SDK's own
    // client-side guards.
    ...(input.method_ref === undefined ? {} : { method_ref: input.method_ref }),
    ...(input.method_id === undefined ? {} : { method_id: input.method_id }),
  };
}

const START_ERROR_SUMMARIES: ErrorSummaries = {
  config: "Run could not start: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Run was not started: the Pipelex API rejected the request.",
  runtime: "Run could not be started: the Pipelex API returned an error.",
  paywall: "Run could not start: the organization's Pipelex plan does not cover this call.",
};

const STATUS_ERROR_SUMMARIES: ErrorSummaries = {
  config: "Run status could not be read: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Run status was not read: the Pipelex API rejected the request.",
  runtime: "Run status could not be read: the Pipelex API returned an error.",
  paywall:
    "Run status could not be read: the organization's Pipelex plan does not cover this call.",
};

const RESULTS_ERROR_SUMMARIES: ErrorSummaries = {
  config: "Run results could not be read: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Run results were not read: the Pipelex API rejected the request.",
  runtime: "Run results could not be read: the Pipelex API returned an error.",
  paywall:
    "Run results could not be read: the organization's Pipelex plan does not cover this call.",
};

function startSummaryForError(error: ToolError): string {
  // A may-have-run start keeps its class for machine consumers, but its headline
  // is the one line some hosts show the agent, and "could not be started" would
  // invite the second paid run the hint warns against.
  if (startMayHaveRunError(error)) return START_MAY_HAVE_RUN_SUMMARY;
  return summaryForToolError(error, START_ERROR_SUMMARIES);
}

function statusSummaryForError(error: ToolError): string {
  return summaryForToolError(error, STATUS_ERROR_SUMMARIES);
}

function resultsSummaryForError(error: ToolError): string {
  return summaryForToolError(error, RESULTS_ERROR_SUMMARIES);
}

function startErrorResult(summary: string, errors: ToolError[]): RunStartResult {
  return {
    structuredContent: { status: "error", available_view_specs: [], errors },
    summary,
  };
}

function statusErrorResult(summary: string, errors: ToolError[]): RunStatusResult {
  return {
    structuredContent: { status: "error", errors },
    summary,
  };
}

function resultsErrorResult(summary: string, errors: ToolError[]): RunResultsResult {
  return {
    structuredContent: { status: "error", available_view_specs: [], errors },
    summary,
  };
}

// ── tool results ────────────────────────────────────────────────────

export function runToolResult(result: RunStartResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
  };
}

export function runStatusToolResult(result: RunStatusResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
  };
}

export function runResultsToolResult(result: RunResultsResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
    // Response-metadata channel (the mthds_validate convention): the FULL
    // unbounded main output, the FULL per-call token-usage list, and the
    // per-pipe usage rollup ride `_meta`, never structuredContent, so the model
    // never pays their tokens while a raw MCP consumer can still retain them.
    // Keys mirror the API field names (usage_by_pipe is the SDK's per-pipe
    // rollup, projected onto this tool's row shape).
    _meta: {
      main_stuff: result.mainStuff,
      tokens_usages: result.tokensUsages,
      usage_by_pipe: result.usageByPipe,
    },
  };
}
