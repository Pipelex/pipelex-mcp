import {
  buildStaticGraphSpec,
  mergeBundles,
  orderMthdsSources,
  parseMthdsBundle,
} from "@pipelex/mthds-ui/static-graph";
import type { MergedMethodSet } from "@pipelex/mthds-ui/static-graph";
import type { MthdsFileItem, PipeIORequest, PipeIOResponse, PipeIOValidReport } from "@pipelex/sdk";
import { z } from "zod";

import { inputsTemplateFor } from "./inputs-template.js";
import {
  METHOD_REF_GRAMMAR,
  asOneLine,
  asRecord,
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
  hasArtifactEntries,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateMethodReferenceRequest,
} from "./shared.js";
import type {
  ApiConfig,
  AuthErrorTexture,
  ClassifyErrorOptions,
  ErrorSummaries,
  ToolError,
} from "./shared.js";
import { CONSOLE_TOOL_NAMES } from "./tool-names.js";
import {
  VALIDATE_BY_REF_ERROR_OPTIONS,
  hasEntryFor,
  mainPipeSignatureOf,
  mainPipeSignatureSchema,
  signatureLine,
  viewSpecSchema,
} from "./validate.js";
import type { MainPipeSignature, ViewSpec } from "./validate.js";

/**
 * `pipelex_show_method` — the console's one way to look at a method before
 * running it, with two audiences in one result (L-260923-d3c264,
 * "The toolsets after the split"). The user gets the `run-graph` view: the
 * method's graph and an input form they can run from. The model gets the pipe's
 * signature and the fill-in inputs template, so it can fill the inputs in
 * conversation without a second call.
 *
 * It reads one `POST /v1/pipe-io` (L-260924-f3aa28, on the route's shape Louis
 * ruled on 2026-09-30): the three I/O artifacts for every pipe, the method's
 * entry pipe, the runnability facts and the closure's files, for an id and an
 * address alike, with no dry run. It moved there from `/v1/validate` without
 * changing this contract. A method with pending signatures is still reported
 * as not runnable; a method whose dry run would fail is not, since only
 * validate runs one, and its failure surfaces when the run fails. The console
 * has no validate tool: this is not one, and its verdict is only ever "can it
 * run".
 *
 * The graph is drawn here, from the echoed files, by `@pipelex/mthds-ui`'s
 * static builder, because the method's source must never leave this process:
 * only the built graph ships (see `staticGraphOf`).
 *
 * Console-only, so its texts name the console's tools directly.
 */

export const pipelexShowMethodInputSchema = {
  method_id: z
    .string()
    .optional()
    .describe(
      `Catalog id (mt_…) of a saved method in your organization, as ${CONSOLE_TOOL_NAMES.listMethods} returns it. Shows the method's CURRENT stored content. Supply exactly ONE of method_id / method_ref.`,
    ),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR}. Resolved server-side at the tag. Supply exactly ONE of method_id / method_ref.`,
    ),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      `The pipe to show, as a qualified domain.pipe_code. Omit for the method's entry pipe — the one ${CONSOLE_TOOL_NAMES.run} executes when it is given no pipe_ref.`,
    ),
};

export const pipelexShowMethodOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  method_id: z.string().optional().describe("Echoed when the method was named by its catalog id."),
  method_ref: z
    .string()
    .optional()
    .describe("Echoed when the method was named by its published address."),
  is_valid: z.boolean(),
  is_runnable: z
    .boolean()
    .describe(
      `True when ${CONSOLE_TOOL_NAMES.run} can execute the method: it validates and no pipe signature is pending.`,
    ),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      `The pipe the signature and the template are for (domain.pipe_code): the one you named, else the method's entry pipe. Pass it to ${CONSOLE_TOOL_NAMES.run} as pipe_ref.`,
    ),
  main_pipe: mainPipeSignatureSchema
    .optional()
    .describe(
      "The signature of pipe_ref: each declared input with the concept it expects, and the concept it produces. Absent when no pipe was settled.",
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      `The fill-in inputs template for pipe_ref, one {concept, content} entry per declared input: replace each placeholder and pass the object to ${CONSOLE_TOOL_NAMES.run} as inputs. A file input takes an http(s) URL or a pipelex-storage:// reference in its url. Present only on a runnable method.`,
    ),
  pending_signatures: z
    .array(z.string())
    .describe(
      "Pipes whose signatures are declared but not implemented yet; non-empty means not runnable.",
    ),
  validation_errors: z
    .array(z.unknown())
    .optional()
    .describe("Why the method does not validate; present exactly when is_valid is false."),
  available_view_specs: z
    .array(viewSpecSchema)
    .describe(
      'Views this result drives on a host that renders them: "dry_run_graph" (the method\'s graph) and "input_form" (a form for pipe_ref\'s inputs with a Run button).',
    ),
  errors: z.array(toolErrorSchema).optional(),
});

