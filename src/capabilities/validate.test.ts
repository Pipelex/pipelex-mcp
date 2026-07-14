import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type {
  MthdsFile,
  PipelexInvalidReport,
  PipelexValidationReport,
  ValidateFilesOptions,
} from "@pipelex/sdk";

import { DEFAULT_API_URL } from "./shared.js";
import { toolResult, validateMthds, validationResult } from "./validate.js";

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

// Appended to the API's rendered markdown whenever a dry-run graph view is
// available. Kept in sync with `validationResult` in validate.ts.
const VIEWS_NOTE =
  "\n\n## Views\n\nThe validation result includes a graph view of the method (dry run).";

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
  it("projects runnable valid reports and carries the graph off structuredContent", () => {
    const result = validationResult(validReport, true);

    expect(result.structuredContent.status).toBe("ok");
    // The summary is the API markdown plus the appended Views note.
    expect(result.summary).toBe("# Valid" + VIEWS_NOTE);
    // The graph rides the view-only `graphSpec` field (delivered on `_meta`),
    // never `structuredContent` — the model reads the lean verdict only.
    expect(result.graphSpec).toEqual(validReport.graph_spec);
    // ...but the model still learns the graph view is available via this list.
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph"]);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.structuredContent).not.toHaveProperty("rendered_markdown");
  });

  it("omits graph when requested", () => {
    const result = validationResult(validReport, false);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.graphSpec).toBeUndefined();
    // No graph produced → no view advertised.
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
  });

  it("projects pending signatures as valid but not runnable", () => {
    const result = validationResult(pendingReport, true);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.pending_signatures).toEqual(["demo.todo"]);
    // A pending-signature bundle is still valid and carries a graph.
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph"]);
    expect(result.summary).toBe("# Valid" + VIEWS_NOTE);
  });

  it("projects invalid produced verdicts as ok with validation errors", () => {
    const result = validationResult(invalidReport, true);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.validation_errors).toEqual(invalidReport.validation_errors);
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.graphSpec).toBeUndefined();
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

describe("toolResult", () => {
  it("delivers the graph on _meta, never on structuredContent", () => {
    const result = toolResult(validationResult(validReport, true));

    expect(result._meta.graph_spec).toEqual(validReport.graph_spec);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "# Valid" + VIEWS_NOTE }]);
  });

  it("carries an undefined graph on _meta for verdicts without one", () => {
    const result = toolResult(validationResult(invalidReport, true));

    expect(result._meta.graph_spec).toBeUndefined();
    expect(result.isError).toBe(false);
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
        baseUrl: DEFAULT_API_URL,
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
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.graphSpec).toBeUndefined();
  });

  it("does not call the client when request validation fails", async () => {
    let called = false;

    const result = await validateMthds(
      {
        files: [],
      },
      {
        baseUrl: DEFAULT_API_URL,
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
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    expect(result.summary).toBe("Validation was not run: request input is invalid.");
  });

  it("treats a reachable but malformed report as runtime, not unreachable", async () => {
    const malformedReport = {
      ...validReport,
      rendered_markdown: null,
    } as unknown as PipelexValidationReport;

    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async validateFiles() {
            return malformedReport;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.summary).toMatch(/malformed/i);
    expect(result.summary).not.toMatch(/unreachable/i);
  });

  it("surfaces an unreachable API as config", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async validateFiles() {
            throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toMatch(/unreachable|misconfigured/i);
  });

  it("does not claim unreachable for an auth failure", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async validateFiles() {
            throw new ApiResponseError(
              "HTTP 401",
              `${DEFAULT_API_URL}/v1/validate`,
              401,
              "Unauthorized",
              "{}",
              "unauthorized",
              "Missing key",
              undefined, // validationErrors
              undefined, // code
            );
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toMatch(/misconfigured/i);
  });
});
