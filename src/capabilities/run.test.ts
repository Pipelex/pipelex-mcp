import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiResponseError, ApiUnreachableError, MissingMainStuffError } from "@pipelex/sdk";
import type {
  InputForm,
  MethodProvenance,
  OutputForm,
  PipeIOContracts,
  PipelexValidationReport,
  PipelexValidationResult,
  RunRead,
  RunResults,
  RunResultStart,
  RunResultState,
  RunStatus,
  PipelexStartOptions,
  TokensUsageRecord,
  UsageSummary,
  ValidateMethodSelector,
} from "@pipelex/sdk";

import {
  boundMainStuff,
  ELLIPSIS_MARKER,
  getMthdsRunResults,
  getMthdsRunStatus,
  MAIN_STUFF_CAP,
  projectRunUsage,
  projectUsageByPipe,
  resultsResult,
  runIdInputSchemaFor,
  runResultsOutputSchemaFor,
  runStartOutputSchemaFor,
  RUN_RESULTS_ERROR_OPTIONS,
  RUN_START_ERROR_OPTIONS,
  RUN_STATUS_ERROR_OPTIONS,
  runResultsToolResult,
  startMthdsRun,
  startPipelexRun,
  startResult,
  statusResult,
  validateRunRequest,
} from "./run.js";
import type { PipelexRunContext, RunContext } from "./run.js";
import { classifyError, DEFAULT_API_URL, MAX_IMAGE_CANDIDATE_ENTRIES } from "./shared.js";
import { CONSOLE_TOOL_NAMES } from "./tool-names.js";

const RUN_ID = "01JRUN0000000000000000TEST";

function runRead(overrides: Partial<RunRead> = {}): RunRead {
  return {
    pipeline_run_id: RUN_ID,
    status: "RUNNING",
    created_at: "2026-07-15T10:00:00Z",
    degraded: false,
    ...overrides,
  };
}

/**
 * A minimal but REAL trio of I/O artifacts for one pipe. The protocol types are
 * closed shapes, so these are typed rather than cast: a literal that drifts
 * from the standard fails the build here instead of passing a test the wire
 * would reject.
 */
const FIXTURE_PIPE_REF = "demo.main";
const CONTRACTS: PipeIOContracts = {
  [FIXTURE_PIPE_REF]: {
    inputs: {},
    output: {
      concept_ref: "native.Text",
      json_schema: { type: "object", properties: { text: { type: "string" } } },
      multiplicity: "single",
      item_count: null,
      optional: false,
    },
  },
};
const OUTPUT_FORM: OutputForm = {
  [FIXTURE_PIPE_REF]: {
    field: { name: "result", kind: "text", required: true, concept_ref: "native.Text" },
  },
};
const INPUT_FORM: InputForm = { [FIXTURE_PIPE_REF]: { fields: [] } };

describe("validateRunRequest", () => {
  it("rejects an empty file list", () => {
    const errors = validateRunRequest({ files: [] });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("files");
  });

  it("accepts a method_id-only request", () => {
    expect(validateRunRequest({ files: [], method_id: "mt_abc123" })).toEqual([]);
  });

  it("rejects a blank method_id at method_id", () => {
    const errors = validateRunRequest({ files: [], method_id: "  " });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("method_id");
  });

  it("rejects a blank pipe_code", () => {
    const errors = validateRunRequest({
      files: [{ content: 'domain = "demo"' }],
      pipe_code: "  ",
    });

    expect(errors.map((error) => error.location)).toEqual(["pipe_code"]);
    expect(errors[0]?.class).toBe("input_domain");
  });

  it("accepts an omitted pipe_code", () => {
    const errors = validateRunRequest({ files: [{ content: 'domain = "demo"' }] });

    expect(errors).toEqual([]);
  });
});

describe("run-route error classification", () => {
  it("classifies a 404 on the run routes as an unknown run id (input_domain)", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 404",
        `${DEFAULT_API_URL}/v1/runs/${RUN_ID}/status`,
        404,
        "Not Found",
        "{}",
        "not_found",
        "Run not found",
        undefined, // validationErrors
        undefined, // code
      ),
      RUN_STATUS_ERROR_OPTIONS,
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("run_id");
    expect(error.message).toBe("Run not found");
  });

  it("keeps the missing-route 404 arm (config) on the start route", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 404",
        `${DEFAULT_API_URL}/v1/start`,
        404,
        "Not Found",
        "{}",
        "not_found",
        "Not found",
        undefined, // validationErrors
        undefined, // code
      ),
      RUN_START_ERROR_OPTIONS,
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
    expect(error.hint).toContain("/v1/start");
  });

  it("points a start-route 5xx at the recoverable causes first", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 503",
        `${DEFAULT_API_URL}/v1/start`,
        503,
        "Service Unavailable",
        "{}",
        "pipeline_start_unavailable",
        "Failed to start pipeline",
        undefined, // validationErrors
        undefined, // code
      ),
      RUN_START_ERROR_OPTIONS,
    );

    // The hosted /v1/start answers 503 for an invalid bundle too — the hint
    // must point at validation before blaming the platform.
    expect(error.class).toBe("runtime");
    expect(error.hint).toMatch(/mthds_validate/);
  });

  it("points a start-route 422 at the run request fields", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 422",
        `${DEFAULT_API_URL}/v1/start`,
        422,
        "Unprocessable Entity",
        "{}",
        "validation_error",
        "Invalid bundle",
        undefined, // validationErrors
        undefined, // code
      ),
      RUN_START_ERROR_OPTIONS,
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("files");
    expect(error.hint).toMatch(/mthds_validate/);
  });

  it("points a 400/422 on the run-id routes at run_id, not files", () => {
    const routes: Array<[string, typeof RUN_STATUS_ERROR_OPTIONS]> = [
      ["/v1/runs/not-a-run-id/status", RUN_STATUS_ERROR_OPTIONS],
      ["/v1/runs/not-a-run-id/results", RUN_RESULTS_ERROR_OPTIONS],
    ];
    for (const [route, options] of routes) {
      const error = classifyError(
        new ApiResponseError(
          "HTTP 422",
          `${DEFAULT_API_URL}${route}`,
          422,
          "Unprocessable Entity",
          "{}",
          "validation_error",
          "Invalid run id",
          undefined, // validationErrors
          undefined, // code
        ),
        options,
      );

      expect(error.class).toBe("input_domain");
      expect(error.location).toBe("run_id");
      expect(error.hint).toMatch(/mthds_run/);
    }
  });
});

