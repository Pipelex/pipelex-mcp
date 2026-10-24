import { FIELD_KINDS, buildProblem } from "@pipelex/sdk";
import type {
  FieldKind,
  IOMultiplicity,
  PipelexValidateSource,
  PipelexValidationResult,
  PipelexValidationReport,
  PipelexInvalidReport,
  PresenceMarker,
  ValidateOptions,
} from "@pipelex/sdk";
import { z } from "zod";

import { GRAPH_PAGE_FILENAME, graphPageSection, writeGraphPage } from "./graph-page.js";
import {
  METHOD_ID_SELECTOR_SENTENCE,
  methodVersionReportSchema,
  methodVersionsOf,
  planById,
  selectorFailure,
  withMethodContent,
} from "./method-versions.js";
import type { MethodVersionReport, MethodVersionsAware, SelectorPlan } from "./method-versions.js";
import type { GraphPageFile, GraphPageOutcome } from "./graph-page.js";
import {
  METHOD_REF_GRAMMAR,
  asRecord,
  blueprintMainPipeRefOf,
  buildApiConfig,
  createPipelexApiClient,
  faultsProblem,
  filesSentSchema,
  methodDirInputSchema,
  methodFilesInputSchema,
  problemItemSchema,
  problemOf,
  problemSchema,
  problemSummary,
  resolveMethodSource,
  toolResultContent,
  validateMethodSelectorRequest,
  withFilesSent,
  failedBeforeSending,
  isExecutionLocusRefusal,
  markUnsent,
  withTooLargeNote,
} from "./shared.js";
import type {
  ApiConfig,
  ApiNotes,
  FileResolver,
  MethodTreeToSend,
  Problem,
  ProblemItem,
  SubmittedFileInput,
} from "./shared.js";
import { methodTreeLimitsOf } from "./tree-limits.js";
import type { TreeLimitsAware } from "./tree-limits.js";

export const mthdsValidateInputSchema = {
  method_dir: methodDirInputSchema("one_selector"),
  files: methodFilesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR}. Resolved server-side: the repository is fetched at the tag and the package's own file names label the diagnostics; no bundle enters the conversation. Supply exactly ONE of method_dir / files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      `Catalog id (mt_…) of a registered method, resolved server-side — requires an API key (the catalog is org-scoped). ${METHOD_ID_SELECTOR_SENTENCE} Supply exactly ONE of method_dir / files / method_ref / method_id.`,
    ),
  graph_page: z
    .boolean()
    .optional()
    .describe(
      `Whether to write the method's flowchart, ${GRAPH_PAGE_FILENAME}, into method_dir or beside files given as { path } (default true): a standalone page that embeds the files and draws the graph when opened in a browser. It is rewritten on every validation and never replaces a file this tool did not write. Pass false to leave the directory untouched.`,
    ),
};

/**
 * Identifiers of the renderable views a validation result can name. The
 * workshop renders no views, so a result always lists none; the enum stays
 * because it is part of the output schema `workshop.contract.json` pins.
 */
export const viewSpecSchema = z.enum(["dry_run_graph", "input_form"]);

/**
 * The structured-view opt-in sent on every `/validate` call, whatever the
 * selector: the two descriptors the main pipe's signature is read from.
 * `"input_form"` gives its inputs their authored order, and `"output_form"`,
 * the twin for the other half of the contract, is what
 * `main_pipe.output.images` is read from. Tokens are lenient on the server, so
 * a runner that predates one simply returns no descriptor for it and the
 * members that depend on it stay absent — which is why "no images" and
 * "unknown" have to be distinguishable downstream.
 */
export const VALIDATE_VIEW_TOKENS = ["input_form", "output_form"] as const;

/** What every `/validate` call asks for beside the verdict: the Markdown view and the descriptors. */
const VALIDATE_OPTIONS: ValidateOptions = {
  render: ["markdown"],
  views: [...VALIDATE_VIEW_TOKENS],
};

/**
 * The MTHDS standard's multiplicity vocabulary (`IOMultiplicity`), as a runtime
 * tuple: the narrowing needs it as a membership test and the output schema
 * needs it as an enum, and `satisfies` keeps both pinned to the imported type,
 * so a member the standard drops fails the build here.
 */
const IO_MULTIPLICITIES = [
  "single",
  "variable",
  "fixed",
] as const satisfies readonly IOMultiplicity[];

/** The standard's three-valued input presence marker, same discipline. */
const PRESENCE_MARKERS = [
  "plain",
  "optional",
  "force",
] as const satisfies readonly PresenceMarker[];

/**
 * How each multiplicity is written in the rendered signature line: nothing for
 * a single item, `[]` for a variable list, `[N]` for a fixed one. A `Record`
 * over the standard's union rather than a switch, so a multiplicity the
 * standard ADDS fails the build here — the direction `IO_MULTIPLICITIES`'
 * `satisfies` cannot catch.
 */
const MULTIPLICITY_SUFFIX: Record<IOMultiplicity, (itemCount?: number) => string> = {
  single: () => "",
  variable: () => "[]",
  fixed: (itemCount) => `[${itemCount}]`,
};

