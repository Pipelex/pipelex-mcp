import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { ErrorClass } from "./shared.js";
import { formatMib } from "./upload-ceiling.js";

/**
 * The artifact download boundary — the workshop's write-side counterpart of
 * its path trust boundary (`src/local/files.ts`).
 *
 * `mthds_download_artifacts` fetches a presigned URL the configured Pipelex
 * API just minted for a `pipelex-storage://` reference and streams the bytes
 * into a file under the server's working directory. The URL is the API's own
 * answer, not a host- or model-supplied value, so this is not the SSRF surface
 * the attachment fetch boundary guards against — but the same hygiene holds on
 * its own, because a download that writes to the user's disk has to be bounded
 * regardless of who named the URL: http(s) only, no redirects, no credentials
 * forwarded, a bounded timeout, and a byte cap enforced from the response
 * headers before a byte is written and again mid-stream. `http:` is accepted
 * beside `https:` deliberately — the local stack's object store hands out plain
 * http presigned URLs, and refusing them would make the tool useless exactly
 * where it is dogfooded.
 *
 * Files are NEVER overwritten: a name collision gets a numeric suffix
 * ({@link openUniqueFile}). A refused or failed download leaves no partial
 * file behind.
 *
 * Like `FileResolver` and `AttachmentFetcher`, a downloader reports failures as
 * values and never throws — the capability turns them into per-artifact
 * `ToolError`s.
 */

/**
 * The per-artifact byte cap. This is an accident guard against filling the
 * user's disk from a runaway output, not a product judgment about artifact
 * size — run outputs are produced server-side, so a user cannot shrink one the
 * way they can shrink an upload, and a low ceiling would leave them with no
 * recourse but the expiring presigned link.
 */
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/**
 * Bounded connect+read budget for one artifact. Generous on purpose: a large
 * PDF on a slow link still fits, and the signal also covers the body read, so a
 * stalled stream cannot hang the tool call.
 */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Ceiling on collision suffixes before {@link openUniqueFile} gives up. */
const MAX_UNIQUE_ATTEMPTS = 10_000;

/**
 * A refused or failed download. Carries its own class and `retryable` verdict
 * because the causes differ: a vanished object is a permanent `input_domain`
 * refusal, a network fault is a retryable `runtime` one.
 */
export interface ArtifactDownloadFailure {
  class: ErrorClass;
  message: string;
  hint: string;
  retryable: boolean;
}

export interface SavedArtifact {
  /** Absolute path of the written file. */
  path: string;
  /** Bytes written. */
  size: number;
}

export type ArtifactDownloadResult =
  | { ok: true; saved: SavedArtifact }
  | { ok: false; failure: ArtifactDownloadFailure };

/** The seam the capability consumes — injected as a fake in tests. */
export interface ArtifactDownloader {
  /**
   * Fetch `url` and write it under `dir` as `baseName` — suffixed on a name
   * collision, never overwriting. `dir` must already exist and be the
   * boundary-approved target; `baseName` must already be a sanitized bare
   * filename (the capability owns both).
   */
  download(url: string, dir: string, baseName: string): Promise<ArtifactDownloadResult>;
}

export const httpArtifactDownloader: ArtifactDownloader = {
  download: (url, dir, baseName) => downloadArtifactToFile(url, dir, baseName),
};

export interface DownloadOptions {
  /** Override of {@link MAX_ARTIFACT_BYTES} (tests drive the cap with a small value). */
  maxBytes?: number;
}

