import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type { UploadGrant, UploadGrantInput } from "@pipelex/sdk";
import { describe, expect, it } from "vitest";

import { DEFAULT_API_URL } from "./shared.js";
import {
  requestPipelexUpload,
  requestUploadToolResult,
  validateUploadGrantRequest,
} from "./upload-grant.js";
import type { UploadGrantClient, UploadGrantContext } from "./upload-grant.js";
import { UPLOAD_GRANT_META_KEY, narrowUploadGrant } from "./upload-grant-shape.js";

const GRANT: UploadGrant = {
  uri: "pipelex-storage://org_1/assets/0f1e2d3c.pdf",
  url: "https://pipelex-app-dev.s3.amazonaws.com/org_1/assets/0f1e2d3c.pdf?X-Amz-Signature=deadbeef",
  headers: {
    "If-None-Match": "*",
    "Content-Type": "application/pdf",
    "x-amz-meta-uploaded-by": "user_1",
  },
  expires_at: "2026-09-23T15:00:00Z",
  max_bytes: 52_428_800,
};

/** A fake that records what it was asked for and answers with `answer`. */
function fakeClient(answer: () => Promise<unknown>): UploadGrantClient & {
  calls: UploadGrantInput[];
} {
  const calls: UploadGrantInput[] = [];
  return {
    calls,
    async requestUploadGrant(input) {
      calls.push(input);
      return (await answer()) as UploadGrant;
    },
  };
}

function context(client: UploadGrantClient): UploadGrantContext {
  return { baseUrl: DEFAULT_API_URL, apiKey: "plx_sk_test", client };
}