/**
 * Whether a caller must supply a slot carrying each marker. The three-valued
 * vocabulary collapses the way the standard itself recommends for a consumer
 * that only needs "may this be absent?" — the plain/force distinction is lint-
 * and graph-facing and does not bear on a call site. A `Record` rather than a
 * `!== "optional"` comparison for `MULTIPLICITY_SUFFIX`'s reason: a marker the
 * standard ADDS fails the build here and forces the question to be answered,
 * where the comparison would silently rule it required.
 */
const PRESENCE_IS_REQUIRED: Record<PresenceMarker, boolean> = {
  plain: true,
  force: true,
  optional: false,
};

const ioMultiplicitySchema = z
  .enum(IO_MULTIPLICITIES)
  .describe(
    'How many items the slot carries: "single" for one, "variable" for a list of any length, "fixed" for exactly item_count items.',
  );

/**
 * The main pipe's typed signature — what an agent needs to write a call site
 * against a method it cannot read (a `method_ref` or `method_id` source), and
 * the reason it rides `structuredContent` rather than `_meta`, which the model
 * never reads. Names follow the standard's own
 * artifact (`concept_ref`, the `IOMultiplicity` vocabulary): these are MTHDS
 * concepts inside a Pipelex envelope. Per-slot JSON Schemas stay out — that is
 * the token-heavy part, and `mthds_inputs_template` / `mthds_codegen` are where
 * it belongs.
 */
export const mainPipeSignatureSchema = z.object({
  pipe_ref: z
    .string()
    .describe("Namespaced ref (domain.pipe_code) of the pipe a run executes by default."),
  inputs: z
    .array(
      z.object({
        name: z
          .string()
          .describe("Authored name of the input slot — the key a run's inputs object must use."),
        concept_ref: z
          .string()
          .describe(
            "Fully-qualified concept the slot expects, with any multiplicity suffix stripped.",
          ),
        multiplicity: ioMultiplicitySchema,
        item_count: z
          .number()
          .optional()
          .describe('Number of items the slot takes; present only when multiplicity is "fixed".'),
        required: z
          .boolean()
          .describe(
            "Whether the caller must supply this input; false when the slot is declared optional.",
          ),
      }),
    )
    .describe("The main pipe's declared input slots, in authored order."),
  output: z
    .object({
      concept_ref: z
        .string()
        .describe(
          "Fully-qualified concept the pipe produces, with any multiplicity suffix stripped.",
        ),
      multiplicity: ioMultiplicitySchema,
      item_count: z
        .number()
        .optional()
        .describe('Number of items produced; present only when multiplicity is "fixed".'),
      optional: z
        .boolean()
        .describe("Whether a successful run may resolve the output as a recorded absence."),
      images: z
        .array(z.string())
        .optional()
        .describe(
          'Where images sit inside the produced output, as paths from its root: "$" is the output itself, "$.name" a field of it, "$[]" an element of a list, "$[].name" a field of one. A top-level Image output is ["$"] and an Image[] is ["$[]"], so "this method produces pictures" is images.length > 0. An empty array means the server described the WHOLE output and it holds no image; an ABSENT member means the answer is unknown, which is never to be read as none. A non-empty array names positions that really do hold images, and is exhaustive unless part of the description was opaque.',
        ),
    })
    .describe("What the main pipe produces."),
});

const validationStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  is_runnable: z.boolean(),
  pending_signatures: z.array(z.string()),
  available_view_specs: z
    .array(viewSpecSchema)
    .describe(
      'Renderable views available for this result. Contains "dry_run_graph" when an interactive method graph (from the validation dry run) is available to display, and "input_form" when a fill-in form for the entry pipe\'s inputs (with a Run button) is available — a runnable verdict that settled an entry pipe and carries that pipe\'s entry in both per-pipe form artifacts; empty otherwise. main_pipe names that same entry pipe whenever its contract also narrows cleanly, so the two can differ on a malformed contract.',
    ),
  main_pipe: mainPipeSignatureSchema
    .optional()
    .describe(
      "The main pipe's signature: its ref, each declared input with the concept it expects, and the concept it produces. Present on every valid verdict for which the server settled an effective entry pipe — for a published method, the one its manifest names. Absent means no entry pipe was settled, not that the method declares none. Type a call site from this instead of guessing the shapes.",
    ),
  graph_page: z
    .object({
      path: z
        .string()
        .describe("Where the page is, or would have been, relative to the working directory."),
      written: z.boolean().describe("Whether this call wrote the page."),
      error: problemSchema
        .optional()
        .describe("Why the page was not written, as a problem. It never changes the verdict."),
    })
    .optional()
    .describe(
      `The method's flowchart as a standalone HTML page (${GRAPH_PAGE_FILENAME}) beside the validated files, which the user can open in a browser. Present when the method came from method_dir or every file was given as { path }, and graph_page was not false, whatever the verdict; absent otherwise.`,
    ),
  method_version: methodVersionReportSchema,
  files_sent: filesSentSchema,
  warnings: z
    .array(problemItemSchema)
    .optional()
    .describe(
      "A valid verdict's advisory findings, one problem item each, which never change is_valid; absent when there are none. A finding of a PipeDocGen step's template check, such as a field that matches no input, is a pipelex.docgen.template_warning item naming the template and the finding, located at its pipe.",
    ),
  errors: z
    .array(problemItemSchema)
    .optional()
    .describe(
      "An invalid verdict's faults, one problem item each, with its own code, detail and location, and a suggested_fix when the API has one; absent on a valid verdict.",
    ),
  problem: problemSchema
    .optional()
    .describe("Why no verdict could be produced; present exactly when status is error."),
});

