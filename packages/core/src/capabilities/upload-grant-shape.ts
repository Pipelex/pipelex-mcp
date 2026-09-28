import type { UploadGrant } from "@pipelex/sdk/upload";

/**
 * The upload grant's shape check, shared by the two sides that handle one: the
 * `pipelex_request_upload` capability, before it relays a grant, and the
 * `run-graph` view, before it sends a user's file with one.
 *
 * It lives apart from `./upload-grant.ts` because the view bundles it for the
 * browser, and that module reaches `@pipelex/sdk`'s main entry, zod and
 * `./shared.ts`, which a page has no use for. This one imports a type and
 * nothing else, so keep it that way.
 */

/** The `_meta` key a grant rides on, from the capability to the view. */
export const UPLOAD_GRANT_META_KEY = "upload_grant";

/**
 * Narrow a value to the {@link UploadGrant} a file can be sent with, or
 * `undefined` when any member is missing or mistyped. The `uri` must be a
 * storage reference, because the form writes it into the input as its value;
 * the `url` must be `https:` or `http:`, the only schemes a browser `PUT`
 * reaches (plain `http:` being the local compose stack's object store). The
 * SDK's `uploadWithGrant` refuses a URL it cannot send to as well, so this is
 * about never relaying or using a malformed grant, not about the send.
 */
export function narrowUploadGrant(value: unknown): UploadGrant | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { uri, url, headers, expires_at: expiresAt, max_bytes: maxBytes } = record;
  if (typeof uri !== "string" || !uri.startsWith("pipelex-storage://")) return undefined;
  if (typeof url !== "string" || !isHttpUrl(url)) return undefined;
  if (typeof expiresAt !== "string" || expiresAt === "") return undefined;
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes < 0) return undefined;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return undefined;
  const signedHeaders: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") return undefined;
    signedHeaders[name] = headerValue;
  }
  return { uri, url, headers: signedHeaders, expires_at: expiresAt, max_bytes: maxBytes };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
