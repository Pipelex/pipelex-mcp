/**
 * Live e2e — `pipelex_request_upload` against a real Pipelex API.
 *
 * Write-free: a grant is a signed promise to accept one object, and nothing is
 * stored until someone sends the file with it, which this suite never does. The
 * send itself is `@pipelex/sdk`'s and is proven live in that repo, in Node and in
 * a browser; what can only be proven here is that the route still answers the
 * way this capability projects it, and that the host a grant names is one the
 * `run-graph` view's CSP lets a page connect to. That last check is the one a
 * unit test cannot make: the platform picked the global S3 host rather than the
 * regional one the runtime uses, and nothing but a live grant says so.
 */

import { describe, expect, it } from "vitest";

import { UPLOAD_CONNECT_DOMAINS } from "./app-buckets.js";
import { liveApiConfig } from "@pipelex/mcp-core/capabilities/e2e-support.js";
import { requestPipelexUpload } from "@pipelex/mcp-core/capabilities/upload-grant.js";

const context = liveApiConfig();

describe("pipelex_request_upload (live)", () => {
  it("mints a grant for a small file, on a host the run form may connect to", async () => {
    const result = await requestPipelexUpload(
      { filename: "pipelex-mcp-e2e.pdf", content_type: "application/pdf", size: 125 },
      context,
    );

    expect(result.structuredContent.errors, result.summary).toBeUndefined();
    expect(result.structuredContent.status).toBe("ok");
    const grant = result.grant;
    expect(grant).toBeDefined();
    expect(result.structuredContent.uri).toBe(grant?.uri);
    expect(grant?.uri.startsWith("pipelex-storage://")).toBe(true);
    expect(grant?.max_bytes).toBeGreaterThan(125);
    expect(Date.parse(grant?.expires_at ?? "")).toBeGreaterThan(Date.now());
    // Create-only: the grant can write its object once and never overwrite one.
    expect(grant?.headers["If-None-Match"]).toBe("*");
    // A local stack's object store is plain http and named by no CSP here; the
    // allowlist is for the hosted buckets.
    const origin = new URL(grant?.url ?? "").origin;
    if (!origin.startsWith("http://")) {
      expect(UPLOAD_CONNECT_DOMAINS).toContain(origin);
    }
  });

  it("refuses a declared size over the cap before any byte moves", async () => {
    const first = await requestPipelexUpload({ filename: "small.pdf", size: 1 }, context);
    const cap = first.structuredContent.max_bytes;
    expect(cap, first.summary).toBeGreaterThan(0);

    const result = await requestPipelexUpload(
      { filename: "too-large.pdf", size: (cap ?? 0) + 1 },
      context,
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "size",
      retryable: false,
    });
    expect(result.grant).toBeUndefined();
  });
});
