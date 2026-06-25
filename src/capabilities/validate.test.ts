import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ApiResponseError,
  ApiUnreachableError,
  PipelineRequestError,
} from "mthds";
import type {
  MthdsFile,
  PipelexInvalidReport,
  PipelexValidationReport,
  ValidateFilesOptions,
} from "mthds";

import {
  classifyError,
  validateMthds,
  validateRequest,
  validationEnvelope,
} from "./validate.js";

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

describe("validationEnvelope", () => {
  it("projects runnable valid reports and includes graph by default", () => {
    const envelope = validationEnvelope(validReport, true);

    assert.equal(envelope.status, "ok");
    assert.equal(envelope.summary, "Validation passed; the bundle is runnable.");
    assert.deepEqual(envelope.data?.graph_spec, validReport.graph_spec);
    assert.deepEqual(envelope.data?.pipe_io_contracts, validReport.pipe_io_contracts);
    assert.equal(envelope.data?.rendered_markdown, "# Valid");
  });

  it("omits graph when requested", () => {
    const envelope = validationEnvelope(validReport, false);

    assert.equal(envelope.status, "ok");
    assert.ok(!Object.hasOwn(envelope.data ?? {}, "graph_spec"));
  });

  it("projects pending signatures as valid but not runnable", () => {
    const envelope = validationEnvelope(pendingReport, true);

    assert.equal(envelope.status, "ok");
    assert.equal(envelope.data?.is_valid, true);
    assert.equal(envelope.data?.is_runnable, false);
    assert.deepEqual(envelope.data?.pending_signatures, ["demo.todo"]);
    assert.match(envelope.summary, /1 pending signature/);
  });

  it("projects invalid produced verdicts as ok with validation errors", () => {
    const envelope = validationEnvelope(invalidReport, true);

    assert.equal(envelope.status, "ok");
    assert.equal(envelope.data?.is_valid, false);
    assert.equal(envelope.data?.is_runnable, false);
    assert.deepEqual(envelope.data?.validation_errors, invalidReport.validation_errors);
    assert.equal(envelope.data?.rendered_markdown, "# Invalid");
    assert.match(envelope.summary, /found 1 error/);
  });
});

describe("validateRequest", () => {
  it("rejects empty files, empty URIs, and bundle_uri mismatches", () => {
    const errors = validateRequest(
      [
        { content: "domain = \"demo\"", uri: "" },
        { content: "domain = \"demo\"", uri: "bundle.mthds" },
      ],
      "missing.mthds",
    );

    assert.deepEqual(
      errors.map((error) => error.location),
      ["files[0].uri", "bundle_uri"],
    );
  });

  it("rejects an empty file list", () => {
    const errors = validateRequest([], undefined);

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.class, "input_domain");
    assert.equal(errors[0]?.location, "files");
  });
});

describe("classifyError", () => {
  it("classifies unreachable API failures as config", () => {
    const error = classifyError(
      new ApiUnreachableError("connection refused", "http://localhost:8081", "ECONNREFUSED"),
    );

    assert.equal(error.class, "config");
    assert.equal(error.location, "MTHDS_API_URL");
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

    assert.equal(error.class, "input_domain");
    assert.equal(error.location, "files");
    assert.equal(error.message, "Bad request body");
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

    assert.equal(error.class, "config");
    assert.equal(error.location, "MTHDS_API_KEY");
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

    assert.equal(error.class, "runtime");
    assert.equal(error.message, "Server fault");
  });

  it("classifies client request construction failures as config", () => {
    const error = classifyError(new PipelineRequestError("Invalid API base URL"));

    assert.equal(error.class, "config");
    assert.equal(error.location, "MTHDS_API_URL");
  });
});

describe("validateMthds", () => {
  it("maps MCP input to validateFiles and projects the response", async () => {
    let capturedFiles: MthdsFile[] | undefined;
    let capturedOptions: ValidateFilesOptions | undefined;

    const envelope = await validateMthds(
      {
        files: [
          { content: "domain = \"demo\"", uri: "bundle.mthds" },
          { content: "main_pipe = \"main\"", uri: null },
        ],
        bundle_uri: "bundle.mthds",
        allow_signatures: true,
        include_graph: false,
        render_markdown: true,
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

    assert.deepEqual(capturedFiles, [
      { content: "domain = \"demo\"", uri: "bundle.mthds" },
      { content: "main_pipe = \"main\"" },
    ]);
    assert.deepEqual(capturedOptions, {
      allowSignatures: true,
      render: ["markdown"],
    });
    assert.equal(envelope.status, "ok");
    assert.ok(!Object.hasOwn(envelope.data ?? {}, "graph_spec"));
  });

  it("does not call the client when request validation fails", async () => {
    let called = false;

    const envelope = await validateMthds(
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

    assert.equal(called, false);
    assert.equal(envelope.status, "error");
    assert.equal(envelope.errors?.[0]?.location, "files");
  });
});
