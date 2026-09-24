import { UploadTransportError, uploadWithGrant } from "@pipelex/sdk/upload";
import type { GrantedUpload, UploadGrant } from "@pipelex/sdk/upload";

import { UPLOAD_GRANT_META_KEY, narrowUploadGrant } from "../capabilities/upload-grant-shape.js";

/**
 * The run form's upload: what `run-graph` hands `RunPanel` as `uploadFile`,
 * kept out of the component so it can be tested in Node.
 *
 * The view holds the user's file and no credential, so it asks the console for
 * an upload grant (`pipelex_request_upload`, called with the file's name, type
 * and size — never its bytes) and sends the file straight to Pipelex storage
 * with `@pipelex/sdk/upload`'s `uploadWithGrant`. Only once storage has answered
 * does it return the grant's `pipelex-storage://` reference, which the panel
 * writes into the field and which opens the run gate: a reference is never
 * handed over for an object that was not stored.
 *
 * Every failure is thrown as an {@link UploadFailure} whose message is written
 * for the person who picked the file. The panel discards a rejection silently,
 * so the view shows that message itself; the SDK's own messages never carry the
 * grant's URL, which is a bearer credential.
 */

/** What the grant tool's response carries, as `useCallTool` hands it to the view. */
export interface GrantToolResponse {
  structuredContent: {
    status: "ok" | "error";
    errors?: GrantRefusal[];
  };
  meta?: Record<string, unknown>;
}

/** The members of the console's `ToolError` the form reads. */
export interface GrantRefusal {
  class?: string;
  kind?: string;
  location?: string;
  message: string;
  hint?: string;
}

export interface GrantRequest {
  filename: string;
  content_type?: string;
  size: number;
}

export interface UploadPickedFileDeps {
  /** Calls `pipelex_request_upload`. */
  requestGrant: (request: GrantRequest) => Promise<GrantToolResponse>;
  /** Sends the file with the grant; the SDK's `uploadWithGrant` unless a test injects one. */
  send?: (grant: UploadGrant, file: Blob) => Promise<GrantedUpload>;
  /**
   * The upload cap a previous grant reported, when there was one. A file over it
   * is refused before any call; the first file of a session has no cap to check
   * against yet, and the grant route refuses an oversized one itself, before any
   * byte moves.
   */
  knownMaxBytes?: number;
}

/** What `RunPanel`'s `uploadFile` resolves to, plus the cap the grant reported. */
export interface PickedFileUpload {
  url: string;
  filename: string;
  maxBytes: number;
}

/**
 * The failed uploads the form shows, one per field, keyed by the id `RunPanel`
 * hands `uploadFile`: the field's dotted value path (`cv`, `documents.1`,
 * `applicant.photo`). One slot for the whole form let a second upload erase
 * the first field's failure while that field was still empty.
 */
export type UploadErrors = Readonly<Record<string, string>>;

/** The value the panel holds at a field id, walked the way the panel writes it. */
export function valueAtFieldId(values: unknown, fieldId: string): unknown {
  return fieldSlot(values, fieldId).value;
}

/**
 * Drops the failure of every field whose value changed between two commits of
 * the form: the user pasted a link, cleared the field or a later upload filled
 * it, so the message no longer describes the field. A failure inside a list is
 * also dropped when that list gained or lost a row, since the failed row holds
 * nothing either way: a removed row and an unchanged one read alike by value,
 * and after a shift the id names another row. The panel commits nothing when
 * an upload fails, so a failure is never cleared by its own rejection.
 * Returns `errors` itself when nothing was dropped, so React sees no change.
 */
export function clearChangedFields(
  errors: UploadErrors,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): UploadErrors {
  let kept: Record<string, string> | undefined;
  for (const fieldId of Object.keys(errors)) {
    if (sameSlot(fieldSlot(previous, fieldId), fieldSlot(next, fieldId))) continue;
    kept ??= { ...errors };
    delete kept[fieldId];
  }
  return kept ?? errors;
}

// Where a field id lands: the value there (`undefined` past a missing segment)
// and the length of every list the path crosses on the way, which is what
// tells a row that left its list from one that stayed empty.
interface FieldSlot {
  value: unknown;
  listLengths: number[];
}

function fieldSlot(values: unknown, fieldId: string): FieldSlot {
  const listLengths: number[] = [];
  let node = values;
  for (const segment of fieldId.split(".")) {
    if (node === null || typeof node !== "object") return { value: undefined, listLengths };
    if (Array.isArray(node)) listLengths.push(node.length);
    if (!Object.hasOwn(node, segment)) return { value: undefined, listLengths };
    node = (node as Record<string, unknown>)[segment];
  }
  return { value: node, listLengths };
}

function sameSlot(a: FieldSlot, b: FieldSlot): boolean {
  return sameValue(a.listLengths, b.listLengths) && sameValue(a.value, b.value);
}

/** Drops one field's failure, for a retry into that field. */
export function withoutField(errors: UploadErrors, fieldId: string): UploadErrors {
  if (!Object.hasOwn(errors, fieldId)) return errors;
  const kept = { ...errors };
  delete kept[fieldId];
  return kept;
}

// A field's value is plain JSON (a string, a number, `{ url, filename }`, a
// list of those), and a nested commit may rebuild an object it did not change,
// so identity alone would clear a failure on an unrelated edit.
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** A failed upload, with a message meant for the person who picked the file. */
export class UploadFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadFailure";
  }
}