export interface PipelexShowMethodInput {
  method_id?: string;
  method_ref?: string;
  pipe_ref?: string;
}

export interface ShowStructuredContent {
  status: "ok" | "error";
  method_id?: string;
  method_ref?: string;
  is_valid: boolean;
  is_runnable: boolean;
  pipe_ref?: string;
  main_pipe?: MainPipeSignature;
  inputs?: Record<string, unknown>;
  pending_signatures: string[];
  validation_errors?: unknown[];
  available_view_specs: ViewSpec[];
  errors?: ToolError[];
}

export interface ShowResult {
  structuredContent: ShowStructuredContent;
  summary: string;
  /** The view-only artifacts, keyed on `_meta` under the names the `run-graph` view reads. */
  graphSpec?: unknown;
  pipeIoContracts?: unknown;
  inputForm?: unknown;
  outputForm?: unknown;
  /** The method's own entry pipe, which the view's caption calls the entry pipe. */
  mainPipeRef?: string;
  /** The pipe the form opens on: the one the caller named, else the entry pipe. */
  formPipeRef?: string;
}

/** The slice of `PipelexApiClient` this capability calls (test seam). */
export interface ShowClient {
  pipeIo(request: PipeIORequest): Promise<PipeIOResponse>;
}

export interface ShowContext extends ApiConfig {
  client?: ShowClient;
  /** Deployment-specific auth-failure texture (the console sets it per request). */
  authError?: AuthErrorTexture;
}

export function buildShowContext(env = process.env): ShowContext {
  return buildApiConfig(env);
}

/** The route this tool reads, named by the classification of a 404 that has no texture of its own. */
const SHOW_ROUTE = "/v1/pipe-io";

/**
 * The by-id texture. `mthds_validate`'s is for a workshop user who can also
 * submit files; this tool takes none, so its hints name only what a console
 * caller can change.
 */
const SHOW_BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: SHOW_ROUTE,
  methodLocation: "method_id",
  badRequest: {
    location: "method_id",
    hint: "The saved method may have no MTHDS source yet.",
  },
  notFound: {
    location: "method_id",
    hint: `No saved method with this id is visible to your organization. Check the id as ${CONSOLE_TOOL_NAMES.listMethods} returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss.`,
  },
};

/**
 * The by-address texture is `mthds_validate`'s — the address grammar, the tag
 * rule, no matching package, the registry form — since `/v1/pipe-io` resolves
 * an address through the same fetch path; only the route it names differs.
 */
const SHOW_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  ...VALIDATE_BY_REF_ERROR_OPTIONS,
  route: SHOW_ROUTE,
};

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "The method could not be shown: the Pipelex API is unreachable or misconfigured.",
  input_domain: "The method was not shown: the Pipelex API rejected the request.",
  runtime: "The method could not be shown: the Pipelex API returned an error.",
  paywall:
    "The method could not be shown: the organization's Pipelex plan does not cover this call.",
};

type ShowSelector = { method_id: string } | { method_ref: string };

function selectorOf(input: PipelexShowMethodInput): ShowSelector {
  if (input.method_ref !== undefined) return { method_ref: input.method_ref };
  if (input.method_id !== undefined) return { method_id: input.method_id };
  // Unreachable: the request checks refused a request carrying neither.
  throw new Error("No method selector survived request validation.");
}

