import { collectArtifacts, isTerminalRunStatus, summarizeUsage } from "@pipelex/sdk";
import type {
  MethodProvenance,
  PipelexRunResultStart,
  PipelexStartOptions,
  PipeUsageSummary,
  RunRead,
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
  MAX_IMAGE_CANDIDATE_ENTRIES,
  METHOD_REF_GRAMMAR,
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
  filesInputSchema,
  hasArtifactEntries,
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
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";
import type { ToolNames } from "./tool-names.js";

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

function runIdInputField(names: ToolNames) {
  return z.string().describe(`The durable run id returned by ${names.run}.`);
}

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
      "Catalog id (mt_…) of a registered method. Runs the method's CURRENT stored content — requires an API key (the catalog is org-scoped). With files also present, the files run and method_id is recorded as run-history linkage. Provide files, method_ref, or method_id (files + method_id together is also legal).",
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

/**
 * The input schema of the status and results tools alike, its description
 * naming the run tool of the shell that registers it.
 */
export function runIdInputSchemaFor(names: ToolNames) {
  return { run_id: runIdInputField(names) };
}

export const mthdsRunStatusInputSchema = runIdInputSchemaFor(WORKSHOP_TOOL_NAMES);

export const mthdsRunResultsInputSchema = runIdInputSchemaFor(WORKSHOP_TOOL_NAMES);

/**
 * Identifiers of the renderable views a start result can drive (same
 * convention as validate's view-spec list: the model never sees `_meta`, so
 * this is how it learns a view is available to surface). The only kind is
 * `"live_run_status"` — the self-polling run-follow card.
 */
const runViewSpecSchema = z.enum(["live_run_status"]);

/**
 * Identifiers of the renderable views a results result can drive. The only
 * kind is `"run_graph"` — the executed method graph, whose spec rides the tool
 * result's `_meta.graph_spec`.
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

/** The start result's schema, naming the follow-up tools of the shell that registers it. */
export function runStartOutputSchemaFor(names: ToolNames) {
  return z.object({
    status: z.enum(["ok", "error"]),
    run_id: z
      .string()
      .optional()
      .describe(`The durable run id — the handle for ${names.runStatus} and ${names.runResults}.`),
    run_status: runStatusSchema
      .optional()
      .describe("Initial lifecycle state from the start ack, when the server includes one."),
    created_at: z.string().optional(),
    method_provenance: methodProvenanceSchema
      .optional()
      .describe(
        "method_ref runs only — the address, tag, and resolved commit SHA that was fetched.",
      ),
    available_view_specs: z
      .array(runViewSpecSchema)
      .describe(
        'Renderable views available for this result. Contains "live_run_status" when a live-following status card is available; empty otherwise.',
      ),
    errors: z.array(toolErrorSchema).optional(),
  });
}

export const mthdsRunOutputSchema = runStartOutputSchemaFor(WORKSHOP_TOOL_NAMES);

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

/** The results tool's schema, naming the image tool of the shell that registers it. */
export function runResultsOutputSchemaFor(names: ToolNames) {
  return z.object({
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
    failure_message: z.string().optional().describe('State "failed" only.'),
    main_stuff: z
      .unknown()
      .optional()
      .describe(
        'State "completed" only — the resolved main output, bounded to a serialized cap (see truncated).',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        "True when main_stuff was bounded down; the full output rides the view-only _meta.",
      ),
    image_candidates: z
      .array(z.string())
      .optional()
      .describe(
        `State "completed" only, and only when the output references stored files — the pipelex-storage:// references whose storage key looks like an image, as they appear in the output. A free in-memory prefilter over the FULL output, so a reference pruned out of main_stuff still appears here; nothing was fetched and nothing was read, so this is a shortlist, not a verdict. Bounded — see image_candidates_omitted. Pass one of these (or its index in this list) to ${names.showImages} to see the picture.`,
      ),
    image_candidates_omitted: z
      .number()
      .optional()
      .describe(
        `State "completed" only, and only when something was left out — how many image candidates past the listed ones this result does not enumerate. They are still on the run: ${names.showImages} walks the full set.`,
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
}

export const mthdsRunResultsOutputSchema = runResultsOutputSchemaFor(WORKSHOP_TOOL_NAMES);

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
   * The executed method graph, for the Skybridge views only. It rides the tool
   * result's `_meta.graph_spec` (never `structuredContent`), so the model never
   * pays its tokens. Populated only on a completed result that carries one
   * and the invoking shell has views.
   */
  graphSpec?: unknown;
  /**
   * The run's `pipe_io_contracts` — the per-pipe IO contracts for the library
   * the run executed against, keyed by namespaced `pipe_ref`. It rides
   * `_meta.pipe_io_contracts` beside the graph, never `structuredContent`.
   *
   * It travels as a PAIR with `outputForm` because that is the renderer's own
   * rule: `GraphViewer` shows a data node's VALUE only when it holds both, and
   * falls back to the concept's structure table otherwise. Shipping one alone
   * would buy nothing and cost the wire.
   */
  pipeIoContracts?: unknown;
  /**
   * The run's `output_form` — the other half of the pair above. The contract
   * names the payload's shape; the descriptor says what the result IS.
   */
  outputForm?: unknown;
  /**
   * The run's `input_form`. It is what lets the method's own INPUTS show their
   * value, since no pipe produced them and so no output descriptor describes
   * them, and its absence changes nothing but those nodes. Optional to the
   * renderer — but optional *given* the pair rather than independent of it, so
   * it rides only when the pair does. `completedResult` is where that holds,
   * and says why.
   */
  inputForm?: unknown;
  /**
   * The full, unbounded main output on raw MCP response metadata (rides
   * `_meta.main_stuff`). `structuredContent.main_stuff` is the bounded copy.
   * It remains on the raw MCP result even when the invoking shell has no views,
   * so a programmatic consumer never loses the full result.
   */
  mainStuff?: unknown;
  /**
   * The full per-call token-usage record list on raw MCP response metadata
   * (rides `_meta.tokens_usages`). `structuredContent.usage` is the compact
   * run-level projection. Like `mainStuff`, it is carried ungated by
   * `viewsAvailable` so a programmatic consumer keeps the full detail; the model
   * never sees it (it is not in `structuredContent`). Absent when the run
   * reported no usage list.
   */
  tokensUsages?: TokensUsageRecord[];
  /**
   * The per-pipe usage rollup on raw MCP response metadata (rides
   * `_meta.usage_by_pipe`), projected from the SDK summary's `by_pipe` in its
   * order. Deliberately kept off the model-facing
   * `structuredContent.usage` (which is run-level only) so a future
   * detailed-cost tool/view can display per-pipe attribution without spending
   * model tokens on it now. Ungated by views, like `tokensUsages`. Absent when
   * the run reported no usage list.
   */
  usageByPipe?: PipeUsage[];
}

/** The slice of `PipelexApiClient` the run capabilities call (test seam). */
interface RunClient {
  start(options: PipelexStartOptions): Promise<PipelexRunResultStart>;
  getRunStatus(runId: string): Promise<RunRead>;
  getRunResult(runId: string): Promise<RunResultState>;
}

export interface RunContext extends ApiConfig {
  client?: RunClient;
  /** Fills `{ path }` items from disk (local workshop); absent on the hosted console. */
  resolver?: FileResolver;
  /** Whether this shell can render run-follow and its view-only result payloads. */
  viewsAvailable?: boolean;
  /**
   * Whether this shell registers `mthds_download_artifacts` (the workshop
   * does; the console has a UI for it). When true, every completed result's
   * summary names the tool as the way to keep the run on disk — the output
   * verbatim, and the files it references, whose presigned links die within
   * the hour — and a truncated result names it as the way to read the rest.
   * The summary is the channel that reaches the agent at the moment it
   * matters, and a model that does not know the tool retypes the output.
   */
  artifactDownloadAvailable?: boolean;
  /** The tool names this shell's texts use; the workshop's when absent. */
  toolNames?: ToolNames;
  /** Deployment-specific auth-failure texture (the hosted console overrides it per request); default env-var wording when absent. */
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
 * user, so the deployment the key points at is theirs to check; the console's
 * deployment is not the caller's to change, and what they can check is which
 * organization they are signed in to.
 */
function unknownRunHint(names: ToolNames): string {
  return names.shell === "workshop"
    ? `No run with this id is known to the configured API. Check the run_id returned by ${names.run}, and that PIPELEX_BASE_URL points at the deployment that started it.`
    : `No run with this id is visible to your organization. Check the run_id returned by ${names.run}: a run started in another organization is not visible from this one.`;
}

function malformedRunIdHint(names: ToolNames): string {
  return `Pass the run_id exactly as returned by ${names.run}.`;
}

/** The status route's classify options, in the vocabulary of the shell that reads them. */
export function runStatusErrorOptions(names: ToolNames): ClassifyErrorOptions {
  return {
    route: "/v1/runs/{id}/status",
    badRequest: { location: "run_id", hint: malformedRunIdHint(names) },
    notFound: { location: "run_id", hint: unknownRunHint(names) },
  };
}

/** The results route's classify options, in the vocabulary of the shell that reads them. */
export function runResultsErrorOptions(names: ToolNames): ClassifyErrorOptions {
  return {
    route: "/v1/runs/{id}/results",
    badRequest: { location: "run_id", hint: malformedRunIdHint(names) },
    notFound: { location: "run_id", hint: unknownRunHint(names) },
  };
}

export const RUN_STATUS_ERROR_OPTIONS: ClassifyErrorOptions =
  runStatusErrorOptions(WORKSHOP_TOOL_NAMES);

export const RUN_RESULTS_ERROR_OPTIONS: ClassifyErrorOptions =
  runResultsErrorOptions(WORKSHOP_TOOL_NAMES);

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
 * echoed in the summary). A produced ack advertises the `live_run_status` view
 * only when the invoking shell registered run-follow.
 */
export function startResult(
  ack: PipelexRunResultStart,
  viewsAvailable = true,
  names: ToolNames = WORKSHOP_TOOL_NAMES,
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
    available_view_specs: viewsAvailable ? ["live_run_status"] : [],
  };

  const summaryParts = [
    "# Run started",
    `The run was accepted; its durable id is \`${ack.pipeline_run_id}\`.`,
  ];
  if (provenance !== undefined) {
    summaryParts.push(
      `Resolved \`${provenance.address}\`${provenance.tag === null ? "" : ` at tag \`${provenance.tag}\``} to commit \`${provenance.commit_sha}\` — the run executes exactly that snapshot.`,
    );
  }
  summaryParts.push(
    `Check on it with \`${names.runStatus}\` (one cheap read — honor its retry hint instead of polling in a tight loop), and fetch the outcome with \`${names.runResults}\` once it is terminal.`,
  );
  if (viewsAvailable) {
    summaryParts.push(
      "## Views",
      "A live status card follows this run on its own (polling, then the results); the user is already watching it — no need to poll on their behalf.",
    );
  }

  return { structuredContent, summary: summaryParts.join("\n\n") };
}

/** Project a self-healing status read. A terminal non-COMPLETED status is a produced verdict. */
export function statusResult(
  read: RunRead,
  names: ToolNames = WORKSHOP_TOOL_NAMES,
): RunStatusResult {
  const isTerminal = isTerminalRunStatus(read.status);

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
  };

  return { structuredContent, summary: statusSummary(read, isTerminal, names) };
}

