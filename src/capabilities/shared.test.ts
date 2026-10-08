import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  ArtifactAuthenticationError,
  ArtifactOperationError,
  EmptyMethodSourceError,
  InputPreparationError,
  InvalidLocalSourceError,
  MissingMainStuffError,
  PagingNotTerminatingError,
  PipelineRequestError,
  RejectedAssetError,
  RequestArgumentError,
  RunLifecycleUnavailableError,
  RunTimeoutError,
  ScopeUnavailableError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "@pipelex/sdk";

import {
  ALLOW_HTTP_ENV,
  BULK_RESOLVE_ERROR_OPTIONS,
  allowsPlainHttp,
  blueprintMainPipeRefOf,
  buildApiConfig,
  buildArtifactFetchConfig,
  classifyError,
  createPipelexApiClient,
  DEFAULT_API_URL,
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
import type { ErrorSummaries, FileResolver, ToolError } from "./shared.js";

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

/**
 * What the SDK throws when the API refuses a request: the real client, reading
 * a stubbed answer, so the verdict on the error is the one the SDK decides from
 * the problem document it parsed. `problem` is the document's members; a
 * string is sent as the raw body, as a bare runner or a gateway answers.
 */
async function refused(
  status: number,
  problem: Record<string, unknown> | string = {},
): Promise<ApiResponseError> {
  const body = typeof problem === "string" ? problem : JSON.stringify({ status, ...problem });
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(body, {
        status,
        headers: { "content-type": "application/problem+json" },
      }),
    ),
  );
  try {
    await createPipelexApiClient({ baseUrl: DEFAULT_API_URL }).getMethod("mt_test");
  } catch (err) {
    if (err instanceof ApiResponseError) return err;
    throw err;
  }
  throw new Error("the client did not refuse");
}

/** What the SDK throws when nothing answers: an `ApiUnreachableError` carrying the network code. */
async function unreachable(code: string): Promise<unknown> {
  vi.stubGlobal("fetch", () =>
    Promise.reject(
      new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }),
    ),
  );
  return createPipelexApiClient({ baseUrl: DEFAULT_API_URL })
    .getMethod("mt_test")
    .then(
      () => undefined,
      (err: unknown) => err,
    );
}

/**
 * What input preparation throws once the client's `upload()` met `answer`: the
 * SDK's `prepareInputs` on the real client, asked for one image whose value is
 * bytes to upload, so the `UploadTransportError` wrapping the refusal is the
 * SDK's own.
 */
async function uploadFailure(answer: () => Promise<Response>): Promise<unknown> {
  vi.stubGlobal("fetch", (url: string) =>
    String(url).endsWith("/v1/pipe-io")
      ? Promise.resolve(
          Response.json({
            is_valid: true,
            pipe_ref: "demo.main",
            pipe_io_contracts: {},
            input_form: {
              "demo.main": {
                fields: [
                  { kind: "image", required: true, name: "photo", presence: "plain", gating: true },
                ],
              },
            },
            output_form: {},
            default_pipe_ref: "demo.main",
            pending_signatures: [],
            is_runnable: true,
          }),
        )
      : answer(),
  );
  return createPipelexApiClient({ baseUrl: DEFAULT_API_URL })
    .prepareInputs({
      files: [{ content: 'domain = "demo"' }],
      inputs: { photo: "data:image/png;base64,AQ==" },
    })
    .then(
      () => undefined,
      (err: unknown) => err,
    );
}

/** The runner's own rendering of a refusal: `error_type`, `detail` and `error_domain`. */
function runnerProblem(errorType: string, detail: string, errorDomain?: string) {
  return {
    error_type: errorType,
    detail,
    ...(errorDomain === undefined ? {} : { error_domain: errorDomain }),
  };
}

