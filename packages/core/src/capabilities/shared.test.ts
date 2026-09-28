import { describe, expect, it } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  ArtifactAuthenticationError,
  ArtifactOperationError,
  ClientAuthenticationError,
  EmptyMethodSourceError,
  MissingMainStuffError,
  PipelineRequestError,
  RunLifecycleUnavailableError,
  ScopeUnavailableError,
} from "@pipelex/sdk";
import type { MthdsFileItem } from "@pipelex/sdk";

import {
  ALLOW_HTTP_ENV,
  allowsPlainHttp,
  blueprintMainPipeRefOf,
  buildApiConfig,
  buildArtifactFetchConfig,
  classifyError,
  DEFAULT_API_URL,
  fetchMethodFiles,
  filesInputSchema,
  imageCandidatesOf,
  itemToolError,
  looksLikeImageKey,
  parseAllowHttpOverride,
  resolveSubmittedFiles,
  storageKeyOf,
  summaryForToolError,
  toolResultContent,
  validateMethodSelectorRequest,
  validateRunIdRequest,
} from "./shared.js";
import type { ErrorSummaries, FileResolver, MethodFetchClient, ToolError } from "./shared.js";

describe("buildApiConfig", () => {
  it("defaults to the hosted API with no key", () => {
    const config = buildApiConfig({});

    expect(config.baseUrl).toBe(DEFAULT_API_URL);
    expect(config.apiKey).toBeUndefined();
  });

  it("reads the base URL and key from the environment", () => {
    const config = buildApiConfig({
      PIPELEX_BASE_URL: "http://localhost:8081",
      PIPELEX_API_KEY: "secret",
    });

    expect(config.baseUrl).toBe("http://localhost:8081");
    expect(config.apiKey).toBe("secret");
  });

  it("treats an empty key as absent", () => {
    const config = buildApiConfig({ PIPELEX_API_KEY: "" });

    expect(config.apiKey).toBeUndefined();
  });

  it("falls back to the hosted default when the base URL is blank", () => {
    const config = buildApiConfig({ PIPELEX_BASE_URL: "" });

    expect(config.baseUrl).toBe(DEFAULT_API_URL);
  });
});

describe("filesInputSchema", () => {
  it("accepts the content arm and the path arm", () => {
    const parsed = filesInputSchema.parse([
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { path: "methods/bundle.mthds" },
    ]);

    expect(parsed).toEqual([
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { path: "methods/bundle.mthds" },
    ]);
  });

  it("parses a pathological both-keys item as the content arm, ignoring path", () => {
    const parsed = filesInputSchema.parse([
      { content: 'domain = "demo"', path: "methods/bundle.mthds" },
    ]);

    expect(parsed).toEqual([{ content: 'domain = "demo"' }]);
  });

  it("rejects an item matching neither arm", () => {
    expect(filesInputSchema.safeParse([{ uri: "bundle.mthds" }]).success).toBe(false);
  });
});

function fakeResolver(contents: Record<string, string>): FileResolver {
  return {
    async resolve(path) {
      const content = contents[path];
      if (content === undefined) {
        return { ok: false, message: `File not found: ${path}`, hint: "Check the path." };
      }
      return { ok: true, content };
    },
  };
}

