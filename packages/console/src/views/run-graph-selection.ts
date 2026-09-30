/**
 * The pipe-selection decision core of the run-graph view, kept pure so it is
 * unit-testable in the Node Vitest environment. The view owns the click state
 * and the artifact lookups; this module owns which pipe the form is for.
 */

/** A pipe picked for the form: its code, plus its domain for the contract lookup and the `pipe_ref` `pipelex_run` takes. */
export interface SelectedPipe {
  domain?: string;
  code: string;
}

/** `domain.code` → `{ domain, code }`. Pipe codes carry no dots, so the last one splits. */
export function parsePipeRef(ref: string): SelectedPipe {
  const dot = ref.lastIndexOf(".");
  return dot === -1 ? { code: ref } : { domain: ref.slice(0, dot), code: ref.slice(dot + 1) };
}

/**
 * The pipe the form is for: the node the user last clicked, else the pipe the
 * show named or the effective entry pipe the verdict settled
 * (`_meta.form_pipe_ref`, then `_meta.main_pipe_ref`), else **nothing**.
 *
 * There is deliberately no third arm. A verdict with no entry pipe — the server
 * stated `default_pipe_ref: null`, say, because the manifest names a pipe the
 * closure declares in several domains — is one where a selector-less run would
 * fail to resolve a pipe too, and `structuredContent.main_pipe` is simply
 * absent. The view used to reach for whichever pipe came first in the contract
 * map there, which put a fill-in form and a Run button in front of the user for
 * a pipe nobody chose. No form is the honest rendering until somebody chooses:
 * the capability still ships the artifact pair on such a verdict (it only
 * withholds the *advert*), so a pipe the user picks in the graph is the one
 * way a form appears — and this function is what keeps it the only one.
 */
export function selectedPipeFor(
  pickedPipe: SelectedPipe | null,
  formPipeRef: string | null,
): SelectedPipe | null {
  if (pickedPipe) return pickedPipe;
  if (formPipeRef) return parsePipeRef(formPipeRef);
  return null;
}

/**
 * The pipe the graph was built for, as a namespaced `pipe_ref`, read off the
 * graph itself: both mthds-ui's static builder and a dry run stamp
 * `pipeline_ref.domain` and `pipeline_ref.main_pipe` with the pipe they start
 * from. On `pipelex_show_method` that is the pipe the form opens on
 * (`_meta.form_pipe_ref`): the one the caller named, else the entry pipe,
 * manifest included; with neither, the first `main_pipe` the files declare.
 *
 * Both halves must be non-empty strings, the same test pipelex applies when it
 * reads the ref back; anything less is `null`, and the view then says nothing
 * about the graph rather than guessing which pipe it shows.
 */
export function graphPipeRefOf(graphSpec: unknown): string | null {
  if (typeof graphSpec !== "object" || graphSpec === null) return null;
  const pipelineRef = (graphSpec as { pipeline_ref?: unknown }).pipeline_ref;
  if (typeof pipelineRef !== "object" || pipelineRef === null) return null;
  const { domain, main_pipe: mainPipe } = pipelineRef as { domain?: unknown; main_pipe?: unknown };
  if (typeof domain !== "string" || domain.length === 0) return null;
  if (typeof mainPipe !== "string" || mainPipe.length === 0) return null;
  return `${domain}.${mainPipe}`;
}

/**
 * The caption under the graph when it shows a different pipe from the entry
 * pipe, or `null` when there is nothing to say.
 *
 * The graph is of the pipe it was drawn from and the pipes that pipe calls;
 * the entry pipe (`_meta.main_pipe_ref`) is what a selector-less run executes.
 * `pipelex_show_method` draws the graph from the pipe the caller named, else
 * from the entry pipe, so the two differ exactly when the caller named another
 * pipe, and the caption then says the graph is not the whole method, with
 * both refs spelled out. A verdict with no entry pipe has no
 * `_meta.main_pipe_ref`, so its graph, drawn from the files' `main_pipe`, is
 * never captioned against an entry pipe the method does not have.
 *
 * The second sentence follows the form actually on screen, so the caption stays
 * true after a click: it says the form runs the entry pipe only while it does
 * (`formPipeRef` is the ref of the pipe the rendered form is for, `null` when no
 * form is shown), and otherwise just names the entry pipe.
 */
export function graphCaptionFor(
  graphPipeRef: string | null,
  mainPipeRef: string | null,
  formPipeRef: string | null,
): string | null {
  if (!graphPipeRef || !mainPipeRef || graphPipeRef === mainPipeRef) return null;
  const graphSentence = `The graph above shows ${graphPipeRef} and the pipes it calls.`;
  return formPipeRef === mainPipeRef
    ? `${graphSentence} The form below runs ${mainPipeRef}, the method's entry pipe.`
    : `${graphSentence} The method's entry pipe is ${mainPipeRef}.`;
}
