import { describe, expect, it } from "vitest";

import { ClientAuthenticationError, PipelexApiClient } from "@pipelex/sdk";

import { buildToolContexts } from "../tools.js";
import { validateMthds } from "../capabilities/validate.js";
import { contextsForRequest } from "./contexts.js";

describe("contextsForRequest", () => {
  it("lifts the verified token into the API key of every capability context", () => {
    const base = buildToolContexts({ env: {} });

    const contexts = contextsForRequest(base, { token: "workos_access_token" });

    expect(contexts.catalog.apiKey).toBe("workos_access_token");
    expect(contexts.validation.apiKey).toBe("workos_access_token");
    expect(contexts.inputs.apiKey).toBe("workos_access_token");
    expect(contexts.prepare.apiKey).toBe("workos_access_token");
    expect(contexts.run.apiKey).toBe("workos_access_token");
    // The attachment ingest uploads to storage, so the signed-in caller's own
    // identity is what funds it — the console holds no key.
    expect(contexts.attachments.apiKey).toBe("workos_access_token");
  });

  it("takes precedence over a server-held env key", () => {
    const base = buildToolContexts({ env: { PIPELEX_API_KEY: "plx_sk_server" } });

    const contexts = contextsForRequest(base, { token: "workos_access_token" });

    expect(contexts.catalog.apiKey).toBe("workos_access_token");
    expect(contexts.validation.apiKey).toBe("workos_access_token");
  });

  it("gives a rejected session the sign-in-again texture", () => {
    const contexts = contextsForRequest(buildToolContexts({ env: {} }), {
      token: "workos_access_token",
    });

    expect(contexts.validation.authError?.location).toBe("authorization");
    expect(contexts.validation.authError?.hint).toContain("sign in again");
    expect(contexts.catalog.authError).toEqual(contexts.validation.authError);
    expect(contexts.inputs.authError).toEqual(contexts.validation.authError);
    expect(contexts.prepare.authError).toEqual(contexts.validation.authError);
    expect(contexts.run.authError).toEqual(contexts.validation.authError);
    expect(contexts.attachments.authError).toEqual(contexts.validation.authError);
  });

  it("clears a server-held env key when no verified token reached the handler", () => {
    // Unreachable in production — Skybridge mounts `requireBearerAuth`
    // server-wide — but it must fail closed rather than spend the operator's
    // key on an unauthenticated caller.
    const base = buildToolContexts({ env: { PIPELEX_API_KEY: "plx_sk_server" } });

    const contexts = contextsForRequest(base, undefined);

    // Empty string, NOT undefined: the SDK constructor reads
    // `options.apiKey ?? process.env.PIPELEX_API_KEY`, so an absent key falls
    // back to the deployment's env. See the behavioral test below — asserting
    // this field alone does not prove the guarantee.
    expect(contexts.catalog.apiKey).toBe("");
    expect(contexts.validation.apiKey).toBe("");
    expect(contexts.run.apiKey).toBe("");
    expect(contexts.attachments.apiKey).toBe("");
    expect(contexts.validation.authError?.location).toBe("authorization");
    expect(contexts.validation.authError?.hint).toContain("no verified sign-in");
  });

  it("preserves the shell wiring of the base contexts", () => {
    const base = buildToolContexts({ env: {}, viewsAvailable: true });

    const contexts = contextsForRequest(base, { token: "workos_access_token" });

    expect(contexts.validation.viewsAvailable).toBe(true);
    expect(contexts.run.viewsAvailable).toBe(true);
    expect(contexts.validation.resolver).toBeUndefined();
  });
});

describe("the tokenless branch on the wire", () => {
  /**
   * The guarantee is about what leaves the process, not about a field value.
   * `contextsForRequest` hands its `apiKey` straight to `PipelexApiClient`,
   * whose constructor falls back to `process.env.PIPELEX_API_KEY` when the
   * option is nullish — so a context carrying `undefined` would quietly send
   * the operator's key upstream while every field assertion still passed.
   * This drives a real client through a stubbed `fetch` to pin the outcome.
   */
  async function capturedAuthHeader(apiKey: string | undefined): Promise<string | undefined> {
    const original = { fetch: globalThis.fetch, key: process.env.PIPELEX_API_KEY };
    let seen: Headers | undefined;
    process.env.PIPELEX_API_KEY = "plx_sk_server";
    globalThis.fetch = ((_url: string, init?: { headers?: HeadersInit }) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(new Response("[]", { status: 200 }));
    }) as typeof globalThis.fetch;

    try {
      await new PipelexApiClient({ baseUrl: "https://api.test", apiKey }).listMethods();
      return seen?.get("authorization") ?? undefined;
    } finally {
      globalThis.fetch = original.fetch;
      if (original.key === undefined) {
        delete process.env.PIPELEX_API_KEY;
      } else {
        process.env.PIPELEX_API_KEY = original.key;
      }
    }
  }

  it("sends no Authorization header, rather than the deployment's env key", async () => {
    const contexts = contextsForRequest(buildToolContexts({ env: {} }), undefined);

    expect(await capturedAuthHeader(contexts.catalog.apiKey)).toBeUndefined();
  });

  it("pins the SDK fallback this defends against — `undefined` leaks the env key", async () => {
    // If this ever stops holding, the empty-string sentinel above can go. Until
    // then it is the reason it exists.
    expect(await capturedAuthHeader(undefined)).toBe("Bearer plx_sk_server");
  });

  it("sends the verified token when one is present", async () => {
    const contexts = contextsForRequest(buildToolContexts({ env: {} }), {
      token: "workos_access_token",
    });

    expect(await capturedAuthHeader(contexts.catalog.apiKey)).toBe("Bearer workos_access_token");
  });
});

describe("console auth failures through a capability", () => {
  it("surfaces the reconnect hint when the API rejects the forwarded token", async () => {
    const contexts = contextsForRequest(buildToolContexts({ env: {} }), {
      token: "workos_access_token",
    });

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
    expect(error?.location).toBe("authorization");
    expect(error?.hint).toContain("reconnect the Pipelex connector");
  });
});
