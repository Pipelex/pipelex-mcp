import { InputPreparationError } from "@pipelex/sdk";
import type {
  InputForm,
  InputFormField,
  InputFormItem,
  MthdsFileItem,
  PipelexValidationResult,
  PipelexValidationReport,
  PrepareInputsRequest,
  PreparedInputs,
  ValidateMethodSelector,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  METHOD_REF_GRAMMAR,
  MissingInputFormError,
  UnresolvableClosureError,
  blueprintMainPipeRefOf,
  buildApiConfig,
  classifyError,
  summaryForToolError,
  filesInputSchema,
  resolveSubmittedFiles,
  toolErrorSchema,
  toolResultContent,
  validateMethodSelectorRequest,
} from "./shared.js";
import type {
  AuthErrorTexture,
  ClassifyErrorOptions,
  FileResolver,
  SubmittedFile,
  SubmittedFileInput,
  ErrorSummaries,
  ToolError,
} from "./shared.js";
import { MAX_UPLOAD_BYTES, SizeGuardedPipelexApiClient, formatMib } from "./upload-ceiling.js";

export const mthdsPrepareInputsInputSchema = {
  files: filesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR} — the signature source. Resolved server-side (the repository is fetched at the tag); no bundle enters the conversation. Supply exactly ONE of files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      "Catalog id (mt_…) of a registered method — the signature source. Uses the method's CURRENT stored content and requires an API key (the catalog is org-scoped). Supply exactly ONE of files / method_ref / method_id.",
    ),
  pipe_ref: z
    .string()
    .optional()
    .describe(
      "The pipe whose declared signature identifies the file-bearing inputs, as a qualified domain.pipe_code — the same value mthds_run takes as pipe_code and mthds_inputs_template as pipe_ref. Omit to default to the closure's main_pipe.",
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .describe(
      "The caller's FILLED inputs (the mthds_inputs_template output, populated). File-bearing values are uploaded to Pipelex storage and rewritten to pipelex-storage://; http(s) URLs and existing pipelex-storage:// URIs pass through. An empty object uploads nothing.",
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
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsPrepareInputsOutputSchema = prepareStructuredContentSchema;

export interface MthdsPrepareInputsInput {
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

/** The prepare request after `{ path }` resolution — what the checks and the prepare step consume. */
interface ResolvedPrepareRequest {
  files: SubmittedFile[];
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

export interface PrepareStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  inputs?: Record<string, unknown>;
  uploads?: string[];
  errors?: ToolError[];
}

export interface PrepareResult {
  structuredContent: PrepareStructuredContent;
  summary: string;
}

/**
 * The slice of `PipelexApiClient` the prepare capability calls (test seam).
 *
 * Two methods, one per arm, and both take the selector as given: the workshop
 * hands the whole request to the SDK's `prepareInputs`, and the console asks
 * `validate` for the same signature the SDK would have read. Neither expands a
 * selector client-side, which is why there is no `getMethodClosure` here any
 * more.
 */
interface PrepareClient {
  validate(
    source: string[] | ValidateMethodSelector,
    allowSignatures?: boolean,
    mthdsSources?: string[],
    render?: string[],
    views?: string[],
  ): Promise<PipelexValidationResult>;
  prepareInputs(request: PrepareInputsRequest): Promise<PreparedInputs>;
}

export interface PrepareContext {
  baseUrl: string;
  apiKey?: string;
  client?: PrepareClient;
  /** Fills `{ path }` closure items from disk (local workshop); absent on the hosted console. */
  resolver?: FileResolver;
  /**
   * The per-deployment asset boundary (analogous to {@link resolver}): the
   * local workshop uploads file-bearing inputs (`true`), the hosted console is
   * pass-through only (`false`, the default). When `false` the capability never
   * hands raw inputs to the SDK's `prepareInputs` — a bare-path value would make
   * the SDK read the *server's* filesystem before failing (LFI / DoS / existence
   * oracle on a public endpoint). It resolves the signature itself and refuses
   * any upload-needing input up front instead.
   */
  allowUpload?: boolean;
  /** Deployment-specific auth-failure texture (the hosted console overrides it per request); default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildPrepareContext(env = process.env): PrepareContext {
  return buildApiConfig(env);
}

/**
 * Name the real ceiling. `POST /v1/upload` sits behind an AWS gateway whose
 * 10 MiB request quota, divided by base64's 4/3 inflation, is the actual wall
 * — NOT the app-level 50 MiB MAX_UPLOAD_MIB, which is unreachable through the
 * public gateway and must never be quoted to a caller. Shared by all three
 * shapes: an oversize asset is the caller's input value whatever named the
 * method.
 */
const PREPARE_ASSET_TEXTURE: NonNullable<ClassifyErrorOptions["asset"]> = {
  hint: `Pipelex storage accepts uploads up to ${formatMib(MAX_UPLOAD_BYTES)}. Shrink the file, or reference it by an http(s) URL instead.`,
};

/**
 * The signature texture, and the reason every shape carries it unchanged: an
 * unqualified `pipe_ref`, an unknown one and a closure with no single default
 * pipe are all refused **client-side**, as an `InputPreparationError` raised
 * before any request. Each really is a question about the pipe, whatever named
 * the method — which is why it rides `preparation` rather than `badRequest`,
 * whose locator follows the selector the caller actually typed.
 *
 * Two conditions that used to land here no longer do, because neither is a
 * question about the pipe: a deployment serving no descriptor
 * ({@link MissingInputFormError}) and a closure that does not validate
 * ({@link UnresolvableClosureError}). Both were reported against a `pipe_ref`
 * the caller had usually left empty.
 */
const PREPARE_SIGNATURE_TEXTURE: NonNullable<ClassifyErrorOptions["preparation"]> = {
  location: "pipe_ref",
  hint: "Pass pipe_ref as a qualified domain.pipe_code; omitting it requires the closure to declare exactly one main_pipe.",
};

/**
 * Shared by all three shapes: the deployment, not the request, is what serves
 * the descriptor, so the locator is the knob that selects the deployment. On
 * the hosted console that knob belongs to the operator and not to the caller,
 * which the `config` class is precisely how this repo says so.
 */
const PREPARE_MISSING_DESCRIPTOR_TEXTURE: NonNullable<ClassifyErrorOptions["missingDescriptor"]> = {
  location: "PIPELEX_BASE_URL",
  hint: "The signature is read from this deployment's /v1/validate, which must serve the input-form descriptor (pipelex-api >= 0.18.0). No change to the request works around it.",
};

/** The closure-repair hint; the locator is per-shape, being whatever named the method. */
const PREPARE_CLOSURE_HINT =
  "The method's own bundle does not validate, so no signature can be read from it. Run mthds_validate on the same method for the diagnostics.";

/** Classify options for a files-shaped request. */
const PREPARE_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
  // No `badRequest` override on purpose: a files request names no selector
  // field, so the default `files` locator is already right, and it is the very
  // texture `mthds_validate` gets for the very same body on the very same
  // route. It must NOT be the signature texture, which is what it was while
  // this tool still sent `pipe_ref` to `/v1/build/inputs`: pipe selection is
  // client-side now, so `/v1/validate` can never be complaining about it.
  closure: { location: "files", hint: PREPARE_CLOSURE_HINT },
  preparation: PREPARE_SIGNATURE_TEXTURE,
  missingDescriptor: PREPARE_MISSING_DESCRIPTOR_TEXTURE,
  asset: PREPARE_ASSET_TEXTURE,
};

/**
 * Classify options for an address-shaped request — the `mthds_validate`
 * textures, because this tool now reaches the very same route with the very
 * same selector. Note the address travels through `/v1/validate` and therefore
 * through the execution-locus gate, so a published package shipping in-process
 * Python is a 403 here off a deployment that is not sandbox-hosted, while the
 * same address still answers on `mthds_inputs_template` and `mthds_codegen`,
 * which reach their crate another way. That 403 is classified
 * route-independently in `classifyError`.
 */
const PREPARE_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
  badRequest: {
    location: "method_ref",
    hint: `Check the address and tag — ${METHOD_REF_GRAMMAR}. The tag must be a git tag on the repository (branches do not pin), and the ref must be resolvable by an anonymous clone.`,
  },
  preparation: PREPARE_SIGNATURE_TEXTURE,
  missingDescriptor: PREPARE_MISSING_DESCRIPTOR_TEXTURE,
  closure: { location: "method_ref", hint: PREPARE_CLOSURE_HINT },
  notFound: {
    location: "method_ref",
    hint: "The repository was fetched but holds no package matching this address by manifest identity. Check the package selector against the repository's METHODS.toml manifests.",
  },
  notImplemented: {
    location: "method_ref",
    hint: `Only address-form refs are supported (${METHOD_REF_GRAMMAR}); registry references are reserved until a method registry exists.`,
  },
  asset: PREPARE_ASSET_TEXTURE,
};

/**
 * Classify options for an id-shaped request. The hosted platform resolves the
 * id and injects the stored source before the runner sees the request, so the
 * failures are `mthds_validate`'s: an unknown or foreign-org id is a 404
 * (indistinguishable by design), and a stored method with no MTHDS source is a
 * 422 — which is where a source-less method now surfaces, the fail-fast
 * `EmptyMethodSourceError` having gone out with the client-side expansion.
 */
const PREPARE_BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
  badRequest: {
    location: "method_id",
    hint: "The stored method may have no MTHDS source yet, or this deployment may not resolve method_id on /v1/validate — the selector is hosted-only (a bare pipelex-api runner has no catalog).",
  },
  preparation: PREPARE_SIGNATURE_TEXTURE,
  missingDescriptor: PREPARE_MISSING_DESCRIPTOR_TEXTURE,
  closure: { location: "method_id", hint: PREPARE_CLOSURE_HINT },
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. Check the id as the catalog returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss.",
  },
  asset: PREPARE_ASSET_TEXTURE,
};