describe("startResult", () => {
  it("projects a hosted start ack with its extension fields", () => {
    const ack: RunResultStart = {
      pipeline_run_id: RUN_ID,
      state: "STARTED",
      created_at: "2026-07-15T10:00:00Z",
      workflow_id: "wf-123",
    };

    const result = startResult(ack);

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      run_status: "STARTED",
      created_at: "2026-07-15T10:00:00Z",
      available_view_specs: ["live_run_status"],
    });
    expect(result.summary).toContain(RUN_ID);
    expect(result.summary).toContain("mthds_run_status");
    expect(result.summary).toContain("mthds_run_results");
    expect(result.summary).toContain("## Views");
  });

  it("projects method_provenance and narrates the resolved snapshot", () => {
    const result = startResult({
      pipeline_run_id: RUN_ID,
      method_provenance: {
        address: "github.com/Pipelex/methods/documents",
        tag: "v0.1.0",
        commit_sha: "abc123def456",
      },
    });

    expect(result.structuredContent.method_provenance).toEqual({
      address: "github.com/Pipelex/methods/documents",
      tag: "v0.1.0",
      commit_sha: "abc123def456",
    });
    expect(result.summary).toContain("github.com/Pipelex/methods/documents");
    expect(result.summary).toContain("v0.1.0");
    expect(result.summary).toContain("abc123def456");
  });

  it("narrates a tagless resolution without inventing a tag", () => {
    const result = startResult({
      pipeline_run_id: RUN_ID,
      method_provenance: {
        address: "github.com/Pipelex/methods/documents",
        tag: null,
        commit_sha: "abc123def456",
      },
    });

    expect(result.structuredContent.method_provenance?.tag).toBeNull();
    expect(result.summary).not.toContain("at tag");
  });

  it("drops a malformed method_provenance extension instead of guessing", () => {
    const result = startResult({
      pipeline_run_id: RUN_ID,
      method_provenance: {
        address: "github.com/x/y",
        commit_sha: 42,
      } as unknown as MethodProvenance,
    });

    expect(result.structuredContent).not.toHaveProperty("method_provenance");
  });

  it("tolerates a bare protocol ack with no extensions", () => {
    const result = startResult({ pipeline_run_id: RUN_ID });

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
    expect(result.structuredContent).not.toHaveProperty("run_status");
    expect(result.structuredContent).not.toHaveProperty("created_at");
  });

  it("does not advertise or narrate a live card when the invoking shell has no views", () => {
    const result = startResult({ pipeline_run_id: RUN_ID }, false);

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.summary).not.toContain("## Views");
    expect(result.summary).not.toContain("live status card");
  });

  it("drops an unrecognized state extension instead of guessing", () => {
    const result = startResult({ pipeline_run_id: RUN_ID, state: "WARMING_UP" });

    expect(result.structuredContent).not.toHaveProperty("run_status");
  });
});

describe("statusResult", () => {
  it("projects a non-terminal status with the retry hint passed through", () => {
    const result = statusResult(runRead({ status: "RUNNING", retry_after_seconds: 5 }));

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      run_status: "RUNNING",
      is_terminal: false,
      degraded: false,
      retry_after_seconds: 5,
      created_at: "2026-07-15T10:00:00Z",
    });
    expect(result.summary).toContain("~5s");
  });

  it("suggests a default check-again delay when the server sends no hint", () => {
    const result = statusResult(runRead({ status: "PENDING" }));

    expect(result.structuredContent).not.toHaveProperty("retry_after_seconds");
    expect(result.summary).toMatch(/check again in ~\d+s/i);
  });

  it("projects a completed run as terminal and points at mthds_run_results", () => {
    const result = statusResult(
      runRead({ status: "COMPLETED", finished_at: "2026-07-15T10:05:00Z" }),
    );

    expect(result.structuredContent.run_status).toBe("COMPLETED");
    expect(result.structuredContent.is_terminal).toBe(true);
    expect(result.structuredContent.finished_at).toBe("2026-07-15T10:05:00Z");
    expect(result.summary).toContain("mthds_run_results");
    expect(result.summary).not.toMatch(/check again/i);
  });

  it("projects a failed run as a produced ok verdict, not an error", () => {
    const result = statusResult(runRead({ status: "FAILED" }));

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_status).toBe("FAILED");
    expect(result.structuredContent.is_terminal).toBe(true);
    expect(result.structuredContent).not.toHaveProperty("errors");
  });

  it("derives is_terminal from the whole RunStatus set", () => {
    const expectations: Array<[RunStatus, boolean]> = [
      ["PENDING", false],
      ["STARTED", false],
      ["RUNNING", false],
      ["COMPLETED", true],
      ["FAILED", true],
      ["CANCELLED", true],
      ["TERMINATED", true],
      ["TIMED_OUT", true],
    ];

    for (const [status, isTerminal] of expectations) {
      expect(statusResult(runRead({ status })).structuredContent.is_terminal).toBe(isTerminal);
    }
  });

  it("flags a degraded read without alarming the summary", () => {
    const result = statusResult(
      runRead({ status: "RUNNING", degraded: true, retry_after_seconds: 10 }),
    );

    expect(result.structuredContent.degraded).toBe(true);
    expect(result.structuredContent.retry_after_seconds).toBe(10);
    expect(result.summary).toMatch(/last-known/i);
  });
});

