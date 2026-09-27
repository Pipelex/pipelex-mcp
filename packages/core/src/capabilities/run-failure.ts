/**
 * Why a hosted run failed, carried from the report the runner stored and worded
 * for each reader.
 *
 * When a run fails, the runner writes an error report and the platform stores it
 * on the run whole: the status read serves it as `RunRead.error`, and the results
 * read's `409` carries it too once the platform relays it there. This module
 * narrows that report into the `failure` object every failed arm of the run
 * family carries, and words it twice: for the model, in the result summary, and
 * for the person, in the console's views.
 *
 * The two wordings differ on purpose. The platform serves the runner's VERBOSE
 * report, so its `message` can hold a provider's raw text. The model reads that
 * message, through `failure.message` and the summary, because it is what lets an
 * assistant diagnose the fault. The person never sees it: the views say why from
 * the report's `title`, what to do from its `user_action`, and give a short
 * support line with the run id, the error type and the time the run ended.
 *
 * Nothing here is inferred. Whether running it again can help comes from the
 * report's `retryable` alone, and a report without one gets no retry sentence
 * either way. The runner owns the report's shape, so every field is narrowed as
 * it arrives, the way `narrowMethodProvenance` treats provenance: a field of the
 * wrong type reads as absent, and a report with nothing to say reads as no report.
 *
 * The views bundle this module for the browser, so it imports types only.
 */

import type { RunStatus } from "@pipelex/sdk";

/** The next step the report advises: `kind` names the category, `detail` says it in words. */
export interface RunFailureUserAction {
  kind: string;
  detail: string;
}

/**
 * The `failure` object a failed arm carries: the report's fields a reader acts
 * on, with the run id and the time the run ended. It leaves out
 * `provider_metadata`, which holds the provider's raw body, and every field the
 * report did not carry.
 */
export interface RunFailure {
  run_id: string;
  /** The runner's exception class name, an open set: for the support line, never matched against. */
  error_type?: string;
  /** The stable human label of the error class (`LLM completion`). */
  title?: string;
  /** What went wrong, as the runner wrote it. It can hold a provider's raw text. */
  message?: string;
  /** Who can fix it: `input`, `config` or `runtime`. */
  error_domain?: string;
  /** The finer class of an inference failure: `transient`, `configuration`, `content`, `capacity`, … */
  error_category?: string;
  /** Whether running it again can succeed. Absent means unknown, which is not `false`. */
  retryable?: boolean;
  user_action?: RunFailureUserAction;
  /** When the run ended, as the run record states it. */
  finished_at?: string;
}

/**
 * The most of a report's `message` a result carries, in Unicode code points.
 * The runner embeds whatever its exception said, unbounded: a structured output
 * that still failed after its re-asks quotes every validation error, and a
 * provider SDK's error quotes the whole response body, so one report can run to
 * hundreds of kilobytes, and the message reaches the model in the summary and in
 * `structuredContent` both. The head says what went wrong; the rest is a
 * provider's detail the model cannot act on.
 */
export const FAILURE_MESSAGE_MAX_CODE_POINTS = 2_000;

/** The most of any other text field of a report a result carries, in Unicode code points. */
export const FAILURE_FIELD_MAX_CODE_POINTS = 300;

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
 * The `failure` object for a run, from its stored report, or `undefined` when
 * there is none to carry: a `null` report (a run the platform finalized itself),
 * one that is not an object, and one carrying none of the fields that say what
 * happened (`error_type`, `title`, `message`, `user_action`). Every text field
 * is bounded (`FAILURE_MESSAGE_MAX_CODE_POINTS` for the message,
 * `FAILURE_FIELD_MAX_CODE_POINTS` for the rest), and a `wait_and_retry` action
 * carries this module's own advice rather than the runner's, for the reason
 * {@link nextStepOf} gives.
 */