describe("resolveSubmittedFiles", () => {
  it("passes content items through untouched", async () => {
    const files = [
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { content: 'main_pipe = "main"' },
    ];

    const resolution = await resolveSubmittedFiles(files);

    expect(resolution.errors).toEqual([]);
    expect(resolution.files).toEqual(files);
  });

  it("rejects path items instructively when no resolver is provided (hosted)", async () => {
    const resolution = await resolveSubmittedFiles([
      { content: 'domain = "demo"' },
      { path: "methods/bundle.mthds" },
    ]);

    expect(resolution.errors).toHaveLength(1);
    const error = resolution.errors[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("files[1].path");
    expect(error?.message).toBe(
      "This deployment cannot read files from disk; submit the file contents instead.",
    );
    expect(error?.hint).toContain("{ content, uri? }");
    expect(error?.hint).toContain("npx @pipelex/mcp");
    expect(error?.retryable).toBe(false);
  });

  it("rejects a blank path on both deployments, before the resolver runs", async () => {
    let resolverCalled = false;
    const resolver: FileResolver = {
      async resolve() {
        resolverCalled = true;
        return { ok: true, content: "x" };
      },
    };

    for (const activeResolver of [undefined, resolver]) {
      const resolution = await resolveSubmittedFiles([{ path: "  " }], activeResolver);

      expect(resolution.errors).toHaveLength(1);
      expect(resolution.errors[0]?.class).toBe("input_domain");
      expect(resolution.errors[0]?.location).toBe("files[0].path");
      expect(resolution.errors[0]?.message).toMatch(/must not be empty/);
    }
    expect(resolverCalled).toBe(false);
  });

  it("resolves path items through the resolver, carrying the path as uri", async () => {
    const resolution = await resolveSubmittedFiles(
      [{ content: 'domain = "demo"', uri: "inline.mthds" }, { path: "methods/bundle.mthds" }],
      fakeResolver({ "methods/bundle.mthds": 'main_pipe = "main"' }),
    );

    expect(resolution.errors).toEqual([]);
    expect(resolution.files).toEqual([
      { content: 'domain = "demo"', uri: "inline.mthds" },
      { content: 'main_pipe = "main"', uri: "methods/bundle.mthds" },
    ]);
  });

  it("maps resolver failures to input_domain errors at the item's path", async () => {
    const resolution = await resolveSubmittedFiles(
      [{ path: "missing.mthds" }, { path: "also-missing.mthds" }],
      fakeResolver({}),
    );

    expect(resolution.errors).toHaveLength(2);
    expect(resolution.errors.map((error) => error.location)).toEqual([
      "files[0].path",
      "files[1].path",
    ]);
    expect(resolution.errors[0]?.class).toBe("input_domain");
    expect(resolution.errors[0]?.message).toBe("File not found: missing.mthds");
    expect(resolution.errors[0]?.hint).toBe("Check the path.");
    expect(resolution.errors[0]?.retryable).toBe(false);
  });
});

describe("toolResultContent", () => {
  it("returns just the summary when there are no errors (success)", () => {
    expect(toolResultContent("# Validation passed")).toEqual([
      { type: "text", text: "# Validation passed" },
    ]);
  });

  it("returns just the summary for an empty error list", () => {
    expect(toolResultContent("headline", [])).toEqual([{ type: "text", text: "headline" }]);
  });

  it("surfaces each error's locator, message, and hint under the summary", () => {
    const errors: ToolError[] = [
      {
        class: "input_domain",
        location: "files[1].path",
        message: "This deployment cannot read files from disk; submit the file contents instead.",
        hint: "Resubmit this item as { content, uri? }, or use the local workshop server (npx @pipelex/mcp).",
        retryable: false,
      },
    ];

    const [content] = toolResultContent(
      "Validation was not run: request input is invalid.",
      errors,
    );

    // The headline stays first, so hosts that show only the top line still read well.
    expect(content.text.startsWith("Validation was not run: request input is invalid.")).toBe(true);
    // The instructive detail every capability writes into errors[] now reaches
    // the agent-facing content stream, not just structuredContent.errors.
    expect(content.text).toContain("`files[1].path`");
    expect(content.text).toContain(
      "This deployment cannot read files from disk; submit the file contents instead.",
    );
    expect(content.text).toContain("*Hint: Resubmit this item as { content, uri? }");
    expect(content.text).toContain("npx @pipelex/mcp");
  });

  it("omits the locator and hint segments when they are absent", () => {
    const [content] = toolResultContent("headline", [
      { class: "runtime", message: "Server fault.", retryable: true },
    ]);

    expect(content.text).toBe("headline\n\n- Server fault.");
  });

  it("lists every error, one per line", () => {
    const [content] = toolResultContent("headline", [
      { class: "input_domain", location: "files[0].path", message: "First.", retryable: false },
      { class: "input_domain", location: "files[1].path", message: "Second.", retryable: false },
    ]);

    expect(content.text).toBe(
      "headline\n\n- `files[0].path` — First.\n- `files[1].path` — Second.",
    );
  });

  it("collapses embedded newlines so a crafted message stays one Markdown bullet", () => {
    // A path with an embedded blank line still ends in .mthds, so it clears the
    // extension gate and reaches the content stream; without normalization the
    // blank line would terminate the list item early.
    const [content] = toolResultContent("headline", [
      {
        class: "input_domain",
        location: "files[0].path",
        message: "File not found: a\n\nb.mthds",
        hint: "Check\nthe path.",
        retryable: false,
      },
    ]);

    expect(content.text).toBe(
      "headline\n\n- `files[0].path` — File not found: a b.mthds\n  *Hint: Check the path.*",
    );
  });
});

describe("validateMethodSelectorRequest", () => {
  const files = [{ content: 'domain = "demo"' }];
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";

  it("accepts each selector alone, under both rules", () => {
    for (const rule of ["one_selector", "run_source"] as const) {
      expect(validateMethodSelectorRequest(files, {}, { rule })).toEqual([]);
      expect(validateMethodSelectorRequest([], { method_ref: ADDRESS }, { rule })).toEqual([]);
      expect(validateMethodSelectorRequest([], { method_id: "mt_abc123" }, { rule })).toEqual([]);
    }
  });

  it("rejects a request with no selector at all, naming the accepted forms", () => {
    const errors = validateMethodSelectorRequest([], {}, { rule: "one_selector" });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("files");
    expect(errors[0]?.message).toBe("Provide MTHDS files, a method_ref address, or a method_id.");
    expect(errors[0]?.hint).toContain("github.com/");
  });

  it("rejects a blank method_id at method_id, with or without files", () => {
    for (const presentFiles of [[], files]) {
      const errors = validateMethodSelectorRequest(
        presentFiles,
        { method_id: "  " },
        { rule: "run_source" },
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.class).toBe("input_domain");
      expect(errors[0]?.location).toBe("method_id");
      expect(errors[0]?.retryable).toBe(false);
    }
  });

  it("rejects a blank method_ref at method_ref", () => {
    const errors = validateMethodSelectorRequest(
      [],
      { method_ref: "  " },
      { rule: "one_selector" },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("method_ref");
  });

  it("accepts any non-blank selector — format stays server-owned", () => {
    expect(
      validateMethodSelectorRequest([], { method_id: "not-an-mt-id" }, { rule: "one_selector" }),
    ).toEqual([]);
    expect(
      validateMethodSelectorRequest([], { method_ref: "not-an-address" }, { rule: "one_selector" }),
    ).toEqual([]);
  });

  it("one_selector: rejects every pairing, each at the extra selector", () => {
    const filesAndId = validateMethodSelectorRequest(
      files,
      { method_id: "mt_abc123" },
      { rule: "one_selector" },
    );
    expect(filesAndId).toHaveLength(1);
    expect(filesAndId[0]?.location).toBe("method_id");
    expect(filesAndId[0]?.message).toContain("mutually exclusive");

    const filesAndRef = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS },
      { rule: "one_selector" },
    );
    expect(filesAndRef).toHaveLength(1);
    expect(filesAndRef[0]?.location).toBe("method_ref");

    const refAndId = validateMethodSelectorRequest(
      [],
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "one_selector" },
    );
    expect(refAndId).toHaveLength(1);
    expect(refAndId[0]?.location).toBe("method_id");
  });

  it("run_source: files + method_id is the legal linkage pair", () => {
    expect(
      validateMethodSelectorRequest(files, { method_id: "mt_abc123" }, { rule: "run_source" }),
    ).toEqual([]);
  });

  it("run_source: method_ref pairs with nothing", () => {
    const filesAndRef = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS },
      { rule: "run_source" },
    );
    expect(filesAndRef).toHaveLength(1);
    expect(filesAndRef[0]?.location).toBe("method_ref");

    const refAndId = validateMethodSelectorRequest(
      [],
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "run_source" },
    );
    expect(refAndId).toHaveLength(1);
    expect(refAndId[0]?.location).toBe("method_id");
    expect(refAndId[0]?.message).toContain("provenance");
  });

  it("all three selectors report each illegal pairing", () => {
    const errors = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "one_selector" },
    );

    expect(errors.map((error) => error.location).sort()).toEqual([
      "method_id",
      "method_id",
      "method_ref",
    ]);
  });

  it("a blank selector earns its own error, not a pairing error", () => {
    // The blank method_ref is invalid on its own; it must not also produce
    // an exclusivity error against the files.
    const errors = validateMethodSelectorRequest(
      files,
      { method_ref: "  " },
      { rule: "run_source" },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("must not be empty");
  });

  it("still applies the per-file checks when files are present", () => {
    const errors = validateMethodSelectorRequest(
      [{ content: "" }, { content: "x", uri: "" }],
      {},
      { rule: "run_source" },
    );

    expect(errors.map((error) => error.location)).toEqual(["files[0].content", "files[1].uri"]);
  });
});