describe("resultsResult", () => {
  it("projects a running lookup as a produced ok verdict with the retry hint", () => {
    const result = resultsResult({
      state: "running",
      pipeline_run_id: RUN_ID,
      retry_after_seconds: 3,
    });

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "running",
      retry_after_seconds: 3,
      available_view_specs: [],
    });
    expect(result.summary).toContain("~3s");
    expect(result.graphSpec).toBeUndefined();
    expect(result.mainStuff).toBeUndefined();
  });

  it("names mthds_download_artifacts on every completed workshop result, and never on the console", () => {
    const withFiles = {
      state: "completed" as const,
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: {
          url: "pipelex-storage://runs/x/illustration.png",
          public_url: "https://signed.example/illustration.png?X-Amz-Expires=3600",
        },
      },
    };
    const withoutFiles = {
      ...withFiles,
      result: { pipeline_run_id: RUN_ID, main_stuff: { answer: 42 } },
    };

    // The workshop: files produced → the nudge, output and files, with the expiry stated.
    const workshop = resultsResult(withFiles, false, true);
    expect(workshop.summary).toContain("mthds_download_artifacts");
    expect(workshop.summary).toContain("main_stuff.json");
    expect(workshop.summary).toContain("1 stored file(s)");
    expect(workshop.summary).toContain("expire");
    // The nudge is prose only — the structured contract is untouched.
    expect(workshop.structuredContent).not.toHaveProperty("artifacts");

    // The workshop, nothing produced → still the way to keep the output, since
    // a model that does not know the tool retypes the output into a file.
    const outputOnly = resultsResult(withoutFiles, false, true).summary;
    expect(outputOnly).toContain("mthds_download_artifacts");
    expect(outputOnly).toContain("main_stuff.json");
    expect(outputOnly).toContain("Never retype it");
    expect(outputOnly).not.toContain("stored file(s)");
    // The console has no such tool → silent even with files.
    expect(resultsResult(withFiles, true, false).summary).not.toContain("mthds_download_artifacts");
    expect(resultsResult(withFiles).summary).not.toContain("mthds_download_artifacts");
  });

  it("lists the image candidates on both shells, for free, from the FULL output", () => {
    const picture = "pipelex-storage://runs/x/illustration.png";
    const report = "pipelex-storage://runs/x/report.pdf";
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: { cover: { url: picture }, appendix: { url: report } },
      },
    };

    // The console (no download tool) gets the same structured list as the workshop.
    for (const result of [resultsResult(state, true, false), resultsResult(state, false, true)]) {
      // Bare references: the key beside them was a fixed-prefix strip of the
      // reference itself, so it doubled the list's cost and said nothing new.
      expect(result.structuredContent.image_candidates).toEqual([picture]);
      expect(result.structuredContent).not.toHaveProperty("image_candidates_omitted");
    }

    const summary = resultsResult(state, true, false).summary;
    expect(summary).toContain("2 stored file(s)");
    expect(summary).toContain("1 of which look like images");
    expect(summary).toContain("mthds_show_images");
    // Nothing was fetched to say it, and nothing is inlined here.
    expect(summary).not.toContain("mthds_download_artifacts");
  });

  it("survives a main output bounded away from its references", () => {
    const picture = "pipelex-storage://runs/x/illustration.png";
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        // Big enough that the prune ladder cuts the reference out of the
        // model-facing copy; the candidate list still finds it.
        main_stuff: { filler: "x".repeat(MAIN_STUFF_CAP * 2), cover: { url: picture } },
      },
    };

    const result = resultsResult(state, false, true);

    expect(result.structuredContent.truncated).toBe(true);
    expect(result.structuredContent.image_candidates).toEqual([picture]);
  });

  it("bounds the candidate inventory and counts what it left out", () => {
    // The walk reads the FULL output deliberately, so an unbounded projection
    // of it was model-facing content outside the MAIN_STUFF_CAP discipline
    // main_stuff obeys beside it — round 1's three-reviewer finding.
    const pictures = Array.from(
      { length: MAX_IMAGE_CANDIDATE_ENTRIES + 9 },
      (_unused, index) => `pipelex-storage://runs/x/frame-${index}.png`,
    );
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: pictures.map((url) => ({ url })),
      },
    };

    const result = resultsResult(state, false, true);

    expect(result.structuredContent.image_candidates).toHaveLength(MAX_IMAGE_CANDIDATE_ENTRIES);
    // A prefix, so an index into this list means the same thing it means to
    // mthds_show_images, which still walks the whole set.
    expect(result.structuredContent.image_candidates).toEqual(
      pictures.slice(0, MAX_IMAGE_CANDIDATE_ENTRIES),
    );
    expect(result.structuredContent.image_candidates_omitted).toBe(9);
  });

  it("says nothing of files, and omits the member, when the output references no stored file", () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: { answer: 42 } },
    };

    const result = resultsResult(state, true, false);

    expect(result.structuredContent).not.toHaveProperty("image_candidates");
    expect(result.summary).not.toContain("mthds_show_images");
    expect(result.summary).not.toContain("stored file(s)");
  });

  it("names the download tool as the way to read a truncated output, on the workshop only", () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: { memo: "x".repeat(MAIN_STUFF_CAP * 2) } },
    };

    const workshop = resultsResult(state, false, true);
    expect(workshop.structuredContent.truncated).toBe(true);
    expect(workshop.summary).toContain("truncated to fit the response");
    expect(workshop.summary).toContain("saves all of it to disk");
    // One mention, not two: without files, the truncation sentence is the save note.
    expect(workshop.summary.split("mthds_download_artifacts")).toHaveLength(2);

    // The console keeps its own sentences: the views hold the full output, the model does not.
    const hosted = resultsResult(state, true, false);
    expect(hosted.summary).toContain("the full output is available to views");
    expect(hosted.summary).not.toContain("mthds_download_artifacts");
    expect(resultsResult(state, false, false).summary).not.toContain("mthds_download_artifacts");
  });

  it("reports stored files that look like nothing without naming the image tool", () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: { doc: { url: "pipelex-storage://runs/x/report.pdf" } },
      },
    };

    const result = resultsResult(state, false, true);

    expect(result.structuredContent.image_candidates).toEqual([]);
    expect(result.summary).toContain("none of them looks like an image");
    expect(result.summary).not.toContain("mthds_show_images");
    expect(result.summary).toContain("mthds_download_artifacts");
  });

  it("projects a completed run and carries graph + full output off structuredContent", () => {
    const mainStuff = { answer: 42, items: ["a", "b"] };
    const graphSpec = { nodes: [{ id: "demo.main" }] };
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: mainStuff, graph_spec: graphSpec },
    });

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.state).toBe("completed");
    expect(result.structuredContent.main_stuff).toEqual(mainStuff);
    expect(result.structuredContent.truncated).toBe(false);
    expect(result.structuredContent.available_view_specs).toEqual(["run_graph"]);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.graphSpec).toEqual(graphSpec);
    expect(result.mainStuff).toBe(mainStuff);
    expect(result.summary).toContain("```json");
    expect(result.summary).toContain('"answer": 42');
    // No tokens_usages on the wire → usage reads "unavailable", nothing on _meta.
    expect(result.structuredContent.usage).toEqual({
      state: "unavailable",
      cost_usd: null,
      tokens: null,
      calls: 0,
      assembly_error: null,
    });
    expect(result.tokensUsages).toBeUndefined();
    expect(result.summary).not.toContain("## Usage");
  });

  it("carries the graph's data artifacts off structuredContent when both halves have entries", () => {
    const contracts = CONTRACTS;
    const outputForm = OUTPUT_FORM;
    const inputForm = INPUT_FORM;
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: "done",
        graph_spec: { nodes: [{ id: "demo.main" }] },
        pipe_io_contracts: contracts,
        output_form: outputForm,
        input_form: inputForm,
      },
    });

    expect(result.pipeIoContracts).toEqual(contracts);
    expect(result.outputForm).toEqual(outputForm);
    expect(result.inputForm).toEqual(inputForm);
    // Never the model-facing channel — these are view-only, like the graph.
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.structuredContent).not.toHaveProperty("output_form");
    expect(result.structuredContent).not.toHaveProperty("input_form");
  });

  it("withholds both halves of the pair when only one arrived", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: "done",
        graph_spec: { nodes: [{ id: "demo.main" }] },
        pipe_io_contracts: CONTRACTS,
        output_form: null,
      },
    });

    // The renderer reads them together or not at all, so half the pair renders
    // exactly like neither — shipping the contracts alone would only cost wire.
    expect(result.pipeIoContracts).toBeUndefined();
    expect(result.outputForm).toBeUndefined();
    // The graph itself is unaffected: it still rides and is still advertised.
    expect(result.graphSpec).toEqual({ nodes: [{ id: "demo.main" }] });
    expect(result.structuredContent.available_view_specs).toEqual(["run_graph"]);
  });

  it("treats an empty artifact map as no artifact", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: "done",
        graph_spec: { nodes: [{ id: "demo.main" }] },
        pipe_io_contracts: {},
        output_form: {},
      },
    });

    // A map the view can look nothing up in drives nothing.
    expect(result.pipeIoContracts).toBeUndefined();
    expect(result.outputForm).toBeUndefined();
  });

  it("rides the pair without an input form, which is independently optional", () => {
    const contracts = CONTRACTS;
    const outputForm = OUTPUT_FORM;
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: "done",
        graph_spec: { nodes: [{ id: "demo.main" }] },
        pipe_io_contracts: contracts,
        output_form: outputForm,
      },
    });

    expect(result.pipeIoContracts).toEqual(contracts);
    expect(result.outputForm).toEqual(outputForm);
    // Only the method's own input nodes lose their value; the rest still render.
    expect(result.inputForm).toBeUndefined();
  });

  it("withholds the data artifacts from a shell with no views", () => {
    const result = resultsResult(
      {
        state: "completed",
        pipeline_run_id: RUN_ID,
        result: {
          pipeline_run_id: RUN_ID,
          main_stuff: "done",
          graph_spec: { nodes: [{ id: "demo.main" }] },
          pipe_io_contracts: CONTRACTS,
          output_form: OUTPUT_FORM,
          input_form: INPUT_FORM,
        },
      },
      false,
    );

    // They exist to feed a renderer this shell does not have.
    expect(result.pipeIoContracts).toBeUndefined();
    expect(result.outputForm).toBeUndefined();
    expect(result.inputForm).toBeUndefined();
  });

  it("does not advertise a view but preserves full result metadata when the shell has no views", () => {
    const mainStuff = { answer: "x".repeat(MAIN_STUFF_CAP * 2) };
    const result = resultsResult(
      {
        state: "completed",
        pipeline_run_id: RUN_ID,
        result: {
          pipeline_run_id: RUN_ID,
          main_stuff: mainStuff,
          graph_spec: { nodes: [{ id: "demo.main" }] },
        },
      },
      false,
    );

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.truncated).toBe(true);
    expect(result.graphSpec).toBeUndefined();
    expect(result.mainStuff).toBe(mainStuff);
  });

  it("keeps a falsy-but-present main output as a valid completed result", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: [] },
    });

    expect(result.structuredContent.main_stuff).toEqual([]);
    expect(result.structuredContent.truncated).toBe(false);
  });

  it("advertises no view when the completed result carries no graph", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", graph_spec: null },
    });

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.graphSpec).toBeUndefined();
  });

  it("bounds a huge completed output and keeps the full copy for the view", () => {
    const mainStuff = {
      report: Array.from({ length: 3000 }, (_, index) => ({
        index,
        text: `item ${index} `.repeat(5),
      })),
    };
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: mainStuff },
    });

    expect(result.structuredContent.truncated).toBe(true);
    expect(JSON.stringify(result.structuredContent.main_stuff).length).toBeLessThanOrEqual(
      MAIN_STUFF_CAP,
    );
    expect(result.mainStuff).toBe(mainStuff);
    expect(result.summary).toMatch(/truncated/i);
  });

  it("projects run-level usage in structuredContent, per-pipe only off it, and no usage prose", () => {
    const tokensUsages: TokensUsageRecord[] = [
      {
        pipe_code: "extract",
        cost: 0.018,
        nb_tokens_by_category: { input: 6000, input_cached: 2000, output: 3000 },
      },
      { pipe_code: "summarize", cost: 0.005, nb_tokens_by_category: { input: 2500, output: 1000 } },
    ];
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", tokens_usages: tokensUsages },
    });

    const usage = result.structuredContent.usage;
    // Run-level totals only; input_cached (a subset of input) is excluded: 9000 + 3500 = 12500.
    expect(usage?.state).toBe("records");
    expect(usage?.cost_usd).toBeCloseTo(0.023, 10);
    expect(usage?.tokens).toBe(12500);
    expect(usage?.calls).toBe(2);
    expect(usage).not.toHaveProperty("cost_partial");
    expect(usage?.assembly_error).toBeNull();
    // Per-pipe is deliberately absent from the model-facing structuredContent.
    expect(usage).not.toHaveProperty("by_pipe");
    expect(usage).not.toHaveProperty("by_pipe_truncated");
    // Per-pipe rollup + full per-call list ride the result (→ _meta), never structuredContent.
    expect(result.tokensUsages).toBe(tokensUsages);
    expect(result.usageByPipe).toEqual([
      { pipe_code: "extract", cost_usd: 0.018, tokens: 9000, calls: 1 },
      { pipe_code: "summarize", cost_usd: 0.005, tokens: 3500, calls: 1 },
    ]);
    // Usage never appears in the prose summary.
    expect(result.summary).not.toContain("Usage");
    expect(result.summary).not.toContain("$0.02");
    expect(result.summary).not.toContain("tokens");
  });

  it("reads usage as unavailable, and keeps the completed result, when the run reported none", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", tokens_usages: null },
    });

    expect(result.structuredContent.state).toBe("completed");
    expect(result.structuredContent.usage?.state).toBe("unavailable");
    expect(result.structuredContent.usage?.assembly_error).toBeNull();
    expect(result.tokensUsages).toBeUndefined();
    expect(result.usageByPipe).toBeUndefined();
  });

  it("hard-errors when a completed result is missing its main output", () => {
    const state = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID },
    } as unknown as RunResultState;

    expect(() => resultsResult(state)).toThrow(/main_stuff/);
  });

  it("projects a failed run as a produced ok verdict with the failure details", () => {
    const result = resultsResult({
      state: "failed",
      pipeline_run_id: RUN_ID,
      status: "FAILED",
      message: "Pipe demo.main raised.",
    });

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "failed",
      run_status: "FAILED",
      failure_message: "Pipe demo.main raised.",
      available_view_specs: [],
    });
    expect(result.summary).toContain("FAILED");
    expect(result.summary).toContain("Pipe demo.main raised.");
    expect(result.summary).toMatch(/no graph/i);
  });
});

