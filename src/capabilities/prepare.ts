import { InputPreparationError, UploadNotAllowedError } from "@pipelex/sdk";
import type {
  MethodTreeSource,
  PrepareInputsRequest,
  PreparedInputs,
  UploadKind,
  UploadKindOptions,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  LEGACY_LINK_FILE_NAME,
  LEGACY_LINK_MOVE,
  LINK_FILE_NAME,
  apiHostOf,
  holdsLegacyLink,
  readMethodLink,
} from "./catalog-link.js";
import {
  METHOD_ID_SELECTOR_SENTENCE,
  methodVersionReportSchema,
  methodVersionsOf,
  planById,
  selectorFailure,
  withMethodContent,
} from "./method-versions.js";
import type { MethodVersionReport, MethodVersionsAware, SelectorPlan } from "./method-versions.js";
import {
  METHOD_REF_GRAMMAR,
  argumentProblem,
  bareMethodIdOf,
  bareMethodIdRefusal,
  buildApiConfig,
  createPipelexApiClient,
  faultsProblem,
  filesSentSchema,
  inputsPathSchema,
  methodDirInputSchema,
  methodFilesInputSchema,
  problemOf,
  problemSchema,
  problemSummary,
  resolveInputsSource,
  resolveMethodSource,
  toolResultContent,
  validateMethodSelectorRequest,
  withFilesSent,
  failedBeforeSending,
  markUnsent,
} from "./shared.js";
import type {
  ApiConfig,
  ApiNotes,
  FileResolver,
  MethodTreeToSend,
  Problem,
  SubmittedFileInput,
} from "./shared.js";
import { methodTreeLimitsOf } from "./tree-limits.js";
import type { TreeLimitsAware } from "./tree-limits.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";
import { SizeGuardedPipelexApiClient } from "./upload-ceiling.js";

/** What an upload is recorded as: a member's file, or a test input made for one method. */
export const UPLOAD_KINDS = ["uploaded", "test"] as const satisfies readonly UploadKind[];

/**
 * What every upload of one preparation is recorded as: the prepare request's
 * `upload` member, which the SDK sends with each `POST /v1/upload` of the
 * walk. A test file names the bare id of the method it was made for.
 */
interface UploadMarking extends UploadKindOptions {
  kind: UploadKind;
}

export const mthdsPrepareInputsInputSchema = {
  method_dir: methodDirInputSchema("one_selector"),
  files: methodFilesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR} — the signature source. Resolved server-side (the repository is fetched at the tag); no bundle enters the conversation. Supply exactly ONE of method_dir / files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      `Catalog id (mt_…) of a registered method — the signature source, resolved server-side and requiring an API key (the catalog is org-scoped). ${METHOD_ID_SELECTOR_SENTENCE} Supply exactly ONE of method_dir / files / method_ref / method_id.`,
    ),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      "The pipe whose declared signature identifies the file-bearing inputs, as a qualified domain.pipe_code — the same value mthds_run takes as pipe_code and mthds_inputs_template as pipe_ref. Omit to default to the closure's main_pipe.",
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The caller's FILLED inputs (the mthds_inputs_template output, populated). File-bearing values are uploaded to Pipelex storage and rewritten to pipelex-storage://; http(s) URLs and existing pipelex-storage:// URIs pass through. An empty object uploads nothing. Supply exactly ONE of inputs / inputs_path.",
    ),
  inputs_path: inputsPathSchema,
  kind: z
    .enum(UPLOAD_KINDS)
    .optional()
    .describe(
      `What the files this call uploads are recorded as in the organization's files: uploaded (the default, a member's file) or test (a test input made for this method, listed as its test file). test needs the method's saved id, so name the method by its bare method_id (no @ suffix), or by a method_dir that ${WORKSHOP_TOOL_NAMES.saveMethod} linked to its saved method (${LINK_FILE_NAME}). Values that pass through are not uploaded and keep what they are.`,
    ),
};

const prepareStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      "Echoed only when the caller supplied it (the resolved main_pipe default is not returned).",
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The prepared (rewritten) inputs — ready to hand to mthds_run."),
  uploads: z
    .array(z.string())
    .optional()
    .describe(
      "The pipelex-storage:// uris of the assets uploaded this call; [] when all inputs pass through.",
    ),
  kind: z
    .enum(UPLOAD_KINDS)
    .optional()
    .describe("Echoed only when the caller supplied it: what the uploads were recorded as."),
  test_method_id: z
    .string()
    .optional()
    .describe(
      "With kind test, when something was uploaded: the bare id of the method the uploads were recorded as test files of.",
    ),
  method_version: methodVersionReportSchema,
  files_sent: filesSentSchema,
  problem: problemSchema
    .optional()
    .describe("Why the inputs could not be prepared; present exactly when status is error."),
});

export const mthdsPrepareInputsOutputSchema = prepareStructuredContentSchema;

export interface MthdsPrepareInputsInput {
  method_dir?: string;
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs?: Record<string, unknown>;
  inputs_path?: string;
  kind?: UploadKind;
}

/** The prepare request once its method and `inputs_path` are resolved — what the checks and the prepare step consume. */
interface ResolvedPrepareRequest {
  /** The method's tree, from `method_dir` or `files`. */
  tree?: MethodTreeToSend;
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
  kind?: UploadKind;
}

export interface PrepareStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  inputs?: Record<string, unknown>;
  uploads?: string[];
  /** Echoed when the caller supplied it. */
  kind?: UploadKind;
  /** With `kind: "test"`: the bare id of the method the uploads are test files of. */
  test_method_id?: string;
  /** By-id calls only: the content whose signature the inputs were prepared against, when this server can tell. */
  method_version?: MethodVersionReport;
  /** Calls on a tree, from `method_dir` or `files`: every file sent. */
  files_sent?: string[];
  /** The one problem of a call that prepared nothing. */
  problem?: Problem;
}

export interface PrepareResult {
  structuredContent: PrepareStructuredContent;
  summary: string;
}

/**
 * The slice of `PipelexApiClient` the prepare capability calls (test seam): the
 * SDK's `prepareInputs`, handed the selector as given. Nothing here expands a
 * selector or reads a signature client-side, which is why there is no
 * `getMethodClosure` and no `pipeIo` here: the SDK reads the signature from
 * one `POST /v1/pipe-io` itself.
 */
interface PrepareClient {
  prepareInputs(request: PrepareInputsRequest): Promise<PreparedInputs>;
  /** `GET /v1/version`, read to learn whether a bare id names the draft or a version; optional on a test seam. */
  version?(): Promise<unknown>;
}

/**
 * `mthds_prepare_inputs` always uploads: the workshop is co-located with the
 * user's files.
 */
export interface PrepareContext extends ApiConfig, MethodVersionsAware, TreeLimitsAware {
  client?: PrepareClient;
  /** Reads `{ path }` items and `method_dir` from disk (local workshop). */
  resolver?: FileResolver;
  /** Reads `inputs_path` from disk (local workshop, `.json` only); without one `inputs_path` is refused. */
  inputsResolver?: FileResolver;
  /** Where the call's key and base URL came from, for a failed request's summary; the variables' names when absent. */
  apiNotes?: ApiNotes;
}

export function buildPrepareContext(env = process.env): PrepareContext {
  return buildApiConfig(env);
}

// Constructed inside each caught block (mirroring inputs.ts / run.ts): the SDK
// constructor throws on a malformed base URL, and that must become the
// result's problem, not reject the MCP handler.
export function prepareClient(context: PrepareContext): PrepareClient {
  return (
    context.client ??
    // Size-guarded: the upload walk (delegated to the SDK's prepareInputs)
    // would otherwise learn an asset is too big only from the gateway's 413,
    // after the whole payload had crossed the wire — and with a server message
    // that cannot name the real limit. See upload-ceiling.ts.
    createPipelexApiClient(context, SizeGuardedPipelexApiClient)
  );
}