/**
 * The console (pass-through only) found a file-bearing input that would require
 * an upload. Not an SDK error and deliberately not an `InputPreparationError`,
 * so `classifyError` never grabs it — the capability catches it explicitly to
 * compose the bespoke refusal that names the workshop and the alternatives.
 */
class UploadNotAllowedError extends Error {
  public readonly inputName: string;
  public readonly kind: string;

  constructor(inputName: string, kind: string, sentence?: string) {
    super(sentence ?? `Input "${inputName}" is ${kind}, which this hosted console cannot upload.`);
    this.name = "UploadNotAllowedError";
    this.inputName = inputName;
    this.kind = kind;
  }
}

// Constructed inside each caught block (mirroring inputs.ts / run.ts): the SDK
// constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
export function prepareClient(context: PrepareContext): PrepareClient {
  return (
    context.client ??
    // Size-guarded: the workshop's upload walk (delegated to the SDK's
    // prepareInputs) would otherwise learn an asset is too big only from the
    // gateway's 413, after the whole payload had crossed the wire — and with a
    // server message that cannot name the real limit. See upload-ceiling.ts.
    new SizeGuardedPipelexApiClient({
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    })
  );
}

export async function prepareMthdsInputs(
  input: MthdsPrepareInputsInput,
  context: PrepareContext = buildPrepareContext(),
): Promise<PrepareResult> {
  const resolution = await resolveSubmittedFiles(input.files ?? [], context.resolver);
  if (resolution.errors.length > 0) {
    return errorResult("Inputs were not prepared: request input is invalid.", resolution.errors);
  }

  const request: ResolvedPrepareRequest = { ...input, files: resolution.files };
  const inputErrors = validatePrepareInputsRequest(request);
  if (inputErrors.length > 0) {
    return errorResult("Inputs were not prepared: request input is invalid.", inputErrors);
  }

  // Classify options follow the request's selector shape, exactly as
  // mthds_validate and mthds_codegen do — each failure locates at the field
  // that caused it.
  const classifyOptions =
    request.files.length > 0
      ? PREPARE_ERROR_OPTIONS
      : request.method_ref !== undefined
        ? PREPARE_BY_REF_ERROR_OPTIONS
        : PREPARE_BY_ID_ERROR_OPTIONS;

  let prepared: PreparedInputs;
  try {
    // Built inside the try for the same reason the client is: the selector
    // narrowing throws on its own unreachable arm, and that must classify as a
    // ToolError rather than reject the MCP handler.
    const envelope: PrepareEnvelope = {
      selector: prepareSelectorOf(request),
      ...(request.pipe_ref === undefined ? {} : { pipe_ref: request.pipe_ref }),
      inputs: request.inputs,
    };
    prepared =
      context.allowUpload === true
        ? await prepareWithUpload(prepareClient(context), envelope)
        : await preparePassThrough(prepareClient(context), envelope);
  } catch (err) {
    // The console's own pass-through refusal is not an SDK error — surface it as
    // the instructive input_domain@inputs no-verdict, ahead of classifyError.
    if (err instanceof UploadNotAllowedError) {
      const error = uploadRefusedError(err);
      return errorResult(summaryForError(error), [error]);
    }
    const error = classifyError(err, { ...classifyOptions, auth: context.authError });
    return errorResult(summaryForError(error), [error]);
  }

  return prepareInputsResult(prepared, request.pipe_ref);
}