describe("validateRunIdRequest", () => {
  it("rejects an empty or whitespace-only run id", () => {
    for (const runId of ["", "   ", "\n\t"]) {
      const errors = validateRunIdRequest(runId);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.class).toBe("input_domain");
      expect(errors[0]?.location).toBe("run_id");
    }
  });

  it("accepts a normal run id", () => {
    expect(validateRunIdRequest("01JRUN0000000000000000TEST")).toEqual([]);
  });
});

describe("classifyError", () => {
  it("classifies unreachable API failures as config, retryable", () => {
    const error = classifyError(
      new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
    expect(error.retryable).toBe(true);
  });

  it("classifies API request-shape responses as input_domain", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 422",
        `${DEFAULT_API_URL}/v1/validate`,
        422,
        "Unprocessable Entity",
        "{}",
        "validation_error",
        "Bad request body",
        undefined, // validationErrors
        undefined, // code
      ),
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("files");
    expect(error.message).toBe("Bad request body");
    expect(error.retryable).toBe(false);
  });

  it("applies route-specific bad-request texture when provided", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 422",
        `${DEFAULT_API_URL}/v1/build/inputs`,
        422,
        "Unprocessable Entity",
        "{}",
        "validation_error",
        "Unknown pipe: demo.missing",
        undefined, // validationErrors
        undefined, // code
      ),
      {
        route: "/v1/build/inputs",
        badRequest: { location: "pipe_ref", hint: "Pass a qualified domain.pipe_code." },
      },
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("pipe_ref");
    expect(error.hint).toBe("Pass a qualified domain.pipe_code.");
  });

  it("classifies a 413 at the declared size only on a route that declared the texture", () => {
    const tooLarge = () =>
      new ApiResponseError(
        "HTTP 413",
        `${DEFAULT_API_URL}/v1/upload/grant`,
        413,
        "Payload Too Large",
        "{}",
        "PayloadTooLargeError",
        "Declared file size exceeds the 50 MiB limit.",
        undefined, // validationErrors
        "payload_too_large",
      );

    const declared = classifyError(tooLarge(), {
      route: "/v1/upload/grant",
      tooLarge: { location: "size", hint: "Pick a smaller file." },
    });
    expect(declared).toEqual({
      class: "input_domain",
      location: "size",
      message: "Declared file size exceeds the 50 MiB limit.",
      hint: "Pick a smaller file.",
      retryable: false,
    });

    // Elsewhere a 413 keeps the unexpected-status arm it always had.
    const undeclared = classifyError(tooLarge(), { route: "/v1/validate" });
    expect(undeclared.class).toBe("runtime");
    expect(undeclared.hint).toBe("The Pipelex API returned HTTP 413.");
  });

  it("names the route in the 404 hint", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 404",
        `${DEFAULT_API_URL}/v1/build/inputs`,
        404,
        "Not Found",
        "{}",
        "not_found",
        "Not found",
        undefined, // validationErrors
        undefined, // code
      ),
      { route: "/v1/build/inputs" },
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
    expect(error.hint).toContain("/v1/build/inputs");
    expect(error.retryable).toBe(false);
  });

  it("classifies auth responses as config", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 401",
        `${DEFAULT_API_URL}/v1/validate`,
        401,
        "Unauthorized",
        "{}",
        "unauthorized",
        "Missing key",
        undefined, // validationErrors
        undefined, // code
      ),
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_API_KEY");
    expect(error.retryable).toBe(false);
  });

  it("applies deployment auth texture to a 401 response", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 401",
        `${DEFAULT_API_URL}/v1/validate`,
        401,
        "Unauthorized",
        "{}",
        "unauthorized",
        "Missing key",
        undefined, // validationErrors
        undefined, // code
      ),
      { auth: { location: "api_key", hint: "Bring your own key." } },
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("api_key");
    expect(error.hint).toBe("Bring your own key.");
    expect(error.retryable).toBe(false);
  });

  it("applies deployment auth texture to a ClientAuthenticationError", () => {
    const error = classifyError(new ClientAuthenticationError("Unauthorized"), {
      auth: { location: "api_key", hint: "Bring your own key." },
    });

    expect(error.class).toBe("config");
    expect(error.location).toBe("api_key");
    expect(error.hint).toBe("Bring your own key.");
    expect(error.retryable).toBe(false);
  });

  it("uses the route's forbidden texture on a 403, keeping the auth locator", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 403",
        `${DEFAULT_API_URL}/v1/codegen`,
        403,
        "Forbidden",
        "{}",
        "forbidden",
        "Feature not enabled",
        undefined, // validationErrors
        undefined, // code
      ),
      {
        auth: { location: "authorization", hint: "Sign in again." },
        forbidden: { hint: "Sign in again. If that is fine, the feature is gated." },
      },
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("authorization");
    expect(error.hint).toBe("Sign in again. If that is fine, the feature is gated.");
    expect(error.retryable).toBe(false);
  });

  it("classifies the sandbox refusal (403 CustomCodeRequiresSandbox) at the method, not the key", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 403",
        `${DEFAULT_API_URL}/v1/validate`,
        403,
        "Forbidden",
        "{}",
        "CustomCodeRequiresSandbox",
        "This bundle ships custom Python (.py); running it requires a sandbox-hosted deployment.",
        undefined, // validationErrors
        undefined, // code
      ),
      {
        methodLocation: "method_ref",
        // The textures that would otherwise win: a deployment auth wording and
        // a route gate. Neither may reach a refusal about the method itself.
        auth: { location: "authorization", hint: "Sign in again." },
        forbidden: { hint: "The feature is gated." },
      },
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("method_ref");
    expect(error.hint).toMatch(/sandbox-hosted/);
    expect(error.hint).not.toMatch(/sign in/i);
    expect(error.retryable).toBe(false);
  });

  it("locates the sandbox refusal wherever the request named the method", () => {
    const refusal = (methodLocation: string): ToolError =>
      classifyError(
        new ApiResponseError(
          "HTTP 403",
          `${DEFAULT_API_URL}/v1/start`,
          403,
          "Forbidden",
          "{}",
          "CustomCodeRequiresSandbox",
          "This bundle ships custom Python (.py).",
          undefined, // validationErrors
          undefined, // code
        ),
        { methodLocation },
      );

    // `/v1/start` applies the gate to a submitted bundle and to a stored
    // method's injected source as well as to a fetched package, so the locator
    // follows the request shape rather than being hardcoded to method_ref.
    expect(refusal("files").location).toBe("files");
    expect(refusal("method_id").location).toBe("method_id");
  });

  it("reports no location for a sandbox refusal on a route that names no method field", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 403",
        `${DEFAULT_API_URL}/v1/validate`,
        403,
        "Forbidden",
        "{}",
        "CustomCodeRequiresSandbox",
        "This bundle ships custom Python (.py).",
        undefined, // validationErrors
        undefined, // code
      ),
      {},
    );

    // A missing locator is the honest answer — better than pointing the caller
    // at a field this route never had.
    expect(error.class).toBe("input_domain");
    expect(error.location).toBeUndefined();
  });

  it("never applies the sandbox arm to a 401 carrying the same error_type", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 401",
        `${DEFAULT_API_URL}/v1/validate`,
        401,
        "Unauthorized",
        "{}",
        "CustomCodeRequiresSandbox",
        "Missing key",
        undefined, // validationErrors
        undefined, // code
      ),
      { methodLocation: "method_ref" },
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_API_KEY");
  });

  it("never applies the forbidden texture to a 401 — a rejected credential is not a gate", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 401",
        `${DEFAULT_API_URL}/v1/codegen`,
        401,
        "Unauthorized",
        "{}",
        "unauthorized",
        "Missing key",
        undefined, // validationErrors
        undefined, // code
      ),
      {
        auth: { location: "authorization", hint: "Sign in again." },
        forbidden: { hint: "The feature is gated." },
      },
    );

    expect(error.location).toBe("authorization");
    expect(error.hint).toBe("Sign in again.");
  });

  it("keeps the env-var auth texture when no override is provided", () => {
    const error = classifyError(new ClientAuthenticationError("Unauthorized"));

    expect(error.location).toBe("PIPELEX_API_KEY");
    expect(error.hint).toBe("Check the API key for the configured Pipelex API.");
  });

  it("classifies a paywall 402 as config with the billing hint", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 402",
        `${DEFAULT_API_URL}/v1/start`,
        402,
        "Payment Required",
        "{}",
        "subscription_required",
        "Subscription required to run methods",
        undefined, // validationErrors
        // The platform's problem code for 402 is "forbidden" — classification
        // must branch on the status, never on this.
        "forbidden",
      ),
    );

    expect(error.class).toBe("config");
    // The class stays `config` (settled contract); `kind` is what tells a
    // billing refusal from an unreachable API, for the headline and for a
    // machine consumer that would otherwise have to sniff the message.
    expect(error.kind).toBe("paywall");
    expect(error.location).toBeUndefined();
    expect(error.message).toBe("Subscription required to run methods");
    expect(error.hint).toContain("app.pipelex.com");
    expect(error.retryable).toBe(false);
  });

  it("falls back to the transport message on a 402 without a server message", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 402",
        `${DEFAULT_API_URL}/v1/start`,
        402,
        "Payment Required",
        "{}",
        undefined, // errorType
        undefined, // serverMessage
        undefined, // validationErrors
        undefined, // code
      ),
    );

    expect(error.class).toBe("config");
    expect(error.kind).toBe("paywall");
    expect(error.message).toBe("HTTP 402");
    expect(error.retryable).toBe(false);
  });

  it("classifies API server failures as runtime, retryable", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 500",
        `${DEFAULT_API_URL}/v1/validate`,
        500,
        "Internal Server Error",
        "{}",
        "internal",
        "Server fault",
        undefined, // validationErrors
        undefined, // code
      ),
    );

    expect(error.class).toBe("runtime");
    expect(error.message).toBe("Server fault");
    expect(error.retryable).toBe(true);
  });

  it("classifies a throttle (429) or a request timeout (408) as runtime, retryable", () => {
    // Refused for its timing, not its content: a poll loop must keep going.
    for (const status of [429, 408]) {
      const error = classifyError(
        new ApiResponseError(
          `HTTP ${status}`,
          `${DEFAULT_API_URL}/v1/runs/run_1`,
          status,
          "Slow down",
          "{}",
          undefined,
          undefined,
          undefined, // validationErrors
          undefined, // code
        ),
      );

      expect(error.class).toBe("runtime");
      expect(error.retryable).toBe(true);
    }
  });

  it("classifies an unexpected non-5xx status as runtime, not retryable", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 418",
        `${DEFAULT_API_URL}/v1/validate`,
        418,
        "I'm a teapot",
        "{}",
        "teapot",
        "Teapot",
        undefined, // validationErrors
        undefined, // code
      ),
    );

    expect(error.class).toBe("runtime");
    expect(error.retryable).toBe(false);
  });

  it("classifies unknown faults as runtime, retryable", () => {
    const error = classifyError(new Error("boom"));

    expect(error.class).toBe("runtime");
    expect(error.retryable).toBe(true);
  });

  it("classifies client request construction failures as config, not retryable", () => {
    const error = classifyError(new PipelineRequestError("Invalid API base URL"));

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
    expect(error.retryable).toBe(false);
  });

  it("classifies a missing run lifecycle as config, pointing at the hosted API", () => {
    const error = classifyError(
      new RunLifecycleUnavailableError("run lifecycle not served", DEFAULT_API_URL),
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
    expect(error.hint).toMatch(/hosted/i);
    expect(error.retryable).toBe(false);
  });

  it("classifies a completed run missing its main stuff as runtime, not retryable", () => {
    const error = classifyError(
      new MissingMainStuffError("Completed run 'x' returned no main stuff.", "x"),
    );

    expect(error.class).toBe("runtime");
    expect(error.message).toMatch(/main stuff/i);
    expect(error.retryable).toBe(false);
  });

  it("classifies the artifact family ahead of the generic PipelineRequestError arm", () => {
    const verdict = {
      scope: "main_stuff" as const,
      artifacts: [],
      saved_paths: [],
      all_saved: true,
    };
    const auth = classifyError(
      new ArtifactAuthenticationError(
        "The resolve route refused the credential (401).",
        401,
        verdict,
      ),
      { auth: { location: "connector", hint: "Reconnect." } },
    );
    expect(auth).toMatchObject({
      class: "config",
      location: "connector",
      hint: "Reconnect.",
      retryable: false,
    });
    expect(classifyError(new ArtifactAuthenticationError("refused", 403, verdict))).toMatchObject({
      class: "config",
      location: "PIPELEX_API_KEY",
    });

    // A scope with no artifact on a completed run reads like a missing main output.
    expect(classifyError(new ScopeUnavailableError("main_stuff", "run-1"))).toMatchObject({
      class: "runtime",
      retryable: false,
    });

    // The base class is never the caller's input, and never the base-URL config arm.
    const operation = classifyError(new ArtifactOperationError("malformed bulk answer"));
    expect(operation).toMatchObject({ class: "runtime", retryable: false });
    expect(operation.location).toBeUndefined();
  });

  it("overrides the 404 arm to input_domain when the route says so", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 404",
        `${DEFAULT_API_URL}/v1/runs/unknown/status`,
        404,
        "Not Found",
        "{}",
        "not_found",
        "Run not found",
        undefined, // validationErrors
        undefined, // code
      ),
      {
        route: "/v1/runs/{id}/status",
        notFound: { location: "run_id", hint: "Check the run id." },
      },
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("run_id");
    expect(error.hint).toBe("Check the run id.");
    expect(error.retryable).toBe(false);
  });
});