export async function prepareMthdsInputs(
  input: MthdsPrepareInputsInput,
  context: PrepareContext = buildPrepareContext(),
): Promise<PrepareResult> {
  const resolution = await resolveMethodSource(input, context.resolver, "one_selector", () =>
    methodTreeLimitsOf(context, () => prepareClient(context)),
  );
  const inputsResolution = await resolveInputsSource(input, context.inputsResolver, {
    required: true,
  });
  const resolutionFaults = [...resolution.faults, ...inputsResolution.faults];
  if (resolutionFaults.length > 0) {
    return errorResult(faultsProblem(resolutionFaults), context);
  }

  // `inputs_path` is settled into `inputs` here and goes no further: the rest
  // of the flow cannot tell a loaded file from an inline object.
  const { inputs_path: _inputsPath, method_dir: _methodDir, files: _files, ...selection } = input;
  const request: ResolvedPrepareRequest = {
    ...selection,
    ...(resolution.tree === undefined ? {} : { tree: resolution.tree }),
    inputs: inputsResolution.inputs ?? {},
  };
  const inputFaults = validatePrepareInputsRequest(request);
  if (inputFaults.length > 0) {
    return errorResult(faultsProblem(inputFaults), context);
  }
  const marking = await uploadMarkingOf(request, context);
  if (!marking.ok) {
    return errorResult(marking.problem, context);
  }

  return withFilesSent(await requestPreparedInputs(request, marking, context), request.tree);
}

/**
 * What the request's uploads are recorded as, settled before anything is sent
 * as far as it can be.
 *
 * `uploaded` is what the platform records when told nothing, so it sends
 * nothing. A test file names the method it was made for, by its bare id,
 * since a test file is the method's whatever version it tests: a `method_id`
 * selector must therefore be bare, and a suffixed one is refused with the bare
 * id to pass, as `mthds_list_files` refuses one (`bareMethodIdOf`). From a
 * `method_dir`, the method is the saved one its link file names. A folder
 * still holding the link an earlier release wrote is refused at once with the
 * command that moves it, as the save and the pull refuse it.
 *
 * Every other way of not knowing the method, a list of files, a published
 * address, a folder with no link, a link file that cannot be read, a link
 * whose id is damaged and a link made against another API, matters only when
 * something is uploaded: inputs that are all addresses record no file at all.
 * Such a request goes out with uploads disallowed (`unmarkable`), and the
 * refusal is answered only if the SDK's walk meets a value that needs one.
 */
async function uploadMarkingOf(
  request: ResolvedPrepareRequest,
  context: PrepareContext,
): Promise<UploadMarkingResult> {
  if (request.kind !== "test") return { ok: true };
  const unmarkable = (reason: string, message: string, remedy: string): UploadMarkingResult => ({
    ok: true,
    unmarkable: { reason, message, remedy },
  });

  if (request.method_id !== undefined) {
    const check = bareMethodIdOf(request.method_id);
    if (!check.ok) {
      return {
        ok: false,
        problem: bareMethodIdRefusal(
          request.method_id,
          check,
          "method_id",
          "To prepare test files against the draft's signature, pass the method's linked folder as method_dir instead.",
        ),
      };
    }
    return { ok: true, upload: { kind: "test", method_id: check.methodId } };
  }

  const folder = request.tree?.folder;
  if (folder === undefined) {
    return unmarkable(
      "no_saved_method",
      "kind test records each upload as a test file of a saved method, and a list of files or a published address names none.",
      `Name the method by its saved id as method_id, or by a method_dir linked to its saved method (${LINK_FILE_NAME}, which ${WORKSHOP_TOOL_NAMES.saveMethod} writes); or omit kind to upload the files as the organization's own.`,
    );
  }
  if (await holdsLegacyLink(folder)) {
    return {
      ok: false,
      problem: argumentProblem(
        "kind",
        "legacy_link",
        `The method_dir holds ${LEGACY_LINK_FILE_NAME}, the link file an earlier release of the workshop wrote, which it now reads only at ${LINK_FILE_NAME}: as it is, the folder reads as unlinked, and its test files would belong to no method. Nothing was sent.`,
        `Move it into place from inside the folder, then prepare again: ${LEGACY_LINK_MOVE} (plain mv outside git), and commit the move.`,
      ),
    };
  }
  const read = await readMethodLink(folder);
  switch (read.kind) {
    case "none":
      return unmarkable(
        "unlinked",
        "kind test records each upload as a test file of a saved method, and this method_dir is not linked to one: it holds no " +
          `${LINK_FILE_NAME}.`,
        `Save the method with ${WORKSHOP_TOOL_NAMES.saveMethod}, which links its folder, then prepare again; or omit kind to upload the files as the organization's own.`,
      );
    case "unreadable":
      return unmarkable(
        "link_unreadable",
        `The method_dir's ${LINK_FILE_NAME} cannot be read, so the saved method its test files belong to is unknown: ${read.reason}.`,
        `Repair or remove ${LINK_FILE_NAME} (a save with ${WORKSHOP_TOOL_NAMES.saveMethod} writes it again), or name the method by its saved id as method_id.`,
      );
    case "link": {
      const check = bareMethodIdOf(read.link.method_id);
      if (!check.ok) {
        return unmarkable(
          "link_damaged",
          `The method_dir's ${LINK_FILE_NAME} is damaged: its method_id ${JSON.stringify(read.link.method_id)} is not a saved method's bare id, so the method its test files belong to is unknown.`,
          `Save the method again with ${WORKSHOP_TOOL_NAMES.saveMethod}, passing its id, which rewrites the link file; or name the method by its saved id as method_id. The link file is never edited by hand.`,
        );
      }
      const apiHost = apiHostOf(context.baseUrl);
      if (read.link.api_host !== apiHost) {
        return unmarkable(
          "linked_elsewhere",
          `The method_dir is linked to \`${check.methodId}\` on ${read.link.api_host}, and this call goes to ${apiHost}, where that method does not exist.`,
          `Prepare against the API the method was saved on, or save the method on ${apiHost} with ${WORKSHOP_TOOL_NAMES.saveMethod} first.`,
        );
      }
      return { ok: true, upload: { kind: "test", method_id: check.methodId } };
    }
  }
}

