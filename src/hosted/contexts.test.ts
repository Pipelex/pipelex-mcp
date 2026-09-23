import { afterEach, describe, expect, it, vi } from "vitest";

import { ClientAuthenticationError, PipelexApiClient, SDK_VERSION } from "@pipelex/sdk";

import { listMthdsMethods } from "../capabilities/catalog.js";
import { MCP_VERSION } from "../capabilities/client-identification.js";
import { validateMthds } from "../capabilities/validate.js";
import { contextsForRequest } from "./contexts.js";
import { buildHostedToolContexts } from "./tools.js";

describe("contextsForRequest", () => {
  it("lifts the verified token into the API key of every capability context", () => {
    const base = buildHostedToolContexts({});

    const contexts = contextsForRequest(base, { token: "workos_access_token" });

    expect(contexts.catalog.apiKey).toBe("workos_access_token");
    expect(contexts.validation.apiKey).toBe("workos_access_token");
    expect(contexts.inputs.apiKey).toBe("workos_access_token");
    expect(contexts.codegen.apiKey).toBe("workos_access_token");
    expect(contexts.prepare.apiKey).toBe("workos_access_token");
    expect(contexts.run.apiKey).toBe("workos_access_token");
    // The attachment ingest uploads to storage, so the signed-in caller's own
    // identity is what funds it — the console holds no key.
    expect(contexts.attachments.apiKey).toBe("workos_access_token");
    // The image display RESOLVES and FETCHES caller-scoped stored objects, so
    // it is the context where a missed override would have the deployment's
    // key reading another organization's pictures.
    expect(contexts.images.apiKey).toBe("workos_access_token");
    // And every context the console builds, named or not, so a capability
    // added to the console's set cannot join it on the deployment's key.
    for (const [name, context] of Object.entries(contexts)) {
      expect(context.apiKey, name).toBe("workos_access_token");
    }
  });

  it("takes precedence over a server-held env key", () => {
    const base = buildHostedToolContexts({ PIPELEX_API_KEY: "plx_sk_server" });

    const contexts = contextsForRequest(base, { token: "workos_access_token" });

    expect(contexts.catalog.apiKey).toBe("workos_access_token");
    expect(contexts.validation.apiKey).toBe("workos_access_token");
  });

  it("gives a rejected session the sign-in-again texture", () => {
    const contexts = contextsForRequest(buildHostedToolContexts({}), {
      token: "workos_access_token",
    });

    expect(contexts.validation.authError?.location).toBe("authorization");
    expect(contexts.validation.authError?.hint).toContain("sign in again");
    expect(contexts.catalog.authError).toEqual(contexts.validation.authError);
    expect(contexts.inputs.authError).toEqual(contexts.validation.authError);
    expect(contexts.codegen.authError).toEqual(contexts.validation.authError);
    expect(contexts.prepare.authError).toEqual(contexts.validation.authError);
    expect(contexts.run.authError).toEqual(contexts.validation.authError);
    expect(contexts.attachments.authError).toEqual(contexts.validation.authError);
    expect(contexts.images.authError).toEqual(contexts.validation.authError);
  });

  it("clears a server-held env key when no verified token reached the handler", () => {
    // Unreachable in production — Skybridge mounts `requireBearerAuth`
    // server-wide — but it must fail closed rather than spend the operator's
    // key on an unauthenticated caller.
    const base = buildHostedToolContexts({ PIPELEX_API_KEY: "plx_sk_server" });

    const contexts = contextsForRequest(base, undefined);

    // Empty string, NOT undefined: the SDK constructor reads
    // `options.apiKey ?? process.env.PIPELEX_API_KEY`, so an absent key falls
    // back to the deployment's env. See the behavioral test below — asserting
    // this field alone does not prove the guarantee.
    expect(contexts.catalog.apiKey).toBe("");
    expect(contexts.validation.apiKey).toBe("");
    expect(contexts.codegen.apiKey).toBe("");
    expect(contexts.run.apiKey).toBe("");
    expect(contexts.attachments.apiKey).toBe("");
    expect(contexts.images.apiKey).toBe("");
    expect(contexts.validation.authError?.location).toBe("authorization");
    expect(contexts.validation.authError?.hint).toContain("no verified sign-in");
  });

  it("preserves the console's own settings through the override", () => {
    const base = buildHostedToolContexts({});

    const contexts = contextsForRequest(base, { token: "workos_access_token" });

    // Views on; no filesystem, so no `{ path }` resolver and no write root;
    // no uploads through mthds_prepare_inputs; no download tool to name.
    expect(contexts.validation.viewsAvailable).toBe(true);
    expect(contexts.run.viewsAvailable).toBe(true);
    expect(contexts.validation.resolver).toBeUndefined();
    expect(contexts.run.resolver).toBeUndefined();
    expect(contexts.codegen.saveRoot).toBeUndefined();
    expect(contexts.prepare.allowUpload).toBe(false);
    expect(contexts.run.artifactDownloadAvailable).toBe(false);
    expect(contexts.images.artifactDownloadAvailable).toBe(false);
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
    const contexts = contextsForRequest(buildHostedToolContexts({}), undefined);

    expect(await capturedAuthHeader(contexts.catalog.apiKey)).toBeUndefined();
  });

  it("pins the SDK fallback this defends against — `undefined` leaks the env key", async () => {
    // If this ever stops holding, the empty-string sentinel above can go. Until
    // then it is the reason it exists.
    expect(await capturedAuthHeader(undefined)).toBe("Bearer plx_sk_server");
  });

  it("sends the verified token when one is present", async () => {
    const contexts = contextsForRequest(buildHostedToolContexts({}), {
      token: "workos_access_token",
    });

    expect(await capturedAuthHeader(contexts.catalog.apiKey)).toBe("Bearer workos_access_token");
  });
});

