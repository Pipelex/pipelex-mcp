import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type { BuildInputsRequest, BuildInputsResponse } from "@pipelex/sdk";

import {
  buildMthdsInputs,
  inputsResult,
  inputsToolResult,
  validateInputsRequest,
} from "./inputs.js";
import { DEFAULT_API_URL } from "./shared.js";

const validJsonReport: BuildInputsResponse = {
  is_valid: true,
  pipe_ref: "demo.main",
  message: "Inputs template built.",
  format: "json",
  explicit: false,
  inputs: { question: "Your question here" },
};

const validTomlReport: BuildInputsResponse = {
  is_valid: true,
  pipe_ref: "demo.main",
  requested_pipe_ref: "demo.main",
  message: "Inputs template built.",
  format: "toml",
  explicit: true,
  inputs_toml: '# question (Text)\nquestion = "Your question here"\n',
};

const invalidReport: BuildInputsResponse = {
  is_valid: false,
  message: "The closure did not validate.",
  validation_errors: [
    {
      category: "blueprint_validation",
      message: "Unknown pipe type",
      source: "bundle.mthds",
    },
  ],
};

describe("inputsResult", () => {
  it("projects a json template with the resolved pipe", () => {
    const result = inputsResult(validJsonReport);

    expect(result.structuredContent).toEqual({
      status: "ok",
      is_valid: true,
      pipe_ref: "demo.main",
      format: "json",
      explicit: false,
      inputs: { question: "Your question here" },
    });
    expect(result.structuredContent).not.toHaveProperty("inputs_toml");
    // The summary deliberately duplicates the template: it is the payload the
    // model must read, unlike validation's large view-only graph.
    expect(result.summary).toContain("Resolved pipe: `demo.main`");
    expect(result.summary).toContain("```json");
    expect(result.summary).toContain('"question": "Your question here"');
  });

  it("projects a toml template as raw text", () => {
    const result = inputsResult(validTomlReport);

    expect(result.structuredContent.format).toBe("toml");
    expect(result.structuredContent.explicit).toBe(true);
    expect(result.structuredContent.inputs_toml).toBe(
      '# question (Text)\nquestion = "Your question here"\n',
    );
    expect(result.structuredContent).not.toHaveProperty("inputs");
    expect(result.summary).toContain("```toml");
    expect(result.summary).toContain('question = "Your question here"');
  });

  it("projects invalid produced verdicts as ok with validation errors", () => {
    const result = inputsResult(invalidReport);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.validation_errors).toEqual(
      (invalidReport as { validation_errors: unknown[] }).validation_errors,
    );
    expect(result.structuredContent).not.toHaveProperty("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("inputs");
    expect(result.summary).toContain("Inputs template not produced");
    expect(result.summary).toContain("Unknown pipe type");
    expect(result.summary).toContain("bundle.mthds");
  });

  it("throws when the valid arm is missing its template field", () => {
    const malformed = { ...validJsonReport, inputs: undefined } as unknown as BuildInputsResponse;

    expect(() => inputsResult(malformed)).toThrow(/did not include the json template/);
  });
});

describe("inputsToolResult", () => {
  it("carries the summary as content with no _meta channel", () => {
    const result = inputsToolResult(inputsResult(validJsonReport));

    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: inputsResult(validJsonReport).summary }]);
    expect(result.isError).toBe(false);
    expect(result).not.toHaveProperty("_meta");
  });

  it("flags no-verdict results as errors", () => {
    const result = inputsToolResult({
      structuredContent: { status: "error", is_valid: false, errors: [] },
      summary: "failed",
    });

    expect(result.isError).toBe(true);
  });
});

