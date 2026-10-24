/**
 * Why a hosted run did not succeed: the run's own problem, carried to the
 * caller and stated for the model.
 *
 * When a run ends without success, the platform stores the problem it ended
 * with on the run, under the run's own code (`run.cancelled`,
 * `run.timed_out`, a model's or a method's code), with its own `domain`,
 * `retry` and `next_step`. The status read serves it as `RunPublic.error`, and
 * the results read's `409`, a `run.failed` problem, nests it as `run_error`,
 * which the SDK's failed arm carries as `error`. This module carries it, in the
 * caller's view, as the `error` member of `mthds_run_status`, the `run_error`
 * member of every other failed arm of the run family, and the `problem` of a
 * progress invocation's `last_failure`, and states it in the result summary.
 *
 * The platform serves the problem through its strict disclosure: what only an
 * engineer needs, the provider's raw answer among it, rides in the operator's
 * `diagnostics`. This module drops `diagnostics` whatever served the problem,
 * so a local loop serving it verbose keeps it from the model too. It also
 * bounds the texts a problem carries: the runtime bounds none it writes, a
 * problem about a bundle that failed validation can list every fault in it,
 * and every text reaches the model in the summary and in `structuredContent`
 * both. The head says what went wrong, and a cut says how much it left out.
 *
 * Nothing here is inferred: whether running it again can help is the
 * problem's `retry`, and what to do is its `next_step`. A value that is not a
 * problem document reads as no problem (`isProblem`), as the SDK reads it.
 */

import { isProblem, renderProblemMarkdown } from "@pipelex/sdk";
import type { Problem, ProblemItem, RunStatus } from "@pipelex/sdk";
import { z } from "zod";

import { callerView, problemSchema } from "./shared.js";

/**
 * The most of a run problem's `detail`, `message` and `next_step.detail` a
 * result carries, in Unicode code points, and of the other free texts the run
 * family relays (a progress degradation's message). A problem about a bundle
 * that failed validation can quote every fault in its detail, so one problem
 * can run long, and it reaches the model twice.
 */
export const FAILURE_MESSAGE_MAX_CODE_POINTS = 2_000;

/** The most of a run problem's `title`, and of any other short text the run family relays, in Unicode code points. */
export const FAILURE_FIELD_MAX_CODE_POINTS = 300;

/** The most of one fault's `detail`, an item of a run problem's `errors`, in Unicode code points. */
export const RUN_ERROR_ITEM_MAX_CODE_POINTS = 500;

/** The most faults of a run problem's `errors` a result lists; the rest are counted in `errors_omitted`. */
export const RUN_ERROR_MAX_ITEMS = 20;

/**
 * A run's own problem, as the run family's failed arms carry it: the caller's
 * view of the problem document, its texts bounded, with `errors_omitted`
 * counting the faults its `errors` leaves out.
 */
export const runErrorSchema = problemSchema
  .extend({
    errors_omitted: z
      .number()
      .int()
      .optional()
      .describe("How many of the run's faults errors leaves out."),
  })
  .describe(
    "The run's own problem: why it did not succeed, under its own code, with who must act (domain), whether running it again can succeed (retry) and what to do (next_step). Long texts are cut, each cut saying how much it left out.",
  );

/**
 * `value` cut to `max` Unicode code points, with a note saying how much was
 * left out, or `value` itself when it fits. Code points, so a cut never splits
 * a character.
 */