describe("console auth failures through a capability", () => {
  it("surfaces the reconnect hint when the API rejects the forwarded token", async () => {
    const contexts = contextsForRequest(buildHostedToolContexts({}), {
      token: "workos_access_token",
    });

    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"\n' }] },
      {
        ...contexts.validation,
        client: {
          validate: () =>
            Promise.reject(new Error("validate (selector leg) must not be called in this test")),
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

describe("the console's User-Agent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The header a real client built from the per-request contexts sends. */
  async function userAgentFor(userAgent: string | undefined): Promise<string | undefined> {
    let seen: string | undefined;
    vi.stubGlobal("fetch", (_url: string, init?: { headers?: HeadersInit }) => {
      seen = new Headers(init?.headers).get("user-agent") ?? undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }),
      );
    });
    const headers = userAgent === undefined ? {} : { "user-agent": userAgent };
    const contexts = contextsForRequest(
      buildHostedToolContexts({ PIPELEX_BASE_URL: "https://api.pipelex.test" }),
      { token: "workos_access_token" },
      { headers },
    );
    await listMthdsMethods({}, contexts.catalog);
    return seen;
  }

  const sdkAndRuntime = `pipelex-sdk-js/${SDK_VERSION} node/${process.versions.node} (${process.platform}; ${process.arch})`;

  it("names the console and ChatGPT's connector as openai", async () => {
    expect(await userAgentFor("openai-mcp/1.0.0 (+https://openai.com/bot)")).toBe(
      `pipelex-mcp/${MCP_VERSION} (console; host=openai) ${sdkAndRuntime}`,
    );
  });

  it("names Claude's connector as claude", async () => {
    expect(await userAgentFor("Claude-User")).toBe(
      `pipelex-mcp/${MCP_VERSION} (console; host=claude) ${sdkAndRuntime}`,
    );
  });

  it("names the console alone when the connector is unrecognised or silent", async () => {
    expect(await userAgentFor("python-httpx/0.28.1")).toBe(
      `pipelex-mcp/${MCP_VERSION} (console) ${sdkAndRuntime}`,
    );
    expect(await userAgentFor(undefined)).toBe(
      `pipelex-mcp/${MCP_VERSION} (console) ${sdkAndRuntime}`,
    );
  });

  it("carries the identity on every context, the tokenless branch included", () => {
    const contexts = contextsForRequest(buildHostedToolContexts({}), undefined, {
      headers: { "user-agent": "openai-mcp/1.0.0" },
    });
    // Every member of the console's context set, so a context added to it later
    // is covered without editing this list.
    const all = Object.values(contexts);
    expect(all).toHaveLength(8);
    for (const context of all) {
      expect(context.appInfo?.().details).toEqual(["console", "host=openai"]);
    }
  });
});