export const mthdsValidateOutputSchema = validationStructuredContentSchema;

export interface MthdsValidateInput {
  method_dir?: string;
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  /** Default true; only a context with a `saveRoot` writes the page at all. */
  graph_page?: boolean;
}

/** The validate request once its method is resolved — what the checks and the API call consume. */
interface ResolvedValidateRequest {
  /** The method's tree, from `method_dir` or `files`. */
  tree?: MethodTreeToSend;
  method_ref?: string;
  method_id?: string;
}

export type ViewSpec = z.infer<typeof viewSpecSchema>;

/** One declared input slot of the main pipe, as the signature reports it. */
export interface MainPipeInputSignature {
  name: string;
  concept_ref: string;
  multiplicity: IOMultiplicity;
  /** Present exactly on the fixed arm — the unused field is absent, per this repo's convention. */
  item_count?: number;
  /** `presence !== "optional"`: the plain/force distinction has no bearing on typing a call site. */
  required: boolean;
}

/** What the main pipe produces, as the signature reports it. */
export interface MainPipeOutputSignature {
  concept_ref: string;
  multiplicity: IOMultiplicity;
  item_count?: number;
  optional: boolean;
  /**
   * Image field paths within the output, in `$` notation — see the schema's
   * `.describe()`. Absent when no output-form descriptor arrived (an older
   * runner, or a verdict whose entry in it did not narrow), which is how
   * "unknown" stays distinguishable from the empty array's "none".
   */
  images?: string[];
}

export interface MainPipeSignature {
  pipe_ref: string;
  /** Authored order when the input-form descriptor states it, contract map order otherwise. */
  inputs: MainPipeInputSignature[];
  output: MainPipeOutputSignature;
}

export interface ValidationStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  available_view_specs: ViewSpec[];
  main_pipe?: MainPipeSignature;
  graph_page?: GraphPageStructuredContent;
  /** By-id validations only: the content validated, when this server can tell. */
  method_version?: MethodVersionReport;
  /** Validations of a tree, from `method_dir` or `files`: every file sent. */
  files_sent?: string[];
  /** A valid verdict's advisory findings, the API's problem items as it sent them; absent when empty. */
  warnings?: ProblemItem[];
  /** An invalid verdict's faults, the API's problem items as it sent them. */
  errors?: ProblemItem[];
  /** The one problem of a call that produced no verdict. */
  problem?: Problem;
}

/** The model-facing half of a {@link GraphPageOutcome}: `created` shapes the prose only. */
export interface GraphPageStructuredContent {
  path: string;
  written: boolean;
  error?: Problem;
}

export interface ValidationResult {
  structuredContent: ValidationStructuredContent;
  summary: string;
  /**
   * What became of the method's graph page, when this validation wrote one or
   * tried to. Kept beside `summary` rather than folded into it because
   * {@link toolResult} renders its section after the summary: a page can be
   * written when the API refused to produce a verdict, and its note must not
   * sit inside the problem it follows.
   */
  graphPage?: GraphPageOutcome;
  /**
   * The effective entry pipe as a namespaced `pipe_ref` (`defaultPipeRefOf`:
   * the report's `default_pipe_ref`, the blueprint's `domain.main_pipe` only
   * behind an absent field). It rides `_meta.main_pipe_ref` on every valid
   * verdict that settles one, the signature's ref being the same, so a raw MCP
   * consumer can read it without parsing the report. Absent when nothing
   * settled an entry pipe.
   */
  mainPipeRef?: string;
  /**
   * Set on a no-verdict result whose request the deployment refused for the
   * Python the method holds, the execution-locus gate
   * (`isExecutionLocusRefusal`): the deployment will not load the method, so
   * it can give no verdict about it, while nothing is wrong with the request.
   * `mthds_save_method` reads it to store the draft unvalidated rather than
   * refuse to save it.
   */
  refusedForPython?: boolean;
}

export interface ValidationClient {
  /** `GET /v1/version`, read to learn whether a bare id names the draft or a version; optional on a test seam. */
  version?(): Promise<unknown>;
  /**
   * `POST /v1/validate`, the SDK's `validate`: the method's tree as `{ tree }`,
   * sent inline or by hash, or a `{ method_ref }` / `{ method_id }` selector,
   * resolved server-side, whose diagnostics name the package's, or the stored
   * method's, own tree paths.
   */
  validate(
    source: PipelexValidateSource,
    allowSignatures?: boolean,
    options?: ValidateOptions,
  ): Promise<PipelexValidationResult>;
}

