import { uploadWithGrant } from "@pipelex/sdk/upload";
import type { GrantedUpload, UploadGrant, UploadWithGrantOptions } from "@pipelex/sdk/upload";

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
    errors?: { message: string }[];
  };
  meta?: Record<string, unknown>;
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
  send?: (
    grant: UploadGrant,
    file: Blob,
    options: UploadWithGrantOptions,
  ) => Promise<GrantedUpload>;
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

/** A failed upload, with a message meant for the person who picked the file. */
export class UploadFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadFailure";
  }
}

/**
 * The time the PUT is given before it is abandoned: a minute to start, plus one
 * second per 128 KiB, which is a floor of about 1 Mbit/s. The SDK sets no
 * timeout of its own on `uploadWithGrant`, so without one a stalled upload
 * would leave the field busy forever. The grant's own expiry does not bound it:
 * storage checks the signature when the request starts, not when it ends.
 */
export function uploadTimeoutMs(size: number): number {
  return 60_000 + Math.ceil(size / 131_072) * 1_000;
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
    throw new UploadFailure(
      `Could not ask for an upload grant for "${file.name}": ${messageOf(err, "the console did not answer.")}`,
    );
  }

  if (response.structuredContent.status !== "ok") {
    const reason = response.structuredContent.errors?.[0]?.message ?? "the console refused it.";
    throw new UploadFailure(`Could not upload "${file.name}": ${reason}`);
  }
  const grant = narrowUploadGrant(response.meta?.[UPLOAD_GRANT_META_KEY]);
  if (grant === undefined) {
    // A host that dropped the result's `_meta` on the way to the view lands
    // here, as would a malformed grant: either way nothing can be sent.
    throw new UploadFailure(
      `Could not upload "${file.name}": the console's answer carried no usable upload grant.`,
    );
  }

  const timeoutMs = uploadTimeoutMs(file.size);
  const send = deps.send ?? uploadWithGrant;
  let stored: GrantedUpload;
  try {
    stored = await send(grant, file, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (isNamedError(err, "TimeoutError")) {
      throw new UploadFailure(
        `The upload of "${file.name}" timed out after ${Math.round(timeoutMs / 1_000)} seconds. Try again, or pick a smaller file.`,
      );
    }
    // The SDK's refusals already name the file and say what to do.
    throw new UploadFailure(messageOf(err, `The upload of "${file.name}" failed.`));
  }

  return { url: stored.uri, filename: file.name, maxBytes: grant.max_bytes };
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message !== "" ? err.message : fallback;
}

// `AbortSignal.timeout` aborts with a `DOMException` named `TimeoutError`, and
// the SDK rethrows a caller's abort reason unwrapped. A DOMException is not an
// `Error` subclass in every runtime, so the name is read directly.
function isNamedError(err: unknown, name: string): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${Number(mib.toFixed(1))} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}
