import { describe, expect, it } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  MissingMainStuffError,
  PipelineRequestError,
  RunLifecycleUnavailableError,
} from "@pipelex/sdk";

import {
  buildApiConfig,
  classifyError,
  DEFAULT_API_URL,
  filesInputSchema,
  resolveSubmittedFiles,
  toolResultContent,
  validateRequest,
  validateRunIdRequest,
} from "./shared.js";
import type { FileResolver, ToolError } from "./shared.js";

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

describe("validateRequest", () => {
  it("rejects empty file URIs", () => {
    const errors = validateRequest([
      { content: 'domain = "demo"', uri: "" },
      { content: 'main_pipe = "main"', uri: "bundle.mthds" },
    ]);

    expect(errors.map((error) => error.location)).toEqual(["files[0].uri"]);
  });

  it("rejects an empty file list", () => {
    const errors = validateRequest([]);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("files");
    expect(errors[0]?.retryable).toBe(false);
  });

  it("rejects empty and whitespace-only file content", () => {
    const errors = validateRequest([
      { content: "" },
      { content: "  \n\t " },
      { content: 'domain = "demo"' },
    ]);

    expect(errors.map((error) => error.location)).toEqual(["files[0].content", "files[1].content"]);
    expect(errors.every((error) => error.class === "input_domain")).toBe(true);
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
