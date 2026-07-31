import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_FETCH_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  fetchAttachmentBytes,
  isAllowedAttachmentHost,
} from "./attachment-fetch.js";

const ALLOWED_URL =
  "https://oaisdmntprkoreacentral.blob.core.windows.net/files/00000000-7170/raw?se=2026-07-30T15%3A47%3A24Z&sig=abc";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isAllowedAttachmentHost", () => {
  it("accepts the per-upload OpenAI blob hosts across regions", () => {
    for (const region of ["nznorth", "koreacentral", "westus", "newzealandnorth"]) {
      expect(isAllowedAttachmentHost(`oaisdmntpr${region}.blob.core.windows.net`)).toBe(true);
    }
  });

  it("accepts the vendor-documented files host", () => {
    expect(isAllowedAttachmentHost("files.oaiusercontent.com")).toBe(true);
  });

  it("rejects a suffix-only match — ANY Azure customer can register one", () => {
    // The whole reason the `oaisdmntpr` prefix is required rather than optional:
    // `*.blob.core.windows.net` would happily fetch an attacker-owned blob.
    expect(isAllowedAttachmentHost("evil.blob.core.windows.net")).toBe(false);
    expect(isAllowedAttachmentHost("oaisdmntpr.evil.blob.core.windows.net")).toBe(false);
    expect(isAllowedAttachmentHost("notoaisdmntprwestus.blob.core.windows.net")).toBe(false);
  });

  it("rejects lookalike suffixes and unrelated hosts", () => {
    expect(isAllowedAttachmentHost("oaisdmntprwestus.blob.core.windows.net.evil.com")).toBe(false);
    expect(isAllowedAttachmentHost("files.oaiusercontent.com.evil.com")).toBe(false);
    expect(isAllowedAttachmentHost("169.254.169.254")).toBe(false);
    expect(isAllowedAttachmentHost("localhost")).toBe(false);
  });
});

