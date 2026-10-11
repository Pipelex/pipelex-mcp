/**
 * Why a hosted run failed, carried from the report the runner stored and worded
 * for the model.
 *
 * When a run fails, the runner writes an error report and the platform stores it
 * on the run whole; for an ending no runner reported (a workflow that kept
 * failing, a timeout, a workflow that vanished) the platform writes the report
 * itself. The status read serves it as `RunRead.error`, and the results read's
 * `409` carries it too once the platform relays it there. This module narrows
 * that report into the `failure` object every failed arm of the run family
 * carries, and words it in the result summary.
 *
 * The platform serves every stored report through the runner's STRICT
 * disclosure. It keeps the fields that classify the failure (`error_type`,
 * `title`, `type_uri`, `error_domain`, `error_category`, `retryable`,
 * `validation_errors`), reduces `provider_metadata` to a status code and a
 * retry delay, and keeps `message` and `user_action` only on a report flagged
 * `caller_facing_message: true`: the runner sets that flag on a message it
 * wrote as copy about the caller's own method or inputs, and the platform on
 * every report it writes itself. Any other report's `message` is the
 * placeholder "An internal error occurred.", which tells an assistant nothing,
 * so this module carries `message` only from a report flagged caller-facing,
 * and the failed arm's account of the ending, which quotes that message, follows
 * the same rule (`failureMessageOf` in `run.ts`, with {@link isCallerFacing},
 * {@link quotesReportMessage} and {@link statusOnlyFailureMessage} from here).
 * The model reads the title, the
 * next step and the support line instead, the support line giving the run id,
 * the error type and the time the run ended, by which the people who run the
 * platform find the whole report the run row keeps. A local loop serving the
 * VERBOSE report gets the same treatment, so a message written for engineers
 * never reaches the model there either; an unflagged report's `user_action`,
 * the runner's advice rather than its account of the fault, still comes through
 * there, since dropping it is the disclosure's doing.
 *
 * Nothing here is inferred. Whether running it again can help comes from the
 * report's `retryable` alone, and a report without one gets no retry sentence
 * either way. The runner owns the report's shape, and `@pipelex/sdk` checks it
 * field by field before handing it back, so a field of the wrong type already
 * reads as absent and a `user_action` arrives whole or not at all. What this
 * module decides is presentation: a blank field says nothing, every text is
 * bounded, and a report with nothing to say reads as no report.
 */

import type { RunErrorReport, RunStatus } from "@pipelex/sdk";

/** The next step the report advises: `kind` names the category, `detail` says it in words. */
export interface RunFailureUserAction {
  kind: string;
  detail: string;
}

/**
 * The `failure` object a failed arm carries: the report's fields a reader acts
 * on, with the run id and the time the run ended. It leaves out
 * `provider_metadata` (a status code and a retry delay once disclosed, the
 * provider's raw body on a verbose report), a `message` not flagged
 * caller-facing, and every field the report did not carry.
 */
