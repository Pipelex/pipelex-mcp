import type { PipelexValidationResult, ValidateMethodSelector } from "@pipelex/sdk";
import { z } from "zod";

import { inputsTemplateFor } from "./inputs-template.js";
import {
  METHOD_REF_GRAMMAR,
  asOneLine,
  asRecord,
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
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
  VALIDATE_VIEW_TOKENS,
  mainPipeSignatureSchema,
  projectValidationReport,
  signatureLine,
  viewSpecSchema,
} from "./validate.js";
import type { MainPipeSignature, ViewSpec } from "./validate.js";

/**
 * `pipelex_show_method` — the console's one way to look at a method before
 * running it, with two audiences in one result (`wip/mcp-server-split/design.md`,
 * "The toolsets after the split"). The user gets the `run-graph` view: the
 * method's graph and an input form they can run from. The model gets the pipe's
 * signature and the fill-in inputs template, so it can fill the inputs in
 * conversation without a second call.
 *
 * It reads `POST /v1/validate` with the graph and both form descriptors (ruled
 * 2026-09-25): that route already serves everything the tool needs for an id
 * and an address alike, and it reports a method whose dry run fails, or whose
 * signatures are pending, as not runnable instead of handing out a form whose
 * Run can only fail. The move onto `/v1/input-form` (L-260924-f3aa28) changes
 * the route, never this contract. The console has no validate tool: this is not
 * one, and its verdict is only ever "can it run".
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
  /** The view-only artifacts, keyed on `_meta` exactly as `mthds_validate` keyed them for the view. */
  graphSpec?: unknown;
  pipeIoContracts?: unknown;
  inputForm?: unknown;
  outputForm?: unknown;
  mainPipeRef?: string;
}

/** The slice of `PipelexApiClient` this capability calls (test seam). */
export interface ShowClient {
  validate(
    source: ValidateMethodSelector,
    allowSignatures?: boolean,
    mthdsSources?: string[],
    render?: string[],
    views?: string[],
  ): Promise<PipelexValidationResult>;
}

export interface ShowContext extends ApiConfig {
  client?: ShowClient;
  /** Deployment-specific auth-failure texture (the console sets it per request). */
  authError?: AuthErrorTexture;
}

export function buildShowContext(env = process.env): ShowContext {
  return buildApiConfig(env);
}

/**
 * The by-id texture. `mthds_validate`'s is for a workshop user who can also
 * submit files; this tool takes none, so its hints name only what a console
 * caller can change.
 */
const SHOW_BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
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
    input.method_ref !== undefined ? VALIDATE_BY_REF_ERROR_OPTIONS : SHOW_BY_ID_ERROR_OPTIONS;

  let report: PipelexValidationResult;
  let selector: ShowSelector;
  try {
    selector = selectorOf(input);
    // No `render`: this tool composes its own summary, so the validation
    // report's Markdown would only cost the wire.
    report = await (context.client ?? createPipelexApiClient(context)).validate(
      selector,
      true,
      undefined,
      undefined,
      [...VALIDATE_VIEW_TOKENS],
    );
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
              : "The Pipelex API returned a malformed validation report.",
          hint: "The API responded but its report was missing required fields; inspect the method on the platform.",
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
 * projected, naming the pipes it does declare — the same two refusals
 * `pipelex_run`'s input walk makes, so a pipe this tool accepts is one the run
 * accepts too. Read off the IO contracts, keyed by the same namespaced refs; a
 * report without them (an older runner) cannot be checked, and is not refused.
 */
function unknownPipeError(
  requested: string,
  report: PipelexValidationResult,
): ToolError | undefined {
  const contracts = asRecord((report as { pipe_io_contracts?: unknown }).pipe_io_contracts);
  if (contracts === undefined) return undefined;
  const declared = Object.keys(contracts);
  const candidates = declared.length > 0 ? declared.join(", ") : "(none)";
  if (!requested.includes(".")) {
    return {
      class: "input_domain",
      location: "pipe_ref",
      message: `pipe_ref must be qualified (domain.pipe_code), got the bare "${requested}". The method declares: ${candidates}.`,
      hint: "Pass one of the declared pipes as it is written above, or omit pipe_ref for the entry pipe.",
      retryable: false,
    };
  }
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
 * Project the report. Everything the verdict, the signature and the view
 * artifacts are is `mthds_validate`'s projection, run for the pipe the caller
 * named when they named one; what this adds is the selector echo, the template
 * and the prose.
 */
export function showResult(
  report: PipelexValidationResult,
  selector: ShowSelector,
  requestedPipe?: string,
): ShowResult {
  const projection = projectValidationReport(report, true, true, requestedPipe);
  const verdict = projection.structuredContent;
  const pipeRef = report.is_valid ? projection.mainPipeRef : undefined;

  // The template is for a method that can run: a pending-signature method
  // gets neither a template nor (from the projection) a form, since both
  // would only lead to a Run that fails.
  const template =
    report.is_valid && report.is_runnable && pipeRef !== undefined
      ? inputsTemplateFor((report as { input_form?: unknown }).input_form, pipeRef, {
          explicit: true,
          format: "json",
        })
      : undefined;
  const inputs = template?.format === "json" ? template.inputs : undefined;

  const structuredContent: ShowStructuredContent = {
    status: "ok",
    ...selector,
    is_valid: verdict.is_valid,
    is_runnable: verdict.is_runnable,
    ...(pipeRef === undefined ? {} : { pipe_ref: pipeRef }),
    ...(verdict.main_pipe === undefined ? {} : { main_pipe: verdict.main_pipe }),
    ...(inputs === undefined ? {} : { inputs }),
    pending_signatures: verdict.pending_signatures,
    ...(verdict.validation_errors === undefined
      ? {}
      : { validation_errors: verdict.validation_errors }),
    available_view_specs: verdict.available_view_specs,
  };

  return {
    structuredContent,
    summary: showSummary(
      structuredContent,
      selector,
      template?.format === "json" ? template.text : undefined,
      report,
    ),
    graphSpec: projection.graphSpec,
    pipeIoContracts: projection.pipeIoContracts,
    inputForm: projection.inputForm,
    outputForm: projection.outputForm,
    mainPipeRef: projection.mainPipeRef,
  };
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
 * (`hosted/server.ts`), and this text defers to them.
 */
function showSummary(
  content: ShowStructuredContent,
  selector: ShowSelector,
  templateJson: string | undefined,
  report: PipelexValidationResult,
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

function declaredPipes(report: PipelexValidationResult): string[] {
  const contracts = asRecord((report as { pipe_io_contracts?: unknown }).pipe_io_contracts);
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
    // view reads, so the view `mthds_validate` fed is fed the same way here.
    _meta: {
      graph_spec: result.graphSpec,
      pipe_io_contracts: result.pipeIoContracts,
      input_form: result.inputForm,
      output_form: result.outputForm,
      main_pipe_ref: result.mainPipeRef,
    },
  };
}
