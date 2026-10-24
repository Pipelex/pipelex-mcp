/**
 * How far a hosted run has got, relayed from its progress snapshot to the
 * model.
 *
 * The hosted plane projects a run's progress snapshot at each read of
 * `GET /v1/runs/{id}/progress`: which invocations of which pipes have started,
 * ended or been skipped, how far each batch has got, which outcome each
 * condition took, where the run is retrying or stuck, and a one-line `summary`
 * worded by the contract's own rule. `@pipelex/sdk` reads it as `RunProgress`
 * (`client.getRunProgress`). The status tool reads it once after every status
 * read (`readRunProgress` in `run.ts`), and this module narrows the snapshot
 * into the `progress` member of the status tool's `structuredContent` and gives
 * the paragraph the result's Markdown carries.
 *
 * **The summary is relayed, never worded here.** The contract words it from the
 * snapshot alone so that every carrier and every client says the same progress
 * the same way, the hosted console's run status included, so the paragraph is
 * `Progress: ` and the summary as the platform sent it, a line break collapsed
 * to a space so that it stays one paragraph.
 *
 * **The projection keeps the status tool answering.** The MCP server checks a
 * result's `structuredContent` against the tool's output schema and turns a
 * mismatch into a failed call, and the SDK checks only the members a reader
 * leans on, relaying the rest as sent. So the snapshot is projected onto the
 * contract's known members, each optional one kept only when it has its type
 * (`root_path` and `chain` are dropped: the hosted plane never sets them), and
 * a snapshot whose required members do not have theirs reads as none at all,
 * since the progress is best effort and must never fail the status it rides
 * with.
 *
 * **It is bounded, because it is model-facing.** A wide batch gives the snapshot
 * one invocation per item and every invocation below each, so the status tool
 * lists at most `MAX_PROGRESS_INVOCATIONS` of them and counts the rest in
 * `progress_invocations_omitted` (`selectInvocations`). The ones worth reading
 * are kept first: those running or in trouble, with their ancestors so that
 * the list still nests; the rest fill what room is left in snapshot order, and
 * the list keeps snapshot order. The free texts the runtime or the platform
 * write in it (a degradation's message, a skip reason) are bounded as a run's
 * problem is, and an invocation's latest failure is a problem carried as the
 * run's own is (`runErrorOf` in `run-failure.ts`); the summary is not, since it
 * is the contract's own line, a label per level of the run's nesting.
 *
 * `last_failure` is read as the hosted contract states it, `{ problem, at }`,
 * and not as `@pipelex/sdk`'s `ProgressFailure` types it (`{ message, at }`, a
 * shape the platform no longer serves): its `problem` is checked as a problem
 * document, and an annotation without one is dropped.
 */

import type { Problem, RunProgress } from "@pipelex/sdk";
import { z } from "zod";

import {
  FAILURE_FIELD_MAX_CODE_POINTS,
  FAILURE_MESSAGE_MAX_CODE_POINTS,
  boundedFailureText,
  runErrorOf,
  runErrorSchema,
} from "./run-failure.js";

/**
 * The most invocations the status tool's `progress` lists; the rest are
 * counted in `progress_invocations_omitted`.
 */
export const MAX_PROGRESS_INVOCATIONS = 50;

/**
 * Why a run reads degraded, as the status read and the snapshot both carry it.
 * Its members are each present when the platform sent them with their type.
 */
export interface ProgressDegradation {
  reason: string;
  message?: string | null;
  failed_attempts?: number | null;
  failing_since?: string | null;
  ends_at?: string | null;
}

/** One invocation of the snapshot, as the status tool relays it. */
export interface ProgressInvocationProjection {
  path: string;
  pipe_code: string;
  pipe_ref: string;
  pipe_type: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  step_count?: number;
  branch_count?: number;
  skip_reason?: string;
  batch?: { total: number; done: number; running: number; failed: number };
  condition?: { selected_outcome: string | null };
  attempts?: number;
  last_failure?: { problem: Problem; at?: string };
  degradation?: ProgressDegradation;
}