/** Show one method: its verdict, its signature and template for the model, its graph and form for the view. */
export async function showPipelexMethod(
  input: PipelexShowMethodInput,
  context: ShowContext = buildShowContext(),
): Promise<ShowResult> {
  const requestErrors = validateShowRequest(input);
  if (requestErrors.length > 0) {
    return errorResult("The method was not shown: request input is invalid.", requestErrors);
  }

  const classifyOptions =
    input.method_ref !== undefined ? SHOW_BY_REF_ERROR_OPTIONS : SHOW_BY_ID_ERROR_OPTIONS;

  let report: PipeIOResponse;
  let selector: ShowSelector;
  try {
    selector = selectorOf(input);
    // One call gives the show everything it reads. `all_pipes` keys the three
    // maps by every pipe, so the view can look up a pipe the user clicks and a
    // refusal can name the declared pipes, and it never refuses a method for
    // want of an entry pipe: it answers `default_pipe_ref: null` and the
    // summary asks for one. `include_files` echoes the closure the graph is
    // drawn from.
    //
    // The caller's `pipe_ref` is deliberately not forwarded. The whole-method
    // answer already describes every pipe, so the named pipe is checked against
    // it here, and the refusal can list what the method declares, which the
    // route's own refusal of an unknown ref does not; a bare ref, which the
    // route would still resolve across domains, is refused here too.
    report = await (context.client ?? createPipelexApiClient(context)).pipeIo({
      ...selector,
      all_pipes: true,
      include_files: true,
    });
  } catch (err) {
    const error = classifyError(err, { ...classifyOptions, auth: context.authError });
    return errorResult(summaryForToolError(error, ERROR_SUMMARIES), [error]);
  }

  const requestedPipe = nonBlank(input.pipe_ref);
  if (requestedPipe !== undefined && report.is_valid) {
    const unknown = unknownPipeError(requestedPipe, report);
    if (unknown !== undefined) {
      return errorResult("The method was not shown: request input is invalid.", [unknown]);
    }
  }

  try {
    return showResult(report, selector, requestedPipe);
  } catch (err) {
    return errorResult(
      "The method could not be shown: the Pipelex API returned a malformed report.",
      [
        {
          class: "runtime",
          message:
            err instanceof Error
              ? err.message
              : "The Pipelex API returned a malformed pipe I/O answer.",
          hint: "The API responded but its answer was missing required fields; inspect the method on the platform.",
          retryable: false,
        },
      ],
    );
  }
}

/** Request-shape checks: exactly one method reference, and a pipe_ref that is not blank. */
export function validateShowRequest(input: PipelexShowMethodInput): ToolError[] {
  const errors = validateMethodReferenceRequest(input);
  if (input.pipe_ref !== undefined && input.pipe_ref.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "pipe_ref",
      message: "pipe_ref must not be empty when supplied.",
      hint: "Pass a qualified domain.pipe_code, or omit pipe_ref to show the method's entry pipe.",
      retryable: false,
    });
  }
  return errors;
}

/**
 * A named pipe the method does not declare is refused before anything is
 * projected, naming the pipes it does declare, so a pipe this tool accepts is
 * one `pipelex_run` accepts too. Read off the IO contracts, which the
 * whole-method answer keys by every pipe's namespaced ref; an answer without
 * them is malformed, and it is then only a bare ref that can be refused.
 */