export interface ValidationContext extends ApiConfig, MethodVersionsAware, TreeLimitsAware {
  client?: ValidationClient;
  /** Fills `{ path }` items from disk; the workshop always sets it, and without one every `{ path }` is refused. */
  resolver?: FileResolver;
  /** Where the call's key and base URL came from, for a failed request's summary; the variables' names when absent. */
  apiNotes?: ApiNotes;
  /**
   * The working directory the method's graph page is written under — the same
   * name and meaning as `CodegenContext.saveRoot`. Set, a validation of files
   * that were all given as `{ path }` writes {@link GRAPH_PAGE_FILENAME} beside
   * them unless the caller passes `graph_page: false`. Absent, nothing is
   * written: `mthds_save_method`'s validation leg must not write a file its own
   * result never reports.
   */
  saveRoot?: string;
}

export function buildValidationContext(env = process.env): ValidationContext {
  return buildApiConfig(env);
}

// Constructed inside each caught block (mirroring run.ts's runClient): the SDK
// constructor throws on a malformed base URL, and that must become the
// result's problem, not reject the MCP handler.
function validationClient(context: ValidationContext): ValidationClient {
  return context.client ?? createPipelexApiClient(context);
}

export async function validateMthds(
  input: MthdsValidateInput,
  context: ValidationContext = buildValidationContext(),
): Promise<ValidationResult> {
  const resolution = await resolveMethodSource(input, context.resolver, "one_selector", () =>
    methodTreeLimitsOf(context, () => validationClient(context)),
  );
  if (resolution.faults.length > 0) {
    return errorResult(faultsProblem(resolution.faults), context);
  }

  const request: ResolvedValidateRequest = {
    ...(resolution.tree === undefined ? {} : { tree: resolution.tree }),
    ...(input.method_ref === undefined ? {} : { method_ref: input.method_ref }),
    ...(input.method_id === undefined ? {} : { method_id: input.method_id }),
  };
  const inputFaults = validateMethodSelectorRequest(request.tree !== undefined, request, {
    rule: "one_selector",
  });
  if (inputFaults.length > 0) {
    return errorResult(faultsProblem(inputFaults), context);
  }

  const result = withFilesSent(await validateRequest(request, context), request.tree);
  const saveRoot = context.saveRoot;
  const pageFiles = graphPageFilesOf(input, request.tree);
  if (saveRoot === undefined || pageFiles === undefined) {
    return result;
  }
  // Written whatever the verdict, and even when the API produced none: the
  // page draws from the files it embeds, not from the report, so an invalid
  // method or an unreachable API is no reason to leave a stale page in place.
  const graphPage = await writeGraphPage(saveRoot, pageFiles);
  return {
    ...result,
    structuredContent: { ...result.structuredContent, graph_page: graphPageContentOf(graphPage) },
    graphPage,
  };
}

/**
 * The files the graph page embeds, with the paths they can be opened at: the
 * `.mthds` files of the tree sent, only when the caller did not opt out and
 * every file of it was read from disk, which a tree from `method_dir` always
 * was, so the page lands in the folder itself, the deepest directory holding a
 * bundle with one at its top. An inline item has no directory to write beside,
 * and a page embedding some of the method's files but not others would draw a
 * different method from the one validated. The other files of the tree are not
 * the method's text, so they are left out.
 */
function graphPageFilesOf(
  input: MthdsValidateInput,
  tree: MethodTreeToSend | undefined,
): GraphPageFile[] | undefined {
  if (input.graph_page === false || tree === undefined) {
    return undefined;
  }
  if (tree.files.some((file) => !file.onDisk)) {
    return undefined;
  }
  const decoder = new TextDecoder();
  const pageFiles = tree.files
    .filter((file) => file.treePath.toLowerCase().endsWith(".mthds"))
    .map((file) => ({ path: file.shown, content: decoder.decode(file.bytes) }));
  return pageFiles.length > 0 ? pageFiles : undefined;
}

function graphPageContentOf(outcome: GraphPageOutcome): GraphPageStructuredContent {
  const content: GraphPageStructuredContent = { path: outcome.path, written: outcome.written };
  if (outcome.error !== undefined) {
    content.error = outcome.error;
  }
  return content;
}

/**
 * Validate a method's tree already read and checked, as `mthds_save_method`
 * does with the folder it saves: the tree goes to the route as it is, with no
 * second read, no second pass of the secret guard, no second wait on the
 * limits handshake, and no graph page, which the save's result never reports.
 */
export async function validateMethodTree(
  tree: MethodTreeToSend,
  context: ValidationContext,
): Promise<ValidationResult> {
  return withFilesSent(await validateRequest({ tree }, context), tree);
}