export function runFailureOf(
  runId: string,
  report: unknown,
  finishedAt?: string | null,
): RunFailure | undefined {
  if (!isRecord(report)) return undefined;
  const errorType = field(report.error_type);
  const title = field(report.title);
  const rawMessage = text(report.message);
  const message =
    rawMessage === undefined
      ? undefined
      : boundedFailureText(rawMessage, FAILURE_MESSAGE_MAX_CODE_POINTS);
  const retryable = typeof report.retryable === "boolean" ? report.retryable : undefined;
  const userAction = userActionOf(report.user_action, retryable);
  if (
    errorType === undefined &&
    title === undefined &&
    message === undefined &&
    userAction === undefined
  ) {
    return undefined;
  }
  const errorDomain = field(report.error_domain);
  const errorCategory = field(report.error_category);
  const ended = text(finishedAt);
  return {
    run_id: runId,
    ...(errorType === undefined ? {} : { error_type: errorType }),
    ...(title === undefined ? {} : { title }),
    ...(message === undefined ? {} : { message }),
    ...(errorDomain === undefined ? {} : { error_domain: errorDomain }),
    ...(errorCategory === undefined ? {} : { error_category: errorCategory }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(userAction === undefined ? {} : { user_action: userAction }),
    ...(ended === undefined ? {} : { finished_at: ended }),
  };
}

/**
 * The sentence for a user action that carries no detail, by its `kind`. A kind
 * this table does not know (`unknown`, or one the runner adds) says nothing
 * rather than guess.
 */
const NEXT_STEP_BY_KIND: Readonly<Record<string, string>> & { wait_and_retry: string } = {
  wait_and_retry: "Wait a moment, then run it again.",
  change_input: "Change the inputs, then start a new run.",
  change_model: "Choose another model for the pipe that failed, then start a new run.",
  check_billing: "Check the organization's billing and credits, then start a new run.",
  check_credentials: "Check the credentials the method uses, then start a new run.",
  contact_support: "Contact Pipelex support with the details below.",
};

/**
 * What to do next: the report's own advice when it words one, else the sentence
 * its `kind` calls for, else `undefined`.
 *
 * A `wait_and_retry` kind is the exception, and always takes this module's own
 * sentence. The runner words that kind's advice for a pipe still inside its own
 * retries ("the system will retry automatically"), which is false once the
 * report is the stored account of a run that has ended: nothing retries a
 * finished run. And on a report whose `retryable` is `false` the kind yields
 * nothing at all, since the two disagree and the retry flag is the one that
 * decides.
 */
export function nextStepOf(failure: RunFailure | undefined): string | undefined {
  const action = failure?.user_action;
  if (action === undefined) return undefined;
  if (action.kind === "wait_and_retry") {
    return failure?.retryable === false ? undefined : NEXT_STEP_BY_KIND.wait_and_retry;
  }
  const detail = action.detail.trim();
  if (detail !== "") return detail;
  return NEXT_STEP_BY_KIND[action.kind];
}

/**
 * Whether running it again can help, from the report's `retryable` alone;
 * `undefined` when it does not say. A `false` is worded as the report's
 * expectation and never as a certainty: the runner sets it for a failure it
 * could not classify as well as for one that will surely recur, so it means
 * "not expected to help", not "will fail".
 */
export function retryAdviceOf(failure: RunFailure | undefined): string | undefined {
  if (failure?.retryable === true) return "Running it again can succeed.";
  if (failure?.retryable === false) {
    return "The report does not expect running it again unchanged to help.";
  }
  return undefined;
}

/**
 * The line to hand support: the run id, the error type and the time the run
 * ended, each only when known — `Run run_… · LLMCompletionError · ended
 * 2026-09-23T15:16:37.856067+00:00`. The time is the run record's own, as it
 * came, since that is what support finds the run's logs by.
 */
export function supportLineOf(
  runId: string,
  failure: RunFailure | undefined,
  finishedAt?: string | null,
): string {
  const ended = failure?.finished_at ?? text(finishedAt);
  return [`Run ${runId}`, failure?.error_type, ended === undefined ? undefined : `ended ${ended}`]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/**
 * The failure as the model reads it in a result summary, one labelled sentence
 * per line: that the run ended and how, why (the report's title and message),
 * what to do, whether running it again can help, and what to give support. A run
 * with no report says so, and still gives the support line. `reportRead` is
 * `false` when the read that would have carried the report failed, so that an
 * absent report is said to be unknown rather than missing.
 */
export function failureSummaryLines(
  runId: string,
  status: RunStatus,
  failure: RunFailure | undefined,
  finishedAt?: string | null,
  reportRead = true,
): string[] {
  const lines = [`Run \`${runId}\` ended ${status}.`];
  if (failure === undefined) {
    lines.push(
      reportRead
        ? "Why: the run stored no error report, so its status is all that is known about why it ended."
        : "Why: unknown for now, since the run's error report could not be read; reading the run's status again returns it.",
    );
  } else {
    const why = [failure.title, failure.message].filter(
      (part): part is string => part !== undefined,
    );
    lines.push(
      why.length === 0
        ? `Why: the report names the error type \`${failure.error_type ?? "unknown"}\` and gives no message.`
        : `Why: ${why.join(" — ")}`,
    );
    lines.push(`What to do: ${nextStepOf(failure) ?? "the report names no next step."}`);
    const retry = retryAdviceOf(failure);
    if (retry !== undefined) lines.push(`Retry: ${retry}`);
  }
  lines.push(`For support: ${supportLineOf(runId, failure, finishedAt)}`);
  return lines;
}

/** The failure as a person reads it in the console's views: never the report's message, never provider text. */
export interface RunFailureDisplay {
  /** Why the run failed, in plain words: the report's title. */
  reason: string;
  /** What the person can do next. */
  nextStep: string;
  /** Whether trying again can help, when the report says. */
  retry?: string;
  /** The short line to copy for support. */
  support: string;
}

/**
 * The failure as the views show it. The reason is the report's `title`, the
 * stable label of the error class, and never its `message`, which can carry a
 * provider's raw text; the next step is the report's advice, or support when it
 * gives none.
 */
export function failureDisplayOf(
  runId: string,
  failure: RunFailure | undefined,
  finishedAt?: string | null,
): RunFailureDisplay {
  const retry = retryAdviceOf(failure);
  return {
    reason:
      failure === undefined
        ? "No reason was recorded for this run."
        : (failure.title ?? "The run failed without naming a cause."),
    nextStep: nextStepOf(failure) ?? "If you need help, contact support with the line below.",
    ...(retry === undefined ? {} : { retry }),
    support: supportLineOf(runId, failure, finishedAt),
  };
}

/**
 * The report's user action, bounded. A `wait_and_retry` kind carries this
 * module's own sentence, or no advice when the report says a retry cannot help:
 * the runner words that kind for a pipe still inside its own retries ("the
 * system will retry automatically"), which the model would otherwise read here
 * about a run that has ended.
 */
function userActionOf(
  value: unknown,
  retryable: boolean | undefined,
): RunFailureUserAction | undefined {
  if (!isRecord(value)) return undefined;
  const kind = field(value.kind);
  if (kind === undefined || typeof value.detail !== "string") return undefined;
  if (kind === "wait_and_retry") {
    return { kind, detail: retryable === false ? "" : NEXT_STEP_BY_KIND.wait_and_retry };
  }
  return { kind, detail: boundedFailureText(value.detail, FAILURE_FIELD_MAX_CODE_POINTS) };
}

/** A non-blank string, as given; anything else reads as absent. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** A non-blank string bounded to `FAILURE_FIELD_MAX_CODE_POINTS`; anything else reads as absent. */
function field(value: unknown): string | undefined {
  const given = text(value);
  return given === undefined ? undefined : boundedFailureText(given, FAILURE_FIELD_MAX_CODE_POINTS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