function unknownPipeError(requested: string, report: PipeIOValidReport): ToolError | undefined {
  const contracts = asRecord(report.pipe_io_contracts);
  const declared = contracts === undefined ? [] : Object.keys(contracts);
  const candidates = declared.length > 0 ? declared.join(", ") : "(none)";
  // Checked whether or not the contracts arrived: `pipelex_run` refuses a bare
  // ref before any call, so a show that let one through would hand the model a
  // run that cannot start.
  if (!requested.includes(".")) {
    return {
      class: "input_domain",
      location: "pipe_ref",
      message:
        contracts === undefined
          ? `pipe_ref must be qualified (domain.pipe_code), got the bare "${requested}".`
          : `pipe_ref must be qualified (domain.pipe_code), got the bare "${requested}". The method declares: ${candidates}.`,
      hint:
        contracts === undefined
          ? "Pass the pipe as domain.pipe_code, or omit pipe_ref for the entry pipe."
          : "Pass one of the declared pipes as it is written above, or omit pipe_ref for the entry pipe.",
      retryable: false,
    };
  }
  if (contracts === undefined) return undefined;
  if (!(requested in contracts)) {
    return {
      class: "input_domain",
      location: "pipe_ref",
      message: `The method declares no pipe "${requested}". It declares: ${candidates}.`,
      hint: "Pass one of the declared pipes, or omit pipe_ref for the entry pipe.",
      retryable: false,
    };
  }
  return undefined;
}

/**
 * Project the route's answer: the verdict, the signature and the template for
 * the model, the graph and the form's artifacts for the view. The signature
 * and the form follow the pipe the caller named, else the method's entry pipe;
 * the graph is always the whole method, drawn from its entry pipe.
 */
export function showResult(
  report: PipeIOResponse,
  selector: ShowSelector,
  requestedPipe?: string,
): ShowResult {
  if (!report.is_valid) {
    // The invalid arm is the crate verdict: no artifacts, no runnability facts
    // and no files, so there is no pipe, no form and no graph to show.
    const structuredContent: ShowStructuredContent = {
      status: "ok",
      ...selector,
      is_valid: false,
      is_runnable: false,
      pending_signatures: [],
      validation_errors: report.validation_errors,
      available_view_specs: [],
    };
    return {
      structuredContent,
      summary: showSummary(structuredContent, selector, undefined, report),
    };
  }

  // The route states the entry pipe on every valid answer; a stated `null`
  // means it found none, or several, and nothing stands in for it.
  const entryPipeRef = nonBlank(report.default_pipe_ref ?? undefined);
  const pipeRef = requestedPipe ?? entryPipeRef;
  const mainPipe = mainPipeSignatureOf(report, pipeRef);

  // Two gates, as they were on validate. The form's artifacts ride a runnable
  // answer whose two maps carry something, whichever pipe was settled: they
  // are view-only data, and the maps the view looks a clicked pipe up in. The
  // ADVERT is narrower: `input_form` joins `available_view_specs` only when a
  // pipe was settled and both maps describe it, so the model is never told a
  // form exists for a pipe nothing chose. A method with pending signatures
  // gets neither, since its Run could only fail.
  const formRides =
    report.is_runnable &&
    hasArtifactEntries(report.pipe_io_contracts) &&
    hasArtifactEntries(report.input_form);
  const formAdvertised =
    formRides &&
    pipeRef !== undefined &&
    hasEntryFor(report.pipe_io_contracts, pipeRef) &&
    hasEntryFor(report.input_form, pipeRef);

  // The graph starts at the method's entry pipe, whichever pipe the form is
  // for, so a named pipe shows as one node of the whole method, as the dry-run
  // graph did. With no entry pipe it starts at the named pipe, else wherever
  // the builder's own fallback finds one.
  const graphSpec = staticGraphOf(report.files, entryPipeRef ?? pipeRef);

  const template =
    report.is_runnable && pipeRef !== undefined
      ? inputsTemplateFor(report.input_form, pipeRef, { explicit: true, format: "json" })
      : undefined;
  const inputs = template?.format === "json" ? template.inputs : undefined;

  const availableViewSpecs: ViewSpec[] = [];
  // The token still says "dry_run_graph" although the graph is static now:
  // renaming it changes the console's pinned contract (L-260930-e9cd94).
  if (graphSpec !== undefined) availableViewSpecs.push("dry_run_graph");
  if (formAdvertised) availableViewSpecs.push("input_form");

  const structuredContent: ShowStructuredContent = {
    status: "ok",
    ...selector,
    is_valid: true,
    is_runnable: report.is_runnable,
    ...(pipeRef === undefined ? {} : { pipe_ref: pipeRef }),
    ...(mainPipe === undefined ? {} : { main_pipe: mainPipe }),
    ...(inputs === undefined ? {} : { inputs }),
    pending_signatures: report.pending_signatures,
    available_view_specs: availableViewSpecs,
  };

  return {
    structuredContent,
    summary: showSummary(
      structuredContent,
      selector,
      template?.format === "json" ? template.text : undefined,
      report,
    ),
    graphSpec,
    ...(formRides
      ? {
          pipeIoContracts: report.pipe_io_contracts,
          inputForm: report.input_form,
          outputForm: report.output_form,
        }
      : {}),
    ...(entryPipeRef === undefined ? {} : { mainPipeRef: entryPipeRef }),
    ...(pipeRef === undefined ? {} : { formPipeRef: pipeRef }),
  };
}