/**
 * Why a test upload's method is unknown, answered as a refusal of `kind` only
 * should the walk need to upload anything: the refusal's reason, the sentence
 * and what to do, which the input that needed an upload is put between.
 */
interface UnmarkableTest {
  reason: string;
  message: string;
  remedy: string;
}

/**
 * What {@link uploadMarkingOf} settled: a refusal before anything is sent, or
 * the marking every upload carries, or, for a test upload whose method is
 * unknown, the refusal to answer should the walk need to upload anything.
 */
type UploadMarkingResult =
  | { ok: true; upload?: UploadMarking; unmarkable?: UnmarkableTest }
  | { ok: false; problem: Problem };

/** The SDK's `prepareInputs` for a request that passed its checks, and the projection of what it prepared. */
async function requestPreparedInputs(
  request: ResolvedPrepareRequest,
  marking: { upload?: UploadMarking; unmarkable?: UnmarkableTest },
  context: PrepareContext,
): Promise<PrepareResult> {
  const { upload, unmarkable } = marking;

  let prepared: PreparedInputs;
  let plan: SelectorPlan | undefined;
  let client: PrepareClient | undefined;
  try {
    client = prepareClient(context);
    let sent = request;
    if (request.method_id !== undefined) {
      // A bare id reads the draft on a platform that does not resolve version
      // selectors yet, and the latest published version on one that does: the
      // platform is asked beside the request, which never waits on it, and the
      // result says whose signature the inputs were prepared against
      // (`method-versions.ts`).
      plan = planById(request.method_id, methodVersionsOf(context), client, {
        needBareReport: true,
      });
      sent = { ...request, method_id: plan.send };
    }
    // Built inside the try for the same reason the client is: the selector
    // narrowing throws on its own unreachable arm, and that must become the
    // result's problem rather than reject the MCP handler.
    const envelope: PrepareEnvelope = {
      selector: prepareSelectorOf(sent),
      ...(request.pipe_ref === undefined ? {} : { pipe_ref: request.pipe_ref }),
      inputs: request.inputs,
      ...(upload === undefined ? {} : { upload }),
      ...(unmarkable === undefined ? {} : { allowUploads: false as const }),
    };
    prepared = await prepareWithUpload(client, envelope);
  } catch (err) {
    // A test upload whose method is unknown, met by the first value of the
    // walk that needs an upload: nothing was read or uploaded, and the
    // refusal names that input.
    if (unmarkable !== undefined && err instanceof UploadNotAllowedError) {
      return errorResult(
        argumentProblem(
          "kind",
          unmarkable.reason,
          `${unmarkable.message} The input ${err.inputPath} needs an upload, so a test file would be recorded.`,
          unmarkable.remedy,
        ),
        context,
      );
    }
    // The SDK's problem, as it read the answer or the failure: its code, its
    // domain and its retry verdict are relayed, never overridden. An input
    // over the upload limit is the problem `upload-ceiling.ts` gives it, and
    // a refused pipe selection the route's own, located at pipe_ref.
    const problem = await selectorFailure(problemOf(err), plan, methodVersionsOf(context));
    const failed = errorResult(problem, context);
    // A client that could not be built, or an argument refused before
    // sending, sent no file of the tree.
    return client === undefined || failedBeforeSending(err) ? markUnsent(failed) : failed;
  }

  return await withMethodContent(
    prepareInputsResult(prepared, request.pipe_ref, { kind: request.kind, upload }),
    plan,
    "prepared the inputs against the signature of",
  );
}