export interface RunFailure {
  run_id: string;
  /** The runner's exception class name, an open set: for the support line, never matched against. */
  error_type?: string;
  /** The stable human label of the error class (`LLM completion`). */
  title?: string;
  /**
   * What went wrong, as copy written for the caller: present only when the
   * report is flagged `caller_facing_message: true`. Any other report's message
   * is the disclosure's placeholder, or on a verbose report text written for
   * engineers, and is left out.
   */
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
 * The most of a report's `message` a result carries, in Unicode code points,
 * and of the failed arm's account of the ending, which quotes that message once
 * the platform relays it. The runner bounds no message it writes: a
 * caller-facing one about a bundle that failed validation can name every error
 * in it, and on a verbose report a provider SDK's error quotes the whole
 * response body, so one report can run to hundreds of kilobytes, and the message
 * reaches the model in the summary and in `structuredContent` both. The head
 * says what went wrong.
 */
export const FAILURE_MESSAGE_MAX_CODE_POINTS = 2_000;

/** The most of any other text field of a report a result carries, in Unicode code points. */
export const FAILURE_FIELD_MAX_CODE_POINTS = 300;

/**
 * Whether a report's `message` was written as copy for the caller: its
 * `caller_facing_message` is exactly `true`. Only such a message reaches the
 * model, in `failure.message` and in the failed arm's `failure_message` both;
 * any other is the strict disclosure's placeholder, or on a verbose report text
 * written for engineers.
 */
export function isCallerFacing(report: RunErrorReport | null | undefined): boolean {
  return report?.caller_facing_message === true;
}

/**
 * The account of the ending the platform's `409` gives when the report it
 * serves has no message, word for word: what the failed arm's `failure_message`
 * says in place of an account that would quote a message not written for the
 * caller.
 */
export function statusOnlyFailureMessage(status: RunStatus): string {
  return `Run finished with status ${status}; no result available`;
}

/**
 * The wording of the platform's `409` when it quotes the served report's
 * message: the status word, a colon, then the message. Its other wordings, the
 * status-only sentence and the copy it writes for a stored result it refuses to
 * read, quote nothing.
 */
const QUOTED_REPORT_ACCOUNT = /^Run finished with status [A-Z_]+: /;

/**
 * Whether a failed arm's account of the ending quotes a report's message, by the
 * platform's wording alone: what decides it for an arm that carries no report,
 * whose account may still quote one the SDK's check dropped.
 */
export function quotesReportMessage(account: string): boolean {
  return QUOTED_REPORT_ACCOUNT.test(account);
}

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
 * there is none to carry: a `null` report (a run that ended with none, such as
 * a cancelled one), and one carrying none of the fields that say what happened
 * (`error_type`, `title`, a caller-facing `message`, `user_action`), a blank one
 * saying nothing. The message is carried only from a report flagged
 * `caller_facing_message: true`, for the reason the module comment gives. Every
 * text field is bounded (`FAILURE_MESSAGE_MAX_CODE_POINTS` for the message,
 * `FAILURE_FIELD_MAX_CODE_POINTS` for the rest), and a `wait_and_retry` action
 * carries this module's own advice rather than the runner's, for the reason
 * {@link nextStepOf} gives.
 */
export function runFailureOf(
  runId: string,
  report: RunErrorReport | null | undefined,
  finishedAt?: string | null,
): RunFailure | undefined {
  if (report === null || report === undefined) return undefined;
  const errorType = field(report.error_type);
  const title = field(report.title);
  const rawMessage = isCallerFacing(report) ? text(report.message) : undefined;
  const message =
    rawMessage === undefined
      ? undefined
      : boundedFailureText(rawMessage, FAILURE_MESSAGE_MAX_CODE_POINTS);
  const retryable = report.retryable ?? undefined;
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
 * per line: that the run ended and how, why (the report's title, and its message
 * when the report flags it caller-facing), what to do, whether running it again
 * can help, and what to give support. A run with no report says so, and still
 * gives the support line. `reportRead` is `false` when the read that would have
 * carried the report failed, so that an absent report is said to be unknown
 * rather than missing.
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
        ? `Why: the report names the error type \`${failure.error_type ?? "unknown"}\` and carries no message written for the caller.`
        : `Why: ${why.join(" — ")}`,
    );
    lines.push(`What to do: ${nextStepOf(failure) ?? "the report names no next step."}`);
    const retry = retryAdviceOf(failure);
    if (retry !== undefined) lines.push(`Retry: ${retry}`);
  }
  lines.push(`For support: ${supportLineOf(runId, failure, finishedAt)}`);
  return lines;
}

/**
 * The report's user action, bounded. A `wait_and_retry` kind carries this
 * module's own sentence, or no advice when the report says a retry cannot help:
 * the runner words that kind for a pipe still inside its own retries ("the
 * system will retry automatically"), which the model would otherwise read here
 * about a run that has ended.
 */
function userActionOf(
  action: RunErrorReport["user_action"],
  retryable: boolean | undefined,
): RunFailureUserAction | undefined {
  if (action === null || action === undefined) return undefined;
  const kind = field(action.kind);
  if (kind === undefined) return undefined;
  if (kind === "wait_and_retry") {
    return { kind, detail: retryable === false ? "" : NEXT_STEP_BY_KIND.wait_and_retry };
  }
  return { kind, detail: boundedFailureText(action.detail, FAILURE_FIELD_MAX_CODE_POINTS) };
}

/** A non-blank string, as given; a blank one, `null` and absence read as absent. */
function text(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && value.trim() !== "" ? value : undefined;
}

/** A non-blank string bounded to `FAILURE_FIELD_MAX_CODE_POINTS`; anything else reads as absent. */
function field(value: string | null | undefined): string | undefined {
  const given = text(value);
  return given === undefined ? undefined : boundedFailureText(given, FAILURE_FIELD_MAX_CODE_POINTS);
}