describe("classifyError", () => {
  describe("takes the verdict from the SDK's error", () => {
    it("reads a refused request's class and retryable flag as the SDK decided them", async () => {
      const error = classifyError(
        await refused(422, runnerProblem("ValidationError", "Bad request body", "input")),
      );

      expect(error).toEqual({
        class: "input_domain",
        location: "files",
        message: "Bad request body",
        hint: "Check the submitted file contents and provenance fields.",
        retryable: false,
      });
    });

    it("follows the server's own members over the status", async () => {
      // A runner's engine configuration error is a 500 that names its domain
      // and says nothing of a retry: the SDK reads it as config, not retryable,
      // where the status alone would have called it a passing fault.
      const configFault = classifyError(
        await refused(500, runnerProblem("ConfigError", "Missing secret", "config")),
      );
      expect(configFault).toMatchObject({ class: "config", retryable: false });

      const finalFault = classifyError(
        await refused(503, { detail: "Gone for good", error_domain: "runtime", retryable: false }),
      );
      expect(finalFault).toMatchObject({ class: "runtime", retryable: false });
    });

    it("reads the SDK's fallback when the server sent no verdict", async () => {
      const server = classifyError(await refused(500, { detail: "Server fault" }));
      expect(server).toMatchObject({ class: "runtime", message: "Server fault", retryable: true });

      // A conflict is the caller's request meeting the stored state.
      expect(classifyError(await refused(409, { code: "conflict" }))).toMatchObject({
        class: "input_domain",
        hint: "The Pipelex API returned HTTP 409.",
        retryable: false,
      });

      // Refused for its timing, not its content: a poll loop must keep going.
      for (const status of [429, 408]) {
        expect(classifyError(await refused(status))).toMatchObject({
          class: "runtime",
          retryable: true,
        });
      }
    });

    it("reads an unreachable API as retryable config at the base URL", async () => {
      const error = classifyError(await unreachable("ECONNREFUSED"));

      expect(error.class).toBe("config");
      expect(error.location).toBe("PIPELEX_BASE_URL");
      expect(error.retryable).toBe(true);
    });

    it("reads the SDK's own request timeout as a retryable runtime fault, not the base URL", () => {
      const error = classifyError(
        new ApiUnreachableError("no answer in time", DEFAULT_API_URL, "ABORT_TIMEOUT"),
      );

      expect(error.class).toBe("runtime");
      expect(error.location).toBeUndefined();
      expect(error.hint).toMatch(/did not answer in time/);
      expect(error.retryable).toBe(true);
    });

    it("reads the client's refusal of its own arguments by their verdict", () => {
      // A base URL carrying a path is refused at construction, as `config`.
      let construction: unknown;
      try {
        createPipelexApiClient({ baseUrl: `${DEFAULT_API_URL}/v1` });
      } catch (err) {
        construction = err;
      }
      expect(construction).toBeInstanceOf(RequestArgumentError);
      expect(classifyError(construction)).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: false,
      });

      const argument = classifyError(new RequestArgumentError("No run source given."));
      expect(argument).toMatchObject({ class: "input_domain", retryable: false });
      expect(argument.location).toBeUndefined();
    });

    it("reads the run family and the paging guard by their verdict", () => {
      expect(classifyError(new RunTimeoutError("still going", "run_1", 1_000))).toMatchObject({
        class: "runtime",
        retryable: true,
      });
      expect(classifyError(new PagingNotTerminatingError("cursors never end", 100))).toMatchObject({
        class: "runtime",
        retryable: false,
      });
      expect(
        classifyError(new MissingMainStuffError("Completed run 'x' returned no main stuff.", "x")),
      ).toMatchObject({
        class: "runtime",
        message: expect.stringMatching(/main stuff/i),
        retryable: false,
      });
    });

    it("reads a missing run lifecycle as config, pointing at the hosted API", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(Response.json({ detail: "Not Found" }, { status: 404 })),
      );
      const err = await createPipelexApiClient({ baseUrl: DEFAULT_API_URL })
        .getRunStatus("run_1")
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(RunLifecycleUnavailableError);

      const error = classifyError(err);
      expect(error.class).toBe("config");
      expect(error.location).toBe("PIPELEX_BASE_URL");
      expect(error.hint).toMatch(/hosted/i);
      expect(error.retryable).toBe(false);
    });

    it("reads a verdict carried by an error that is not this copy's class", () => {
      const foreign = Object.assign(new Error("refused elsewhere"), {
        retryable: false,
        errorDomain: "input",
      });

      expect(classifyError(foreign)).toMatchObject({ class: "input_domain", retryable: false });
    });

    it("keeps its own reading of a failure that carries no verdict", () => {
      const bare = classifyError(new PipelineRequestError("Invalid API base URL"));
      expect(bare).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: false,
      });

      // A fault nothing names stays retryable: for the poll loops, wrongly
      // stopping a live follow is worse than one more read.
      expect(classifyError(new Error("boom"))).toMatchObject({ class: "runtime", retryable: true });
      expect(classifyError("boom")).toMatchObject({
        class: "runtime",
        message: "Unknown failure.",
        retryable: true,
      });
    });
  });

  describe("overrides the SDK's class where this server knows better, and says why", () => {
    it("reads every rejected credential as config, whatever the server tagged it", async () => {
      // The runner tags its own 401 `input`; the platform sends no domain.
      const fromRunner = await refused(
        401,
        runnerProblem("Unauthenticated", "Missing key", "input"),
      );
      expect(fromRunner.errorDomain).toBe("input");
      for (const err of [fromRunner, await refused(401, { code: "unauthorized" })]) {
        expect(classifyError(err)).toMatchObject({
          class: "config",
          location: "PIPELEX_API_KEY",
          hint: "Check PIPELEX_API_KEY for the configured API.",
          retryable: false,
        });
      }
    });

    it("takes a route's declared class for a 400 no argument fixes", async () => {
      const orgless = await refused(400, { code: "bad_request", detail: "No active organization" });
      expect(orgless.errorDomain).toBe("input");

      expect(classifyError(orgless, BULK_RESOLVE_ERROR_OPTIONS)).toMatchObject({
        class: "config",
        retryable: false,
      });
    });

    it("reads the registry form of method_ref as the caller's, on a route that declared it", async () => {
      const registry = await refused(
        501,
        runnerProblem("MethodRefNotImplemented", "Registry refs are reserved.", "config"),
      );
      const texture = { location: "method_ref", hint: "Use an address." };

      expect(classifyError(registry, { notImplemented: texture })).toEqual({
        class: "input_domain",
        location: "method_ref",
        message: "Registry refs are reserved.",
        hint: "Use an address.",
        retryable: false,
      });
      // Elsewhere the deployment does not implement the route.
      expect(classifyError(registry, { route: "/v1/codegen" })).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        hint: expect.stringContaining("/v1/codegen"),
        retryable: false,
      });
    });

    it("reads a 404 as the caller's miss only where the route takes a name and the SDK reads it so", async () => {
      const texture = { location: "method_ref", hint: "No such package." };
      const options = { route: "/v1/pipe-io", notFound: texture };

      // A runner's typed refusal and the platform's coded one both name the miss.
      const typed = await refused(
        404,
        runnerProblem("MethodPackageNotFoundError", "No package matches.", "input"),
      );
      expect(classifyError(typed, options)).toMatchObject({
        class: "input_domain",
        location: "method_ref",
        retryable: false,
      });
      const coded = await refused(404, { code: "not_found", detail: "Method not found" });
      expect(classifyError(coded, options).location).toBe("method_ref");

      // A bare 404 is the deployment not serving the route.
      const bare = classifyError(await refused(404, '{"detail":"Not Found"}'), options);
      expect(bare).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: false,
      });
      expect(bare.hint).toContain("/v1/pipe-io");

      // On a route that names no resource, even a coded 404 is the route
      // missing: the platform renders a path it does not serve that way.
      expect(classifyError(coded, { route: "/v1/methods" })).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        hint: expect.stringContaining("/v1/methods"),
      });
    });
  });

  describe("words each refusal for this server's caller", () => {
    it("applies route-specific bad-request texture when provided", async () => {
      const error = classifyError(
        await refused(422, runnerProblem("ValidationError", "Unknown pipe: demo.missing", "input")),
        {
          route: "/v1/pipe-io",
          badRequest: { location: "pipe_ref", hint: "Pass a qualified domain.pipe_code." },
        },
      );

      expect(error).toMatchObject({
        class: "input_domain",
        location: "pipe_ref",
        hint: "Pass a qualified domain.pipe_code.",
      });
    });

    it("locates a refused pipe selection at the selection texture, ahead of the selector's", async () => {
      const refusal = (errorType: string) =>
        refused(
          422,
          runnerProblem(errorType, "Several domains declare a main_pipe: a.main, b.main.", "input"),
        );
      const withoutSelection = {
        route: "/v1/pipe-io",
        badRequest: { location: "method_ref", hint: "Check the address." },
      };
      const options = {
        ...withoutSelection,
        selection: { location: "pipe_ref", hint: "Name the pipe." },
      };

      for (const errorType of ["EntryPipeNotFoundError", "EntryPipeAmbiguousError"]) {
        expect(classifyError(await refusal(errorType), options)).toEqual({
          class: "input_domain",
          location: "pipe_ref",
          message: "Several domains declare a main_pipe: a.main, b.main.",
          hint: "Name the pipe.",
          retryable: false,
        });
      }

      // Any other 422 keeps the selector's texture, and a route that declared no
      // selection texture keeps the generic arm for the typed refusal too.
      expect(classifyError(await refusal("ValidationError"), options).location).toBe("method_ref");
      expect(
        classifyError(await refusal("EntryPipeNotFoundError"), withoutSelection).location,
      ).toBe("method_ref");
    });

    it("locates a stray EmptyMethodSourceError at method_id", () => {
      expect(classifyError(new EmptyMethodSourceError("mt_123"))).toMatchObject({
        class: "input_domain",
        location: "method_id",
        retryable: false,
      });
    });

    it("locates a 413 at the declared size only on a route that declared the texture", async () => {
      const tooLarge = () =>
        refused(413, {
          code: "payload_too_large",
          detail: "Declared file size exceeds the 50 MiB limit.",
        });

      expect(
        classifyError(await tooLarge(), {
          route: "/v1/upload/grant",
          tooLarge: { location: "size", hint: "Pick a smaller file." },
        }),
      ).toEqual({
        class: "input_domain",
        location: "size",
        message: "Declared file size exceeds the 50 MiB limit.",
        hint: "Pick a smaller file.",
        retryable: false,
      });

      // Elsewhere a 413 keeps the SDK's verdict and names its status.
      const undeclared = classifyError(await tooLarge(), { route: "/v1/validate" });
      expect(undeclared).toMatchObject({ class: "input_domain", retryable: false });
      expect(undeclared.location).toBeUndefined();
      expect(undeclared.hint).toBe("The Pipelex API returned HTTP 413.");
    });

    it("applies deployment auth texture to a 401 response", async () => {
      const error = classifyError(await refused(401, { code: "unauthorized" }), {
        auth: { location: "api_key", hint: "Bring your own key." },
      });

      expect(error).toMatchObject({
        class: "config",
        location: "api_key",
        hint: "Bring your own key.",
        retryable: false,
      });
    });

    it("uses the route's forbidden texture on a 403, keeping the auth locator", async () => {
      const error = classifyError(await refused(403, { code: "forbidden" }), {
        auth: { location: "authorization", hint: "Sign in again." },
        forbidden: { hint: "Sign in again. If that is fine, the feature is gated." },
      });

      expect(error).toMatchObject({
        class: "config",
        location: "authorization",
        hint: "Sign in again. If that is fine, the feature is gated.",
        retryable: false,
      });
    });

    it("never applies the forbidden texture to a 401 — a rejected credential is not a gate", async () => {
      const error = classifyError(await refused(401, { code: "unauthorized" }), {
        auth: { location: "authorization", hint: "Sign in again." },
        forbidden: { hint: "The feature is gated." },
      });

      expect(error.location).toBe("authorization");
      expect(error.hint).toBe("Sign in again.");
    });

    it("classifies the sandbox refusal (403 CustomCodeRequiresSandbox) at the method, not the key", async () => {
      const error = classifyError(
        await refused(
          403,
          runnerProblem(
            "CustomCodeRequiresSandbox",
            "This bundle ships custom Python (.py); running it requires a sandbox-hosted deployment.",
            "input",
          ),
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

    it("locates the sandbox refusal wherever the request named the method, or nowhere", async () => {
      const sandbox = await refused(
        403,
        runnerProblem(
          "CustomCodeRequiresSandbox",
          "This bundle ships custom Python (.py).",
          "input",
        ),
      );

      // `/v1/start` applies the gate to a submitted bundle and to a stored
      // method's injected source as well as to a fetched package, so the locator
      // follows the request shape rather than being hardcoded to method_ref.
      expect(classifyError(sandbox, { methodLocation: "files" }).location).toBe("files");
      expect(classifyError(sandbox, { methodLocation: "method_id" }).location).toBe("method_id");
      // A missing locator is the honest answer — better than pointing the caller
      // at a field this route never had.
      const unlocated = classifyError(sandbox, {});
      expect(unlocated.class).toBe("input_domain");
      expect(unlocated.location).toBeUndefined();
    });

    it("classifies the structures refusal (403 MethodStructuresRefusedError) at method_ref", async () => {
      // The runner sends this refusal with no `error_domain` (L-261007-31dea6),
      // and the SDK reads a bare 403 as `config`: the arm overrides it.
      const refusal = await refused(
        403,
        runnerProblem("MethodStructuresRefusedError", "Structure classes refused."),
      );
      expect(refusal.errorDomain).toBe("config");

      const error = classifyError(refusal);

      expect(error).toMatchObject({
        class: "input_domain",
        location: "method_ref",
        retryable: false,
      });
    });

    it("never applies the sandbox arm to a 401 carrying the same error_type", async () => {
      const error = classifyError(
        await refused(401, runnerProblem("CustomCodeRequiresSandbox", "Missing key", "input")),
        { methodLocation: "method_ref" },
      );

      expect(error.class).toBe("config");
      expect(error.location).toBe("PIPELEX_API_KEY");
    });

    it("classifies a paywall 402 as config with the billing hint", async () => {
      // The platform's problem code for 402 is "forbidden" — the arm branches
      // on the status, never on this.
      const error = classifyError(
        await refused(402, { code: "forbidden", detail: "Subscription required to run methods" }),
      );

      // The class stays `config`; `kind` is what tells a billing refusal from
      // an unreachable API, for the headline and for a machine consumer that
      // would otherwise have to sniff the message.
      expect(error).toEqual({
        class: "config",
        kind: "paywall",
        message: "Subscription required to run methods",
        hint: expect.stringContaining("app.pipelex.com"),
        retryable: false,
      });
    });

    it("falls back to the transport message on a 402 without a server message", async () => {
      const error = classifyError(await refused(402, ""));

      expect(error).toMatchObject({ class: "config", kind: "paywall", retryable: false });
      expect(error.message).toMatch(/402/);
    });
  });

  describe("the upload leg", () => {
    it("reads a wrapped plan refusal as the paywall it is, not a passing fault", async () => {
      const err = await uploadFailure(() =>
        Promise.resolve(
          Response.json({ status: 402, code: "forbidden", detail: "Plan limit" }, { status: 402 }),
        ),
      );
      expect(err).toBeInstanceOf(UploadTransportError);

      expect(classifyError(err)).toMatchObject({
        class: "config",
        kind: "paywall",
        message: "Plan limit",
        retryable: false,
      });
    });

    it("reads a wrapped unreachable API as retryable config at the base URL", async () => {
      const err = await uploadFailure(() =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
          }),
        ),
      );
      expect(err).toBeInstanceOf(UploadTransportError);

      expect(classifyError(err)).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: true,
      });
    });

    it("reads a wrapped server fault by its verdict, with the upload's own hint", async () => {
      const err = await uploadFailure(() =>
        Promise.resolve(Response.json({ status: 503, detail: "Busy" }, { status: 503 })),
      );

      expect(classifyError(err)).toMatchObject({
        class: "runtime",
        hint: expect.stringMatching(/could not reach Pipelex storage/),
        retryable: true,
      });

      const refusal = await uploadFailure(() =>
        Promise.resolve(Response.json({ status: 400, detail: "Bad file" }, { status: 400 })),
      );
      expect(classifyError(refusal, { asset: { location: "inputs.photo" } })).toMatchObject({
        class: "input_domain",
        location: "inputs.photo",
        retryable: false,
      });
    });

    it("reads the rest of the preparation family by its verdict, located at the asset", () => {
      const options = { asset: { location: "inputs.photo", hint: "Shrink it." } };

      expect(
        classifyError(new RejectedAssetError("too large", "photo.png", 413), options),
      ).toMatchObject({
        class: "input_domain",
        location: "inputs.photo",
        hint: "Shrink it.",
        retryable: false,
      });
      expect(
        classifyError(new InvalidLocalSourceError("unreadable", "./photo.png"), options),
      ).toMatchObject({ class: "input_domain", location: "inputs.photo", retryable: false });
      expect(classifyError(new UnsupportedUploadCapabilityError("no upload route"))).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: false,
      });
      expect(
        classifyError(new UploadAuthenticationError("refused", 401), {
          auth: { location: "api_key", hint: "Bring your own key." },
        }),
      ).toMatchObject({ class: "config", location: "api_key", retryable: false });
    });

    it("locates the preparation base error at the pipe, unless the SDK reads it as no fault of the caller's", () => {
      const options = { preparation: { location: "pipe_ref", hint: "Name the pipe." } };

      expect(classifyError(new InputPreparationError("Unknown pipe."), options)).toMatchObject({
        class: "input_domain",
        location: "pipe_ref",
        retryable: false,
      });

      const unreadable = classifyError(
        new InputPreparationError("is_valid is not a boolean", {
          verdict: { errorDomain: "runtime", retryable: false },
        }),
        options,
      );
      expect(unreadable).toMatchObject({ class: "runtime", retryable: false });
      expect(unreadable.location).toBeUndefined();
    });
  });

  it("classifies the artifact family by its verdict, with its own texture", () => {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyError on the method-version codes", () => {
  it("reads a never-published method's bare id as the caller's, naming the draft and the publish", async () => {
    const error = classifyError(
      await refused(409, { code: "method_not_published", detail: "mt_test is not published." }),
      { route: "/v1/validate", methodLocation: "files" },
    );

    expect(error).toMatchObject({
      class: "input_domain",
      location: "method_id",
      message: "mt_test is not published.",
      retryable: false,
    });
    expect(error.hint).toContain("mt_…@draft");
    expect(error.hint).toContain("mthds_publish_method");
    expect(error.hint).toContain("only when the user asks");
  });

  it("locates a stale draft token where the route says, with its hint", async () => {
    const conflict = await refused(409, { code: "method_update_conflict", detail: "Moved." });

    expect(classifyError(conflict)).toMatchObject({
      class: "input_domain",
      location: "expected_updated_at",
    });
    expect(
      classifyError(conflict, {
        conflict: { location: "expected_draft_updated_at", hint: "Read it again." },
      }),
    ).toMatchObject({ location: "expected_draft_updated_at", hint: "Read it again." });
  });

  it("says a method being deleted is going away", async () => {
    const error = classifyError(
      await refused(409, { code: "method_being_deleted", detail: "Deleting." }),
    );
    expect(error).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(error.hint).toContain("being deleted");
  });

  it("reads an unknown version as the caller's, ahead of the route's unknown-method hint", async () => {
    const error = classifyError(
      await refused(404, { code: "method_version_not_found", detail: "No version 9." }),
      { notFound: { location: "method_id", hint: "No registered method with this id." } },
    );

    expect(error).toMatchObject({
      class: "input_domain",
      location: "method_id",
      message: "No version 9.",
      retryable: false,
    });
    expect(error.hint).not.toContain("No registered method");
    expect(error.hint).toContain("no published version with this number");
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

  it("trims both members, as the SDK does", () => {
    // Load-bearing, not cosmetic: the SDK reads both through its own
    // `nonEmptyString`, and `mthds_prepare_inputs` delegates to the SDK.
    // Untrimmed, a padded `main_pipe` keyed nothing here and `demo.main` there.
    // Nothing upstream strips it: `DomainBlueprint.main_pipe` is a bare `str`
    // with no validator.
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
