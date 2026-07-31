import type { ErrorClass } from "./shared.js";
import { formatMib } from "./upload-ceiling.js";

/**
 * The attachment fetch boundary — the hosted console's analogue of the local
 * workshop's path trust boundary (`src/local/files.ts`).
 *
 * Fetching a host-supplied URL from a public endpoint is an SSRF surface, and
 * it is the one genuinely new risk `mthds_upload_attachments` introduces. This
 * module denies by default and ships WITH the first fetch, not as a hardening
 * follow-up: https only, an OpenAI host pattern, no redirects, no credentials,
 * a bounded timeout, and a byte cap enforced from the response headers before
 * the body is read and again mid-stream.
 *
 * The classic SSRF targets — link-local metadata, loopback, RFC1918 — are
 * unreachable by construction under https-only + host allowlist + no-redirects.
 * But the `oaisdmntpr` prefix is undocumented vendor infrastructure that can
 * change without notice, so the byte cap, the timeout and the no-redirect rule
 * must hold on their own: the host check is a filter, not the defence.
 *
 * Like `FileResolver`, a fetcher reports failures as values and never throws —
 * the capability turns them into per-attachment `ToolError`s.
 */

/**
 * The per-attachment byte cap. Deliberately below `MAX_UPLOAD_BYTES`
 * (~7.5 MiB, the AWS gateway wall on `POST /v1/upload`), leaving headroom for
 * the upload's own JSON envelope. This is a transport ceiling, not a product
 * judgment about what makes a sane MTHDS input — and ChatGPT hands over files
 * far larger than this (a 19.6 MB PDF passed the host with no refusal), so an
 * oversize attachment is an ordinary case whose refusal has to be excellent.
 */
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;

/** Bounded connect+read budget. Ample: 7 MiB at the observed ~3.2 MB/s is a few seconds. */
export const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

/**
 * OpenAI's per-upload Azure Blob host. The region varies per upload — four
 * captures from one user in one afternoon came back from three different
 * regions — so a literal host list is dead. A suffix-only rule
 * (`*.blob.core.windows.net`) is equally unacceptable in the other direction:
 * any Azure customer can create a storage account under that suffix. The
 * `oaisdmntpr` prefix is the only OpenAI-specific part and is required.
 */
const OPENAI_BLOB_HOST_PATTERN = /^oaisdmntpr[a-z0-9]+\.blob\.core\.windows\.net$/;

/** The host OpenAI's own documentation names. Live traffic uses the blob pattern above. */
const OPENAI_FILES_HOST = "files.oaiusercontent.com";

const WRONG_HOST_HINT =
  "Only files the user attached in a ChatGPT conversation can be ingested — the host supplies the signed URL, it is never one to construct. On any other host, ask the user for an http(s) URL to the file and pass that to mthds_prepare_inputs instead.";

/** True for a host this boundary will fetch from. `hostname` is already lowercased by `URL`. */
export function isAllowedAttachmentHost(hostname: string): boolean {
  return hostname === OPENAI_FILES_HOST || OPENAI_BLOB_HOST_PATTERN.test(hostname);
}

/**
 * A refused or failed fetch. Carries its own class and `retryable` verdict
 * because the causes differ sharply: a disallowed host is a permanent
 * `input_domain` refusal, a read timeout is a retryable `runtime` fault.
 */
export interface AttachmentFetchFailure {
  class: ErrorClass;
  message: string;
  hint: string;
  retryable: boolean;
}

export interface FetchedAttachment {
  bytes: Uint8Array;
  /** The storage host's declared content type, when it sent one. */
  contentType?: string;
}

export type AttachmentFetchResult =
  | { ok: true; attachment: FetchedAttachment }
  | { ok: false; failure: AttachmentFetchFailure };

/** The seam the capability consumes — injected as a fake in tests. */
export interface AttachmentFetcher {
  fetch(downloadUrl: string): Promise<AttachmentFetchResult>;
}

export const httpAttachmentFetcher: AttachmentFetcher = { fetch: fetchAttachmentBytes };

export async function fetchAttachmentBytes(downloadUrl: string): Promise<AttachmentFetchResult> {
  const checked = checkUrl(downloadUrl);
  if (!checked.ok) {
    return { ok: false, failure: checked.failure };
  }

  let response: Response;
  try {
    // Fetch the ALREADY-PARSED URL, never the raw string: handing the string
    // back would parse it a second time, and a divergence between the two
    // parses is the classic way an allowlist gets walked past.
    response = await fetch(checked.url, {
      // "manual" rather than "error": undici collapses a refused redirect into
      // an opaque `TypeError: fetch failed`, indistinguishable from a network
      // fault. Surfacing the 3xx ourselves keeps the refusal precise. A signed
      // SAS URL has no reason to redirect, and refusing outright is stricter
      // and simpler than comparing hosts across a redirect chain.
      redirect: "manual",
      cache: "no-store",
      // No headers, and Node's fetch carries no cookie jar or ambient
      // identity — nothing of ours is forwarded to the storage host.
      signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, failure: networkFailure(err) };
  }

  const statusRefusal = checkStatus(response);
  if (statusRefusal !== undefined) {
    await discard(response);
    return { ok: false, failure: statusRefusal };
  }

  // Headers are in hand before any of the body has been read, so a declared
  // oversize is refused without pulling a single byte of payload.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    await discard(response);
    return { ok: false, failure: tooLargeFailure(declared) };
  }

  let bytes: Uint8Array | "too_large";
  try {
    bytes = await readBounded(response, MAX_ATTACHMENT_BYTES);
  } catch (err) {
    return { ok: false, failure: networkFailure(err) };
  }
  // A lying or absent content-length cannot get past the mid-stream cap.
  if (bytes === "too_large") {
    return { ok: false, failure: tooLargeFailure(undefined) };
  }

  return {
    ok: true,
    attachment: {
      bytes,
      ...contentTypeOf(response),
    },
  };
}