function statusSummary(read: RunRead, isTerminal: boolean, names: ToolNames): string {
  const lines: string[] = [];

  if (isTerminal) {
    lines.push(
      read.status === "COMPLETED"
        ? `Run \`${read.pipeline_run_id}\` is COMPLETED. Fetch the output with \`${names.runResults}\`.`
        : `Run \`${read.pipeline_run_id}\` ended ${read.status}. \`${names.runResults}\` returns the failure details.`,
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
 */
export function resultsResult(
  state: RunResultState,
  viewsAvailable = true,
  artifactDownloadAvailable = false,
  names: ToolNames = WORKSHOP_TOOL_NAMES,
): RunResultsResult {
  switch (state.state) {
    case "running":
      return runningResult(state.pipeline_run_id, state.retry_after_seconds);
    case "completed":
      return completedResult(
        state.pipeline_run_id,
        state.result,
        viewsAvailable,
        artifactDownloadAvailable,
        names,
      );
    case "failed":
      return failedResult(state.pipeline_run_id, state.status, state.message);
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

function completedResult(
  runId: string,
  result: RunResults,
  viewsAvailable: boolean,
  artifactDownloadAvailable: boolean,
  names: ToolNames,
): RunResultsResult {
  // The SDK guarantees a non-null main_stuff on a completed run (it throws
  // MissingMainStuffError otherwise); reaching here without one is a contract
  // violation the caller surfaces as a runtime no-verdict. A falsy-but-present
  // output (empty array, 0) is valid and passes.
  if (result.main_stuff == null) {
    throw new Error("Completed run results did not include main_stuff.");
  }

  const { value: bounded, truncated } = boundMainStuff(result.main_stuff);
  const graphSpec = viewsAvailable ? (result.graph_spec ?? undefined) : undefined;
  // The graph's data artifacts, on the same terms as the graph itself: views
  // only, `_meta` only. They travel as a PAIR, which is the renderer's rule and
  // not a convenience — `GraphViewer` reads a data node's value only when it
  // holds `contracts` and `outputForm` together, and shows the concept's
  // structure table otherwise, so half the pair renders exactly like neither.
  // `hasArtifactEntries` is what makes that a real test: the hosted results
  // relay these keys as `null` for any run whose runner predates them, and an
  // empty map is a map the view can look nothing up in.
  const artifactsRide =
    viewsAvailable &&
    hasArtifactEntries(result.pipe_io_contracts) &&
    hasArtifactEntries(result.output_form);
  const pipeIoContracts = artifactsRide ? result.pipe_io_contracts : undefined;
  const outputForm = artifactsRide ? result.output_form : undefined;
  // Third, and optional GIVEN the pair rather than independent of it: the input
  // form answers for the method's own inputs alone — nodes no pipe produced,
  // which no output descriptor describes — and its absence costs those nodes
  // their value and nothing else. It rides when it has entries and the pair
  // does, because the renderer consults it only inside the gate the pair opens:
  // shipping it without them renders identically and costs the wire. Should a
  // later mthds-ui open that gate on the contracts alone, this conjunction
  // starts costing real input-node values and has to be loosened with it.
  const inputForm =
    artifactsRide && hasArtifactEntries(result.input_form) ? result.input_form : undefined;
  const usage = summarizeUsage(result);

  // Both walks read the FULL output, not the bounded copy: a reference pruned
  // out of the model-facing copy is still a file the workshop can save and a
  // picture mthds_show_images can fetch. Both are in-memory, so a completed
  // result pays no network call for either, on either shell.
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
    available_view_specs: graphSpec === undefined ? [] : ["run_graph"],
  };

  return {
    structuredContent,
    // Usage is deliberately kept OUT of the prose summary — the run-level totals
    // ride structuredContent.usage; the per-pipe rollup rides _meta only.
    summary: completedSummary(
      runId,
      bounded,
      truncated,
      viewsAvailable,
      stored.length,
      candidates.length,
      artifactDownloadAvailable,
      names,
    ),
    graphSpec,
    pipeIoContracts,
    outputForm,
    inputForm,
    mainStuff: result.main_stuff,
    // Both ride `_meta` ungated by views (like mainStuff): the full per-call
    // list, and the per-pipe rollup for a future detailed-cost surface. Kept off
    // the model-facing channels so they cost no model tokens now. Absent when
    // the run reported no usage list (state "unavailable").
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
  viewsAvailable: boolean,
  storedFiles: number,
  imageCandidates: number,
  artifactDownloadAvailable: boolean,
  names: ToolNames,
): string {
  const fence =
    typeof bounded === "string"
      ? "```\n" + bounded + "\n```"
      : "```json\n" + JSON.stringify(bounded, null, 2) + "\n```";

  const parts = ["# Run results", `Run \`${runId}\` completed. Main output:`, fence];
  if (truncated) {
    parts.push(truncationNote(viewsAvailable, artifactDownloadAvailable));
  }
  const stored = [
    storedFilesNote(storedFiles, imageCandidates, names),
    artifactDownloadAvailable ? saveNote(storedFiles, truncated) : undefined,
  ].filter((sentence): sentence is string => sentence !== undefined);
  if (stored.length > 0) parts.push(stored.join(" "));
  return parts.join("\n\n");
}

/**
 * What the model is told when the output was bounded. On the workshop the rest
 * is one call away — the download tool writes the whole output to disk, where
 * the agent reads it with its own file tools — so the sentence says so rather
 * than leave a cut output looking like the last word. The console has no disk:
 * its views hold the full output, and its model does not.
 */
function truncationNote(viewsAvailable: boolean, artifactDownloadAvailable: boolean): string {
  if (artifactDownloadAvailable) {
    return "The output shown above was truncated to fit the response. `mthds_download_artifacts` with this run id saves all of it to disk as `main_stuff.json`, verbatim; read it there in full.";
  }
  return viewsAvailable
    ? "The output shown above was truncated to fit the response; the full output is available to views."
    : "The output shown above was truncated to fit the response.";
}

/**
 * The run's stored files: how many there are, how many look like images, and
 * how to see one. This tool itself never fetches a byte and never puts a
 * picture in the conversation, which is the whole point of naming
 * `mthds_show_images` here instead. Said on both shells, since
 * `mthds_show_images` is registered on both; nothing is said when the output
 * references no stored file.
 */
function storedFilesNote(
  storedFiles: number,
  imageCandidates: number,
  names: ToolNames,
): string | undefined {
  if (storedFiles === 0) return undefined;

  const parts = [
    imageCandidates === 0
      ? `The output references ${storedFiles} stored file(s) (\`pipelex-storage://\` references); none of them looks like an image.`
      : `The output references ${storedFiles} stored file(s) (\`pipelex-storage://\` references), ${imageCandidates} of which look like images (listed as \`image_candidates\`).`,
  ];
  if (imageCandidates > 0) {
    parts.push(
      `To see one, call \`${names.showImages}\` with this run id — it returns the picture itself, which then stays in this conversation for every turn that follows, so ask for it when someone wants to look at it rather than by reflex.`,
    );
  }
  return parts.join(" ");
}

/**
 * How to keep the run, on the shell that registers the download tool. The
 * results land here and nowhere else, so this is the moment to say that the
 * output can reach the disk without the model retyping it — which costs output
 * tokens in proportion to the result and can alter it silently — and, when the
 * output references stored files, that their presigned links expire within the
 * hour. A truncated result's own sentence already names the tool, so without
 * files there is nothing left to add.
 */
function saveNote(storedFiles: number, truncated: boolean): string | undefined {
  if (storedFiles > 0) {
    return "To keep this run, call `mthds_download_artifacts` with this run id: it saves the output verbatim as `main_stuff.json` and the full files beside it, under `runs/<run_id>/` — the presigned `public_url` links in the output expire within the hour, where that tool resolves a fresh one every time.";
  }
  if (truncated) return undefined;
  return "To keep this output on disk, call `mthds_download_artifacts` with this run id: it writes it verbatim as `main_stuff.json` under `runs/<run_id>/`. Never retype it into a file yourself.";
}

function failedResult(runId: string, status: RunStatus, message: string): RunResultsResult {
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "failed",
      run_status: status,
      failure_message: message,
      available_view_specs: [],
    },
    summary: [
      "# Run failed",
      `Run \`${runId}\` ended ${status}: ${message}`,
      "No graph is available for failed runs.",
    ].join("\n\n"),
  };
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

  try {
    const ack = await runClient(context).start(toStartOptions(request));
    return startResult(ack, context.viewsAvailable !== false, context.toolNames);
  } catch (err) {
    const error = classifyError(err, { ...classifyOptions, auth: context.authError });
    return startErrorResult(startSummaryForError(error), [error]);
  }
}

/** One cheap self-healing status read — `GET /v1/runs/{id}/status`. */
export async function getMthdsRunStatus(
  input: RunIdInput,
  context: RunContext = buildRunContext(),
): Promise<RunStatusResult> {
  const names = context.toolNames ?? WORKSHOP_TOOL_NAMES;
  const inputErrors = validateRunIdRequest(input.run_id, names);
  if (inputErrors.length > 0) {
    return statusErrorResult("Run status was not read: request input is invalid.", inputErrors);
  }

  try {
    const read = await runClient(context).getRunStatus(input.run_id);
    return statusResult(read, names);
  } catch (err) {
    const error = classifyError(err, { ...runStatusErrorOptions(names), auth: context.authError });
    return statusErrorResult(statusSummaryForError(error), [error]);
  }
}

/** One-shot result lookup — `GET /v1/runs/{id}/results`. */
export async function getMthdsRunResults(
  input: RunIdInput,
  context: RunContext = buildRunContext(),
): Promise<RunResultsResult> {
  const names = context.toolNames ?? WORKSHOP_TOOL_NAMES;
  const inputErrors = validateRunIdRequest(input.run_id, names);
  if (inputErrors.length > 0) {
    return resultsErrorResult("Run results were not read: request input is invalid.", inputErrors);
  }

  let state: RunResultState;
  try {
    state = await runClient(context).getRunResult(input.run_id);
  } catch (err) {
    const error = classifyError(err, { ...runResultsErrorOptions(names), auth: context.authError });
    return resultsErrorResult(resultsSummaryForError(error), [error]);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (a completed result missing main_stuff) is a
  // reachable contract violation, surfaced as a runtime no-verdict error.
  try {
    return resultsResult(
      state,
      context.viewsAvailable !== false,
      context.artifactDownloadAvailable === true,
      names,
    );
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
    // Response-metadata channel (the mthds_validate convention): the executed
    // graph, the FULL unbounded main output, the FULL per-call token-usage list,
    // and the per-pipe usage rollup ride `_meta`, never structuredContent, so the
    // model never pays their tokens. Views consume it on the hosted shell; raw
    // MCP consumers can still retain it on the tools-only local shell. Keys
    // mirror the API field names (usage_by_pipe is the SDK's per-pipe rollup,
    // projected onto this tool's row shape).
    _meta: {
      graph_spec: result.graphSpec,
      // Keyed as the API names them, like every other key here. These three are
      // what turn the graph's data nodes from structure tables into the run's
      // actual values; see `completedResult` for why the first two are a pair.
      pipe_io_contracts: result.pipeIoContracts,
      output_form: result.outputForm,
      input_form: result.inputForm,
      main_stuff: result.mainStuff,
      tokens_usages: result.tokensUsages,
      usage_by_pipe: result.usageByPipe,
    },
  };
}