describe("projectRunUsage", () => {
  function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
    return {
      state: "records",
      total_cost_usd: 0.03,
      cost_partial: false,
      tokens: { input: 100, output: 50 },
      calls: 2,
      assembly_error: null,
      by_pipe: [],
      ...overrides,
    };
  }

  it("keeps this tool's field names over the SDK's summary, with the state first", () => {
    expect(projectRunUsage(summary())).toEqual({
      state: "records",
      cost_usd: 0.03,
      tokens: 150,
      calls: 2,
      assembly_error: null,
    });
  });

  it("adds the input and output totals into one figure, null only when both are null", () => {
    expect(projectRunUsage(summary({ tokens: { input: 100, output: null } })).tokens).toBe(100);
    expect(projectRunUsage(summary({ tokens: { input: null, output: 7 } })).tokens).toBe(7);
    expect(projectRunUsage(summary({ tokens: { input: null, output: null } })).tokens).toBeNull();
    expect(projectRunUsage(summary({ tokens: { input: 0, output: 0 } })).tokens).toBe(0);
  });

  it("reads a blank assembly error as no error", () => {
    // The SDK relays the runner's field verbatim; a non-null value here means
    // "assembly failed", so a runner reporting an empty string must not be
    // reported as a run whose usage assembly broke.
    expect(
      projectRunUsage(summary({ state: "unavailable", assembly_error: "" })).assembly_error,
    ).toBeNull();
    expect(
      projectRunUsage(summary({ state: "unavailable", assembly_error: "   " })).assembly_error,
    ).toBeNull();
    expect(
      projectRunUsage(summary({ state: "unavailable", assembly_error: "collector timed out" }))
        .assembly_error,
    ).toBe("collector timed out");
  });

  it("carries cost_partial only when it is true", () => {
    expect(projectRunUsage(summary({ cost_partial: true })).cost_partial).toBe(true);
    expect(projectRunUsage(summary())).not.toHaveProperty("cost_partial");
  });

  it("never carries the per-pipe rollup — that rides _meta only", () => {
    const usage = projectRunUsage(
      summary({
        by_pipe: [
          {
            pipe_code: "a",
            total_cost_usd: 0.03,
            cost_partial: false,
            tokens: { input: 100, output: 50 },
            calls: 2,
          },
        ],
      }),
    );

    expect(usage).not.toHaveProperty("by_pipe");
  });
});