/** The status tool's `progress`: the run's progress snapshot, its invocations bounded. */
export interface RunProgressProjection {
  pipeline_run_id: string;
  mode: string;
  status: string;
  version: number;
  assembled_at: string;
  summary: string;
  degradation?: ProgressDegradation;
  invocations: ProgressInvocationProjection[];
}

/** A snapshot as the status tool relays it, and how many invocations it left out. */
export interface ProjectedRunProgress {
  progress: RunProgressProjection;
  /** How many of the snapshot's invocations `progress.invocations` leaves out; 0 when none. */
  omitted: number;
}

const progressDegradationSchema = z.object({
  reason: z
    .string()
    .describe(
      'Why the run reads degraded: "workflow_task_failing" (the run is not making progress) or "status_unavailable" (the platform could not read the run, so its status is the last one recorded). An open set.',
    ),
  message: z.string().nullable().optional().describe("The platform's account, to show as it is."),
  failed_attempts: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("How many times in a row the run has failed to advance."),
  failing_since: z.string().nullable().optional().describe("When that series of failures began."),
  ends_at: z
    .string()
    .nullable()
    .optional()
    .describe("When the platform ends the run as failed if it is still failing then."),
});

const progressCountSchema = z.number().int();

const progressInvocationSchema = z.object({
  path: z
    .string()
    .describe(
      "The invocation's path: the entry pipe's pipe_ref, then one segment per controller level (step_<n>, branch_<n>, item_<n>, outcome_<key>, default), joined by /.",
    ),
  pipe_code: z.string(),
  pipe_ref: z.string(),
  pipe_type: z.string(),
  status: z.string().describe("scheduled, running, succeeded, failed, skipped or canceled."),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  step_count: progressCountSchema.optional(),
  branch_count: progressCountSchema.optional(),
  skip_reason: z.string().optional(),
  batch: z
    .object({
      total: progressCountSchema,
      done: progressCountSchema,
      running: progressCountSchema,
      failed: progressCountSchema,
    })
    .optional()
    .describe("On a batch that has fanned out, its items' counts."),
  condition: z
    .object({ selected_outcome: z.string().nullable() })
    .optional()
    .describe("On a condition that has resolved, the outcome it took; null for its default."),
  attempts: progressCountSchema
    .optional()
    .describe("How many times its work has been tried, when more than once."),
  last_failure: z
    .object({ problem: runErrorSchema, at: z.string().optional() })
    .optional()
    .describe(
      "The latest failure of its work: the problem that ended it when it failed, else that of the latest attempt its engine is trying again.",
    ),
  degradation: progressDegradationSchema
    .optional()
    .describe("The run is stuck at this invocation."),
});

/** The output schema of the status tool's `progress` member. */
export const runProgressSchema = z.object({
  pipeline_run_id: z.string(),
  mode: z.string().describe('"live" on the hosted API.'),
  status: z.string().describe("pending, running, succeeded, failed or canceled."),
  version: progressCountSchema.describe(
    "Grows with each progress event the run records: of two snapshots, the higher version is the newer.",
  ),
  assembled_at: z.string().describe("When the platform projected the snapshot."),
  summary: z
    .string()
    .describe(
      "One line saying how far the run has got, which the summary repeats. Show it as it is; never parse it.",
    ),
  degradation: progressDegradationSchema
    .optional()
    .describe("The run status's degradation, when the run reads degraded."),
  invocations: z
    .array(progressInvocationSchema)
    .describe(
      `Invocations of pipes in the run, each listed after its ancestors: at most ${MAX_PROGRESS_INVOCATIONS}, those running or in trouble kept first.`,
    ),
});