/**
 * The method selector as the SDK spells it — one of the three, already proved
 * to be exactly one by {@link validatePrepareInputsRequest}. The SDK takes it
 * as-is: nothing here resolves an address or an id, the route does.
 */
type PrepareSelector = { tree: MethodTreeSource } | { method_ref: string } | { method_id: string };

function prepareSelectorOf(request: ResolvedPrepareRequest): PrepareSelector {
  if (request.tree !== undefined) {
    return { tree: request.tree.source };
  }
  if (request.method_ref !== undefined) {
    return { method_ref: request.method_ref };
  }
  if (request.method_id !== undefined) {
    return { method_id: request.method_id };
  }
  // Unreachable: `validateMethodSelectorRequest` has already refused a request
  // carrying no selector. Throwing rather than defaulting is the point — a
  // placeholder would put a blank selector on the wire if the invariant ever
  // broke, and this lands in the capability's own catch as the result's
  // problem instead.
  throw new InputPreparationError(
    "Cannot prepare inputs: no method selector. Supply exactly one of method_dir, files, method_ref or method_id.",
  );
}

/** The resolved selector + pipe + filled inputs the prepare step consumes. */
interface PrepareEnvelope {
  selector: PrepareSelector;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
  /** What the walk's uploads are recorded as, when not the platform's default. */
  upload?: UploadMarking;
  /** Set to `false` when a test upload's method is unknown: the walk then uploads nothing. */
  allowUploads?: false;
}

/**
 * Hand the whole request to the SDK's `prepareInputs`, selector included. Since
 * `@pipelex/sdk` 0.17.0 that call takes the method, a `method_ref` or a
 * `method_id`, and since 0.27.0 it resolves each, with the `pipe_ref` if one
 * was named, through one `POST /v1/pipe-io` for that one pipe, with no dry run
 * — which is why this repo does not expand a stored method into files before
 * calling it. The method travels as its tree, inline or by hash.
 */
function prepareWithUpload(
  client: PrepareClient,
  envelope: PrepareEnvelope,
): Promise<PreparedInputs> {
  // Spelled out per selector rather than spread-and-cast: `PrepareInputsRequest`
  // is an XOR that pins the other two members to `never`, and a cast on the one
  // call that reaches the SDK is exactly where a wrong shape would hide.
  const base = {
    ...(envelope.pipe_ref === undefined ? {} : { pipe_ref: envelope.pipe_ref }),
    inputs: envelope.inputs,
    ...(envelope.upload === undefined ? {} : { upload: envelope.upload }),
    ...(envelope.allowUploads === undefined ? {} : { allowUploads: envelope.allowUploads }),
  };
  if ("tree" in envelope.selector) {
    return client.prepareInputs({ ...base, tree: envelope.selector.tree });
  }
  if ("method_ref" in envelope.selector) {
    return client.prepareInputs({ ...base, method_ref: envelope.selector.method_ref });
  }
  return client.prepareInputs({ ...base, method_id: envelope.selector.method_id });
}

export function validatePrepareInputsRequest(input: ResolvedPrepareRequest): Problem[] {
  const faults = validateMethodSelectorRequest(input.tree !== undefined, input, {
    rule: "one_selector",
  });

  if (input.pipe_ref !== undefined && input.pipe_ref.trim() === "") {
    faults.push(
      argumentProblem(
        "pipe_ref",
        "empty",
        "pipe_ref must not be empty when supplied.",
        "Pass a qualified domain.pipe_code, or omit pipe_ref to default to the closure's main_pipe.",
      ),
    );
  } else if (input.pipe_ref !== undefined) {
    const refusal = pipeRefRefusal(input.pipe_ref.trim());
    if (refusal !== undefined) faults.push(refusal);
  }

  return faults;
}