describe("projectUsageByPipe", () => {
  it("projects each SDK row onto this tool's row shape, keeping the SDK's order", () => {
    expect(
      projectUsageByPipe([
        {
          pipe_code: "pricey",
          total_cost_usd: 0.07,
          cost_partial: false,
          tokens: { input: 140, output: 60 },
          calls: 2,
        },
        {
          pipe_code: null,
          total_cost_usd: null,
          cost_partial: false,
          tokens: { input: null, output: null },
          calls: 1,
        },
      ]),
    ).toEqual([
      { pipe_code: "pricey", cost_usd: 0.07, tokens: 200, calls: 2 },
      { pipe_code: null, cost_usd: null, tokens: null, calls: 1 },
    ]);
  });
});

describe("usage through the SDK's summarizeUsage", () => {
  function completedWith(overrides: Partial<RunResults>) {
    return resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", ...overrides },
    });
  }

  function record(overrides: Partial<TokensUsageRecord> = {}): TokensUsageRecord {
    return {
      pipe_code: "demo",
      cost: 0.01,
      nb_tokens_by_category: { input: 100, output: 50 },
      ...overrides,
    };
  }

  it("reads an empty list as no inference: zero cost, zero tokens, an empty rollup", () => {
    const result = completedWith({ tokens_usages: [] });

    expect(result.structuredContent.usage).toEqual({
      state: "no_inference",
      cost_usd: 0,
      tokens: 0,
      calls: 0,
      assembly_error: null,
    });
    expect(result.usageByPipe).toEqual([]);
  });

  it("branches on usage_assembly_error, not the null list, when assembly broke", () => {
    const result = completedWith({
      tokens_usages: null,
      usage_assembly_error: "artifact read failed",
    });

    expect(result.structuredContent.usage).toEqual({
      state: "unavailable",
      cost_usd: null,
      tokens: null,
      calls: 0,
      assembly_error: "artifact read failed",
    });
  });

  it("returns a null cost (not 0) when calls happened but none were priced", () => {
    const usage = completedWith({
      tokens_usages: [record({ cost: null }), record({ cost: undefined })],
    }).structuredContent.usage;

    expect(usage?.state).toBe("records");
    expect(usage?.cost_usd).toBeNull();
    expect(usage?.tokens).toBe(300);
    expect(usage).not.toHaveProperty("cost_partial");
  });

  it("flags cost_partial when the run mixes priced and unpriced calls", () => {
    const usage = completedWith({
      tokens_usages: [record({ cost: 0.02 }), record({ cost: null })],
    }).structuredContent.usage;

    expect(usage?.cost_usd).toBeCloseTo(0.02, 10);
    expect(usage?.cost_partial).toBe(true);
  });

  it("returns null tokens when no record reported input or output counts", () => {
    const usage = completedWith({
      tokens_usages: [
        record({ nb_tokens_by_category: null }),
        record({ nb_tokens_by_category: {} }),
      ],
    }).structuredContent.usage;

    expect(usage?.tokens).toBeNull();
  });

  it("orders the per-pipe rollup the SDK's way — unattributed calls last on a tie", () => {
    const result = completedWith({
      tokens_usages: [
        record({ pipe_code: null, cost: 0.01 }),
        record({ pipe_code: "named", cost: 0.01 }),
        record({ pipe_code: "pricey", cost: 0.05 }),
      ],
    });

    expect(result.usageByPipe?.map((row) => row.pipe_code)).toEqual(["pricey", "named", null]);
  });
});

describe("usage stays out of the run-results prose", () => {
  function completedSummaryFor(overrides: Partial<RunResults>): string {
    return resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", ...overrides },
    }).summary;
  }

  it("never mentions usage, cost, or tokens for a run with usage records", () => {
    const summary = completedSummaryFor({
      tokens_usages: [
        { pipe_code: "demo", cost: 0.02, nb_tokens_by_category: { input: 10, output: 5 } },
      ],
    });
    expect(summary).not.toMatch(/usage/i);
    expect(summary).not.toContain("$");
    expect(summary).not.toContain("tokens");
  });

  it("never mentions a usage assembly error in the prose", () => {
    const summary = completedSummaryFor({ usage_assembly_error: "boom" });
    expect(summary).not.toMatch(/usage/i);
    expect(summary).not.toContain("boom");
  });
});

describe("boundMainStuff", () => {
  it("returns a value at the cap untouched", () => {
    // JSON.stringify adds the two quotes, landing exactly on the cap.
    const value = "a".repeat(MAIN_STUFF_CAP - 2);

    const bounded = boundMainStuff(value);

    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBe(value);
  });

  it("head+tails a text output just over the cap", () => {
    const text = "H".repeat(1000) + "m".repeat(MAIN_STUFF_CAP) + "T".repeat(1000);

    const bounded = boundMainStuff(text);

    expect(bounded.truncated).toBe(true);
    const value = bounded.value as string;
    expect(value.length).toBeLessThanOrEqual(MAIN_STUFF_CAP);
    expect(value.startsWith("H".repeat(100))).toBe(true);
    expect(value.endsWith("T".repeat(100))).toBe(true);
    expect(value).toContain(ELLIPSIS_MARKER);
  });

  it("prunes a long collection with an ellipsis marker", () => {
    const value = Array.from({ length: 2000 }, (_, index) => ({
      index,
      text: "x".repeat(50),
    }));

    const bounded = boundMainStuff(value);

    expect(bounded.truncated).toBe(true);
    const prunedItems = bounded.value as unknown[];
    expect(prunedItems.at(-1)).toBe(ELLIPSIS_MARKER);
    expect(prunedItems[0]).toEqual(value[0]);
    expect(JSON.stringify(bounded.value).length).toBeLessThanOrEqual(MAIN_STUFF_CAP);
  });

  it("prunes deep nesting and long strings deterministically", () => {
    let nested: Record<string, unknown> = { payload: "y".repeat(3000) };
    for (let level = 0; level < 30; level += 1) {
      nested = { payload: "y".repeat(3000), child: nested };
    }

    const first = boundMainStuff(nested);
    const second = boundMainStuff(nested);

    expect(first.truncated).toBe(true);
    expect(JSON.stringify(first.value).length).toBeLessThanOrEqual(MAIN_STUFF_CAP);
    expect(JSON.stringify(first.value)).toContain(ELLIPSIS_MARKER);
    expect(second.value).toEqual(first.value);
  });

  it("leaves a small structured output untouched", () => {
    const value = { answer: 42, items: ["a", "b"] };

    const bounded = boundMainStuff(value);

    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBe(value);
  });
});

// ── capability tests (fake client seam) ─────────────────────────────

// Structural mirror of the RunClient seam in run.ts.
interface FakeRunClient {
  start(options: PipelexStartOptions): Promise<RunResultStart>;
  getRunStatus(runId: string): Promise<RunRead>;
  getRunResult(runId: string): Promise<RunResultState>;
}