/**
 * The status tool's `progress` from a snapshot, with how many invocations it
 * left out, or `undefined` when the snapshot cannot be read: a required member,
 * the snapshot's or an invocation's, missing or of another type. See the
 * module comment for what is kept and bounded.
 */
export function runProgressOf(snapshot: RunProgress): ProjectedRunProgress | undefined {
  const record: Record<string, unknown> = snapshot;
  const { pipeline_run_id, mode, status, version, assembled_at, summary, invocations } = record;
  if (
    !isString(pipeline_run_id) ||
    !isString(mode) ||
    !isString(status) ||
    !isCount(version) ||
    !isString(assembled_at) ||
    !isString(summary) ||
    !Array.isArray(invocations)
  ) {
    return undefined;
  }
  const projected: ProgressInvocationProjection[] = [];
  for (const invocation of invocations) {
    const kept = invocationOf(invocation);
    if (kept === undefined) return undefined;
    projected.push(kept);
  }
  const selected = selectInvocations(projected, MAX_PROGRESS_INVOCATIONS);
  const degradation = degradationOf(record.degradation);
  return {
    progress: {
      pipeline_run_id,
      mode,
      status,
      version,
      assembled_at,
      summary,
      ...(degradation === undefined ? {} : { degradation }),
      invocations: selected,
    },
    omitted: projected.length - selected.length,
  };
}

/**
 * At most `max` of a snapshot's invocations, in snapshot order: first every
 * invocation running or in trouble (`needsAttention`) with its ancestors, then
 * the others in snapshot order while room is left. Snapshot order lists each
 * invocation after its ancestors, and each step takes invocations in that
 * order, so the list still nests, even when the first kind alone passes `max`
 * and only its first `max` are kept.
 */
export function selectInvocations(
  invocations: readonly ProgressInvocationProjection[],
  max: number,
): ProgressInvocationProjection[] {
  if (invocations.length <= max) return [...invocations];
  const indexByPath = new Map(invocations.map((invocation, index) => [invocation.path, index]));
  const wanted = new Set<number>();
  invocations.forEach((invocation, index) => {
    if (!needsAttention(invocation)) return;
    wanted.add(index);
    for (const ancestor of ancestorPathsOf(invocation.path)) {
      const ancestorIndex = indexByPath.get(ancestor);
      if (ancestorIndex !== undefined) wanted.add(ancestorIndex);
    }
  });
  const chosen = new Set<number>();
  for (const index of [...wanted].sort((left, right) => left - right)) {
    if (chosen.size === max) break;
    chosen.add(index);
  }
  for (let index = 0; index < invocations.length && chosen.size < max; index += 1) {
    chosen.add(index);
  }
  return [...chosen]
    .sort((left, right) => left - right)
    .map((index) => invocations[index] as ProgressInvocationProjection);
}

/**
 * The paragraph the status tool's Markdown gives the snapshot: `Progress: ` and
 * its summary as the platform sent it, a line break collapsed to a space.
 */
export function progressParagraph(progress: RunProgressProjection): string {
  return `Progress: ${progress.summary.replace(/[\r\n\u2028\u2029]+/g, " ")}`;
}

/**
 * Whether a snapshot reports the run stuck: it carries a degradation for any
 * reason but the platform's failure to read the run, which says nothing about
 * the run itself. A reason this server does not know counts as stuck, since a
 * reader that does not know it must not tell the person the run is fine.
 */
export function progressReportsStuck(progress: RunProgressProjection | undefined): boolean {
  const reason = progress?.degradation?.reason;
  return reason !== undefined && reason !== "status_unavailable";
}

/**
 * Whether an invocation is one a reader needs first: running, failed, or
 * carrying a health annotation (`attempts`, `last_failure`, `degradation`).
 */
function needsAttention(invocation: ProgressInvocationProjection): boolean {
  return (
    invocation.status === "running" ||
    invocation.status === "failed" ||
    invocation.attempts !== undefined ||
    invocation.last_failure !== undefined ||
    invocation.degradation !== undefined
  );
}