export async function downloadArtifactToFile(
  url: string,
  dir: string,
  baseName: string,
  options: DownloadOptions = {},
): Promise<ArtifactDownloadResult> {
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;

  const checked = checkUrl(url);
  if (!checked.ok) {
    return { ok: false, failure: checked.failure };
  }

  let response: Response;
  try {
    // Fetch the ALREADY-PARSED URL, never the raw string (the attachment
    // boundary's rule, kept for the same reason: one parse, one decision).
    response = await fetch(checked.url, {
      // "manual" rather than "error": undici collapses a refused redirect into
      // an opaque `TypeError: fetch failed`. A presigned object URL has no
      // reason to redirect, and refusing outright is simpler than following.
      redirect: "manual",
      cache: "no-store",
      // No headers: the presigned URL carries its own authorization in the
      // query string, and nothing of ours must ride along to the object store.
      signal: AbortSignal.timeout(ARTIFACT_DOWNLOAD_TIMEOUT_MS),
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
  // oversize is refused without writing a byte.
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    return { ok: false, failure: tooLargeFailure(declared, maxBytes) };
  }

  let target: { handle: FileHandle; path: string };
  try {
    target = await openUniqueFile(dir, baseName);
  } catch (err) {
    await discard(response);
    return { ok: false, failure: writeFailure(err) };
  }

  let written: number | "too_large";
  try {
    written = await streamBounded(response, target.handle, maxBytes);
  } catch (err) {
    await removePartial(target);
    // A disk fault is not cured by a fresh link; only a transport fault is.
    return {
      ok: false,
      failure: err instanceof ArtifactWriteError ? writeFailure(err.inner) : networkFailure(err),
    };
  }

  if (written === "too_large") {
    await removePartial(target);
    return { ok: false, failure: tooLargeFailure(undefined, maxBytes) };
  }

  try {
    await target.handle.close();
  } catch (err) {
    await removePartial(target);
    return { ok: false, failure: writeFailure(err) };
  }

  return { ok: true, saved: { path: target.path, size: written } };
}

/**
 * Create `baseName` under `dir` exclusively (`wx`), suffixing the stem
 * (`name-1.ext`, `name-2.ext`, …) until a free name is found. Exclusive
 * creation is what makes "never overwrite" true rather than merely likely: an
 * exists-check followed by a write would race a concurrent writer.
 */
export async function openUniqueFile(
  dir: string,
  baseName: string,
): Promise<{ handle: FileHandle; path: string }> {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);

  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, attempt === 0 ? baseName : `${stem}-${attempt}${ext}`);
    try {
      return { handle: await fs.open(candidate, "wx"), path: candidate };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }

  throw new Error(`Could not find a free filename for ${baseName} in ${dir}.`);
}

/** The parsed, boundary-approved URL — the object the fetch then uses verbatim. */
type UrlCheck = { ok: true; url: URL } | { ok: false; failure: ArtifactDownloadFailure };

const RESOLVE_AGAIN_HINT =
  "The download link is minted fresh on every call, so retrying this tool resolves a new one.";

function checkUrl(downloadUrl: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return refuse({
      class: "runtime",
      message: "The Pipelex API returned a download link that is not a valid absolute URL.",
      hint: "The configured deployment's storage resolved to an unusable link; inspect the API.",
      retryable: false,
    });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return refuse({
      class: "runtime",
      message: `The Pipelex API returned a download link this server does not fetch ("${url.protocol.replace(":", "")}").`,
      hint: "Only http(s) links are downloaded. A deployment backed by local-filesystem storage hands out file:// links, which cannot be fetched here.",
      retryable: false,
    });
  }

  if (url.username !== "" || url.password !== "") {
    return refuse({
      class: "runtime",
      message:
        "The Pipelex API returned a download link carrying credentials; this server does not fetch it.",
      hint: "Inspect the configured deployment's storage configuration.",
      retryable: false,
    });
  }

  return { ok: true, url };
}

function refuse(failure: ArtifactDownloadFailure): UrlCheck {
  return { ok: false, failure };
}

function checkStatus(response: Response): ArtifactDownloadFailure | undefined {
  const status = response.status;

  if (status >= 300 && status < 400) {
    return {
      class: "runtime",
      message: `The download link redirected (HTTP ${status}); this server does not follow redirects.`,
      hint: "A presigned object link should answer directly. Inspect the configured deployment's storage.",
      retryable: false,
    };
  }

  // The link is minted per call, so a 401/403 is an object-store refusal of a
  // fresh signature (clock skew, a signing misconfiguration) rather than an
  // expired link — retrying mints another and may well succeed.
  if (status === 401 || status === 403) {
    return {
      class: "runtime",
      message: `The object store refused the download link (HTTP ${status}).`,
      hint: RESOLVE_AGAIN_HINT,
      retryable: true,
    };
  }

  if (status === 404 || status === 410) {
    return {
      class: "input_domain",
      message: `The stored file is no longer available (HTTP ${status}).`,
      hint: "The object behind this storage reference is gone; re-run the method to produce it again.",
      retryable: false,
    };
  }

  if (!response.ok) {
    return {
      class: "runtime",
      message: `The object store returned HTTP ${status} for the download.`,
      hint: RESOLVE_AGAIN_HINT,
      retryable: true,
    };
  }

  return undefined;
}

