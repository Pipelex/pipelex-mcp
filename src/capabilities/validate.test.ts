import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError, PipelineRequestError } from "mthds";
import type {
  MthdsFile,
  PipelexInvalidReport,
  PipelexValidationReport,
  ValidateFilesOptions,
} from "mthds";

import { classifyError, validateMthds, validateRequest, validationResult } from "./validate.js";

const validReport: PipelexValidationReport = {
  is_valid: true,
  bundle_blueprint: { main_pipe: "main" },
  pipe_io_contracts: { "demo.main": { inputs: {}, output: "Text" } },
  graph_spec: { nodes: [{ id: "demo.main" }] },
  validated_pipes: [],
  pending_signatures: [],
  is_runnable: true,
  message: "ok",
  rendered_markdown: "# Valid",
};

const pendingReport: PipelexValidationReport = {
  ...validReport,
  pending_signatures: ["demo.todo"],
  is_runnable: false,
};

const invalidReport: PipelexInvalidReport = {
  is_valid: false,
  is_runnable: false,
  pending_signatures: [],
  message: "invalid",
  validation_errors: [
    {
      category: "blueprint_validation",
      message: "Unknown pipe type",
      source: "bundle.mthds",
    },
  ],
  rendered_markdown: "# Invalid",
};

describe("validationResult", () => {
  it("projects runnable valid reports and includes graph by default", () => {
    const result = validationResult(validReport, true);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.summary).toBe("# Valid");
    expect(result.structuredContent.graph_spec).toEqual(validReport.graph_spec);
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.structuredContent).not.toHaveProperty("rendered_markdown");
  });

  it("omits graph when requested", () => {
    const result = validationResult(validReport, false);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
  });

  it("projects pending signatures as valid but not runnable", () => {
    const result = validationResult(pendingReport, true);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.pending_signatures).toEqual(["demo.todo"]);
    expect(result.summary).toBe("# Valid");
  });

  it("projects invalid produced verdicts as ok with validation errors", () => {
    const result = validationResult(invalidReport, true);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.validation_errors).toEqual(invalidReport.validation_errors);
    expect(result.structuredContent).not.toHaveProperty("rendered_markdown");
    expect(result.summary).toBe("# Invalid");
  });

  it("throws when rendered markdown is missing", () => {
    const report = {
      ...validReport,
      rendered_markdown: null,
    } as unknown as PipelexValidationReport;

    expect(() => validationResult(report, true)).toThrow(/did not include rendered markdown/);
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
  });
});

describe("classifyError", () => {
  it("classifies unreachable API failures as config", () => {
    const error = classifyError(
      new ApiUnreachableError("connection refused", "http://localhost:8081", "ECONNREFUSED"),
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("MTHDS_API_URL");
  });

  it("classifies API request-shape responses as input_domain", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 422",
        "http://localhost:8081/v1/validate",
        422,
        "Unprocessable Entity",
        "{}",
        "validation_error",
        "Bad request body",
        undefined,
      ),
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("files");
    expect(error.message).toBe("Bad request body");
  });

  it("classifies auth responses as config", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 401",
        "http://localhost:8081/v1/validate",
        401,
        "Unauthorized",
        "{}",
        "unauthorized",
        "Missing key",
        undefined,
      ),
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("MTHDS_API_KEY");
  });

  it("classifies API server failures as runtime", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 500",
        "http://localhost:8081/v1/validate",
        500,
        "Internal Server Error",
        "{}",
        "internal",
        "Server fault",
        undefined,
      ),
    );

    expect(error.class).toBe("runtime");
    expect(error.message).toBe("Server fault");
  });

  it("classifies client request construction failures as config", () => {
    const error = classifyError(new PipelineRequestError("Invalid API base URL"));

    expect(error.class).toBe("config");
    expect(error.location).toBe("MTHDS_API_URL");
  });
});

describe("validateMthds", () => {
  it("maps MCP input to validateFiles and projects the response", async () => {
    let capturedFiles: MthdsFile[] | undefined;
    let capturedOptions: ValidateFilesOptions | undefined;

    const result = await validateMthds(
      {
        files: [
          { content: 'domain = "demo"', uri: "bundle.mthds" },
          { content: 'main_pipe = "main"', uri: null },
        ],
        include_graph: false,
      },
      {
        apiUrl: "http://localhost:8081",
        client: {
          async validateFiles(files, options) {
            capturedFiles = files;
            capturedOptions = options;
            return validReport;
          },
        },
      },
    );

    expect(capturedFiles).toEqual([
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { content: 'main_pipe = "main"' },
    ]);
    expect(capturedOptions).toEqual({
      allowSignatures: true,
      render: ["markdown"],
    });
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
  });

  it("does not call the client when request validation fails", async () => {
    let called = false;

    const result = await validateMthds(
      {
        files: [],
      },
      {
        apiUrl: "http://localhost:8081",
        client: {
          async validateFiles() {
            called = true;
            return validReport;
          },
        },
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    expect(result.summary).toBe("Validation was not run: request input is invalid.");
  });
});