async function validateRequest(
  request: ResolvedValidateRequest,
  context: ValidationContext,
): Promise<ValidationResult> {
  let report: PipelexValidationResult;
  let plan: SelectorPlan | undefined;
  let client: ValidationClient | undefined;
  try {
    // `views` is the structured-view opt-in (the `render` sibling): the
    // descriptor spec keeps `input_form` off the report unless a caller asks.
    // Tokens are lenient — a runner that predates the field simply returns no
    // `input_form`, and the signature's inputs then keep the contract's
    // order. A selector is a SERVER pass-through on `POST /v1/validate`
    // itself: the runner resolves an address, the hosted platform resolves an
    // id — nothing is expanded client-side, and the diagnostics name the
    // package's, or the stored method's, own tree paths.
    client = validationClient(context);
    if (request.tree !== undefined) {
      // The whole tree, inline or by hash: every .mthds file is judged, and
      // the template files the steps name are loaded and checked, a valid
      // verdict carrying the check's findings in `warnings`.
      report = await client.validate({ tree: request.tree.source }, true, VALIDATE_OPTIONS);
    } else if (request.method_ref !== undefined) {
      report = await client.validate({ method_ref: request.method_ref }, true, VALIDATE_OPTIONS);
    } else if (request.method_id !== undefined) {
      // What a bare id reads differs between a platform that resolves version
      // selectors and one that does not yet, so the platform is asked beside
      // the request, which never waits on it (`method-versions.ts`), and the
      // result says which content was validated.
      plan = planById(request.method_id, methodVersionsOf(context), client, {
        needBareReport: true,
      });
      report = await client.validate({ method_id: plan.send }, true, VALIDATE_OPTIONS);
    } else {
      // Unreachable: the selector checks above guarantee a source.
      throw new Error("No method selector survived request validation.");
    }
  } catch (err) {
    // The SDK's problem, as it read the answer or the failure: its code, its
    // domain and its retry verdict are relayed, never overridden; a request
    // the method's files made too large says so in its message.
    const sized = await withTooLargeNote(problemOf(err), err, {
      route: "/v1/validate",
      tree: request.tree,
      client,
    });
    const problem = await selectorFailure(sized, plan, methodVersionsOf(context));
    const failed: ValidationResult = {
      ...errorResult(problem, context),
      ...(isExecutionLocusRefusal(err) ? { refusedForPython: true } : {}),
    };
    // A client that could not be built, or an argument refused before
    // sending, sent no file of the tree.
    return client === undefined || failedBeforeSending(err) ? markUnsent(failed) : failed;
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (e.g. missing rendered_markdown) is an answer the
  // workshop cannot read, `client.response_unreadable` of the 200 it came on.
  try {
    const result = validationResult(report);
    return await withMethodContent(result, plan, "validated");
  } catch (err) {
    return errorResult(
      buildProblem(
        "client.response_unreadable",
        { status: 200 },
        {
          extra: {
            message: `${err instanceof Error ? err.message : "The Pipelex API returned a malformed validation report."} The API answered, but its report was missing required fields.`,
          },
        },
      ),
      context,
    );
  }
}

export function toolResult(result: ValidationResult) {
  const [text] = toolResultContent(result.summary, result.structuredContent.files_sent);
  const content =
    result.graphPage === undefined
      ? [text]
      : [
          {
            ...text,
            text: `${text.text}\n\n${graphPageSection(result.graphPage, result.structuredContent.status === "ok")}`,
          },
        ];
  return {
    structuredContent: result.structuredContent,
    content,
    isError: result.structuredContent.status === "error",
    // Response-metadata channel: the main pipe ref rides `_meta`, never
    // `structuredContent`. `_meta` still travels on the raw MCP result, so a
    // programmatic consumer can read it off the wire; it only withholds it
    // from the model's context, which reads the signature instead.
    _meta: {
      main_pipe_ref: result.mainPipeRef,
    },
  };
}

/**
 * Everything a validation report projects to except the prose: the verdict,
 * the signature and the effective entry pipe ({@link defaultPipeRefOf}).
 */
function projectValidationReport(
  report: PipelexValidationResult,
): Omit<ValidationResult, "summary"> {
  const structuredContent: ValidationStructuredContent = {
    status: "ok",
    is_valid: report.is_valid,
    is_runnable: report.is_runnable,
    pending_signatures: report.pending_signatures,
    available_view_specs: [],
  };

  let mainPipeRef: string | undefined;
  if (report.is_valid) {
    const validReport = report as PipelexValidationReport;
    // Advisory findings, the template check's among them, relayed as the API
    // sent them, one problem item each: they are the verdict's, and a consumer
    // such as a template authoring skill branches on their codes and
    // locations. The summary lists them too, under the rendered report's
    // `## Warnings`.
    const warnings: unknown = validReport.warnings;
    if (Array.isArray(warnings) && warnings.length > 0) {
      structuredContent.warnings = warnings as ProblemItem[];
    }
    // The signature needs the main pipe ref on EVERY valid verdict, so
    // `_meta.main_pipe_ref` rides a valid non-runnable verdict too.
    mainPipeRef = defaultPipeRefOf(validReport);
    // A pending-signature verdict carries the signature too — the shape is
    // fully determined before the signatures resolve.
    const mainPipe = mainPipeSignatureOf(validReport, mainPipeRef);
    if (mainPipe !== undefined) {
      structuredContent.main_pipe = mainPipe;
    }
  } else {
    // The faults, one problem item each, relayed as the API sent them: the
    // rendered report lists them for the reader.
    const invalidReport = report as PipelexInvalidReport;
    const errors: unknown = invalidReport.errors;
    structuredContent.errors = Array.isArray(errors) ? (errors as ProblemItem[]) : [];
  }

  return { structuredContent, mainPipeRef };
}

export function validationResult(report: PipelexValidationResult): ValidationResult {
  const projection = projectValidationReport(report);
  const { structuredContent } = projection;

  if (report.rendered_markdown == null) {
    throw new Error("Validation report did not include rendered markdown.");
  }

  let summary = report.rendered_markdown;

  // Prose, because agents read the summary more reliably than the structured
  // fields — and because the summary is the one channel that reaches a host
  // whose cached tool list predates the schema change.
  if (structuredContent.main_pipe !== undefined) {
    summary += `\n\n## Main pipe\n\n\`${signatureLine(structuredContent.main_pipe)}\``;
  }

  return { ...projection, summary };
}

/**
 * The three I/O artifacts a signature is read from, as any answer carrying
 * them spells them: `/v1/validate`'s valid arm and `/v1/pipe-io`'s alike. Typed
 * `unknown` because both are relayed wire data that nothing validates.
 */
export interface PipeIOArtifacts {
  pipe_io_contracts?: unknown;
  input_form?: unknown;
  output_form?: unknown;
}

/**
 * The main pipe's signature, or `undefined` when the report carries no usable
 * one. Defensive on purpose (`narrowMethodProvenance` in `run.ts` is the
 * model): the SDK's declared type is not proof of what arrived, and this is
 * what an agent types a call site against, so every member is checked and ANY
 * malformed one omits the WHOLE signature — half a signature actively misleads
 * where an absent one just sends the agent to `mthds_inputs_template`. The
 * verdict itself is never affected.
 */
export function mainPipeSignatureOf(
  report: PipeIOArtifacts,
  mainPipeRef: string | undefined,
): MainPipeSignature | undefined {
  if (mainPipeRef === undefined) {
    return undefined;
  }
  const contracts = asRecord(report.pipe_io_contracts);
  const contract = contracts === undefined ? undefined : asRecord(contracts[mainPipeRef]);
  if (contract === undefined) {
    return undefined;
  }

  const output = narrowOutputContract(contract.output);
  const inputs = narrowInputContracts(
    contract.inputs,
    orderedInputNames(report.input_form, mainPipeRef),
  );
  if (output === undefined || inputs === undefined) {
    return undefined;
  }

  // Where the pictures are, from the output-form descriptor — the one thing it
  // is consulted for here. A descriptor that did not arrive, or an entry that
  // does not narrow, leaves `images` ABSENT rather than empty, so "this output
  // holds no image" and "nobody said" stay different answers. The signature is
  // never withheld for a bad descriptor: the contract is its source of truth,
  // and this is presentation riding beside it.
  const outputNode = outputFormFieldOf(report.output_form, mainPipeRef);
  if (outputNode !== undefined) {
    const walked = imageFieldPaths(outputNode);
    // The member rides only when it is a truthful answer, which is the whole
    // reason the walk reports its own completeness. An incomplete walk that
    // found nothing would otherwise emit `[]` — "the server described the
    // output and it holds no image" — for a descriptor that said no such
    // thing, and a consumer applying the documented `images.length > 0` rule
    // would read a confident no off an opaque node. An incomplete walk that
    // DID find an image still rides: those positions do hold pictures, and
    // downgrading a known yes to "unknown" would lose the signal this member
    // exists for.
    if (walked.paths.length > 0 || walked.complete) {
      output.images = walked.paths;
    }
  }

  return { pipe_ref: mainPipeRef, inputs, output };
}

/**
 * What the walk does with a node of each kind. Written as a total map over the
 * standard's own `FIELD_KINDS` rather than a `switch` with a `default`, so a
 * kind a later version of the standard adds fails the BUILD here instead of
 * silently reading as "no images in there".
 */
const IMAGE_WALK: Record<FieldKind, "yield" | "fields" | "item" | "none" | "opaque"> = {
  text: "none",
  prose: "none",
  date: "none",
  number: "none",
  boolean: "none",
  enum: "none",
  // Deliberate: documents are not pictures and are not inlined anywhere in this
  // server. A `documents` member is a later increment, not a silent inclusion.
  // "none" and not "opaque": a document is a node the walk fully understood and
  // that holds no picture, which is a complete answer.
  document: "none",
  image: "yield",
  object: "fields",
  list: "item",
  // The standard's escape hatch — a producer that could not map a node honestly.
  // The ONLY opaque member, because it is the only one where "no image here"
  // would be a guess: there may be an image inside and no way to know.
  unknown: "opaque",
};

/**
 * A ceiling on how deep the walk will follow a descriptor. The artifact comes
 * off the wire, so its depth is not this repo's to assume; a method's real
 * output nests a handful of levels at most, and the cap only ever costs a
 * pathological descriptor the paths below it.
 */
const MAX_OUTPUT_FORM_DEPTH = 32;

/**
 * Every position an image sits at within one output-form node, as paths from
 * the output's root: `$` is the output itself, `$.name` a field of it, `$[]` an
 * element of a list, `$[].name` a field of one. A top-level `Image` output is
 * therefore `["$"]` and an `Image[]` is `["$[]"]` — the plural wrap is already
 * performed on the descriptor, so the walk never consults the contract for it.
 *
 * Typed `unknown` rather than `InputFormField` on purpose, like every other
 * narrowing in this file: the SDK's declared type is what the wire is supposed
 * to carry, not proof of what arrived, and a malformed node must cost its own
 * subtree and nothing else.
 *
 * The walk reports whether it was **complete** beside the paths it found,
 * because `[]` and "nobody said" are different answers and only the walk knows
 * which one it is holding. An opaque node (`kind: "unknown"`), a kind this
 * build does not know, a node that is not a record, a field with no usable
 * name, and the depth ceiling each mean a subtree was never looked into — so
 * the empty list they produce is "could not tell", never "there are none".
 */
export function imageFieldPaths(field: unknown, path = "$", depth = 0): ImageWalk {
  const node = asRecord(field);
  if (node === undefined || !isFieldKind(node.kind) || depth >= MAX_OUTPUT_FORM_DEPTH) {
    // Not a record, a kind this build does not know, or too deep to follow —
    // three ways of not having looked, and none of them is "there are none".
    return { paths: [], complete: false };
  }
  switch (IMAGE_WALK[node.kind]) {
    case "yield":
      return { paths: [path], complete: true };
    case "none":
      return { paths: [], complete: true };
    case "opaque":
      return { paths: [], complete: false };
    case "fields": {
      if (!Array.isArray(node.fields)) {
        return { paths: [], complete: false };
      }
      const paths: string[] = [];
      let complete = true;
      for (const child of node.fields) {
        const record = asRecord(child);
        const name =
          record !== undefined && typeof record.name === "string" && record.name.length > 0
            ? record.name
            : undefined;
        if (name === undefined) {
          // A field with no usable name is a subtree that was never walked, so
          // what lies below this node is not known to be complete.
          complete = false;
          continue;
        }
        const walked = imageFieldPaths(child, `${path}.${name}`, depth + 1);
        paths.push(...walked.paths);
        complete &&= walked.complete;
      }
      return { paths, complete };
    }
    case "item":
      return imageFieldPaths(node.item, `${path}[]`, depth + 1);
  }
}

/**
 * What {@link imageFieldPaths} found, and whether it saw the whole output.
 * `complete: false` means some subtree was opaque or unreadable, so an empty
 * `paths` is "could not tell" rather than "there are none" — the distinction
 * `main_pipe.output.images` is contracted on.
 */
export interface ImageWalk {
  paths: string[];
  complete: boolean;
}

/**
 * The single output node one pipe's output-form descriptor carries, or
 * `undefined` when no descriptor arrived, the pipe has no entry in it, or the
 * entry is not the shape the standard defines (`{ field }`, one node, never a
 * list — a pipe has exactly one output).
 */
function outputFormFieldOf(outputForm: unknown, pipeRef: string): unknown {
  const forms = asRecord(outputForm);
  const descriptor = forms === undefined ? undefined : asRecord(forms[pipeRef]);
  if (descriptor === undefined) {
    return undefined;
  }
  return asRecord(descriptor.field) === undefined ? undefined : descriptor.field;
}

function isFieldKind(value: unknown): value is FieldKind {
  return typeof value === "string" && (FIELD_KINDS as readonly string[]).includes(value);
}

/**
 * The declared input slots, in authored order where the descriptor states one.
 * Names the descriptor lists but the contract does not declare are ignored,
 * and names the contract declares but the descriptor omits keep map order
 * behind them — a disagreement between the two artifacts costs ordering, never
 * an input, and never a duplicated one.
 */
function narrowInputContracts(
  value: unknown,
  order: string[],
): MainPipeInputSignature[] | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const declared = Object.keys(record);
  // The descriptor is a producer artifact like any other, so it may name the
  // same field twice; `Object.keys` cannot. Deduplicating (first occurrence
  // wins, which is what `Set` keeps) is the ordering half of the same
  // whole-signature-or-nothing rule the narrowing below enforces — a repeated
  // slot would render `main(topic: native.Text, topic: native.Text)`, a call
  // site wrong in exactly the plausible way a partial signature is.
  const names = [
    ...new Set([
      ...order.filter((name) => declared.includes(name)),
      ...declared.filter((name) => !order.includes(name)),
    ]),
  ];

  const inputs: MainPipeInputSignature[] = [];
  for (const name of names) {
    const slot = asRecord(record[name]);
    if (slot === undefined || name.length === 0) {
      return undefined;
    }
    const conceptRef = narrowConceptRef(slot.concept_ref);
    const plurality = narrowPlurality(slot.multiplicity, slot.item_count);
    const presence = slot.presence;
    if (conceptRef === undefined || plurality === undefined || !isPresenceMarker(presence)) {
      return undefined;
    }
    inputs.push({
      name,
      concept_ref: conceptRef,
      ...plurality,
      required: PRESENCE_IS_REQUIRED[presence],
    });
  }
  return inputs;
}

