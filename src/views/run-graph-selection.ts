/**
 * The pipe-selection decision core of the run-graph view, kept pure so it is
 * unit-testable in the Node Vitest environment. The view owns the click state
 * and the artifact lookups; this module owns which pipe the form is for.
 */

/** A pipe picked for the form: the bare code `mthds_run` takes, plus its domain for the contract lookup. */
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
 * The pipe the form is for: the node the user last clicked, else the effective
 * entry pipe the verdict settled (`_meta.main_pipe_ref`), else **nothing**.
 *
 * There is deliberately no third arm. A verdict with no entry pipe — the server
 * stated `default_pipe_ref: null`, say, because the manifest names a pipe the
 * closure declares in several domains — is one where a selector-less run would
 * fail to resolve a pipe too, and `structuredContent.main_pipe` is simply
 * absent. The view used to reach for whichever pipe came first in the contract
 * map there, which put a fill-in form and a Run button in front of the user for
 * a pipe nobody chose. No form is the honest rendering; a pipe the user picks
 * in the graph is the only way one appears.
 */
export function selectedPipeFor(
  pickedPipe: SelectedPipe | null,
  mainPipeRef: string | null,
): SelectedPipe | null {
  if (pickedPipe) return pickedPipe;
  if (mainPipeRef) return parsePipeRef(mainPipeRef);
  return null;
}