const NEVER_CLIENT: FakeRunClient = {
  start: () => Promise.reject(new Error("start must not be called")),
  getRunStatus: () => Promise.reject(new Error("getRunStatus must not be called")),
  getRunResult: () => Promise.reject(new Error("getRunResult must not be called")),
};

function contextWith(overrides: Partial<FakeRunClient>): RunContext {
  return {
    baseUrl: DEFAULT_API_URL,
    client: { ...NEVER_CLIENT, ...overrides },
  };
}

describe("startMthdsRun", () => {
  it("maps MCP input to PipelexStartOptions and projects the ack", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID, state: "STARTED" });
      },
    });

    const result = await startMthdsRun(
      {
        files: [{ content: 'domain = "demo"', uri: "file:///demo.mthds" }],
        pipe_code: "main",
        inputs: { question: "why?" },
      },
      context,
    );

    // /v1/start takes no source labels — only the contents cross the wire.
    expect(seen).toEqual({
      mthds_contents: ['domain = "demo"'],
      pipe_code: "main",
      inputs: { question: "why?" },
    });
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
  });

  it("omits pipe_code and inputs from PipelexStartOptions when not supplied", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID });
      },
    });

    await startMthdsRun({ files: [{ content: 'domain = "demo"' }] }, context);

    expect(seen).toEqual({ mthds_contents: ['domain = "demo"'] });
    expect(seen).not.toHaveProperty("pipe_code");
    expect(seen).not.toHaveProperty("inputs");
  });

  it("does not call the client when request validation fails", async () => {
    const result = await startMthdsRun({ files: [] }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.available_view_specs).toEqual([]);
  });

  it("classifies an unreachable API as config", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
        ),
    });

    const result = await startMthdsRun({ files: [{ content: 'domain = "demo"' }] }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toContain("unreachable or misconfigured");
  });
});

describe("startMthdsRun by method_ref", () => {
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";

  it("forwards method_ref as the run source, with no contents and no linkage id", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID });
      },
    });

    const result = await startMthdsRun({ method_ref: ADDRESS, inputs: { q: "why?" } }, context);

    expect(seen).toEqual({ inputs: { q: "why?" }, method_ref: ADDRESS });
    expect(result.structuredContent.status).toBe("ok");
  });

  it("rejects files beside method_ref without calling the client", async () => {
    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_ref: ADDRESS },
      contextWith({}),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
  });

  it("rejects method_ref beside method_id without calling the client", async () => {
    const result = await startMthdsRun(
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      contextWith({}),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.message).toContain("provenance");
  });

  it("classifies a structures refusal (403 MethodStructuresRefusedError) at method_ref", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 403",
            `${DEFAULT_API_URL}/v1/start`,
            403,
            "Forbidden",
            "{}",
            "MethodStructuresRefusedError",
            "The method declares in-process Python structures",
            undefined,
            undefined,
          ),
        ),
    });

    const result = await startMthdsRun({ method_ref: ADDRESS }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/MTHDS concepts/);
  });

  it("classifies a sandbox refusal (403 CustomCodeRequiresSandbox) at what named the method", async () => {
    const refusal = (): Promise<never> =>
      Promise.reject(
        new ApiResponseError(
          "HTTP 403",
          `${DEFAULT_API_URL}/v1/start`,
          403,
          "Forbidden",
          "{}",
          "CustomCodeRequiresSandbox",
          "This bundle ships custom Python (.py); running it requires a sandbox-hosted deployment.",
          undefined,
          undefined,
        ),
      );

    const byRef = await startMthdsRun({ method_ref: ADDRESS }, contextWith({ start: refusal }));
    // `/v1/start` applies the same gate to a submitted bundle, so the locator
    // follows the request shape rather than always naming the address.
    const byFiles = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith({ start: refusal }),
    );

    for (const result of [byRef, byFiles]) {
      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
      expect(result.structuredContent.errors?.[0]?.hint).toMatch(/sandbox-hosted/);
    }
    expect(byRef.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(byFiles.structuredContent.errors?.[0]?.location).toBe("files");
  });

  it("classifies a registry-form 501 at method_ref with the address-form hint", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 501",
            `${DEFAULT_API_URL}/v1/start`,
            501,
            "Not Implemented",
            "{}",
            undefined,
            "Registry-form refs are not implemented",
            undefined,
            undefined,
          ),
        ),
    });

    const result = await startMthdsRun({ method_ref: ADDRESS }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/address-form/i);
  });
});

describe("startMthdsRun by method_id", () => {
  function notFound(): ApiResponseError {
    return new ApiResponseError(
      "HTTP 404",
      `${DEFAULT_API_URL}/v1/start`,
      404,
      "Not Found",
      "{}",
      "not_found",
      "Method 'mt_missing' not found",
      undefined, // validationErrors
      "not_found",
    );
  }

  it("starts by id alone — method_id crosses as a named option, no mthds_contents", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID, state: "STARTED" });
      },
    });

    const result = await startMthdsRun(
      { method_id: "mt_abc123", inputs: { question: "why?" } },
      context,
    );

    expect(seen).toEqual({ method_id: "mt_abc123", inputs: { question: "why?" } });
    expect(seen).not.toHaveProperty("mthds_contents");
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
  });

  it("passes both when files and method_id are supplied (files run, id is linkage)", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID });
      },
    });

    await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_abc123" },
      context,
    );

    expect(seen).toEqual({
      mthds_contents: ['domain = "demo"'],
      method_id: "mt_abc123",
    });
  });

  it("does not call the client when neither files nor method_id is supplied", async () => {
    const result = await startMthdsRun({}, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    expect(result.structuredContent.errors?.[0]?.message).toBe(
      "Provide MTHDS files, a method_ref address, or a method_id.",
    );
  });

  it("does not call the client on a blank method_id", async () => {
    const result = await startMthdsRun({ method_id: "   " }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("classifies an unknown-method 404 as input_domain at method_id, not retryable", async () => {
    const context = contextWith({ start: () => Promise.reject(notFound()) });

    const result = await startMthdsRun({ method_id: "mt_missing" }, context);

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("method_id");
    expect(error?.hint).toMatch(/org-scoped/);
    expect(error?.retryable).toBe(false);
  });

  it("keeps a files-only 404 as config at PIPELEX_BASE_URL (regression guard)", async () => {
    const context = contextWith({ start: () => Promise.reject(notFound()) });

    const result = await startMthdsRun({ files: [{ content: 'domain = "demo"' }] }, context);

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("PIPELEX_BASE_URL");
  });

  it("classifies a paywall 402 as config with the billing hint", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 402",
            `${DEFAULT_API_URL}/v1/start`,
            402,
            "Payment Required",
            "{}",
            "subscription_required",
            "Subscription required to run methods",
            undefined, // validationErrors
            "forbidden",
          ),
        ),
    });

    const result = await startMthdsRun({ method_id: "mt_abc123" }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("app.pipelex.com");
    // A headline-only host shows just this line, so it must name the plan
    // rather than the connectivity headline every other `config` error gets.
    expect(result.summary).toBe(
      "Run could not start: the organization's Pipelex plan does not cover this call.",
    );
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("points a mixed-request 422 at files — the executed source — not method_id", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 422",
            `${DEFAULT_API_URL}/v1/start`,
            422,
            "Unprocessable Entity",
            "{}",
            "unprocessable_entity",
            "Pipe 'missing_pipe' not found in the submitted bundle",
            undefined, // validationErrors
            undefined, // code
          ),
        ),
    });

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_abc123" },
      context,
    );

    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("files");
    expect(error?.hint).toMatch(/files, pipe_code, and inputs/);
    expect(error?.retryable).toBe(false);
  });

  it("keeps a mixed-request 404 at method_id — the linkage id is what a 404 is about", async () => {
    const context = contextWith({ start: () => Promise.reject(notFound()) });

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_missing" },
      context,
    );

    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("method_id");
    expect(error?.hint).toMatch(/org-scoped/);
    expect(error?.retryable).toBe(false);
  });

  it("points a by-id 422 at method_id with the combined no-source/org-context hint", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 422",
            `${DEFAULT_API_URL}/v1/start`,
            422,
            "Unprocessable Entity",
            "{}",
            "unprocessable_entity",
            "Stored method 'mt_abc123' has no MTHDS source to run.",
            undefined, // validationErrors
            undefined, // code
          ),
        ),
    });

    const result = await startMthdsRun({ method_id: "mt_abc123" }, context);

    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("method_id");
    expect(error?.hint).toMatch(/no MTHDS source/);
    expect(error?.hint).toMatch(/organization context/);
  });
});