export function boundedFailureText(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max).join("")}… [${points.length - max} more characters left out]`;
}

/**
 * How deep a structured member of a run problem (`params`, `location`) is
 * carried; a value nested deeper is replaced by a text saying it was left out.
 */
export const RUN_ERROR_VALUE_MAX_DEPTH = 4;

/**
 * A run's own problem as a result carries it, or `undefined` when `value` is
 * no problem document: the caller's view, without the operator's
 * `diagnostics`, its `detail`, `message` and `next_step.detail` bounded to
 * {@link FAILURE_MESSAGE_MAX_CODE_POINTS}, its `title` to
 * {@link FAILURE_FIELD_MAX_CODE_POINTS}, and its `errors` to
 * {@link RUN_ERROR_MAX_ITEMS} faults of {@link RUN_ERROR_ITEM_MAX_CODE_POINTS}
 * each, with `errors_omitted` saying how many were left out. Its `params` and
 * `location`, and each fault's `params`, `location` and `suggestions`, are
 * bounded the same way ({@link boundedMembers}), and a fault's
 * `suggested_fix` is carried whole or not at all ({@link boundedItem}). Every
 * cut says what it left out, and the result is still a problem document
 * (`isProblem`), open to every other member as served.
 */
export function runErrorOf(value: unknown): Problem | undefined {
  if (!isProblem(value)) return undefined;
  const view = callerView(value);
  const { message } = view;
  return {
    ...view,
    title: boundedFailureText(view.title, FAILURE_FIELD_MAX_CODE_POINTS),
    detail: boundedFailureText(view.detail, FAILURE_MESSAGE_MAX_CODE_POINTS),
    next_step: {
      ...view.next_step,
      detail: boundedFailureText(view.next_step.detail, FAILURE_MESSAGE_MAX_CODE_POINTS),
    },
    ...(typeof message === "string"
      ? { message: boundedFailureText(message, FAILURE_MESSAGE_MAX_CODE_POINTS) }
      : {}),
    ...(view.params === undefined
      ? {}
      : { params: boundedMembers(view.params, RUN_ERROR_ITEM_MAX_CODE_POINTS) }),
    ...(view.location === undefined
      ? {}
      : { location: boundedMembers(view.location, FAILURE_FIELD_MAX_CODE_POINTS) }),
    ...(view.errors === undefined ? {} : boundedItems(view.errors)),
  };
}

/** A problem's faults, at most {@link RUN_ERROR_MAX_ITEMS} of them, each bounded, and how many were left out. */
function boundedItems(items: readonly ProblemItem[]): {
  errors: ProblemItem[];
  errors_omitted?: number;
} {
  const kept = items.slice(0, RUN_ERROR_MAX_ITEMS).map(boundedItem);
  return {
    errors: kept,
    ...(items.length > kept.length ? { errors_omitted: items.length - kept.length } : {}),
  };
}

/**
 * One fault with its texts and its structured members bounded. Its
 * `suggestions`, a list of names, keep at most {@link RUN_ERROR_MAX_ITEMS},
 * with `suggestions_omitted` counting the rest. A `suggested_fix` is a patch a
 * tool applies as written, so a cut one would be a wrong one: it is carried
 * whole while its JSON fits {@link FAILURE_MESSAGE_MAX_CODE_POINTS}, and
 * otherwise left out, `suggested_fix_omitted` saying so.
 */
function boundedItem(item: ProblemItem): ProblemItem {
  const { suggestions, suggested_fix: suggestedFix, ...rest } = item;
  const bounded: ProblemItem = {
    ...rest,
    code: item.code,
    detail: boundedFailureText(item.detail, RUN_ERROR_ITEM_MAX_CODE_POINTS),
    ...(item.params === undefined
      ? {}
      : { params: boundedMembers(item.params, RUN_ERROR_ITEM_MAX_CODE_POINTS) }),
    ...(item.location === undefined
      ? {}
      : { location: boundedMembers(item.location, FAILURE_FIELD_MAX_CODE_POINTS) }),
  };
  if (suggestions !== undefined) {
    const kept = suggestions
      .slice(0, RUN_ERROR_MAX_ITEMS)
      .map((name) => boundedFailureText(name, FAILURE_FIELD_MAX_CODE_POINTS));
    bounded.suggestions = kept;
    if (suggestions.length > kept.length) {
      bounded.suggestions_omitted = suggestions.length - kept.length;
    }
  }
  if (suggestedFix !== undefined) {
    if (Array.from(JSON.stringify(suggestedFix)).length <= FAILURE_MESSAGE_MAX_CODE_POINTS) {
      bounded.suggested_fix = suggestedFix;
    } else {
      bounded.suggested_fix_omitted = 1;
    }
  }
  return bounded;
}

/**
 * An object member of a problem (`params`, `location`) bounded for a result,
 * by {@link boundedValue} at every level. Kept as it came when it is no
 * object, which a problem document never sends.
 */
function boundedMembers<T>(value: T, maxText: number): T {
  return isRecord(value) ? (boundedValue(value, maxText, 0) as T) : value;
}

/**
 * A structured value bounded for a result, so that what it says still reads
 * as the protocol declares it:
 *
 * - a text is cut to `maxText` code points, saying how much it left out;
 * - an object keeps at most {@link RUN_ERROR_MAX_ITEMS} members, a `…`
 *   member counting the rest, and a list it holds keeps at most as many
 *   entries, a sibling `<name>_omitted` counting the rest, as `errors_omitted`
 *   does, so a typed list, such as `missing_blobs`, holds nothing but its
 *   entries;
 * - a list inside a list keeps as many entries, followed by a text entry
 *   counting the rest;
 * - a value nested deeper than {@link RUN_ERROR_VALUE_MAX_DEPTH} becomes a
 *   text saying it was left out;
 * - a number, a boolean and `null` are kept.
 */
export function boundedValue(value: unknown, maxText: number, depth: number): unknown {
  if (typeof value === "string") return boundedFailureText(value, maxText);
  if (Array.isArray(value)) {
    if (depth >= RUN_ERROR_VALUE_MAX_DEPTH) return `[a list of ${value.length} left out]`;
    const kept = boundedList(value, maxText, depth);
    return value.length > kept.length
      ? [...kept, `… [${value.length - kept.length} more left out]`]
      : kept;
  }
  if (!isRecord(value)) return value;
  const entries = Object.entries(value);
  if (depth >= RUN_ERROR_VALUE_MAX_DEPTH)
    return `[an object of ${entries.length} members left out]`;
  const bounded: Record<string, unknown> = {};
  const put = (name: string, member: unknown): void => {
    Object.defineProperty(bounded, name, {
      value: member,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const [name, member] of entries.slice(0, RUN_ERROR_MAX_ITEMS)) {
    const key = boundedFailureText(name, FAILURE_FIELD_MAX_CODE_POINTS);
    if (Array.isArray(member) && depth + 1 < RUN_ERROR_VALUE_MAX_DEPTH) {
      const kept = boundedList(member, maxText, depth + 1);
      put(key, kept);
      if (member.length > kept.length) put(`${key}_omitted`, member.length - kept.length);
    } else {
      put(key, boundedValue(member, maxText, depth + 1));
    }
  }
  if (entries.length > RUN_ERROR_MAX_ITEMS) {
    put("…", `${entries.length - RUN_ERROR_MAX_ITEMS} more members left out`);
  }
  return bounded;
}

/** A list's first {@link RUN_ERROR_MAX_ITEMS} entries, each bounded. */
function boundedList(list: readonly unknown[], maxText: number, depth: number): unknown[] {
  return list.slice(0, RUN_ERROR_MAX_ITEMS).map((entry) => boundedValue(entry, maxText, depth + 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The line to hand support: the run id, the problem's code and the time the
 * run ended, each only when known — `Run run_… · model.unavailable · ended
 * 2026-09-23T15:16:37.856067+00:00`. The time is the run record's own, as it
 * came, since that is what support finds the run's logs by.
 */
export function supportLineOf(
  runId: string,
  runError: Problem | undefined,
  finishedAt?: string | null,
): string {
  const ended = finishedAt !== null && finishedAt !== undefined && finishedAt.trim() !== "";
  return [`Run ${runId}`, runError?.code, ended ? `ended ${finishedAt}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/**
 * The run's ending as the model reads it in a result summary: that the run
 * ended and how, its problem as `renderProblemMarkdown` renders it (title,
 * detail, next step, code with its domain and retry verdict, each fault), and
 * what to give support. A run with no problem says so, and still gives the
 * support line. `problemRead` is `false` when the read that would have carried
 * the problem failed, so that an absent problem is said to be unknown rather
 * than missing.
 */
export function runErrorSummary(
  runId: string,
  status: RunStatus,
  runError: Problem | undefined,
  finishedAt?: string | null,
  problemRead = true,
): string {
  const parts = [`Run \`${runId}\` ended ${status}.`];
  if (runError !== undefined) {
    parts.push(renderProblemMarkdown(runError).trimEnd());
  } else if (problemRead) {
    parts.push(
      "The run stored no problem saying why it ended, so its status is all that is known about it.",
    );
  } else {
    parts.push(
      "Why it ended is unknown for now, since the run's problem could not be read; reading the run's status again returns it.",
    );
  }
  parts.push(`For support: ${supportLineOf(runId, runError, finishedAt)}`);
  return parts.join("\n\n");
}
