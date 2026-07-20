import { isTerminalRunStatus, PipelexApiClient } from "@pipelex/sdk";
import type {
  RunRead,
  RunResults,
  RunResultStart,
  RunResultState,
  RunStatus,
  StartOptions,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  buildApiConfig,
  classifyError,
  filesInputSchema,
  resolveSubmittedFiles,
  toolErrorSchema,
  toolResultContent,
  validateRequest,
  validateRunIdRequest,
} from "./shared.js";
import type {
  ClassifyErrorOptions,
  ErrorClass,
  FileResolver,
  SubmittedFile,
  SubmittedFileInput,
  ToolError,
} from "./shared.js";

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

const runStatusSchema = z.enum(Object.keys(RUN_STATUS_SET) as [RunStatus, ...RunStatus[]]);

const runIdInputField = z.string().describe("The durable run id returned by mthds_run.");

export const mthdsRunInputSchema = {
  files: filesInputSchema,
  pipe_code: z
    .string()
    .optional()
    .describe("The pipe to run. Omit to run the bundle's declared main pipe."),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Method inputs — fill the template returned by mthds_inputs_template. Binary inputs ride reachable https URLs.",
    ),
};

export const mthdsRunStatusInputSchema = {
  run_id: runIdInputField,
};

export const mthdsRunResultsInputSchema = {
  run_id: runIdInputField,
};

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

const runStartStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  run_id: z
    .string()
    .optional()
    .describe("The durable run id — the handle for mthds_run_status and mthds_run_results."),
  run_status: runStatusSchema
    .optional()
    .describe("Initial lifecycle state from the start ack, when the server includes one."),
  created_at: z.string().optional(),
  available_view_specs: z
    .array(runViewSpecSchema)
    .describe(
      'Renderable views available for this result. Contains "live_run_status" when a live-following status card is available; empty otherwise.',
    ),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsRunOutputSchema = runStartStructuredContentSchema;

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