describe("summaryForToolError", () => {
  const summaries: ErrorSummaries = {
    config: "connectivity headline",
    input_domain: "request headline",
    runtime: "server headline",
    paywall: "billing headline",
  };

  it("maps an untagged error by its class", () => {
    expect(
      summaryForToolError(
        { class: "config", message: "Connection refused", retryable: true },
        summaries,
      ),
    ).toBe("connectivity headline");
  });

  it("prefers the kind headline over the class it refines", () => {
    // The whole point: a 402 is `config` by contract, so a class-first lookup
    // would blame connectivity for a plan limit.
    expect(
      summaryForToolError(
        { class: "config", kind: "paywall", message: "Subscription required", retryable: false },
        summaries,
      ),
    ).toBe("billing headline");
  });
});

describe("fetchMethodFiles", () => {
  const noSourceHint = "Add MTHDS content to the method, or submit files instead.";

  it("forwards a resolved single-file closure, relabeling source as the id uri", async () => {
    const client: MethodFetchClient = {
      async getMethodClosure() {
        return [{ content: 'domain = "demo"\nmain_pipe = "main"', source: "mt_123" }];
      },
    };

    const result = await fetchMethodFiles(() => client, "mt_123", { noSourceHint });

    expect(result).toEqual({
      ok: true,
      files: [{ content: 'domain = "demo"\nmain_pipe = "main"', uri: "mt_123" }],
    });
  });

  it("forwards each file of a multi-file closure", async () => {
    const client: MethodFetchClient = {
      async getMethodClosure() {
        return [
          { content: 'domain = "demo"', source: "mt_123" },
          { content: 'main_pipe = "main"', source: "mt_123" },
        ];
      },
    };

    const result = await fetchMethodFiles(() => client, "mt_123", { noSourceHint });

    expect(result).toEqual({
      ok: true,
      files: [
        { content: 'domain = "demo"', uri: "mt_123" },
        { content: 'main_pipe = "main"', uri: "mt_123" },
      ],
    });
  });

  it("maps EmptyMethodSourceError to a no_source verdict at method_id with the caller's hint", async () => {
    const client: MethodFetchClient = {
      async getMethodClosure(): Promise<MthdsFileItem[]> {
        throw new EmptyMethodSourceError("mt_123");
      },
    };

    const result = await fetchMethodFiles(() => client, "mt_123", { noSourceHint });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_source");
      expect(result.error.class).toBe("input_domain");
      expect(result.error.location).toBe("method_id");
      expect(result.error.hint).toBe(noSourceHint);
      expect(result.error.retryable).toBe(false);
    }
  });

  it("classifies a fetch failure as input_domain at method_id, tagged fetch", async () => {
    const client: MethodFetchClient = {
      async getMethodClosure(): Promise<MthdsFileItem[]> {
        throw new ApiResponseError(
          "HTTP 404",
          `${DEFAULT_API_URL}/v1/methods/mt_missing`,
          404,
          "Not Found",
          "{}",
          "not_found",
          "Method not found",
          undefined, // validationErrors
          "not_found", // code
        );
      },
    };

    const result = await fetchMethodFiles(() => client, "mt_missing", { noSourceHint });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch");
      expect(result.error.class).toBe("input_domain");
      expect(result.error.location).toBe("method_id");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("constructs the client lazily, so a synchronous throw classifies instead of escaping", async () => {
    const result = await fetchMethodFiles(
      () => {
        throw new PipelineRequestError("bad base URL");
      },
      "mt_123",
      { noSourceHint },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fetch");
      expect(result.error.class).toBe("config");
      expect(result.error.location).toBe("PIPELEX_BASE_URL");
    }
  });
});

describe("the plain-http rule", () => {
  it("accepts plain http exactly when the configured API is itself plain http", () => {
    expect(allowsPlainHttp({ baseUrl: "http://localhost:8081" })).toBe(true);
    expect(allowsPlainHttp({ baseUrl: DEFAULT_API_URL })).toBe(false);
    // A malformed base URL refuses; the client constructor reports it as config.
    expect(allowsPlainHttp({ baseUrl: "not a url" })).toBe(false);
  });

  it("lets the explicit override win in both directions", () => {
    expect(allowsPlainHttp({ baseUrl: DEFAULT_API_URL, allowHttp: true })).toBe(true);
    expect(allowsPlainHttp({ baseUrl: "http://localhost:8081", allowHttp: false })).toBe(false);
  });

  it("reads the override from the environment, failing closed on an unrecognized value", () => {
    expect(parseAllowHttpOverride(undefined)).toBeUndefined();
    expect(parseAllowHttpOverride("  ")).toBeUndefined();
    expect(parseAllowHttpOverride("true")).toBe(true);
    expect(parseAllowHttpOverride(" TRUE ")).toBe(true);
    expect(parseAllowHttpOverride("1")).toBe(true);
    expect(parseAllowHttpOverride("false")).toBe(false);
    expect(parseAllowHttpOverride("0")).toBe(false);
    expect(parseAllowHttpOverride("yes")).toBe(false);

    expect(buildArtifactFetchConfig({ [ALLOW_HTTP_ENV]: "true" }).allowHttp).toBe(true);
    expect(buildArtifactFetchConfig({})).not.toHaveProperty("allowHttp");
    expect(buildArtifactFetchConfig({}).baseUrl).toBe(DEFAULT_API_URL);
  });
});

describe("itemToolError", () => {
  it("classifies the SDK's per-item codes and locates each where its caller says", () => {
    expect(
      itemToolError({ code: "not_found", detail: "gone (HTTP 404)." }, "artifacts[1].uri"),
    ).toMatchObject({
      class: "input_domain",
      location: "artifacts[1].uri",
      message: "gone (HTTP 404).",
      retryable: false,
    });
    expect(
      itemToolError({ code: "too_large", detail: "over the cap" }, "artifacts[0].uri"),
    ).toMatchObject({
      class: "input_domain",
      retryable: false,
    });
    expect(
      itemToolError({ code: "forbidden", detail: "another org" }, "artifacts[0].uri"),
    ).toMatchObject({
      class: "input_domain",
      retryable: false,
    });
    for (const code of ["store_refused", "store_error", "timeout", "network", "resolve_failed"]) {
      expect(itemToolError({ code, detail: "x" }, "artifacts[0].uri")).toMatchObject({
        class: "runtime",
        retryable: true,
      });
    }
    expect(
      itemToolError({ code: "write_failed", detail: "EACCES" }, "artifacts[0].uri"),
    ).toMatchObject({
      class: "runtime",
      retryable: false,
    });
  });

  // The locator is a parameter precisely because the table now serves two
  // tools: the download tool locates at `artifacts[i].uri`, mthds_show_images
  // at `images[i].uri`, and everything else about the classification is shared.
  it("carries whichever locator the calling tool names", () => {
    expect(
      itemToolError({ code: "not_found", detail: "gone (HTTP 404)." }, "images[2].uri"),
    ).toMatchObject({
      class: "input_domain",
      location: "images[2].uri",
      message: "gone (HTTP 404).",
    });
  });

  it("points a plain-http refusal at the override instead of the SDK option", () => {
    const error = itemToolError(
      { code: "plain_http_refused", detail: "pass allowHttp: true to accept it" },
      "artifacts[0].uri",
    );

    expect(error.class).toBe("config");
    expect(error.message).not.toContain("allowHttp");
    expect(error.hint).toContain(`${ALLOW_HTTP_ENV}=true`);
  });

  it("reads a code it does not know as a retryable runtime fault", () => {
    expect(
      itemToolError({ code: "something_new", detail: "new failure" }, "artifacts[2].uri"),
    ).toMatchObject({
      class: "runtime",
      location: "artifacts[2].uri",
      message: "new failure",
      retryable: true,
    });
  });

  it("still names a failure when the route sent no detail with it", () => {
    // `detail` is typed but arrives verbatim off the wire, like the code, and
    // `message` is required on both tools' error schemas.
    const missing = itemToolError(
      { code: "not_found", detail: undefined as unknown as string },
      "artifacts[0].uri",
    );
    expect(missing.message).toContain("gave no reason");
    expect(missing.message).toContain("not_found");
    expect(missing.class).toBe("input_domain");

    const blank = itemToolError({ code: "store_refused", detail: "   " }, "artifacts[1].uri");
    expect(blank.message).toContain("gave no reason");
  });

  it("reads a code naming an Object.prototype member as an unknown code, not as its member", () => {
    for (const code of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(itemToolError({ code, detail: "off the wire" }, "artifacts[0].uri")).toMatchObject({
        class: "runtime",
        location: "artifacts[0].uri",
        message: "off the wire",
        retryable: true,
      });
    }
  });
});

describe("the image-candidate prefilter", () => {
  const PICTURE = "pipelex-storage://runs/01JRUN/outputs/illustration.png";
  const REPORT = "pipelex-storage://runs/01JRUN/outputs/report.pdf";
  const UNTYPED = "pipelex-storage://runs/01JRUN/outputs/blob";

  it("reads a reference's storage key as everything after the scheme", () => {
    expect(storageKeyOf(PICTURE)).toBe("runs/01JRUN/outputs/illustration.png");
    // Not a reference at all: answered as-is rather than silently truncated.
    expect(storageKeyOf("illustration.png")).toBe("illustration.png");
  });

  it("takes every known image extension, in any case", () => {
    for (const extension of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".PNG", ".JPeG"]) {
      expect(looksLikeImageKey(`runs/01JRUN/outputs/picture${extension}`)).toBe(true);
    }
  });

  it("takes a key with no extension, because only the fetched type can settle it", () => {
    expect(looksLikeImageKey("runs/01JRUN/outputs/blob")).toBe(true);
    // A leading dot is not an extension.
    expect(looksLikeImageKey("runs/01JRUN/outputs/.hidden")).toBe(true);
  });

  it("refuses an extension that is plainly not an image", () => {
    for (const key of ["out/report.pdf", "out/data.json", "out/notes.txt", "out/logo.svg"]) {
      expect(looksLikeImageKey(key)).toBe(false);
    }
  });

  it("ignores a query- or fragment-looking tail on the key", () => {
    expect(looksLikeImageKey("out/picture.png?v=2")).toBe(true);
    expect(looksLikeImageKey("out/report.pdf?v=2")).toBe(false);
  });

  it("walks a whole output and keeps only the candidates, in discovery order", () => {
    const mainStuff = {
      cover: { url: PICTURE, public_url: "https://store.example/x" },
      attachments: [{ url: REPORT }, { url: UNTYPED }],
    };

    expect(imageCandidatesOf(mainStuff)).toEqual([
      { uri: PICTURE, key: "runs/01JRUN/outputs/illustration.png" },
      { uri: UNTYPED, key: "runs/01JRUN/outputs/blob" },
    ]);
  });

  it("answers nothing for an output that references no stored file", () => {
    expect(imageCandidatesOf({ text: "no files here" })).toEqual([]);
  });
});