function tooLargeFailure(
  declaredBytes: number | undefined,
  maxBytes: number,
): ArtifactDownloadFailure {
  const size = declaredBytes === undefined ? "" : ` It is ${formatMib(declaredBytes)}.`;
  return {
    class: "input_domain",
    message: `The stored file is over the ${formatMib(maxBytes)} limit this tool saves to disk.${size}`,
    hint: "The limit is an accident guard against filling the disk. Fetch the file another way — its presigned public_url in mthds_run_results works for about an hour.",
    retryable: false,
  };
}

function networkFailure(err: unknown): ArtifactDownloadFailure {
  const timedOut = err instanceof Error && err.name === "TimeoutError";
  return {
    class: "runtime",
    message: timedOut
      ? `Downloading the file timed out after ${ARTIFACT_DOWNLOAD_TIMEOUT_MS / 1000}s.`
      : `The file could not be downloaded: ${err instanceof Error ? err.message : String(err)}.`,
    hint: RESOLVE_AGAIN_HINT,
    retryable: true,
  };
}

function writeFailure(err: unknown): ArtifactDownloadFailure {
  return {
    class: "runtime",
    message: `The file could not be written: ${err instanceof Error ? err.message : String(err)}.`,
    hint: "Check that the target directory under the server's working directory is writable.",
    retryable: false,
  };
}

/** The write side of a streamed download: what {@link writeFully} needs of a `FileHandle`. */
export interface ChunkWriter {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
}

/**
 * A write to the target file failed. Tagged so the caller can report a disk
 * fault (not retryable, check the directory) instead of the transport fault it
 * would otherwise assume for anything thrown while streaming.
 */
class ArtifactWriteError extends Error {
  readonly inner: unknown;

  constructor(inner: unknown) {
    super(inner instanceof Error ? inner.message : String(inner));
    this.name = "ArtifactWriteError";
    this.inner = inner;
  }
}

/**
 * Write the whole chunk, looping on short writes. `FileHandle.write()` resolves
 * with the count it managed, which can fall short of the chunk on a filesystem
 * under pressure; taking one call as "written" would report a truncated
 * artifact as saved.
 */
export async function writeFully(writer: ChunkWriter, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await writer.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new Error(
        `the filesystem accepted no bytes at offset ${offset} of ${chunk.byteLength}`,
      );
    }
    offset += bytesWritten;
  }
}

/**
 * Stream the body into the open handle, abandoning it the moment the cap is
 * passed. Returning `"too_large"` rather than throwing keeps the size refusal a
 * value like every other refusal here, distinct from the faults the caller
 * catches around this: a transport fault surfaces as thrown, a disk fault as an
 * {@link ArtifactWriteError}. The handle is left open on every return path; the
 * caller closes or removes it.
 */
async function streamBounded(
  response: Response,
  handle: FileHandle,
  limit: number,
): Promise<number | "too_large"> {
  if (response.body === null) {
    return 0;
  }

  const reader = response.body.getReader();
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
    try {
      await writeFully(handle, value);
    } catch (err) {
      throw new ArtifactWriteError(err);
    }
  }

  return total;
}

/** Close and delete a file we are refusing to leave behind. Best-effort. */
async function removePartial(target: { handle: FileHandle; path: string }): Promise<void> {
  try {
    await target.handle.close();
  } catch {
    // Closing a handle we are about to unlink is best-effort.
  }
  try {
    await fs.unlink(target.path);
  } catch {
    // The partial file may already be gone; nothing to report.
  }
}

/** Release a response we are refusing, so its connection is not left dangling. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Discarding a body we already refused is best-effort; nothing to report.
  }
}