function narrowOutputContract(value: unknown): MainPipeOutputSignature | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const conceptRef = narrowConceptRef(record.concept_ref);
  const plurality = narrowPlurality(record.multiplicity, record.item_count);
  if (conceptRef === undefined || plurality === undefined || typeof record.optional !== "boolean") {
    return undefined;
  }
  return { concept_ref: conceptRef, ...plurality, optional: record.optional };
}

/** The multiplicity pair, with `item_count` present exactly on the fixed arm. */
function narrowPlurality(
  multiplicity: unknown,
  itemCount: unknown,
): { multiplicity: IOMultiplicity; item_count?: number } | undefined {
  if (!isMultiplicity(multiplicity)) {
    return undefined;
  }
  if (multiplicity === "fixed") {
    // A fixed count is always at least two — the language says `Concept[1]` is
    // a way of writing `Concept` and reports `"single"`, so a fixed arm
    // carrying 1 is a producer violation, not an alternate spelling.
    return typeof itemCount === "number" && Number.isInteger(itemCount) && itemCount > 1
      ? { multiplicity, item_count: itemCount }
      : undefined;
  }
  // Off the fixed arm the artifact states `item_count: null` — literally, and
  // always on the wire. Anything else (a number contradicting the multiplicity
  // beside it, a string, an omitted member) is drift.
  return itemCount === null ? { multiplicity } : undefined;
}