const runResultsStructuredContentSchema = z.object({
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
    .describe("True when main_stuff was bounded down; the full output rides the view-only _meta."),
  available_view_specs: z
    .array(resultsViewSpecSchema)
    .describe(
      'Renderable views available for this result. Contains "run_graph" when the executed method graph is available to display; empty otherwise.',
    ),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsRunResultsOutputSchema = runResultsStructuredContentSchema;

export interface MthdsRunInput {
  files: SubmittedFileInput[];
  pipe_code?: string;
  inputs?: Record<string, unknown>;
}

/** The run request after `{ path }` resolution — what the checks and the API call consume. */
interface ResolvedRunRequest {
  files: SubmittedFile[];
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

export interface RunResultsStructuredContent {
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";
  retry_after_seconds?: number | null;
  run_status?: RunStatus;
  failure_message?: string;
  main_stuff?: unknown;
  truncated?: boolean;
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
   * The full, unbounded main output on raw MCP response metadata (rides
   * `_meta.main_stuff`). `structuredContent.main_stuff` is the bounded copy.
   * It remains on the raw MCP result even when the invoking shell has no views,
   * so a programmatic consumer never loses the full result.
   */
  mainStuff?: unknown;
}

/** The slice of `PipelexApiClient` the run capabilities call (test seam). */
interface RunClient {
  start(options: StartOptions): Promise<RunResultStart>;
  getRunStatus(runId: string): Promise<RunRead>;
  getRunResult(runId: string): Promise<RunResultState>;
}

export interface RunContext {
  baseUrl: string;
  apiKey?: string;
  client?: RunClient;
  /** Fills `{ path }` items from disk (local workshop); absent on the hosted console. */
  resolver?: FileResolver;
  /** Whether this shell can render run-follow and its view-only result payloads. */
  viewsAvailable?: boolean;
}

export function buildRunContext(env = process.env): RunContext {
  return buildApiConfig(env);
}

export const RUN_START_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/start",
  badRequest: {
    location: "files",
    hint: "Check files, pipe_code, and inputs; validate the bundle with mthds_validate and fill the template from mthds_inputs_template first.",
  },
  // Live-checked (2026-07-15): the hosted /v1/start reports start-time
  // rejections — including an invalid bundle — as a generic 503 "Failed to
  // start pipeline", indistinguishable from real server trouble. Point the
  // agent at the recoverable cause first.
  serverError: {
    hint: "The hosted API reports start-time rejections (e.g. an invalid bundle or bad inputs) as a generic server error. Validate the bundle with mthds_validate and check the inputs against mthds_inputs_template; if both pass, the platform itself may be having trouble.",
  },
};

const UNKNOWN_RUN_HINT =
  "No run with this id is known to the configured API. Check the run_id returned by mthds_run, and that PIPELEX_BASE_URL points at the deployment that started it.";

const MALFORMED_RUN_ID_HINT = "Pass the run_id exactly as returned by mthds_run.";

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
  const errors = validateRequest(input.files);

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
 * Project a start ack. `state` and `created_at` are hosted extension fields on
 * the protocol's `RunResultStart` (typed `unknown`), so they are narrowed
 * defensively rather than trusted. A produced ack advertises the
 * `live_run_status` view only when the invoking shell registered run-follow.
 */
export function startResult(ack: RunResultStart, viewsAvailable = true): RunStartResult {
  const runStatus = narrowRunStatus(ack.state);
  const createdAt = narrowString(ack.created_at);

  const structuredContent: RunStartStructuredContent = {
    status: "ok",
    run_id: ack.pipeline_run_id,
    ...(runStatus === undefined ? {} : { run_status: runStatus }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    available_view_specs: viewsAvailable ? ["live_run_status"] : [],
  };

  const summaryParts = [
    "# Run started",
    `The run was accepted; its durable id is \`${ack.pipeline_run_id}\`.`,
    "Check on it with `mthds_run_status` (one cheap read — honor its retry hint instead of polling in a tight loop), and fetch the outcome with `mthds_run_results` once it is terminal.",
  ];
  if (viewsAvailable) {
    summaryParts.push(
      "## Views",
      "A live status card follows this run on its own (polling, then the results); the user is already watching it — no need to poll on their behalf.",
    );
  }

  return { structuredContent, summary: summaryParts.join("\n\n") };
}

/** Project a self-healing status read. A terminal non-COMPLETED status is a produced verdict. */
export function statusResult(read: RunRead): RunStatusResult {
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

  return { structuredContent, summary: statusSummary(read, isTerminal) };
}

function statusSummary(read: RunRead, isTerminal: boolean): string {
  const lines: string[] = [];

  if (isTerminal) {
    lines.push(
      read.status === "COMPLETED"
        ? `Run \`${read.pipeline_run_id}\` is COMPLETED. Fetch the output with \`mthds_run_results\`.`
        : `Run \`${read.pipeline_run_id}\` ended ${read.status}. \`mthds_run_results\` returns the failure details.`,
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
export function resultsResult(state: RunResultState, viewsAvailable = true): RunResultsResult {
  switch (state.state) {
    case "running":
      return runningResult(state.pipeline_run_id, state.retry_after_seconds);
    case "completed":
      return completedResult(state.pipeline_run_id, state.result, viewsAvailable);
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

  const structuredContent: RunResultsStructuredContent = {
    status: "ok",
    run_id: runId,
    state: "completed",
    main_stuff: bounded,
    truncated,
    available_view_specs: graphSpec === undefined ? [] : ["run_graph"],
  };

  return {
    structuredContent,
    summary: completedSummary(runId, bounded, truncated, viewsAvailable),
    graphSpec,
    mainStuff: result.main_stuff,
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
): string {
  const fence =
    typeof bounded === "string"
      ? "```\n" + bounded + "\n```"
      : "```json\n" + JSON.stringify(bounded, null, 2) + "\n```";

  const parts = ["# Run results", `Run \`${runId}\` completed. Main output:`, fence];
  if (truncated) {
    parts.push(
      viewsAvailable
        ? "The output shown above was truncated to fit the response; the full output is available to views."
        : "The output shown above was truncated to fit the response.",
    );
  }
  return parts.join("\n\n");
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
  return (
    context.client ??
    new PipelexApiClient({
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    })
  );
}

/** Start a durable run — fire-and-forget `POST /v1/start`, never blocking. */
export async function startMthdsRun(
  input: MthdsRunInput,
  context: RunContext = buildRunContext(),
): Promise<RunStartResult> {
  const resolution = await resolveSubmittedFiles(input.files, context.resolver);
  if (resolution.errors.length > 0) {
    return startErrorResult("Run was not started: request input is invalid.", resolution.errors);
  }

  const request: ResolvedRunRequest = { ...input, files: resolution.files };
  const inputErrors = validateRunRequest(request);
  if (inputErrors.length > 0) {
    return startErrorResult("Run was not started: request input is invalid.", inputErrors);
  }

  try {
    const ack = await runClient(context).start(toStartOptions(request));
    return startResult(ack, context.viewsAvailable !== false);
  } catch (err) {
    const error = classifyError(err, RUN_START_ERROR_OPTIONS);
    return startErrorResult(startSummaryForError(error), [error]);
  }
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
    const error = classifyError(err, RUN_STATUS_ERROR_OPTIONS);
    return statusErrorResult(statusSummaryForError(error), [error]);
  }
}

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
    state = await runClient(context).getRunResult(input.run_id);
  } catch (err) {
    const error = classifyError(err, RUN_RESULTS_ERROR_OPTIONS);
    return resultsErrorResult(resultsSummaryForError(error), [error]);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (a completed result missing main_stuff) is a
  // reachable contract violation, surfaced as a runtime no-verdict error.
  try {
    return resultsResult(state, context.viewsAvailable !== false);
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
// own request-shape errors, so only the contents cross the wire.
function toStartOptions(input: ResolvedRunRequest): StartOptions {
  return {
    mthds_contents: input.files.map((file) => file.content),
    ...(input.pipe_code === undefined ? {} : { pipe_code: input.pipe_code }),
    ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
  };
}

const START_ERROR_SUMMARIES: Record<ErrorClass, string> = {
  config: "Run could not start: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Run was not started: the Pipelex API rejected the request.",
  runtime: "Run could not be started: the Pipelex API returned an error.",
};

const STATUS_ERROR_SUMMARIES: Record<ErrorClass, string> = {
  config: "Run status could not be read: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Run status was not read: the Pipelex API rejected the request.",
  runtime: "Run status could not be read: the Pipelex API returned an error.",
};

const RESULTS_ERROR_SUMMARIES: Record<ErrorClass, string> = {
  config: "Run results could not be read: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Run results were not read: the Pipelex API rejected the request.",
  runtime: "Run results could not be read: the Pipelex API returned an error.",
};

function startSummaryForError(error: ToolError): string {
  return START_ERROR_SUMMARIES[error.class];
}

function statusSummaryForError(error: ToolError): string {
  return STATUS_ERROR_SUMMARIES[error.class];
}

function resultsSummaryForError(error: ToolError): string {
  return RESULTS_ERROR_SUMMARIES[error.class];
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
    // graph and the FULL unbounded main output ride `_meta`, never
    // structuredContent, so the model never pays their tokens. Views consume
    // it on the hosted shell; raw MCP consumers can still retain it on the
    // tools-only local shell. Keys mirror the API field names.
    _meta: { graph_spec: result.graphSpec, main_stuff: result.mainStuff },
  };
}