/**
 * The most nodes a method's static graph may have before the console draws
 * none. A drawing past a few hundred nodes is unreadable anyway; the ceiling
 * exists because the builder has no budget of its own (see
 * {@link staticGraphSizeBound}), and it is generous enough that no real method
 * comes near it.
 */
export const MAX_STATIC_GRAPH_NODES = 2_000;

/**
 * The method's graph, drawn from its files by mthds-ui's static builder, the
 * one the VS Code extension and the workshop's graph page use: a spec with
 * `meta.mode: "static"`, one node per pipe call, no run chrome. The files are
 * ordered first so that the file declaring `main_pipe` leads the merge, as it
 * does in every other host of the builder.
 *
 * **The source never leaves this function.** The files are the method's own
 * text, which the catalog projection invariant keeps out of
 * `structuredContent`, `content`, `_meta` and every log; only the graph built
 * from them ships. That is why the graph is built here, on the server, rather
 * than in the view.
 *
 * **The build is bounded before it starts.** The builder emits a node for
 * every pipe call, so a method a few kilobytes long whose sequences call
 * nested sequences several times over expands to millions of nodes, and the
 * build is synchronous: it would block this shared server's event loop, or
 * exhaust its heap, for every caller. So the method is parsed and merged once,
 * its expansion is counted without building anything, and a method whose
 * count passes {@link MAX_STATIC_GRAPH_NODES} gets no graph.
 *
 * The builder is lenient and documented never to throw; a throw anyway, an
 * entry pipe it cannot resolve, or an answer with no files leaves no graph.
 */
function staticGraphOf(files: MthdsFileItem[] | undefined, entryPipe: string | undefined): unknown {
  if (!Array.isArray(files) || files.length === 0) return undefined;
  try {
    const ordered = orderMthdsSources(
      files.map((file, index) => ({
        name: nonBlank(file.source) ?? `file-${index + 1}.mthds`,
        content: file.content,
      })),
    );
    const merged = mergeBundles(ordered.map((file) => parseMthdsBundle(file.content).bundle));
    if (staticGraphSizeBound(merged, MAX_STATIC_GRAPH_NODES) > MAX_STATIC_GRAPH_NODES) {
      return undefined;
    }
    const { spec } = buildStaticGraphSpec(merged, entryPipe === undefined ? {} : { entryPipe });
    return spec.nodes.length > 0 ? spec : undefined;
  } catch {
    return undefined;
  }
}

/** One pipe call a controller makes: the ref as written, and whether it is an inline batch. */
interface PipeCall {
  ref: string;
  batched: boolean;
}

/** The routes a `PipeCondition` takes that name no pipe, which the builder skips. */
const NON_PIPE_OUTCOMES = new Set(["", "fail", "continue"]);

/**
 * The number of nodes the static builder would emit for the largest pipe of a
 * merged method set, counted without building anything, and capped at
 * `budget + 1` so the count itself stays cheap.
 *
 * It follows the builder's own walk (`walkPipe` in
 * `@pipelex/mthds-ui/static-graph`): one node per pipe call, plus the batch
 * node a sequence step with `batch_over` / `batch_as` adds; a ref carrying
 * `->` is one opaque leaf, an unresolvable ref is skipped, a bare ref resolves
 * in the calling pipe's domain, and a recursive call is drawn as a leaf. Each
 * pipe's count is memoised, which is what makes counting linear where
 * building is exponential. Taking the largest pipe rather than the entry pipe
 * makes the count independent of how the builder picks its entry.
 */