/**
 * The SDK's `prepareInputs` refuses two spellings of `pipe_ref` before any
 * request (`normalizePipeRef`): an `alias->domain.pipe_code` ref, since
 * preparation covers the method's own pipes and not a dependency package's,
 * and a bare `pipe_code`, since a request names a pipe by its qualified ref.
 * Refused here first, with the SDK's reasons, so the refusal is the tool's own
 * request error: a folder's files are then known never to have left the
 * machine, where the SDK's `InputPreparationError` cannot say whether they did.
 */
function pipeRefRefusal(pipeRef: string): Problem | undefined {
  if (pipeRef.includes("->")) {
    return argumentProblem(
      "pipe_ref",
      "dependency_pipe",
      `pipe_ref "${pipeRef}" names a dependency package's pipe; preparation covers the method's own pipes.`,
      "Name one of the method's own pipes as domain.pipe_code, or omit pipe_ref to default to the method's main_pipe.",
    );
  }
  if (!pipeRef.includes(".")) {
    return argumentProblem(
      "pipe_ref",
      "not_qualified",
      `pipe_ref must be qualified (domain.pipe_code), got the bare "${pipeRef}".`,
      "Qualify the pipe with its domain, as domain.pipe_code, or omit pipe_ref to default to the method's main_pipe.",
    );
  }
  return undefined;
}

export function prepareInputsResult(
  prepared: PreparedInputs,
  pipeRef: string | undefined,
  marking: { kind?: UploadKind; upload?: UploadMarking } = {},
): PrepareResult {
  const uploads = prepared.uploads.map((record) => record.uri);
  // Named only when a test file was recorded: inputs that are all addresses
  // upload nothing, and then no file belongs to the method.
  const testMethodId =
    marking.upload?.kind === "test" && uploads.length > 0 ? marking.upload.method_id : undefined;
  return {
    structuredContent: {
      status: "ok",
      is_valid: true,
      ...(pipeRef === undefined ? {} : { pipe_ref: pipeRef }),
      inputs: prepared.inputs,
      uploads,
      ...(marking.kind === undefined ? {} : { kind: marking.kind }),
      ...(testMethodId === undefined ? {} : { test_method_id: testMethodId }),
    },
    summary: prepareSummary(pipeRef, prepared.inputs, uploads, testMethodId),
  };
}

// The build/prepare surface returns no rendered_markdown, so the summary is
// composed here. The prepared inputs are deliberately duplicated into the
// summary (the mthds_inputs_template pattern): they are the small payload the
// model must carry to mthds_run, and some hosts read prose more reliably than
// structured fields.
function prepareSummary(
  pipeRef: string | undefined,
  inputs: Record<string, unknown>,
  uploads: string[],
  testMethodId: string | undefined,
): string {
  const parts = ["# Prepared inputs"];
  if (pipeRef !== undefined) {
    parts.push(`Resolved pipe: \`${pipeRef}\``);
  }
  const recorded =
    testMethodId === undefined ? "" : `, recorded as test files of \`${testMethodId}\``;
  parts.push(
    uploads.length === 0
      ? "No assets required uploading — all inputs pass through unchanged. Hand these inputs to `mthds_run`."
      : `Uploaded ${uploads.length} asset(s) to Pipelex storage${recorded} (rewritten to \`pipelex-storage://\` references). Hand these inputs to \`mthds_run\`.`,
  );
  parts.push("```json\n" + JSON.stringify(inputs, null, 2) + "\n```");
  return parts.join("\n\n");
}

export function prepareInputsToolResult(result: PrepareResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.files_sent),
    isError: result.structuredContent.status === "error",
  };
}

/** A call that prepared nothing: its one problem, and the problem's summary. */
function errorResult(problem: Problem, context: { apiNotes?: ApiNotes }): PrepareResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      problem,
    },
    summary: problemSummary(problem, context.apiNotes),
  };
}
