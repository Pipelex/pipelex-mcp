import { InputPreparationError } from "@pipelex/sdk";
import type {
  InputForm,
  InputFormField,
  InputFormItem,
  MthdsFileItem,
  PipelexValidationReport,
  PipelexValidationResult,
  PreparedInputs,
  ValidateMethodSelector,
} from "@pipelex/sdk";

import {
  METHOD_REF_GRAMMAR,
  MissingInputFormError,
  UnresolvableClosureError,
  blueprintMainPipeRefOf,
  classifyError,
} from "./shared.js";
import type { AuthErrorTexture, ClassifyErrorOptions, ToolError } from "./shared.js";
import { CONSOLE_TOOL_NAMES } from "./tool-names.js";

/**
 * The console's input preparation: the walk `pipelex_run` runs over the
 * caller's filled inputs before it starts a run.
 *
 * The console is pass-through only. A file position takes an `http(s)` URL or
 * an existing `pipelex-storage://` reference, which the walk rewrites into the
 * canonical `{ url }` content the run expects; anything that would need an
 * upload — a local path, a `data:` URL, inline bytes — is refused up front,
 * and nothing is ever read from the server's filesystem.
 *
 * **Why a mirror rather than a call.** The SDK's `prepareInputs` does exactly
 * this walk, with an upload at each leaf. But the filesystem read the console
 * must not perform happens *inside* that walk, before the upload the console
 * could have refused at the client seam, and no value-shape pre-screen can
 * find it without the descriptor — a bare string is a local path at a file
 * position and an ordinary text value everywhere else. So the console reads
 * the same descriptor, picks the pipe by the same order and walks the same
 * kinds; only the leaf differs. Keep the two in step when `@pipelex/sdk`'s
 * `prepare-inputs.ts` changes (L-260921-cea8bb): the invariant that matters is
 * that the console never prepares a different pipe from the one the SDK would.
 * The copy goes when the SDK grows a mode that never uploads and refuses before
 * reading (L-260924-44ee6c).
 *
 * The selector keeps the SDK walk's three forms although `pipelex_run` sends
 * only a reference: the walk is the SDK's, and an inline bundle is the only way
 * the live suite can reach a file-bearing input, since no published method
 * declares one.
 */

/**
 * The method selector as the SDK spells it. The route resolves an address or
 * an id; nothing here expands one client-side.
 */
export type ConsoleInputsSelector =
  | { files: MthdsFileItem[] }
  | { method_ref: string }
  | { method_id: string };

/** The selector, pipe and filled inputs the walk consumes. */
export interface ConsoleInputsRequest {
  selector: ConsoleInputsSelector;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

/**
 * The slice of `PipelexApiClient` the walk calls (test seam): one
 * `POST /v1/validate` with `views: ["input_form"]`, which is where the SDK's
 * own walk reads the signature too.
 */
export interface ConsoleInputsClient {
  validate(
    source: string[] | ValidateMethodSelector,
    allowSignatures?: boolean,
    mthdsSources?: string[],
    render?: string[],
    views?: string[],
  ): Promise<PipelexValidationResult>;
}

/** The walk's answer: the rewritten inputs, or the one classified reason it refused. */
export type ConsoleInputsOutcome =
  | { ok: true; inputs: Record<string, unknown> }
  | { ok: false; error: ToolError };

/**
 * The console found a file-bearing input that would require an upload. Not an
 * SDK error and deliberately not an `InputPreparationError`, so `classifyError`
 * never grabs it: {@link prepareConsoleInputs} catches it explicitly to compose
 * the refusal that names the console's way to store a file.
 */
export class UploadNotAllowedError extends Error {
  public readonly inputName: string;
  public readonly kind: string;

  constructor(inputName: string, kind: string, sentence?: string) {
    super(sentence ?? `Input "${inputName}" is ${kind}, which this hosted console cannot upload.`);
    this.name = "UploadNotAllowedError";
    this.inputName = inputName;
    this.kind = kind;
  }
}

/**
 * The signature texture, the same for every selector: an unqualified
 * `pipe_ref`, an unknown one and a closure with no single default pipe are all
 * refused client-side, before the run starts, and each really is a question
 * about the pipe.
 */
const SIGNATURE_TEXTURE: NonNullable<ClassifyErrorOptions["preparation"]> = {
  location: "pipe_ref",
  hint: "Pass pipe_ref as a qualified domain.pipe_code; omitting it requires the method to settle exactly one entry pipe.",
};

/** The deployment, not the request, serves the descriptor; on the console that knob is the operator's. */
const MISSING_DESCRIPTOR_TEXTURE: NonNullable<ClassifyErrorOptions["missingDescriptor"]> = {
  location: "PIPELEX_BASE_URL",
  hint: "The signature is read from this deployment's /v1/validate, which must serve the input-form descriptor (pipelex-api >= 0.18.0). No change to the request works around it.",
};

/** The closure-repair hint; the locator is per-shape, being whatever named the method. */
const CLOSURE_HINT = `The method's own bundle does not validate, so its inputs cannot be checked and it cannot run. Call ${CONSOLE_TOOL_NAMES.showMethod} on the same method for the diagnostics.`;

const BY_FILES_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
  methodLocation: "files",
  closure: { location: "files", hint: CLOSURE_HINT },
  preparation: SIGNATURE_TEXTURE,
  missingDescriptor: MISSING_DESCRIPTOR_TEXTURE,
};

const BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
  methodLocation: "method_ref",
  badRequest: {
    location: "method_ref",
    hint: `Check the address and tag — ${METHOD_REF_GRAMMAR}. The tag must be a git tag on the repository (branches do not pin), and the ref must be resolvable by an anonymous clone.`,
  },
  preparation: SIGNATURE_TEXTURE,
  missingDescriptor: MISSING_DESCRIPTOR_TEXTURE,
  closure: { location: "method_ref", hint: CLOSURE_HINT },
  notFound: {
    location: "method_ref",
    hint: "The repository was fetched but holds no package matching this address by manifest identity. Check the package selector against the repository's METHODS.toml manifests.",
  },
  notImplemented: {
    location: "method_ref",
    hint: `Only address-form refs are supported (${METHOD_REF_GRAMMAR}); registry references are reserved until a method registry exists.`,
  },
};

const BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/validate",
  methodLocation: "method_id",
  badRequest: {
    location: "method_id",
    hint: "The saved method may have no MTHDS source yet.",
  },
  preparation: SIGNATURE_TEXTURE,
  missingDescriptor: MISSING_DESCRIPTOR_TEXTURE,
  closure: { location: "method_id", hint: CLOSURE_HINT },
  notFound: {
    location: "method_id",
    hint: `No saved method with this id is visible to your organization. Check the id as ${CONSOLE_TOOL_NAMES.listMethods} returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss.`,
  },
};

/** Classify options follow the selector, so each failure locates at the field that named the method. */
export function consoleInputsErrorOptions(selector: ConsoleInputsSelector): ClassifyErrorOptions {
  if ("files" in selector) return BY_FILES_ERROR_OPTIONS;
  if ("method_ref" in selector) return BY_REF_ERROR_OPTIONS;
  return BY_ID_ERROR_OPTIONS;
}

/** The refusal of an input that would need an upload, naming the console's way to store a file. */
export function uploadRefusedError(err: UploadNotAllowedError): ToolError {
  return {
    class: "input_domain",
    location: "inputs",
    message: err.message,
    hint: `This console uploads nothing on its own: pass an http(s) URL or an existing pipelex-storage:// reference. For a file the user attached in this conversation, call ${CONSOLE_TOOL_NAMES.uploadAttachments} first and pass the pipelex-storage:// reference it returns.`,
    retryable: false,
  };
}

/**
 * Prepare the caller's inputs for a run on the console, classifying every
 * refusal. Never throws: the walk's own refusal becomes `input_domain`@`inputs`,
 * and every other failure is classified against the selector that named the
 * method.
 */
export async function prepareConsoleInputs(
  client: ConsoleInputsClient,
  request: ConsoleInputsRequest,
  auth?: AuthErrorTexture,
): Promise<ConsoleInputsOutcome> {
  try {
    const prepared = await prepareInputsPassThrough(client, request);
    return { ok: true, inputs: prepared.inputs };
  } catch (err) {
    if (err instanceof UploadNotAllowedError) {
      return { ok: false, error: uploadRefusedError(err) };
    }
    return {
      ok: false,
      error: classifyError(err, { ...consoleInputsErrorOptions(request.selector), auth }),
    };
  }
}

const PIPELEX_STORAGE_SCHEME = "pipelex-storage://";
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * The walk itself: resolve the pipe's declared signature from the input-form
 * descriptor, then walk the caller's inputs against it — exactly the SDK's
 * `prepareInputs` walk minus the upload. Only http(s) URLs and existing
 * `pipelex-storage://` URIs pass through; any upload-needing value is refused
 * up front. This never calls `uploadFile` / `readLocalPath`, so a bare-path
 * value never triggers a server-side filesystem read on the public console.
 */
export async function prepareInputsPassThrough(
  client: ConsoleInputsClient,
  request: ConsoleInputsRequest,
): Promise<PreparedInputs> {
  const report = await fetchSignature(client, request.selector);

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

  const pipeRef = selectPipeRef(report, inputForm, nonEmptyString(request.pipe_ref));
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

  const rewritten: Record<string, unknown> = { ...request.inputs };
  for (const [name, callerValue] of Object.entries(request.inputs)) {
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
  client: ConsoleInputsClient,
  selector: ConsoleInputsSelector,
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
 * A stated `default_pipe_ref: null` is the server's answer — no entry pipe was
 * determined, and the run route refuses such a run — so falling through would
 * prepare a pipe the run will not execute. Only a field the report does not
 * carry at all (a runner predating it) leaves the two fallbacks standing. A
 * JSON body cannot carry an own property holding `undefined`, so strict
 * `=== undefined` is the whole absence test.
 *
 * Keep this in step with `selectPipeRef` in the SDK's `prepare-inputs.ts`.
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
 * fault; a malformed node must fall to the pass-through arm instead, at every
 * depth.
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
 * never second-guesses the signature. A malformed node falls to the
 * pass-through arm rather than throwing out of the walk; the refusal at a file
 * position still fires either way, since a node that falls through carries no
 * declared file, so nothing upload-bearing escapes unrefused.
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