/** The parsed, boundary-approved URL — the object the fetch then uses verbatim. */
type UrlCheck = { ok: true; url: URL } | { ok: false; failure: AttachmentFetchFailure };

/** Everything decidable from the URL alone, before a packet is sent. */
function checkUrl(downloadUrl: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return refuse({
      class: "input_domain",
      message: "download_url is not a valid absolute URL.",
      hint: WRONG_HOST_HINT,
      retryable: false,
    });
  }

  if (url.protocol !== "https:") {
    return refuse({
      class: "input_domain",
      message: `download_url must be https; got "${url.protocol.replace(":", "")}".`,
      hint: WRONG_HOST_HINT,
      retryable: false,
    });
  }

  if (url.username !== "" || url.password !== "") {
    return refuse({
      class: "input_domain",
      message: "download_url must not carry credentials.",
      hint: WRONG_HOST_HINT,
      retryable: false,
    });
  }

  if (url.port !== "") {
    return refuse({
      class: "input_domain",
      message: `download_url must use the default https port; got ":${url.port}".`,
      hint: WRONG_HOST_HINT,
      retryable: false,
    });
  }

  if (!isAllowedAttachmentHost(url.hostname)) {
    return refuse({
      class: "input_domain",
      message: `This server does not fetch attachments from "${url.hostname}".`,
      hint: WRONG_HOST_HINT,
      retryable: false,
    });
  }

  return { ok: true, url };
}

function refuse(failure: AttachmentFetchFailure): UrlCheck {
  return { ok: false, failure };
}

function checkStatus(response: Response): AttachmentFetchFailure | undefined {
  const status = response.status;

  if (status >= 300 && status < 400) {
    return {
      class: "input_domain",
      message: `The attachment URL redirected (HTTP ${status}); this server does not follow redirects.`,
      hint: "Ask the user to attach the file again so the host issues a fresh direct link.",
      retryable: false,
    };
  }

  // The host's signed link lives about five minutes from the tool call, so an
  // expired one is an ordinary outcome rather than an anomaly. Retrying the
  // SAME call can never work — the recovery is a new attachment, hence a new
  // link — so this is not `retryable`; the hint carries the actual fix.
  if (status === 403) {
    return {
      class: "input_domain",
      message: "The attachment link has expired (HTTP 403).",
      hint: "The host's signed link is only valid for about five minutes. Ask the user to attach the file again, then call this tool with the fresh reference.",
      retryable: false,
    };
  }

  if (status === 404 || status === 410) {
    return {
      class: "input_domain",
      message: `The attachment is no longer available at that link (HTTP ${status}).`,
      hint: "Ask the user to attach the file again, then call this tool with the fresh reference.",
      retryable: false,
    };
  }

  if (!response.ok) {
    return {
      class: "runtime",
      message: `The storage host returned HTTP ${status} for the attachment.`,
      hint: "Retry; if it persists, ask the user to attach the file again.",
      retryable: true,
    };
  }

  return undefined;
}

function tooLargeFailure(declaredBytes: number | undefined): AttachmentFetchFailure {
  const size = declaredBytes === undefined ? "" : ` It is ${formatMib(declaredBytes)}.`;
  return {
    class: "input_domain",
    message: `The attachment is over the ${formatMib(MAX_ATTACHMENT_BYTES)} limit for files ingested this way.${size}`,
    hint: `Pipelex storage accepts uploads up to ${formatMib(MAX_ATTACHMENT_BYTES)} through this channel. Ask the user for a smaller file, or for an http(s) URL to it that can be passed to mthds_prepare_inputs instead.`,
    retryable: false,
  };
}

function networkFailure(err: unknown): AttachmentFetchFailure {
  const timedOut = err instanceof Error && err.name === "TimeoutError";
  return {
    class: "runtime",
    message: timedOut
      ? `Fetching the attachment timed out after ${ATTACHMENT_FETCH_TIMEOUT_MS / 1000}s.`
      : `The attachment could not be fetched: ${err instanceof Error ? err.message : String(err)}.`,
    hint: "Retry; if it persists, ask the user to attach the file again.",
    retryable: true,
  };
}

function contentTypeOf(response: Response): { contentType?: string } {
  const header = response.headers.get("content-type");
  if (header === null || header.trim() === "") {
    return {};
  }
  // Drop parameters (`; charset=…`) — the upload wants a bare MIME type.
  return { contentType: header.split(";")[0]!.trim() };
}

/**
 * Read the body, abandoning it the moment the cap is passed. Returning
 * `"too_large"` rather than throwing keeps the size refusal a value like every
 * other refusal here, distinct from the genuine transport faults the caller
 * catches around this.
 */
async function readBounded(response: Response, limit: number): Promise<Uint8Array | "too_large"> {
  if (response.body === null) {
    return new Uint8Array(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Release a response we are refusing, so its connection is not left dangling. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Discarding a body we already refused is best-effort; nothing to report.
  }
}