// A 402 on a run route: the platform reports a plan limit this way, and its
// problem `code` really is "forbidden" (never sniffed — the status decides).
function paywall(routeSuffix: string): ApiResponseError {
  return new ApiResponseError(
    "HTTP 402",
    `${DEFAULT_API_URL}/v1/runs/${RUN_ID}${routeSuffix}`,
    402,
    "Payment Required",
    "{}",
    "subscription_required",
    "Subscription required",
    undefined, // validationErrors
    "forbidden",
  );
}

describe("getMthdsRunStatus", () => {
  it("reads and projects the status by id", async () => {
    let seenId: string | undefined;
    const context = contextWith({
      getRunStatus: (runId: string) => {
        seenId = runId;
        return Promise.resolve(runRead());
      },
    });

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(seenId).toBe(RUN_ID);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_status).toBe("RUNNING");
  });

  it("does not call the client on a blank run_id", async () => {
    const result = await getMthdsRunStatus({ run_id: "  " }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("run_id");
  });

  it("classifies an unknown-id 404 as input_domain", async () => {
    const context = contextWith({
      getRunStatus: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 404",
            `${DEFAULT_API_URL}/v1/runs/${RUN_ID}/status`,
            404,
            "Not Found",
            "{}",
            "not_found",
            "Run not found",
            undefined, // validationErrors
            undefined, // code
          ),
        ),
    });

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("run_id");
  });

  it("headlines a paywall (402) as a plan limit, not as connectivity", async () => {
    const context = contextWith({ getRunStatus: () => Promise.reject(paywall("/status")) });

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    expect(result.summary).toBe(
      "Run status could not be read: the organization's Pipelex plan does not cover this call.",
    );
    expect(result.summary).not.toMatch(/unreachable/);
  });
});

describe("getMthdsRunResults", () => {
  it("fetches and projects a completed result by id", async () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: { answer: 42 },
        graph_spec: { nodes: [] },
      },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.state).toBe("completed");
    expect(result.graphSpec).toEqual({ nodes: [] });
  });

  it("does not call the client on a blank run_id", async () => {
    const result = await getMthdsRunResults({ run_id: "" }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
  });

  it("classifies the SDK's MissingMainStuffError as runtime", async () => {
    const context = contextWith({
      getRunResult: () =>
        Promise.reject(new MissingMainStuffError("completed run has no main stuff", RUN_ID)),
    });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
  });

  it("treats a reachable but malformed completed result as runtime, not unreachable", async () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: null },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.summary).toContain("malformed report");
  });

  it("headlines a paywall (402) as a plan limit, not as connectivity", async () => {
    const context = contextWith({ getRunResult: () => Promise.reject(paywall("/result")) });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    expect(result.summary).toBe(
      "Run results could not be read: the organization's Pipelex plan does not cover this call.",
    );
    expect(result.summary).not.toMatch(/unreachable/);
  });
});

describe("runResultsToolResult", () => {
  it("delivers the graph and the full output on _meta, never on structuredContent", async () => {
    const huge = { text: "x".repeat(MAIN_STUFF_CAP * 2) };
    const tokensUsages: TokensUsageRecord[] = [
      { pipe_code: "extract", cost: 0.01, nb_tokens_by_category: { input: 100, output: 50 } },
      { pipe_code: "summarize", cost: 0.02, nb_tokens_by_category: { input: 40, output: 20 } },
    ];
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: huge,
        graph_spec: { nodes: [] },
        tokens_usages: tokensUsages,
      },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const toolResult = runResultsToolResult(await getMthdsRunResults({ run_id: RUN_ID }, context));

    expect(toolResult.isError).toBe(false);
    expect(toolResult._meta.graph_spec).toEqual({ nodes: [] });
    // _meta carries the FULL output, the raw per-call list, and the per-pipe rollup;
    // structuredContent carries only the bounded output and the run-level usage.
    expect(toolResult._meta.main_stuff).toBe(huge);
    expect(toolResult._meta.tokens_usages).toBe(tokensUsages);
    expect(toolResult._meta.usage_by_pipe).toEqual([
      { pipe_code: "summarize", cost_usd: 0.02, tokens: 60, calls: 1 },
      { pipe_code: "extract", cost_usd: 0.01, tokens: 150, calls: 1 },
    ]);
    // The run-level usage totals are in structuredContent; per-pipe is not.
    expect(toolResult.structuredContent.usage?.calls).toBe(2);
    expect(toolResult.structuredContent.usage).not.toHaveProperty("by_pipe");
    expect(toolResult.structuredContent.truncated).toBe(true);
    expect(JSON.stringify(toolResult.structuredContent.main_stuff).length).toBeLessThanOrEqual(
      MAIN_STUFF_CAP,
    );
  });

  it("delivers the graph's data artifacts on _meta under the API's own key names", async () => {
    const contracts = CONTRACTS;
    const outputForm = OUTPUT_FORM;
    const inputForm = INPUT_FORM;
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: "done",
        graph_spec: { nodes: [] },
        pipe_io_contracts: contracts,
        output_form: outputForm,
        input_form: inputForm,
      },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const toolResult = runResultsToolResult(await getMthdsRunResults({ run_id: RUN_ID }, context));

    expect(toolResult._meta.pipe_io_contracts).toEqual(contracts);
    expect(toolResult._meta.output_form).toEqual(outputForm);
    expect(toolResult._meta.input_form).toEqual(inputForm);
  });

  it("flags error results as isError with empty _meta", async () => {
    const toolResult = runResultsToolResult(
      await getMthdsRunResults({ run_id: "" }, contextWith({})),
    );

    expect(toolResult.isError).toBe(true);
    expect(toolResult._meta.graph_spec).toBeUndefined();
    expect(toolResult._meta.pipe_io_contracts).toBeUndefined();
    expect(toolResult._meta.output_form).toBeUndefined();
    expect(toolResult._meta.input_form).toBeUndefined();
    expect(toolResult._meta.main_stuff).toBeUndefined();
    expect(toolResult._meta.tokens_usages).toBeUndefined();
    expect(toolResult._meta.usage_by_pipe).toBeUndefined();
  });
});