describe("validateInputsRequest", () => {
  it("inherits the shared files checks", () => {
    const errors = validateInputsRequest({ files: [] });

    expect(errors.map((error) => error.location)).toEqual(["files"]);
  });

  it("rejects a blank pipe_ref", () => {
    const errors = validateInputsRequest({
      files: [{ content: 'domain = "demo"' }],
      pipe_ref: "  ",
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("pipe_ref");
  });

  it("accepts a qualified pipe_ref", () => {
    const errors = validateInputsRequest({
      files: [{ content: 'domain = "demo"' }],
      pipe_ref: "demo.main",
    });

    expect(errors).toEqual([]);
  });
});

describe("buildMthdsInputs", () => {
  it("maps MCP input to the build envelope with defaults pinned", async () => {
    let capturedRequest: BuildInputsRequest | undefined;

    const result = await buildMthdsInputs(
      {
        files: [
          { content: 'domain = "demo"', uri: "bundle.mthds" },
          { content: 'main_pipe = "main"', uri: null },
        ],
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async buildInputs(request) {
            capturedRequest = request;
            return validJsonReport;
          },
        },
      },
    );

    // The MCP surface spells provenance `uri`; the build envelope spells it
    // `source`. Defaults are sent explicitly: format json, light shape.
    expect(capturedRequest).toEqual({
      files: [
        { content: 'domain = "demo"', source: "bundle.mthds" },
        { content: 'main_pipe = "main"' },
      ],
      format: "json",
      explicit: false,
    });
    expect(capturedRequest).not.toHaveProperty("pipe_ref");
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.inputs).toEqual({ question: "Your question here" });
  });

  it("forwards pipe_ref, format, and explicit when supplied", async () => {
    let capturedRequest: BuildInputsRequest | undefined;

    await buildMthdsInputs(
      {
        files: [{ content: 'domain = "demo"' }],
        pipe_ref: "demo.main",
        format: "toml",
        explicit: true,
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async buildInputs(request) {
            capturedRequest = request;
            return validTomlReport;
          },
        },
      },
    );

    expect(capturedRequest).toEqual({
      files: [{ content: 'domain = "demo"' }],
      pipe_ref: "demo.main",
      format: "toml",
      explicit: true,
    });
  });

  it("does not call the client when request validation fails", async () => {
    let called = false;

    const result = await buildMthdsInputs(
      { files: [] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async buildInputs() {
            called = true;
            return validJsonReport;
          },
        },
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    expect(result.summary).toBe("Inputs template was not run: request input is invalid.");
  });

  it("surfaces an unknown pipe_ref rejection as a pipe_ref-located input_domain error", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }], pipe_ref: "demo.missing" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async buildInputs() {
            throw new ApiResponseError(
              "HTTP 422",
              `${DEFAULT_API_URL}/v1/build/inputs`,
              422,
              "Unprocessable Entity",
              "{}",
              "validation_error",
              "Unknown pipe: demo.missing",
              undefined, // validationErrors
              undefined, // code
            );
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.summary).toMatch(/rejected/i);
  });

  it("surfaces an unreachable API as config", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async buildInputs() {
            throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toMatch(/unreachable|misconfigured/i);
  });

  it("treats a reachable but malformed report as runtime, not unreachable", async () => {
    const malformed = { ...validJsonReport, inputs: undefined } as unknown as BuildInputsResponse;

    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async buildInputs() {
            return malformed;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.summary).toMatch(/malformed/i);
    expect(result.summary).not.toMatch(/unreachable/i);
  });
});

describe("buildMthdsInputs path submissions", () => {
  it("resolves { path } items through the context resolver, with the path as source", async () => {
    let capturedRequest: BuildInputsRequest | undefined;

    const result = await buildMthdsInputs(
      { files: [{ path: "methods/bundle.mthds" }] },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: {
          async resolve(path) {
            return { ok: true, content: 'domain = "demo"' + `\n# ${path}` };
          },
        },
        client: {
          async buildInputs(request) {
            capturedRequest = request;
            return validJsonReport;
          },
        },
      },
    );

    // The resolved uri (= the submitted path) crosses into the build
    // envelope's `source` label, so diagnostics locate to the real file.
    expect(capturedRequest?.files).toEqual([
      { content: 'domain = "demo"\n# methods/bundle.mthds', source: "methods/bundle.mthds" },
    ]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    let called = false;

    const result = await buildMthdsInputs(
      { files: [{ path: "methods/bundle.mthds" }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async buildInputs() {
            called = true;
            return validJsonReport;
          },
        },
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files[0].path");
    expect(result.summary).toBe("Inputs template was not run: request input is invalid.");
  });
});
