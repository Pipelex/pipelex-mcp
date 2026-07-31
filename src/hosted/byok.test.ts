import { describe, expect, it } from "vitest";

import { ClientAuthenticationError } from "@pipelex/sdk";

import { buildToolContexts } from "../tools.js";
import { validateMthds } from "../capabilities/validate.js";
import { byokKeyMiddleware, contextsForRequest, extractRequestApiKey } from "./byok.js";
import type { ByokRequest } from "./byok.js";

function request(overrides: Partial<ByokRequest> = {}): ByokRequest {
  return { headers: {}, ...overrides };
}

describe("extractRequestApiKey", () => {
  it("extracts a Bearer token from the Authorization header", () => {
    const key = extractRequestApiKey(
      request({ headers: { authorization: "Bearer plx_sk_test123" } }),
    );

    expect(key).toBe("plx_sk_test123");
  });

  it("accepts a lowercase bearer scheme and surrounding whitespace", () => {
    const key = extractRequestApiKey(
      request({ headers: { authorization: "  bearer   plx_sk_test123  " } }),
    );

    expect(key).toBe("plx_sk_test123");
  });

  it("extracts the api_key query parameter", () => {
    const key = extractRequestApiKey(request({ query: { api_key: "plx_sk_query" } }));

    expect(key).toBe("plx_sk_query");
  });

  it("prefers the header over the query parameter", () => {
    const key = extractRequestApiKey(
      request({
        headers: { authorization: "Bearer plx_sk_header" },
        query: { api_key: "plx_sk_query" },
      }),
    );

    expect(key).toBe("plx_sk_header");
  });

  it("falls back to the query parameter when the header is not a Bearer credential", () => {
    const key = extractRequestApiKey(
      request({ headers: { authorization: "Basic abc" }, query: { api_key: "plx_sk_query" } }),
    );

    expect(key).toBe("plx_sk_query");
  });

  it("ignores a non-string api_key query value", () => {
    const key = extractRequestApiKey(request({ query: { api_key: ["a", "b"] } }));

    expect(key).toBeUndefined();
  });

  it("returns undefined when neither channel carries a value", () => {
    expect(extractRequestApiKey(request())).toBeUndefined();
    expect(extractRequestApiKey(request({ query: { api_key: "   " } }))).toBeUndefined();
  });
});

describe("byokKeyMiddleware", () => {
  it("attaches the extracted key as request auth and calls next", () => {
    const req = request({ headers: { authorization: "Bearer plx_sk_test123" } });
    let nextCalled = false;

    byokKeyMiddleware(req, undefined, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.auth).toEqual({ token: "plx_sk_test123", clientId: "byok", scopes: [] });
  });

  it("leaves auth unset on a keyless request and still calls next", () => {
    const req = request();
    let nextCalled = false;

    byokKeyMiddleware(req, undefined, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(req.auth).toBeUndefined();
  });
});

describe("contextsForRequest", () => {
  it("overrides the API key in every capability context when a key is supplied", () => {
    const base = buildToolContexts({ env: {} });

    const contexts = contextsForRequest(base, { token: "plx_sk_test123" });

    expect(contexts.catalog.apiKey).toBe("plx_sk_test123");
    expect(contexts.validation.apiKey).toBe("plx_sk_test123");
    expect(contexts.inputs.apiKey).toBe("plx_sk_test123");
    expect(contexts.prepare.apiKey).toBe("plx_sk_test123");
    expect(contexts.run.apiKey).toBe("plx_sk_test123");
    // The attachment ingest uploads to storage, so the caller's own key is what
    // funds it — the console holds none of its own.
    expect(contexts.attachments.apiKey).toBe("plx_sk_test123");
    expect(contexts.catalog.authError?.hint).toContain("rejected the supplied API key");
    expect(contexts.validation.authError?.hint).toContain("rejected the supplied API key");
  });

  it("takes precedence over a server-held env key", () => {
    const base = buildToolContexts({ env: { PIPELEX_API_KEY: "plx_sk_server" } });

    const contexts = contextsForRequest(base, { token: "plx_sk_caller" });

    expect(contexts.catalog.apiKey).toBe("plx_sk_caller");
    expect(contexts.validation.apiKey).toBe("plx_sk_caller");
  });

  it("points a fully keyless request at the bring-your-own-key channels", () => {
    const base = buildToolContexts({ env: {} });

    const contexts = contextsForRequest(base, undefined);

    expect(contexts.catalog.apiKey).toBeUndefined();
    expect(contexts.catalog.authError?.location).toBe("api_key");
    expect(contexts.catalog.authError?.hint).toContain("Authorization: Bearer");
    expect(contexts.validation.apiKey).toBeUndefined();
    expect(contexts.validation.authError?.location).toBe("api_key");
    expect(contexts.validation.authError?.hint).toContain("Authorization: Bearer");
    expect(contexts.inputs.authError).toEqual(contexts.validation.authError);
    expect(contexts.prepare.authError).toEqual(contexts.validation.authError);
    expect(contexts.run.authError).toEqual(contexts.validation.authError);
    expect(contexts.attachments.authError).toEqual(contexts.validation.authError);
  });

  it("keeps the base contexts untouched when a server-held env key applies", () => {
    const base = buildToolContexts({ env: { PIPELEX_API_KEY: "plx_sk_server" } });

    const contexts = contextsForRequest(base, undefined);

    expect(contexts).toBe(base);
    expect(contexts.catalog.apiKey).toBe("plx_sk_server");
    expect(contexts.catalog.authError).toBeUndefined();
    expect(contexts.validation.authError).toBeUndefined();
  });

  it("preserves the shell wiring of the base contexts", () => {
    const base = buildToolContexts({ env: {}, viewsAvailable: true });

    const contexts = contextsForRequest(base, { token: "plx_sk_test123" });

    expect(contexts.validation.viewsAvailable).toBe(true);
    expect(contexts.run.viewsAvailable).toBe(true);
    expect(contexts.validation.resolver).toBeUndefined();
  });
});

describe("BYOK auth failures through a capability", () => {
  it("surfaces the bring-your-own-key hint on a keyless auth failure", async () => {
    const base = buildToolContexts({ env: {} });
    const contexts = contextsForRequest(base, undefined);

    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"\n' }] },
      {
        ...contexts.validation,
        client: {
          getMethodClosure: () =>
            Promise.reject(new Error("getMethodClosure must not be called in this test")),
          validateFiles: () => Promise.reject(new ClientAuthenticationError("Unauthorized")),
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("config");
    expect(error?.location).toBe("api_key");
    expect(error?.hint).toContain("?api_key=");
  });
});