export function staticGraphSizeBound(set: MergedMethodSet, budget: number): number {
  const cap = budget + 1;
  const memo = new Map<string, number>();
  const onStack = new Set<string>();

  const sizeOfRef = (ref: string, callerDomain: string): number => {
    if (ref.includes("->")) return 1;
    const dot = ref.lastIndexOf(".");
    return dot === -1 ? sizeOf(callerDomain, ref) : sizeOf(ref.slice(0, dot), ref.slice(dot + 1));
  };

  const sizeOf = (domain: string, code: string): number => {
    const key = `${domain}.${code}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (onStack.has(key)) return 1;
    const blueprint = asRecord(set.domains[domain]?.pipes[code]);
    if (blueprint === undefined) return 0;
    onStack.add(key);
    let size = 1;
    for (const call of pipeCallsOf(blueprint)) {
      size += (call.batched ? 1 : 0) + sizeOfRef(call.ref, domain);
      if (size >= cap) {
        size = cap;
        break;
      }
    }
    onStack.delete(key);
    memo.set(key, size);
    return size;
  };

  let largest = 0;
  for (const [domain, namespace] of Object.entries(set.domains)) {
    for (const code of Object.keys(namespace.pipes)) {
      largest = Math.max(largest, sizeOf(domain, code));
      if (largest >= cap) return cap;
    }
  }
  return largest;
}

/** The pipe calls a blueprint makes, read defensively: it is parsed from text nobody validated here. */
function pipeCallsOf(blueprint: Record<string, unknown>): PipeCall[] {
  const subPipeCalls = (list: unknown): PipeCall[] =>
    Array.isArray(list)
      ? list.flatMap((item) => {
          const record = asRecord(item);
          return record !== undefined && typeof record.pipe_code === "string"
            ? [{ ref: record.pipe_code, batched: asRecord(record.batch_params) !== undefined }]
            : [];
        })
      : [];
  switch (blueprint.type) {
    case "PipeSequence":
      return subPipeCalls(blueprint.sequential_sub_pipes);
    case "PipeParallel":
      return subPipeCalls(blueprint.parallel_sub_pipes);
    case "PipeCondition": {
      const outcomes = asRecord(blueprint.outcome_map);
      const targets = new Set(
        [...Object.values(outcomes ?? {}), blueprint.default_outcome].filter(
          (target): target is string =>
            typeof target === "string" && !NON_PIPE_OUTCOMES.has(target),
        ),
      );
      return [...targets].map((ref) => ({ ref, batched: false }));
    }
    case "PipeBatch":
      return typeof blueprint.branch_pipe_code === "string"
        ? [{ ref: blueprint.branch_pipe_code, batched: false }]
        : [];
    default:
      return [];
  }
}

// ── the prose ───────────────────────────────────────────────────────

/**
 * The summary is the one channel that reaches every host at the moment the
 * model decides what to do next — including a ChatGPT install whose tool list
 * was cached when the connector was added — so it carries the signature, the
 * template, and the rule on who goes first (ruled 2026-09-25): a user who
 * already gave the values gets their run at once; otherwise the model stops and
 * lets the user choose between the form and the chat, because filling the
 * template while the user fills the form runs the method twice.
 *
 * The console cannot tell here whether this host shows the form: it is
 * stateless, so what the host declared at `initialize` is not readable during a
 * tool call. The server instructions are tailored per handshake instead
 * (the console's `src/hosted/server.ts`), and this text defers to them.
 */
function showSummary(
  content: ShowStructuredContent,
  selector: ShowSelector,
  templateJson: string | undefined,
  report: PipeIOResponse,
): string {
  const label = methodLabel(selector);
  const parts: string[] = [`# ${label}`];

  if (!content.is_valid) {
    parts.push(
      `${label} does not validate, so it cannot run. Tell the user why:`,
      validationErrorLines(content.validation_errors ?? []),
    );
    return parts.join("\n\n");
  }

  if (content.main_pipe !== undefined) {
    parts.push(`## Signature\n\n\`${signatureLine(content.main_pipe)}\``);
  }

  if (!content.is_runnable) {
    const pending = content.pending_signatures;
    parts.push(
      `${label} validates but cannot run yet: ${pending.length} pipe signature(s) are declared and not implemented${
        pending.length > 0 ? ` (${pending.map((ref) => `\`${ref}\``).join(", ")})` : ""
      }. There is no template and no form until they are. Tell the user.`,
    );
    return parts.join("\n\n");
  }

  if (content.pipe_ref === undefined) {
    const declared = declaredPipes(report);
    parts.push(
      `${label} is runnable, but it settles no entry pipe, so there is no template yet. Call \`${CONSOLE_TOOL_NAMES.showMethod}\` again with pipe_ref set to the pipe the user wants${
        declared.length > 0 ? `: ${declared.map((ref) => `\`${ref}\``).join(", ")}` : ""
      }.`,
    );
    return parts.join("\n\n");
  }

  parts.push(
    templateJson === undefined
      ? "## Inputs template\n\nNo template could be projected for this pipe; build the inputs from the signature above, one entry per input name."
      : `## Inputs template\n\n\`\`\`json\n${templateJson}\n\`\`\``,
  );
  parts.push(`## Who goes first\n\n${whoGoesFirst(selector, content.pipe_ref)}`);
  return parts.join("\n\n");
}

function whoGoesFirst(selector: ShowSelector, pipeRef: string): string {
  const call = [...Object.entries(selector), ["pipe_ref", pipeRef]]
    .map(([key, value]) => `${key} \`${value}\``)
    .join(", ");
  return [
    `If the user already gave you the input values, fill the template with them and call \`${CONSOLE_TOOL_NAMES.run}\` now, with ${call}.`,
    "Otherwise stop here and let the user choose.",
    "If this host shows the user the method's form (the server instructions say whether it does), they can fill it in and press Run, or give you the values in chat; if it shows none, ask them for the values.",
    `Never call \`${CONSOLE_TOOL_NAMES.run}\` while the user may be filling in the form: the method would run twice.`,
  ].join(" ");
}

function methodLabel(selector: ShowSelector): string {
  return "method_id" in selector
    ? `Method \`${selector.method_id}\``
    : `Method \`${selector.method_ref}\``;
}

function declaredPipes(report: PipeIOResponse): string[] {
  const contracts = report.is_valid ? asRecord(report.pipe_io_contracts) : undefined;
  return contracts === undefined ? [] : Object.keys(contracts);
}

/** The wire's validation errors as bullets, read defensively: they are relayed, not validated. */
function validationErrorLines(errors: unknown[]): string {
  if (errors.length === 0) return "- (the API gave no reason)";
  return errors
    .map((error) => {
      const record = asRecord(error);
      const message =
        record !== undefined && typeof record.message === "string"
          ? asOneLine(record.message)
          : "unknown error";
      const category =
        record !== undefined && typeof record.category === "string"
          ? `**${record.category}** — `
          : "";
      const source =
        record !== undefined && typeof record.source === "string" && record.source !== ""
          ? ` (${record.source})`
          : "";
      return `- ${category}${message}${source}`;
    })
    .join("\n");
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function errorResult(summary: string, errors: ToolError[]): ShowResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      is_runnable: false,
      pending_signatures: [],
      available_view_specs: [],
      errors,
    },
    summary,
  };
}

export function showToolResult(result: ShowResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
    // View-only, never `structuredContent`: exactly the keys the `run-graph`
    // view reads, and never the method's files.
    _meta: {
      graph_spec: result.graphSpec,
      pipe_io_contracts: result.pipeIoContracts,
      input_form: result.inputForm,
      output_form: result.outputForm,
      main_pipe_ref: result.mainPipeRef,
      form_pipe_ref: result.formPipeRef,
    },
  };
}
