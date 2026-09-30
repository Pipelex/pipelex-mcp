// How a view reads a stored file's bytes, to hand them to the host inline.
//
// A host that takes the MCP Apps download request is sent a stored file as a
// link it fetches itself, or as its bytes embedded in the request. claude.ai
// saves embedded content but not a link to an app bucket, even once the bucket
// admits a cross-origin GET (measured on the Dev console on 2026-09-28: a text
// output's Download saved, an image's failed at once, before and after the
// dev bucket's CORS rule), so the view reads the file itself, which the
// bucket's CORS and the views' `connectDomains` allow, and embeds it.
//
// This is the views' one bare `fetch`: the link is a presigned app-bucket URL,
// never the Pipelex API, so it carries no User-Agent of ours
// (`eslint.config.mjs` exempts this file).
import { isStoredFileLink } from "./file-relay.js";

/** A stored file's bytes as the host takes them: base64, and how many bytes that is. */
export interface StoredFileBytes {
  blob: string;
  byteLength: number;
}

/**
 * Reads a stored file for the host, or answers `undefined` when the view
 * cannot or should not embed it: a link to anywhere but an app bucket, a
 * refused or failed read (a bucket whose CORS does not admit it included), a
 * read that outlasts {@link STORED_FILE_READ_TIMEOUT_MS}, or a file past
 * `maxBytes`. Never throws, so a caller falls back to handing the host the
 * link.
 */
export type ReadStoredFile = (
  url: string,
  maxBytes: number,
) => Promise<StoredFileBytes | undefined>;

/**
 * How long one read may take, headers and body, before it is given up. A
 * browser's `fetch` has no timeout of its own, so a read that stalls without
 * failing would otherwise hold its caller for good: a download button spinning
 * and disabled, and a click on the file's link ignored as still in flight
 * (`storedFileOpener`). Two minutes reads the largest file one request embeds
 * at a little over 2 Mbit/s, so a slow link is not turned into a failure.
 */
export const STORED_FILE_READ_TIMEOUT_MS = 120_000;

/** {@link ReadStoredFile} over `fetchImpl`, the browser's `fetch` in the views. */
export function storedFileReader(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = STORED_FILE_READ_TIMEOUT_MS,
): ReadStoredFile {
  return async (url, maxBytes) => {
    if (!isStoredFileLink(url)) return undefined;
    try {
      // The kernel paints an image with a plain `<img>` from this same link,
      // and S3 answers that request with no CORS headers, so a response the
      // browser cached then would fail this read's CORS check. The signal
      // bounds the body's read too, since it aborts the response's stream.
      const response = await fetchImpl(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return undefined;
      const declared = Number(response.headers.get("content-length"));
      if (declared > maxBytes) {
        await response.body?.cancel();
        return undefined;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) return undefined;
      return { blob: base64Of(bytes), byteLength: bytes.byteLength };
    } catch {
      return undefined;
    }
  };
}

/** Base64 of `bytes`, in slices, since spreading a large array overflows the call stack. */
export function base64Of(bytes: Uint8Array): string {
  const SLICE = 0x8000;
  let binary = "";
  for (let start = 0; start < bytes.length; start += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(start, start + SLICE));
  }
  return btoa(binary);
}