/**
 * Authored input order for one pipe, read from the input-form descriptor — the
 * one thing the descriptor is consulted for here. The contract's `inputs` map
 * deliberately carries no order, and the descriptor is the artifact that states
 * it; when it is absent (an older runner, or a verdict the `views` token never
 * reached) the map's own iteration order stands. The signature never depends on
 * the descriptor being present.
 */
function orderedInputNames(inputForm: unknown, pipeRef: string): string[] {
  const forms = asRecord(inputForm);
  const descriptor = forms === undefined ? undefined : asRecord(forms[pipeRef]);
  if (descriptor === undefined || !Array.isArray(descriptor.fields)) {
    return [];
  }
  return descriptor.fields
    .map((field) => {
      const record = asRecord(field);
      return record !== undefined && typeof record.name === "string" ? record.name : undefined;
    })
    .filter((name): name is string => name !== undefined);
}

/**
 * The signature as one line of MTHDS-flavoured notation, e.g.
 * `demo.main(document: legal.Contract, notes?: native.Text, tags: native.Text[]) -> analysis.Report[2]`:
 * `?` marks an input the caller may omit (and an output a successful run may
 * resolve as a recorded absence), `[]` a variable list, `[N]` a fixed one. The
 * two never meet on an input: the standard pins a plural slot to
 * `presence: "plain"`, so an optional list is not a shape a caller can be
 * offered, and only the output can carry both marks.
 */