/**
 * The method selector as the SDK spells it — one of the three, already proved
 * to be exactly one by {@link validatePrepareInputsRequest}. Both arms take it
 * as-is: nothing here resolves an address or an id, the route does.
 */
type PrepareSelector = { files: MthdsFileItem[] } | { method_ref: string } | { method_id: string };

function prepareSelectorOf(request: ResolvedPrepareRequest): PrepareSelector {
  if (request.files.length > 0) {
    return { files: toMthdsFileItems(request.files) };
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
  // broke, and this lands in the capability's own catch as a classified
  // no-verdict instead.
  throw new InputPreparationError(
    "Cannot prepare inputs: no method selector. Supply exactly one of files, method_ref or method_id.",
  );
}

/** The resolved selector + pipe + filled inputs the prepare step consumes. */
interface PrepareEnvelope {
  selector: PrepareSelector;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

/**
 * Workshop path: hand the whole request to the SDK's `prepareInputs`, selector
 * included. Since `@pipelex/sdk` 0.17.0 that call takes `files`, `method_ref`
 * or `method_id` and resolves each through one `POST /v1/validate` with
 * `views: ["input_form"]` — which is why this repo no longer expands a stored
 * method into files before calling it.
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
  };
  if ("files" in envelope.selector) {
    return client.prepareInputs({ ...base, files: envelope.selector.files });
  }
  if ("method_ref" in envelope.selector) {
    return client.prepareInputs({ ...base, method_ref: envelope.selector.method_ref });
  }
  return client.prepareInputs({ ...base, method_id: envelope.selector.method_id });
}

const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Console path (pass-through only): resolve the pipe's declared signature from
 * the input-form descriptor, then walk the caller's inputs against it —
 * exactly the SDK's `prepareInputs` walk minus the upload. Only http(s) URLs
 * and existing `pipelex-storage://` URIs pass through; any upload-needing value
 * (a `data:` URL, inline bytes, a local path) is refused up front. This never
 * calls `uploadFile` / `readLocalPath`, so a bare-path value never triggers a
 * server-side filesystem read on the public console.
 *
 * **Why a mirror rather than a call.** The filesystem read the console must not
 * perform happens *inside* the SDK's walk, before the upload the console could
 * have refused at the client seam, and no value-shape pre-screen can find it
 * without the descriptor — a bare string is a local path at a file position and
 * an ordinary text value everywhere else. So the console reads the same
 * descriptor, picks the pipe by the same order, and walks the same kinds; only
 * the leaf differs. Keep the two in step when `@pipelex/sdk`'s
 * `prepare-inputs.ts` changes: the invariant that matters is that one tool name
 * never prepares two different pipes depending on the shell.
 */
async function preparePassThrough(
  client: PrepareClient,
  envelope: PrepareEnvelope,
): Promise<PreparedInputs> {
  const report = await fetchSignature(client, envelope.selector);

  const inputForm = report.input_form;
  // Tested for a usable RECORD, not merely for `undefined`: the report is
  // extension-open transport that nothing validates at runtime, so a runner or
  // an intermediary that materialises the absent slot as `null` used to slip
  // this guard and die on `Object.keys(null)` two frames down — surfacing as a
  // generic retryable `runtime` fault, which is the one reading this refusal
  // exists to prevent.
  if (!isInputFormRecord(inputForm)) {
    // Never a silent degrade to "no uploads needed": with no descriptor there
    // is no signature to prepare against, and every value would pass through
    // unchecked — which on this arm means a refusal that never fires.
    throw new MissingInputFormError(
      "Cannot prepare inputs: the validate report carries no `input_form` descriptor — the signature " +
        'preparation reads. The descriptor rides `views: ["input_form"]` on pipelex-api >= 0.18.0.',
    );
  }

  const pipeRef = selectPipeRef(report, inputForm, nonEmptyString(envelope.pipe_ref));
  const fields = topLevelFieldsOf(inputForm[pipeRef]);
  if (fields === undefined) {
    // Same refusal, same reason: a descriptor entry with no readable field list
    // leaves nothing to walk, so every value would pass through unchecked.
    throw new MissingInputFormError(
      "Cannot prepare inputs: the validate report's `input_form` descriptor carries no readable " +
        `field list for "${pipeRef}".`,
    );
  }
  const declared = new Map(fields.map((field) => [field.name, field] as const));

  const rewritten: Record<string, unknown> = { ...envelope.inputs };
  for (const [name, callerValue] of Object.entries(envelope.inputs)) {
    const field = declared.get(name);
    if (field === undefined) {
      continue; // Not a declared input — pass through untouched, as the SDK does.
    }
    if (isExplicitEnvelope(callerValue)) {
      // The caller filled the explicit `{ concept, content }` template: walk the inner
      // content against the same node, then re-wrap so the concept annotation rides
      // through to the run (the runtime accepts the envelope). SDK parity.
      rewritten[name] = {
        ...callerValue,
        content: resolveNodePassThrough(field, callerValue.content, name),
      };
      continue;
    }
    rewritten[name] = resolveNodePassThrough(field, callerValue, name);
  }

  return { inputs: rewritten, uploads: [] };
}

/**
 * Ask `validate` for the signature, whatever the selector — SDK parity with
 * `fetchSignature` in `@pipelex/sdk`'s `prepare-inputs.ts`, including
 * `allowSignatures: true`: preparation needs a pipe's DECLARED inputs, and a
 * bundle mid-authoring with an unresolved signature elsewhere must not be
 * refused inputs for a pipe whose inputs are declared. The `is_valid: false`
 * arm still means the closure does not load, which IS a preparation failure.
 */
async function fetchSignature(
  client: PrepareClient,
  selector: PrepareSelector,
): Promise<PipelexValidationReport> {
  let result: PipelexValidationResult;
  if ("files" in selector) {
    const contents = selector.files.map((file) => file.content);
    // `validateFiles`' rule, applied by hand because this goes through the raw
    // `validate`: label every content once any file names a source, so the
    // server never sees a length-mismatched `mthds_sources` array.
    const hasAnySource = selector.files.some((file) => file.source !== undefined);
    const sources = hasAnySource
      ? selector.files.map((file, index) => file.source ?? `inline://file-${index + 1}.mthds`)
      : undefined;
    result = await client.validate(contents, true, sources, undefined, ["input_form"]);
  } else {
    result = await client.validate(selector, true, undefined, undefined, ["input_form"]);
  }

  if (!result.is_valid) {
    const first = result.validation_errors[0]?.message ?? result.message;
    // Its own type, so `classifyError` can locate it at whatever named the
    // method. As the shared preparation error it reported the caller's
    // `pipe_ref` — a field they had usually left empty — for a published
    // package they cannot repair.
    throw new UnresolvableClosureError(
      `Cannot prepare inputs: the method signature did not resolve — ${first}`,
    );
  }
  return result;
}

/**
 * Pick the pipe whose descriptor guides the walk, in the SDK's documented
 * order: an explicit qualified `pipe_ref`, then the report's resolved default
 * — read on the field's PRESENCE, never on its truthiness — and, behind an
 * ABSENT field only, the bundle's declared `main_pipe` then the single pipe.
 *
 * The divergence this function used to carry is gone: it followed the SDK
 * through a **stated** `default_pipe_ref: null` into the blueprint, against
 * `validate.ts`'s stricter reading, on the grounds that the two shells must
 * land on the same pipe and that the stance was `@pipelex/sdk`'s to settle.
 * `@pipelex/sdk` 0.19.0 settled it the other way, so this mirror follows it
 * there: a stated `null` is the server's answer — no entry pipe was determined,
 * and the run route refuses such a run — so falling through would prepare a
 * pipe the run will not execute. Only a field the report does not carry at all
 * (a runner predating it) leaves the two fallbacks standing. A JSON body cannot
 * carry an own property holding `undefined`, so strict `=== undefined` is the
 * whole absence test.
 *
 * Keep this in step with `selectPipeRef` in the SDK's `prepare-inputs.ts`: one
 * tool name preparing two different pipes depending on the shell is the one
 * outcome this tool cannot have.
 */
function selectPipeRef(
  report: PipelexValidationReport,
  inputForm: InputForm,
  requested: string | undefined,
): string {
  const refs = Object.keys(inputForm);
  const candidates = refs.length > 0 ? refs.join(", ") : "(none — the closure declares no pipes)";

  if (requested !== undefined) {
    if (!requested.includes(".")) {
      throw new InputPreparationError(
        "Cannot prepare inputs: `pipe_ref` must be qualified (`domain.pipe_code`), got the bare " +
          `"${requested}". The method declares: ${candidates}.`,
      );
    }
    if (!(requested in inputForm)) {
      throw new InputPreparationError(
        `Cannot prepare inputs: the method declares no pipe "${requested}". It declares: ${candidates}.`,
      );
    }
    return requested;
  }

  // The resolved default, when the runner serves the field at all (manifest-aware
  // for a `method_ref` package, which is why it outranks the blueprint read below).
  if (report.default_pipe_ref !== undefined) {
    const statedDefault = nonEmptyString(report.default_pipe_ref);
    if (statedDefault === undefined) {
      // A stated `null` — or anything else that is not a non-empty string — is the
      // server's verdict, not a gap: no entry pipe was determined, so a run naming
      // no pipe would not resolve one either. Neither fallback stands behind it.
      throw new InputPreparationError(
        "Cannot prepare inputs: the server determined no entry pipe for this method, so a run that " +
          "names no pipe would not resolve one (no `main_pipe` is declared, or the package manifest " +
          "names a pipe the closure does not declare or declares in several domains). Pass " +
          `\`pipe_ref\`. It declares: ${candidates}.`,
      );
    }
    if (!(statedDefault in inputForm)) {
      // The default and the descriptor come from one report keyed by one pipe set, so
      // a miss is the report contradicting itself — falling through would silently
      // prepare a different pipe than the one the run would execute.
      throw new InputPreparationError(
        `Cannot prepare inputs: the validate report names "${statedDefault}" as the default pipe, but ` +
          `its \`input_form\` descriptor does not describe it. Pass \`pipe_ref\`. It declares: ${candidates}.`,
      );
    }
    return statedDefault;
  }

  // Behind an ABSENT field only.
  const blueprintDefault = blueprintMainPipeRefOf(report.bundle_blueprint);
  if (blueprintDefault !== undefined && blueprintDefault in inputForm) {
    return blueprintDefault;
  }

  if (refs.length === 1) {
    return refs[0];
  }

  throw new InputPreparationError(
    "Cannot prepare inputs: the method declares no single default pipe, so `pipe_ref` is required. " +
      `It declares: ${candidates}.`,
  );
}

/** A trimmed non-empty string, or `undefined` — the SDK's "empty is absent" rule. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Strict plain-object test — excludes arrays, typed arrays, and other exotics (SDK parity). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * The descriptor predicates, and why they are this repo's and not the SDK's:
 * the descriptor is wire data reaching a public endpoint, and every shape the
 * declared type forbids still arrives. Unguarded, each one threw a raw
 * `TypeError` out of the walk and surfaced as a generic retryable `runtime`
 * fault — the walk's own doc comment already said a malformed node must fall to
 * the pass-through arm instead, and these are what make that true at every
 * depth rather than only at the two it happened to cover.
 */
function isInputFormRecord(value: unknown): value is InputForm {
  return isPlainObject(value);
}

function isInputFormNode(value: unknown): value is InputFormItem {
  return isPlainObject(value) && typeof value.kind === "string";
}

function isInputFormField(value: unknown): value is InputFormField {
  return isInputFormNode(value) && typeof (value as { name?: unknown }).name === "string";
}

/** The readable top-level fields of one pipe's descriptor entry, or `undefined` if there are none. */
function topLevelFieldsOf(entry: unknown): InputFormField[] | undefined {
  if (!isPlainObject(entry) || !Array.isArray(entry.fields)) {
    return undefined;
  }
  return entry.fields.filter(isInputFormField);
}

/**
 * The explicit-template envelope: a plain object whose keys are EXACTLY `concept` and
 * `content` (SDK parity, mirroring the runtime's own collision rule) — so a declared
 * structured concept that merely happens to carry both fields is not misread as one.
 */
function isExplicitEnvelope(value: unknown): value is { concept: unknown; content: unknown } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && "concept" in value && "content" in value;
}

/**
 * A canonical Image/Document content is a plain object carrying a `url` key.
 * A VALUE-shape helper only (SDK parity): it is consulted at a position the
 * descriptor has already declared a file, never as the signal that one is there
 * — which is the whole point of walking the descriptor.
 */
function isFileContent(node: unknown): node is Record<string, unknown> {
  return isPlainObject(node) && "url" in node;
}

/**
 * Descriptor-guided walk, discriminated on the node's `kind` (SDK parity with
 * `resolveNode` in `@pipelex/sdk`'s `prepare-inputs.ts`):
 *
 * - `document` / `image` — a file position, whatever the value's shape;
 * - `object` — walk the declared `fields` by name; keys the descriptor does not
 *   name are copied through untouched;
 * - `list` — walk `item` against each element;
 * - every other kind (`text`, `prose`, `date`, `number`, `boolean`, `enum`,
 *   `unknown`) — pass through at any depth. `unknown` is the standard's escape
 *   hatch for a `Dynamic` / `Composite` input and is NOT interpreted: the
 *   signature declares no file there, and classifying by value shape is the
 *   defect this walk removes.
 *
 * A caller value whose shape disagrees with the node (a scalar at an `object`, a
 * non-array at a `list`) passes through for the run to reject — preparation
 * never second-guesses the signature. The guards on the descriptor's own
 * members are this repo's, not the SDK's: the descriptor is wire data on a
 * public endpoint, and a malformed node must fall to the pass-through arm
 * rather than throw out of the walk. Note the refusal at a file position still
 * fires either way — a node that falls through carries no declared file, so
 * nothing upload-bearing escapes unrefused.
 */
function resolveNodePassThrough(node: InputFormItem, callerValue: unknown, name: string): unknown {
  switch (node.kind) {
    case "document":
    case "image":
      return resolveFilePositionPassThrough(callerValue, name);
    case "object": {
      if (!isPlainObject(callerValue) || !Array.isArray(node.fields)) {
        return callerValue;
      }
      const result: Record<string, unknown> = { ...callerValue };
      for (const field of node.fields) {
        if (isInputFormField(field) && Object.hasOwn(callerValue, field.name)) {
          result[field.name] = resolveNodePassThrough(field, callerValue[field.name], name);
        }
      }
      return result;
    }
    case "list": {
      // `isInputFormNode`, not `!== undefined`: a stated `item: null` passed the
      // old test and then had `.kind` read off it.
      const item = node.item;
      if (!Array.isArray(callerValue) || !isInputFormNode(item)) {
        return callerValue;
      }
      return callerValue.map((element) => resolveNodePassThrough(item, element, name));
    }
    default:
      return callerValue;
  }
}

/** Rewrite a file-position value to canonical `{ url }` content — but only if the source is pass-through. */
function resolveFilePositionPassThrough(callerValue: unknown, name: string): unknown {
  if (isFileContent(callerValue)) {
    return { ...callerValue, url: passThroughSource(callerValue.url, name) };
  }
  return { url: passThroughSource(callerValue, name) };
}

/** Accept an http(s) / pipelex-storage:// reference; refuse anything that would need an upload. */
function passThroughSource(source: unknown, name: string): string {
  if (typeof source === "string") {
    if (source.startsWith(PIPELEX_STORAGE_SCHEME) || HTTP_URL_RE.test(source)) {
      return source;
    }
    if (source.startsWith("data:")) {
      throw new UploadNotAllowedError(name, "a data: URL");
    }
    throw new UploadNotAllowedError(name, "a local file path");
  }
  if (isInlineBytes(source)) {
    throw new UploadNotAllowedError(name, "inline bytes");
  }
  // Anything else is not a byte payload at all, and saying it is sent the caller
  // hunting one they never sent. The SDK's own arm draws the same distinction.
  throw new UploadNotAllowedError(
    name,
    "an unsupported value",
    `Input "${name}" carries a value this hosted console cannot read as a file: expected an ` +
      `http(s) URL or a pipelex-storage:// reference, got ${describeSourceValue(source)}.`,
  );
}

/** The byte-carrying values the SDK's file arm accepts — refused here, but named accurately. */
function isInlineBytes(value: unknown): boolean {
  return (
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  );
}

/** A short description of an unusable value. Never the value itself, which is caller data. */
function describeSourceValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (isPlainObject(value)) return "an object with no `url` key";
  return `a ${typeof value}`;
}