function apiError(status: number, message: string): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/upload/grant`,
    status,
    message,
    "{}",
    status === 402 ? "subscription_required" : "request_error",
    message,
    undefined,
    status === 413 ? "payload_too_large" : undefined,
  );
}

describe("requestPipelexUpload", () => {
  it("asks for a grant with the file's name, type and size, and returns it", async () => {
    const client = fakeClient(async () => GRANT);

    const result = await requestPipelexUpload(
      { filename: "report.pdf", content_type: "application/pdf", size: 125 },
      context(client),
    );

    expect(client.calls).toEqual([
      { filename: "report.pdf", content_type: "application/pdf", size: 125 },
    ]);
    expect(result.structuredContent).toEqual({
      status: "ok",
      uri: GRANT.uri,
      expires_at: GRANT.expires_at,
      max_bytes: GRANT.max_bytes,
    });
    expect(result.grant).toEqual(GRANT);
  });

  it("omits a type the browser reported as empty", async () => {
    const client = fakeClient(async () => GRANT);

    await requestPipelexUpload(
      { filename: "blob.bin", content_type: " ", size: 3 },
      context(client),
    );

    expect(client.calls).toEqual([{ filename: "blob.bin", size: 3 }]);
  });

  it("refuses a blank filename without calling the API", async () => {
    const client = fakeClient(async () => GRANT);

    const result = await requestPipelexUpload({ filename: "  ", size: 3 }, context(client));

    expect(client.calls).toEqual([]);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "filename",
    });
    expect(result.grant).toBeUndefined();
  });

  it("refuses to relay a grant that arrived malformed", async () => {
    const client = fakeClient(async () => ({ ...GRANT, url: "javascript:alert(1)" }));

    const result = await requestPipelexUpload({ filename: "a.pdf", size: 1 }, context(client));

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "runtime",
      retryable: false,
    });
    expect(result.grant).toBeUndefined();
  });

  it("reports an oversized declaration at size, with the server's own limit", async () => {
    const client = fakeClient(async () => {
      throw apiError(413, "Declared file size exceeds the 50 MiB limit.");
    });

    const result = await requestPipelexUpload(
      { filename: "huge.pdf", size: 60_000_000 },
      context(client),
    );

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "size",
      message: "Declared file size exceeds the 50 MiB limit.",
      retryable: false,
    });
    expect(result.summary).toBe("No upload grant: the file's description was refused.");
  });

  it("reports a missing organization as a credential problem, not the file's", async () => {
    const client = fakeClient(async () => {
      throw apiError(400, "Organization context required.");
    });

    const result = await requestPipelexUpload(
      { filename: "a.pdf", size: 1 },
      {
        ...context(client),
        authError: { location: "authorization", hint: "Reconnect the connector." },
      },
    );

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      location: "authorization",
    });
  });

  it("reports a body the route refused as the file's, with no locator it cannot know", async () => {
    const client = fakeClient(async () => {
      throw apiError(422, "filename: String should have at most 512 characters");
    });

    const result = await requestPipelexUpload({ filename: "a.pdf", size: 1 }, context(client));
    const [error] = result.structuredContent.errors ?? [];

    expect(error).toMatchObject({ class: "input_domain", retryable: false });
    expect(error).not.toHaveProperty("location");
  });

  it("uses the deployment's auth wording for a rejected credential", async () => {
    const client = fakeClient(async () => {
      throw apiError(401, "Unauthorized");
    });

    const result = await requestPipelexUpload(
      { filename: "a.pdf", size: 1 },
      {
        ...context(client),
        authError: { location: "authorization", hint: "Reconnect the connector." },
      },
    );

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      location: "authorization",
      hint: "Reconnect the connector.",
    });
  });

  it("gives a plan limit its own headline", async () => {
    const client = fakeClient(async () => {
      throw apiError(402, "Subscription required");
    });

    const result = await requestPipelexUpload({ filename: "a.pdf", size: 1 }, context(client));

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      kind: "paywall",
    });
    expect(result.summary).toContain("plan does not cover uploads");
  });

  it("names the route when the deployment does not serve it", async () => {
    const client = fakeClient(async () => {
      throw apiError(404, "Not Found");
    });

    const result = await requestPipelexUpload({ filename: "a.pdf", size: 1 }, context(client));

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
    });
    expect(result.structuredContent.errors?.[0]?.hint).toContain("/v1/upload/grant");
  });

  it("keeps an unreachable API retryable", async () => {
    const client = fakeClient(async () => {
      throw new ApiUnreachableError(
        "connect ECONNREFUSED",
        `${DEFAULT_API_URL}/v1/upload/grant`,
        "ECONNREFUSED",
      );
    });

    const result = await requestPipelexUpload({ filename: "a.pdf", size: 1 }, context(client));

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      retryable: true,
    });
  });
});

describe("requestUploadToolResult", () => {
  it("puts the grant on _meta and nowhere the model reads", async () => {
    const result = requestUploadToolResult(
      await requestPipelexUpload(
        { filename: "report.pdf", size: 125 },
        context(fakeClient(async () => GRANT)),
      ),
    );

    expect(result._meta).toEqual({ [UPLOAD_GRANT_META_KEY]: GRANT });
    expect(result.isError).toBe(false);
    // The grant is a bearer capability: its URL and signed headers must not
    // reach structuredContent or the text the model reads.
    const modelFacing = JSON.stringify([result.structuredContent, result.content]);
    expect(modelFacing).not.toContain(GRANT.url);
    expect(modelFacing).not.toContain("X-Amz-Signature");
    expect(modelFacing).not.toContain("x-amz-meta-uploaded-by");
    expect(result.content[0].text).toContain(GRANT.uri);
    expect(result.content[0].text).toContain("mthds_upload_attachments");
  });

  it("carries no _meta on a refusal", async () => {
    const result = requestUploadToolResult(
      await requestPipelexUpload(
        { filename: "a.pdf", size: 1 },
        context(
          fakeClient(async () => {
            throw apiError(413, "too large");
          }),
        ),
      ),
    );

    expect(result).not.toHaveProperty("_meta");
    expect(result.isError).toBe(true);
  });
});

describe("validateUploadGrantRequest", () => {
  it("accepts a named file of any size the schema admits, zero included", () => {
    expect(validateUploadGrantRequest({ filename: "empty.txt", size: 0 })).toEqual([]);
  });
});

describe("narrowUploadGrant", () => {
  it("keeps a well-formed grant, plain http included (the local compose stack)", () => {
    expect(narrowUploadGrant(GRANT)).toEqual(GRANT);
    const local = { ...GRANT, url: "http://localhost:9000/bucket/key?X-Amz-Signature=x" };
    expect(narrowUploadGrant(local)).toEqual(local);
  });

  it("drops members the grant does not define", () => {
    expect(narrowUploadGrant({ ...GRANT, extra: "value" })).toEqual(GRANT);
  });

  it.each([
    ["no object", null],
    ["a uri that is not a storage reference", { ...GRANT, uri: "https://example.com/x" }],
    ["a url that is not http(s)", { ...GRANT, url: "file:///etc/passwd" }],
    ["a url that does not parse", { ...GRANT, url: "not a url" }],
    ["a non-string header", { ...GRANT, headers: { "If-None-Match": 1 } }],
    ["headers as an array", { ...GRANT, headers: ["If-None-Match: *"] }],
    ["no expiry", { ...GRANT, expires_at: "" }],
    ["a negative cap", { ...GRANT, max_bytes: -1 }],
    ["a cap that is not a number", { ...GRANT, max_bytes: "52428800" }],
  ])("refuses %s", (_label, value) => {
    expect(narrowUploadGrant(value)).toBeUndefined();
  });
});