export function signatureLine(signature: MainPipeSignature): string {
  const inputs = signature.inputs
    .map(
      (input) =>
        `${input.name}${input.required ? "" : "?"}: ${conceptNotation(input.concept_ref, input.multiplicity, input.item_count)}`,
    )
    .join(", ");
  const { concept_ref, multiplicity, item_count, optional, images } = signature.output;
  const output = `${conceptNotation(concept_ref, multiplicity, item_count)}${optional ? "?" : ""}`;
  // Prose for the same reason the whole `## Main pipe` section is prose: some
  // agents read the summary more reliably than the structured fields, and it is
  // the one channel that reaches a ChatGPT install whose cached tool list
  // predates the schema change.
  const produces = images !== undefined && images.length > 0 ? " (produces images)" : "";
  return `${signature.pipe_ref}(${inputs}) -> ${output}${produces}`;
}

function conceptNotation(
  conceptRef: string,
  multiplicity: IOMultiplicity,
  itemCount?: number,
): string {
  return `${conceptRef}${MULTIPLICITY_SUFFIX[multiplicity](itemCount)}`;
}

function narrowConceptRef(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isMultiplicity(value: unknown): value is IOMultiplicity {
  return typeof value === "string" && (IO_MULTIPLICITIES as readonly string[]).includes(value);
}

function isPresenceMarker(value: unknown): value is PresenceMarker {
  return typeof value === "string" && (PRESENCE_MARKERS as readonly string[]).includes(value);
}

/**
 * The pipe a selector-less run of this same request would execute, or undefined
 * when nothing settles one.
 *
 * The server's own `default_pipe_ref` wins unconditionally: it is the only
 * signal that knows a `method_ref` package's manifest (`METHODS.toml`), whose
 * `main_pipe` outranks the bundle-level declaration on the run and build
 * routes, so a package where the two differ would otherwise get a signature
 * typing a call site `mthds_run` will not run.
 *
 * The three arms are distinct on purpose, and `null` is not `undefined` here:
 *
 * - a non-empty string is the stated default;
 * - `null` — or any other value the field carries — is the server saying it
 *   determined **no** default (no `main_pipe` anywhere, or a manifest naming a
 *   pipe the closure does not declare or declares in several domains), which is
 *   exactly when a selector-less `mthds_run` would fail to resolve one too, so
 *   the blueprint must NOT be consulted behind it;
 * - the field being **absent** means the runner predates it, and only then does
 *   the blueprint derivation stand.
 *
 * A JSON body cannot produce an own property holding `undefined`, so reading the
 * field is the whole absence test.
 */
export function defaultPipeRefOf(report: PipelexValidationReport): string | undefined {
  const stated: unknown = report.default_pipe_ref;
  if (stated === undefined) {
    return blueprintMainPipeRefOf(report.bundle_blueprint);
  }
  return typeof stated === "string" && stated.length > 0 ? stated : undefined;
}

/** A call that produced no verdict: its one problem, and the problem's summary. */
function errorResult(problem: Problem, context: { apiNotes?: ApiNotes }): ValidationResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      is_runnable: false,
      pending_signatures: [],
      available_view_specs: [],
      problem,
    },
    summary: problemSummary(problem, context.apiNotes),
  };
}