/**
 * The paths of an invocation's ancestors, nearest the root first. A path's root
 * is a `pipe_ref`, which holds no `/`, and an outcome key is percent-encoded, so
 * every `/` separates two segments.
 */
function ancestorPathsOf(path: string): string[] {
  const segments = path.split("/");
  return segments.slice(1).map((_, depth) => segments.slice(0, depth + 1).join("/"));
}

function invocationOf(value: unknown): ProgressInvocationProjection | undefined {
  if (!isRecord(value)) return undefined;
  const { path, pipe_code, pipe_ref, pipe_type, status, started_at, ended_at } = value;
  if (
    !isString(path) ||
    !isString(pipe_code) ||
    !isString(pipe_ref) ||
    !isString(pipe_type) ||
    !isString(status) ||
    !isStringOrNull(started_at) ||
    !isStringOrNull(ended_at)
  ) {
    return undefined;
  }
  const batch = batchOf(value.batch);
  const condition = conditionOf(value.condition);
  const lastFailure = lastFailureOf(value.last_failure);
  const degradation = degradationOf(value.degradation);
  return {
    path,
    pipe_code,
    pipe_ref,
    pipe_type,
    status,
    started_at,
    ended_at,
    ...(isCount(value.step_count) ? { step_count: value.step_count } : {}),
    ...(isCount(value.branch_count) ? { branch_count: value.branch_count } : {}),
    ...(isString(value.skip_reason)
      ? { skip_reason: boundedFailureText(value.skip_reason, FAILURE_FIELD_MAX_CODE_POINTS) }
      : {}),
    ...(batch === undefined ? {} : { batch }),
    ...(condition === undefined ? {} : { condition }),
    ...(isCount(value.attempts) ? { attempts: value.attempts } : {}),
    ...(lastFailure === undefined ? {} : { last_failure: lastFailure }),
    ...(degradation === undefined ? {} : { degradation }),
  };
}

function batchOf(value: unknown): ProgressInvocationProjection["batch"] {
  if (!isRecord(value)) return undefined;
  const { total, done, running, failed } = value;
  if (!isCount(total) || !isCount(done) || !isCount(running) || !isCount(failed)) return undefined;
  return { total, done, running, failed };
}

function conditionOf(value: unknown): ProgressInvocationProjection["condition"] {
  if (!isRecord(value) || !isStringOrNull(value.selected_outcome)) return undefined;
  return { selected_outcome: value.selected_outcome };
}

/**
 * An invocation's latest failure, `{ problem, at }` as the hosted contract
 * states it, its problem carried as a run's own is; `undefined` when it holds
 * no problem document.
 */
function lastFailureOf(value: unknown): ProgressInvocationProjection["last_failure"] {
  if (!isRecord(value)) return undefined;
  const problem = runErrorOf(value.problem);
  if (problem === undefined) return undefined;
  return { problem, ...(isString(value.at) ? { at: value.at } : {}) };
}

/**
 * A degradation's members, each kept when it has its type, or `undefined` when
 * it has no reason to branch on. `@pipelex/sdk` has already checked it the same
 * way; this keeps the projection's promise on its own.
 */
function degradationOf(value: unknown): ProgressDegradation | undefined {
  if (!isRecord(value) || !isString(value.reason)) return undefined;
  const { reason, message, failed_attempts, failing_since, ends_at } = value;
  return {
    reason,
    ...(isStringOrNull(message)
      ? {
          message:
            message === null ? null : boundedFailureText(message, FAILURE_MESSAGE_MAX_CODE_POINTS),
        }
      : {}),
    ...(failed_attempts === null || isCount(failed_attempts) ? { failed_attempts } : {}),
    ...(isStringOrNull(failing_since) ? { failing_since } : {}),
    ...(isStringOrNull(ends_at) ? { ends_at } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
