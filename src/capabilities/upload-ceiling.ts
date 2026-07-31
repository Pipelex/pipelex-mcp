import { PipelexApiClient, RejectedAssetError } from "@pipelex/sdk";
import type { UploadInput, UploadedFile } from "@pipelex/sdk";

/**
 * The real ceiling on `POST /v1/upload`, and a client that refuses past it
 * before spending a round-trip on a request the gateway will reject.
 *
 * The route takes a base64 JSON body behind an AWS API Gateway HTTP API
 * integration, and 10 MiB is a hard AWS request quota — so the wall is the
 * gateway's, not the service's. The app-level `MAX_UPLOAD_MIB` (50 MiB) is
 * unreachable through the public gateway and must never be quoted as the
 * limit anywhere.
 */

/** AWS API Gateway's hard HTTP API request quota. */
const GATEWAY_REQUEST_LIMIT_BYTES = 10 * 1024 * 1024;

/** Room for the JSON envelope wrapping the base64 payload (filename, content type, quoting). */
const UPLOAD_ENVELOPE_ALLOWANCE_BYTES = 4096;

/**
 * The decoded-byte ceiling an upload can carry. Base64 inflates 4/3, so the
 * gateway quota divides down to just under 7.5 MiB — which is exactly where
 * the live wall was measured (2026-07-31: 7.4 MiB uploads, 7.5 MiB is a 413).
 */
export const MAX_UPLOAD_BYTES = Math.floor(
  ((GATEWAY_REQUEST_LIMIT_BYTES - UPLOAD_ENVELOPE_ALLOWANCE_BYTES) * 3) / 4,
);

/** Render a byte count as MiB for a limit message the caller can act on. */
export function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Decoded byte length of a base64 string, computed from its length rather than
 * by decoding it — the point is to refuse without doing more work.
 */
export function base64DecodedLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * A `PipelexApiClient` that refuses an oversize upload locally instead of
 * letting the gateway answer `413` after the whole payload has crossed the
 * wire. It throws the same `RejectedAssetError` the SDK maps a real 413 onto,
 * so every downstream classifier keeps working unchanged — only the message
 * improves, because it can name the actual limit where the server's cannot.
 *
 * `upload` is the only seam available here: the SDK's `prepareInputs` walk
 * calls it through `this`, so subclassing catches both the workshop's
 * delegated walk (`mthds_prepare_inputs`) and our own `uploadFile` calls
 * (`mthds_upload_attachments`) with one override.
 *
 * What this does NOT do: skip reading and base64-encoding the asset first. For
 * a local path the SDK owns that step (`readLocalPath` inside `uploadFile`),
 * so refusing before the read needs a pre-flight in `@pipelex/sdk` itself. The
 * wasted network round-trip — the expensive half — is gone either way.
 */
export class SizeGuardedPipelexApiClient extends PipelexApiClient {
  override async upload(input: UploadInput): Promise<UploadedFile> {
    const size = base64DecodedLength(input.data);
    if (size > MAX_UPLOAD_BYTES) {
      throw new RejectedAssetError(
        `"${input.filename}" is ${formatMib(size)}, over the ${formatMib(MAX_UPLOAD_BYTES)} Pipelex upload limit.`,
        input.filename,
        413,
      );
    }
    return super.upload(input);
  }
}