describe("startMthdsRun path submissions", () => {
  it("resolves { path } items through the context resolver before starting", async () => {
    let seen: PipelexStartOptions | undefined;
    const context: RunContext = {
      ...contextWith({
        start: (options: PipelexStartOptions) => {
          seen = options;
          return Promise.resolve({ pipeline_run_id: RUN_ID });
        },
      }),
      resolver: {
        async resolve() {
          return { ok: true, content: 'domain = "demo"' };
        },
      },
    };

    const result = await startMthdsRun({ files: [{ path: "methods/bundle.mthds" }] }, context);

    // /v1/start takes no source labels — only the resolved contents cross.
    expect(seen).toEqual({ mthds_contents: ['domain = "demo"'] });
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    const result = await startMthdsRun(
      { files: [{ path: "methods/bundle.mthds" }] },
      contextWith({}),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files[0].path");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("npx @pipelex/mcp");
    expect(result.summary).toBe("Run was not started: request input is invalid.");
  });
});

// ── the console's run: `pipelex_run` ────────────────────────────────

describe("startPipelexRun", () => {
  /** A signature with one image input and one text input, for the walk to read. */
  const WALK_FORM: InputForm = {
    "demo.main": {
      fields: [
        {
          name: "photo",
          kind: "image",
          concept_ref: "native.Image",
          required: true,
          presence: "plain",
          gating: true,
        },
        {
          name: "question",
          kind: "prose",
          concept_ref: "native.Text",
          required: true,
          presence: "plain",
          gating: true,
        },
      ],
    },
  };

  const WALK_REPORT: PipelexValidationReport = {
    is_valid: true,
    bundle_blueprint: { domain: "demo", main_pipe: "main" },
    pipe_io_contracts: {},
    input_form: WALK_FORM,
    graph_spec: {},
    validated_pipes: [],
    pending_signatures: [],
    liftable_pipes: [],
    warnings: [],
    is_runnable: true,
    message: "ok",
  };

  interface Recorded {
    validated: Array<string[] | ValidateMethodSelector>;
    started: PipelexStartOptions[];
  }

  /** A console run context whose client serves the walk's read and the start, recording both. */
  function consoleContext(
    options: { report?: PipelexValidationResult; start?: () => Promise<RunResultStart> } = {},
  ): { context: PipelexRunContext; recorded: Recorded } {
    const recorded: Recorded = { validated: [], started: [] };
    const context: PipelexRunContext = {
      baseUrl: DEFAULT_API_URL,
      toolNames: CONSOLE_TOOL_NAMES,
      client: {
        ...NEVER_CLIENT,
        async validate(source: string[] | ValidateMethodSelector) {
          recorded.validated.push(source);
          return options.report ?? WALK_REPORT;
        },
        start(startOptions: PipelexStartOptions) {
          recorded.started.push(startOptions);
          return options.start?.() ?? Promise.resolve({ pipeline_run_id: RUN_ID });
        },
      },
    };
    return { context, recorded };
  }

  it("walks the inputs against the method's signature, then starts it by reference", async () => {
    const { context, recorded } = consoleContext();

    const result = await startPipelexRun(
      {
        method_id: "mt_demo",
        pipe_ref: "demo.main",
        inputs: { photo: "https://example.com/cat.png", question: "why?" },
      },
      context,
    );

    // The walk reads the signature of the same method the run starts.
    expect(recorded.validated).toEqual([{ method_id: "mt_demo" }]);
    // The console's `pipe_ref` rides the run route's `pipe_code`, and the file
    // input arrives in the shape the run needs.
    expect(recorded.started).toEqual([
      {
        method_id: "mt_demo",
        pipe_code: "demo.main",
        inputs: {
          photo: { url: "https://example.com/cat.png" },
          question: "why?",
        },
      },
    ]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
  });

  it("refuses an upload-needing value before anything starts, naming the attachment tool", async () => {
    const { context, recorded } = consoleContext();

    const result = await startPipelexRun(
      { method_ref: "github.com/acme/methods@v1", inputs: { photo: "/etc/passwd", question: "x" } },
      context,
    );

    expect(recorded.started).toEqual([]);
    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("inputs");
    expect(error?.hint).toContain("pipelex_upload_attachments");
    expect(JSON.stringify(result)).not.toContain("mthds_");
  });

  it("reads no signature when there are no inputs to walk", async () => {
    const { context, recorded } = consoleContext();

    await startPipelexRun({ method_ref: "github.com/acme/methods@v1" }, context);
    await startPipelexRun({ method_id: "mt_demo", inputs: {} }, context);

    expect(recorded.validated).toEqual([]);
    expect(recorded.started).toEqual([
      { method_ref: "github.com/acme/methods@v1" },
      { method_id: "mt_demo", inputs: {} },
    ]);
  });

  it("requires exactly one method reference, before any call", async () => {
    const { context, recorded } = consoleContext();

    const neither = await startPipelexRun({ inputs: {} }, context);
    const both = await startPipelexRun(
      { method_id: "mt_demo", method_ref: "github.com/acme/methods@v1" },
      context,
    );
    const blankPipe = await startPipelexRun({ method_id: "mt_demo", pipe_ref: " " }, context);

    expect(neither.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(both.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(blankPipe.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(recorded.validated).toEqual([]);
    expect(recorded.started).toEqual([]);
  });

  it("points a refused start at the console's own tools", async () => {
    const { context } = consoleContext({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 422",
            `${DEFAULT_API_URL}/v1/start`,
            422,
            "Unprocessable Entity",
            "{}",
            "error",
            "bad inputs",
            undefined,
            undefined,
          ),
        ),
    });

    const result = await startPipelexRun({ method_id: "mt_demo" }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("pipelex_show_method");
    expect(JSON.stringify(result)).not.toContain("mthds_");
  });

  it("follows its run with the console's status tool", async () => {
    const { context } = consoleContext();

    const result = await startPipelexRun({ method_id: "mt_demo" }, context);

    expect(result.summary).toContain("pipelex_run_status");
    expect(result.summary).not.toContain("mthds_");
  });
});

describe("the run family in the console's names", () => {
  it("names no workshop tool in a status, a result or a schema", () => {
    const status = statusResult(runRead({ status: "RUNNING" }), CONSOLE_TOOL_NAMES);
    const results = resultsResult(
      {
        state: "completed",
        pipeline_run_id: RUN_ID,
        result: { pipeline_run_id: RUN_ID, main_stuff: { answer: 42 } },
      } as RunResultState,
      false,
      false,
      CONSOLE_TOOL_NAMES,
    );
    const schemas = JSON.stringify([
      z.toJSONSchema(z.object(runIdInputSchemaFor(CONSOLE_TOOL_NAMES))),
      z.toJSONSchema(runStartOutputSchemaFor(CONSOLE_TOOL_NAMES)),
      z.toJSONSchema(runResultsOutputSchemaFor(CONSOLE_TOOL_NAMES)),
    ]);

    for (const text of [JSON.stringify(status), JSON.stringify(results), schemas]) {
      expect(text).not.toContain("mthds_");
    }
  });
});