export function validatePrepareInputsRequest(input: ResolvedPrepareRequest): ToolError[] {
  const errors = validateMethodSelectorRequest(input.files, input, { rule: "one_selector" });

  if (input.pipe_ref !== undefined && input.pipe_ref.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "pipe_ref",
      message: "pipe_ref must not be empty when supplied.",
      hint: "Pass a qualified domain.pipe_code, or omit pipe_ref to default to the closure's main_pipe.",
      retryable: false,
    });
  }

  return errors;
}

export function prepareInputsResult(
  prepared: PreparedInputs,
  pipeRef: string | undefined,
): PrepareResult {
  const uploads = prepared.uploads.map((record) => record.uri);
  return {
    structuredContent: {
      status: "ok",
      is_valid: true,
      ...(pipeRef === undefined ? {} : { pipe_ref: pipeRef }),
      inputs: prepared.inputs,
      uploads,
    },
    summary: prepareSummary(pipeRef, prepared.inputs, uploads),
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
): string {
  const parts = ["# Prepared inputs"];
  if (pipeRef !== undefined) {
    parts.push(`Resolved pipe: \`${pipeRef}\``);
  }
  parts.push(
    uploads.length === 0
      ? "No assets required uploading — all inputs pass through unchanged. Hand these inputs to `mthds_run`."
      : `Uploaded ${uploads.length} asset(s) to Pipelex storage (rewritten to \`pipelex-storage://\` references). Hand these inputs to \`mthds_run\`.`,
  );
  parts.push("```json\n" + JSON.stringify(inputs, null, 2) + "\n```");
  return parts.join("\n\n");
}

function uploadRefusedError(err: UploadNotAllowedError): ToolError {
  return {
    class: "input_domain",
    location: "inputs",
    message: err.message,
    hint: "The hosted console is pass-through only: pass an http(s) URL or an existing pipelex-storage:// reference, or use the local workshop server (npx @pipelex/mcp), which uploads local files, bytes, and data: URLs.",
    retryable: false,
  };
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "Inputs could not be prepared: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Inputs were not prepared: the request could not be prepared as submitted.",
  runtime: "Inputs could not be prepared: the Pipelex API returned an error.",
  paywall:
    "Inputs could not be prepared: the organization's Pipelex plan does not cover this call.",
};

function summaryForError(error: ToolError): string {
  return summaryForToolError(error, ERROR_SUMMARIES);
}

export function prepareInputsToolResult(result: PrepareResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
  };
}

// The MCP surface spells the provenance label `uri` (mirroring mthds_validate);
// the SDK's build envelope spells it `source` (`MthdsFileItem`). Adapt here.
function toMthdsFileItems(files: SubmittedFile[]): MthdsFileItem[] {
  return files.map((file) => {
    if (file.uri === undefined || file.uri === null) {
      return { content: file.content };
    }
    return { content: file.content, source: file.uri };
  });
}

function errorResult(summary: string, errors: ToolError[]): PrepareResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      errors,
    },
    summary,
  };
}