export async function uploadPickedFile(
  file: File,
  deps: UploadPickedFileDeps,
): Promise<PickedFileUpload> {
  const { knownMaxBytes } = deps;
  if (knownMaxBytes !== undefined && file.size > knownMaxBytes) {
    throw new UploadFailure(
      `"${file.name}" is ${formatBytes(file.size)}, over the ${formatBytes(knownMaxBytes)} Pipelex storage accepts.`,
    );
  }

  let response: GrantToolResponse;
  try {
    response = await deps.requestGrant({
      filename: file.name,
      // A browser reports "" for a type it does not know; the tool reads an
      // absent type as none, which is what that means.
      ...(file.type ? { content_type: file.type } : {}),
      size: file.size,
    });
  } catch (err) {
    throw new UploadFailure(hostRefusalMessage(file.name, err));
  }

  if (response.structuredContent.status !== "ok") {
    throw new UploadFailure(
      `Could not upload "${file.name}": ${refusalText(response.structuredContent.errors?.[0])}`,
    );
  }
  const grant = narrowUploadGrant(response.meta?.[UPLOAD_GRANT_META_KEY]);
  if (grant === undefined) {
    // A host that dropped the result's `_meta` on the way to the view lands
    // here, as would a malformed grant: either way nothing can be sent.
    throw new UploadFailure(
      `Could not upload "${file.name}": the console's answer carried no usable upload grant.`,
    );
  }

  // The SDK bounds the PUT itself (a minute plus a second per 128 KiB), so a
  // stalled upload cannot leave the field busy forever. The grant's own expiry
  // would not: storage checks the signature when the request starts, not when
  // it ends.
  const send = deps.send ?? uploadWithGrant;
  let stored: GrantedUpload;
  try {
    stored = await send(grant, file);
  } catch (err) {
    // The SDK's own timeout message is written for a developer holding the
    // grant (a longer `timeoutMs`, a retry with the same grant), neither of
    // which the person at the form can do.
    if (err instanceof UploadTransportError && err.code === "timeout") {
      throw new UploadFailure(
        `The upload of "${file.name}" timed out. Try again, or pick a smaller file.`,
      );
    }
    // The SDK's refusals already name the file and say what to do.
    throw new UploadFailure(messageOf(err, `The upload of "${file.name}" failed.`));
  }

  return { url: stored.uri, filename: file.name, maxBytes: grant.max_bytes };
}

/**
 * The console's refusal as the person who picked the file should read it. The
 * message is the platform's, and for a body the route rejects (`422`) it is a
 * generic "Request body failed validation" pointing at a breakdown nobody sees
 * here; the hint is what says what to do. It is shown only where it is written
 * for that person: a refusal about the file (`input_domain`), one about the
 * sign-in (`authorization`, the console's reconnect wording, which the
 * organization-less `400` is filed under too) and a plan limit (`paywall`).
 * Every other hint is written for an operator — start pipelex-api, inspect the
 * route's logs — and stays off the form.
 */
function refusalText(refusal: GrantRefusal | undefined): string {
  if (refusal === undefined) return "the console refused it.";
  const forThePerson =
    refusal.class === "input_domain" ||
    refusal.location === "authorization" ||
    refusal.kind === "paywall";
  if (!forThePerson || !refusal.hint) return refusal.message;
  const message = /[.!?]$/.test(refusal.message) ? refusal.message : `${refusal.message}.`;
  return `${message} ${refusal.hint}`;
}

// ChatGPT's answer for a tool its stored copy of the connector's list lacks.
const STALE_TOOL_LIST = /resource not found/i;

/**
 * The call to the grant tool threw, so it failed on the way to the console,
 * never inside it: Skybridge resolves a tool's own error as a result, and the
 * console answers every refusal as `status: "error"`. Two different things
 * land here, and they need different advice.
 *
 * The measured one is a connector whose stored tool list predates the tool:
 * ChatGPT answers `MCP error -32000: MCP Resource not found` from its own copy
 * of the list, and removing and re-adding the connector fixed it on
 * 2026-09-24. That is the state of every install a release first reaches, so
 * that error leads with the re-add. Everything else — the view's own 60-second
 * request timeout (`-32001`), a bridge that never finished its handshake
 * (`Not connected`), a closed connection — is not fixed by a re-add, and
 * pushing a user through a fresh sign-in for a timeout helps nobody; those
 * lead with picking the file again. Both name the ways in that need no upload
 * and keep the host's own words last, for whoever reports it.
 */
function hostRefusalMessage(filename: string, err: unknown): string {
  const detail = messageOf(err, "");
  const staleToolList = STALE_TOOL_LIST.test(detail);
  return (
    `Could not upload "${filename}": ` +
    (staleToolList
      ? "this app could not store the file here. Remove and re-add the Pipelex connector in your chat app's settings, then pick the file again. "
      : "the call to the console did not go through. Pick the file again; if it keeps failing, remove and re-add the Pipelex connector in your chat app's settings. ") +
    "You can also paste a link to the file into this field, or on ChatGPT attach the file to your message instead." +
    (detail === "" ? "" : ` (${detail})`)
  );
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== "" ? err.message : fallback;
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${Number(mib.toFixed(1))} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}
