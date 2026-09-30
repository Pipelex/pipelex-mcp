import { InputPreparationError } from "@pipelex/sdk";
import type {
  InputForm,
  InputFormField,
  InputFormItem,
  MthdsFileItem,
  PipeIORequest,
  PipeIOResponse,
  PipeIOValidReport,
  PreparedInputs,
} from "@pipelex/sdk";

import {
  METHOD_REF_GRAMMAR,
  MissingInputFormError,
  UnresolvableClosureError,
  classifyError,
  isPipeSelectionRefusal,
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
 * the same descriptor from the same `POST /v1/pipe-io` call, lets the route
 * pick the pipe as the SDK does, and walks the same kinds; only the leaf
 * differs. Keep the two in step when `@pipelex/sdk`'s `prepare-inputs.ts`
 * changes (L-260921-cea8bb): the invariant that matters is that the console
 * never prepares a different pipe from the one the SDK would. The copy goes
 * when the SDK grows a mode that never uploads and refuses before reading
 * (L-260924-44ee6c).
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
 * `POST /v1/pipe-io`, which is where the SDK's own walk reads the signature
 * too. It runs no dry run, so preparing a run's inputs costs one load of the
 * method rather than a validation.
 */
export interface ConsoleInputsClient {
  pipeIo(request: PipeIORequest): Promise<PipeIOResponse>;
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
 * `pipe_ref`, an unknown one and a method with no single entry pipe are all
 * refused before the run starts — the first here, the other two by the route's
 * typed selection refusal — and each really is a question about the pipe.
 */
const SIGNATURE_TEXTURE: NonNullable<ClassifyErrorOptions["preparation"]> = {
  location: "pipe_ref",
  // The route's refusal of an unknown pipe names no candidates, so the hint
  // says where the declared pipes are listed.
  hint: `Pass pipe_ref as a qualified domain.pipe_code the method declares; ${CONSOLE_TOOL_NAMES.showMethod} lists them. Omitting it requires the method to settle exactly one entry pipe.`,
};

/** The deployment, not the request, serves the descriptor; on the console that knob is the operator's. */
const MISSING_DESCRIPTOR_TEXTURE: NonNullable<ClassifyErrorOptions["missingDescriptor"]> = {
  location: "PIPELEX_BASE_URL",
  hint: "The signature is read from this deployment's /v1/pipe-io, which must serve the input-form descriptor (pipelex-api >= 0.33.1). No change to the request works around it.",
};

/** The route the walk reads, named by the classification of a 404 that has no texture of its own. */
const SIGNATURE_ROUTE = "/v1/pipe-io";

/** The closure-repair hint; the locator is per-shape, being whatever named the method. */
const CLOSURE_HINT = `The method's own bundle does not validate, so its inputs cannot be checked and it cannot run. Call ${CONSOLE_TOOL_NAMES.showMethod} on the same method for the diagnostics.`;

const BY_FILES_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: SIGNATURE_ROUTE,
  methodLocation: "files",
  closure: { location: "files", hint: CLOSURE_HINT },
  preparation: SIGNATURE_TEXTURE,
  missingDescriptor: MISSING_DESCRIPTOR_TEXTURE,
};

const BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: SIGNATURE_ROUTE,
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
  route: SIGNATURE_ROUTE,
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
  const pipeRef = normalizePipeRef(request.pipe_ref);
  const report = await fetchSignature(client, request.selector, pipeRef);

  const inputForm: unknown = report.input_form;
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
      "Cannot prepare inputs: the pipe I/O answer carries no `input_form` descriptor — the signature " +
        "preparation reads. The route serves it on pipelex-api >= 0.33.1.",
    );
  }

  const selected = selectedPipeRef(report, inputForm);
  const fields = topLevelFieldsOf(inputForm[selected]);
  if (fields === undefined) {
    // Same refusal, same reason: a descriptor entry with no readable field list
    // leaves nothing to walk, so every value would pass through unchecked.
    throw new MissingInputFormError(
      "Cannot prepare inputs: the pipe I/O answer's `input_form` descriptor carries no readable " +
        `field list for "${selected}".`,
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
 * Normalize the caller's `pipe_ref` and refuse, before any request, the two
 * spellings preparation cannot honour — SDK parity with `normalizePipeRef` in
 * `@pipelex/sdk`'s `prepare-inputs.ts`. Empty is absent, so the route's
 * selection chain decides.
 *
 * - A **bare** `pipe_code` is refused because a request names a pipe by its
 *   qualified ref, and the route still resolves a bare code across domains.
 *   `pipelex_run` refuses one before it gets here; this is the walk's own
 *   guard.
 * - An **`alias->domain.pipe_code`** ref names a dependency package's pipe,
 *   and preparation covers the method's own pipes: the route does not load an
 *   address-based dependency at all.
 */
function normalizePipeRef(raw: unknown): string | undefined {
  const pipeRef = nonEmptyString(raw);
  if (pipeRef === undefined) return undefined;
  if (pipeRef.includes("->")) {
    throw new InputPreparationError(
      `Cannot prepare inputs: \`pipe_ref\` "${pipeRef}" names a dependency package's pipe. ` +
        "Preparation covers the method's own pipes: name one as `domain.pipe_code`.",
    );
  }
  if (!pipeRef.includes(".")) {
    throw new InputPreparationError(
      `Cannot prepare inputs: \`pipe_ref\` must be qualified (\`domain.pipe_code\`), got the bare ` +
        `"${pipeRef}".`,
    );
  }
  return pipeRef;
}

/**
 * Ask `POST /v1/pipe-io` for the pipe and its signature, whatever the selector
 * — SDK parity with `fetchSignature` in `@pipelex/sdk`'s `prepare-inputs.ts`.
 *
 * The route selects the pipe: the caller's qualified `pipe_ref`, else the
 * method's own entry pipe (a package manifest's `main_pipe`, else the
 * closure's single declaration), which is the pipe a run naming none
 * executes. It runs no dry run and does not refuse a method with pending
 * signatures elsewhere: preparation needs a pipe's DECLARED inputs, and
 * whether the method runs is the run's verdict.
 *
 * A selection the route refuses — an unknown `pipe_ref`, no entry pipe,
 * several — is a typed `422` and becomes the walk's own
 * `InputPreparationError`, located at `pipe_ref`. The `is_valid: false` arm
 * means the closure does not load, which is a question about the method, not
 * the pipe. Every other failure is re-thrown for `classifyError`.
 */
async function fetchSignature(
  client: ConsoleInputsClient,
  selector: ConsoleInputsSelector,
  pipeRef: string | undefined,
): Promise<PipeIOValidReport> {
  const request: PipeIORequest =
    pipeRef === undefined ? { ...selector } : { ...selector, pipe_ref: pipeRef };
  let result: PipeIOResponse;
  try {
    result = await client.pipeIo(request);
  } catch (error) {
    if (isPipeSelectionRefusal(error)) {
      const detail = error.serverMessage ?? error.message;
      throw new InputPreparationError(`Cannot prepare inputs: ${detail}`, { cause: error });
    }
    throw error;
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
 * The pipe the route selected, which the descriptor must describe. A
 * single-pipe answer is keyed by exactly the `pipe_ref` it resolved, so a
 * missing ref or a missing key is the answer contradicting itself, and walking
 * any other pipe would prepare a signature the run does not take — SDK parity
 * with `selectedDescriptor`.
 */
function selectedPipeRef(report: PipeIOValidReport, inputForm: InputForm): string {
  const pipeRef = nonEmptyString(report.pipe_ref);
  if (pipeRef === undefined || !Object.hasOwn(inputForm, pipeRef)) {
    const described = Object.keys(inputForm).join(", ") || "none";
    throw new InputPreparationError(
      `Cannot prepare inputs: the pipe I/O answer selected ${pipeRef === undefined ? "no pipe" : `"${pipeRef}"`}, ` +
        `but its \`input_form\` does not describe it (it describes: ${described}).`,
    );
  }
  return pipeRef;
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