describe("blueprintMainPipeRefOf", () => {
  it("qualifies a bare main_pipe with the blueprint's domain", () => {
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "main" })).toBe("demo.main");
  });

  it("leaves an already-qualified main_pipe alone", () => {
    // The regression this function exists to hold: prefixing unconditionally
    // turned a cross-domain main_pipe into `demo.other.shout`, a ref that keys
    // neither pipe_io_contracts nor input_form, so the signature went missing
    // rather than being found.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "other.shout" })).toBe(
      "other.shout",
    );
  });

  it("answers nothing for a blueprint that declares no usable main pipe", () => {
    expect(blueprintMainPipeRefOf({ domain: "demo" })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "" })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: 7 })).toBeUndefined();
    // A bare main_pipe with no domain to qualify it cannot key either map.
    expect(blueprintMainPipeRefOf({ main_pipe: "main" })).toBeUndefined();
  });

  it("trims both members, so one method cannot resolve on one shell and not the other", () => {
    // Load-bearing, not cosmetic: the SDK reads both through its own
    // `nonEmptyString`, and `mthds_prepare_inputs` mirrors this selection on the
    // console while delegating to the SDK on the workshop. Untrimmed, a padded
    // `main_pipe` keyed nothing here and `demo.main` there — the same method
    // prepared on one shell and refused on the other. Nothing upstream strips
    // it: `DomainBlueprint.main_pipe` is a bare `str` with no validator.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "  main  " })).toBe("demo.main");
    expect(blueprintMainPipeRefOf({ domain: "  demo  ", main_pipe: "main" })).toBe("demo.main");
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "  other.shout  " })).toBe(
      "other.shout",
    );
    // Whitespace-only is still empty, on both members.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "   " })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "   ", main_pipe: "main" })).toBeUndefined();
  });

  it("treats a blueprint that is not an object as declaring nothing", () => {
    for (const blueprint of [undefined, null, "demo.main", 7, ["demo.main"]]) {
      expect(blueprintMainPipeRefOf(blueprint)).toBeUndefined();
    }
  });
});
