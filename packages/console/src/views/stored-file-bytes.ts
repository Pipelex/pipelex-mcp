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

/**
 * The largest stored file a view reads to embed, since the bytes travel base64
 * in one message to the host. A larger file goes to the host as a link.
 */
export const INLINE_SAVE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Reads a stored file for the host: its bytes, base64, or `undefined` when the
 * view cannot or should not embed it: a link to anywhere but an app bucket, a
 * refused or failed read, or a file past {@link INLINE_SAVE_MAX_BYTES}. Never
 * throws, so a caller falls back to handing the host the link.
 */
export type ReadStoredFile = (url: string) => Promise<string | undefined>;

/** {@link ReadStoredFile} over `fetchImpl`, the browser's `fetch` in the views. */
export function storedFileReader(fetchImpl: typeof fetch = fetch): ReadStoredFile {
  return async (url) => {
    if (!isStoredFileLink(url)) return undefined;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) return undefined;
      const declared = Number(response.headers.get("content-length"));
      if (declared > INLINE_SAVE_MAX_BYTES) {
        await response.body?.cancel();
        return undefined;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > INLINE_SAVE_MAX_BYTES ? undefined : base64Of(bytes);
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