describe("fetchAttachmentBytes — the boundary refuses before any request", () => {
  it("refuses a non-https scheme without fetching", async () => {
    const fetchSpy = stubFetch(() => {
      throw new Error("fetch must not be called");
    });

    const result = await fetchAttachmentBytes("http://oaisdmntprwestus.blob.core.windows.net/x");

    expect(result).toMatchObject({ ok: false, failure: { class: "input_domain" } });
    expect(failureOf(result).message).toContain("must be https");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a host outside the allowlist and names ChatGPT as the only channel", async () => {
    const fetchSpy = stubFetch(() => {
      throw new Error("fetch must not be called");
    });

    const result = await fetchAttachmentBytes("https://evil.blob.core.windows.net/files/raw");

    expect(failureOf(result)).toMatchObject({ class: "input_domain", retryable: false });
    expect(failureOf(result).message).toContain("evil.blob.core.windows.net");
    expect(failureOf(result).hint).toContain("ChatGPT");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses credentials in the URL, a non-default port, and a malformed URL", async () => {
    const fetchSpy = stubFetch(() => {
      throw new Error("fetch must not be called");
    });

    const withCreds = await fetchAttachmentBytes(
      "https://user:pass@oaisdmntprwestus.blob.core.windows.net/x",
    );
    const withPort = await fetchAttachmentBytes(
      "https://oaisdmntprwestus.blob.core.windows.net:8443/x",
    );
    const malformed = await fetchAttachmentBytes("not a url");

    for (const result of [withCreds, withPort, malformed]) {
      expect(failureOf(result)).toMatchObject({ class: "input_domain", retryable: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fetchAttachmentBytes — response handling", () => {
  it("returns the bytes and the declared content type on the happy path", async () => {
    stubFetch(() => bodyResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf"));

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.attachment.bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(result.attachment.contentType).toBe("application/pdf");
  });

  it("strips content-type parameters", async () => {
    stubFetch(() => bodyResponse(new Uint8Array([1]), "text/plain; charset=utf-8"));

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(result.ok && result.attachment.contentType).toBe("text/plain");
  });

  it("sends no credentials and does not follow redirects", async () => {
    const fetchSpy = stubFetch(() => bodyResponse(new Uint8Array([1]), "application/pdf"));

    await fetchAttachmentBytes(ALLOWED_URL);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a redirect rather than following it to another host", async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/steal" },
        }),
    );

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(failureOf(result)).toMatchObject({ class: "input_domain", retryable: false });
    expect(failureOf(result).message).toContain("redirect");
  });

  it("reads a 403 as an expired signed link, recoverable only by re-attaching", async () => {
    stubFetch(() => new Response(null, { status: 403 }));

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    // Not `retryable`: the same call can never succeed — the link is dead, and
    // recovery is a NEW attachment. The hint carries the actual fix.
    expect(failureOf(result)).toMatchObject({ class: "input_domain", retryable: false });
    expect(failureOf(result).message).toContain("expired");
    expect(failureOf(result).hint).toContain("attach the file again");
  });

  it("treats another non-2xx from the storage host as a retryable runtime fault", async () => {
    stubFetch(() => new Response(null, { status: 500 }));

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(failureOf(result)).toMatchObject({ class: "runtime", retryable: true });
  });
});

describe("fetchAttachmentBytes — the size cap", () => {
  it("refuses on the declared content-length WITHOUT reading the body", async () => {
    // highWaterMark 0 so the stream never pre-buffers: `pull` then fires only
    // on a real consumer read, making it an honest "were payload bytes pulled?"
    // probe. `cancel` records that we let the connection go instead.
    let bodyRead = false;
    let cancelled = false;
    stubFetch(
      () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                bodyRead = true;
                controller.close();
              },
              cancel() {
                cancelled = true;
              },
            },
            new CountQueuingStrategy({ highWaterMark: 0 }),
          ),
          {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-length": String(MAX_ATTACHMENT_BYTES + 1),
            },
          },
        ),
    );

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(failureOf(result)).toMatchObject({ class: "input_domain", retryable: false });
    expect(failureOf(result).message).toContain("7.0 MiB");
    expect(bodyRead).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("still refuses mid-stream when content-length lies", async () => {
    // A header claiming 1 byte over a body that streams past the cap: the
    // pre-flight check passes and the mid-stream bound is the only thing
    // standing between us and an unbounded read.
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (emitted >= MAX_ATTACHMENT_BYTES + chunk.byteLength) {
                controller.close();
                return;
              }
              emitted += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { "content-type": "application/pdf", "content-length": "1" } },
        ),
    );

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(failureOf(result)).toMatchObject({ class: "input_domain", retryable: false });
    // Abandoned promptly rather than buffering the whole lying stream.
    expect(emitted).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES + chunk.byteLength);
  });

  it("accepts a body exactly at the cap", async () => {
    stubFetch(() => bodyResponse(new Uint8Array(MAX_ATTACHMENT_BYTES), "application/pdf"));

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(result.ok).toBe(true);
    expect(result.ok && result.attachment.bytes.byteLength).toBe(MAX_ATTACHMENT_BYTES);
  });
});

describe("fetchAttachmentBytes — transport faults", () => {
  it("reports a timeout as a retryable runtime fault naming the budget", async () => {
    stubFetch(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(failureOf(result)).toMatchObject({ class: "runtime", retryable: true });
    expect(failureOf(result).message).toContain(`${ATTACHMENT_FETCH_TIMEOUT_MS / 1000}s`);
  });

  it("reports a network fault as a retryable runtime fault", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const result = await fetchAttachmentBytes(ALLOWED_URL);

    expect(failureOf(result)).toMatchObject({ class: "runtime", retryable: true });
    expect(failureOf(result).message).toContain("fetch failed");
  });
});

function stubFetch(impl: () => Response) {
  const spy = vi.fn((_input: unknown, _init?: RequestInit) => Promise.resolve(impl()));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function bodyResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes.buffer as ArrayBuffer, {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(bytes.byteLength) },
  });
}

function failureOf(result: Awaited<ReturnType<typeof fetchAttachmentBytes>>) {
  if (result.ok) {
    throw new Error("expected a refused fetch");
  }
  return result.failure;
}
