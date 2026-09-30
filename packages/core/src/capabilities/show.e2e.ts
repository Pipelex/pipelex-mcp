/**
 * Live e2e — `pipelex_show_method` against a real Pipelex API.
 *
 * The tool reads one `POST /v1/pipe-io` for the whole method with its files,
 * projects the inputs template client-side from the input-form descriptor, and
 * draws the static graph from the echoed files. The unit suite fakes that
 * answer, so only a live call proves the route still serves each artifact the
 * view and the template are built from, and the files the graph is drawn
 * from, for a saved method and a published one alike.
 *
 * Free: the route loads the method, runs no dry run and executes nothing.
 */

import { describe, expect, it } from "vitest";

import {
  FIXTURE_INPUT_NAME,
  FIXTURE_PIPE_REF,
  PUBLISHED_METHOD_PIPE_REF,
  PUBLISHED_METHOD_REF,
  PYTHON_FREE_METHOD_REF,
  apiAdvertisesExtension,
  fixtureMethodId,
  liveApiConfig,
} from "./e2e-support.js";
import { showPipelexMethod, showToolResult } from "./show.js";
import type { ShowContext } from "./show.js";

/** Does this deployment resolve `method_id` / `method_ref` server-side? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

const context: ShowContext = liveApiConfig();

/** The view-only keys the `run-graph` view's form reads, every one of them carrying something. */
function expectFormArtifacts(meta: Record<string, unknown>) {
  for (const key of ["pipe_io_contracts", "input_form", "output_form"]) {
    expect(meta[key], `_meta.${key}`).toBeTypeOf("object");
    expect(meta[key], `_meta.${key}`).not.toBeNull();
  }
  expect(meta.main_pipe_ref).toBeTypeOf("string");
}

/** The form's keys, and the static graph beside them, drawn from the entry pipe. */
function expectViewArtifacts(meta: Record<string, unknown>) {
  expectFormArtifacts(meta);
  const graph = meta.graph_spec as
    | { meta?: { mode?: string }; nodes?: unknown[]; pipeline_ref?: Record<string, unknown> }
    | null
    | undefined;
  expect(graph, "_meta.graph_spec").toBeTypeOf("object");
  expect(graph, "_meta.graph_spec").not.toBeNull();
  expect(graph?.meta?.mode, "_meta.graph_spec.meta.mode").toBe("static");
  expect(graph?.nodes?.length ?? 0, "_meta.graph_spec.nodes").toBeGreaterThan(0);
  expect(`${graph?.pipeline_ref?.domain}.${graph?.pipeline_ref?.main_pipe}`).toBe(
    meta.main_pipe_ref,
  );
}

/** The method's source never rides any channel: the catalog projection invariant. */
function expectNoSource(result: unknown) {
  const everything = JSON.stringify(result);
  expect(everything).not.toContain('"files"');
  expect(everything).not.toMatch(/main_pipe\s*=\s*\\"/);
}

describe.skipIf(!SERVES_SELECTORS)("pipelex_show_method (live)", () => {
  it("shows a saved method by id, with its template and every view artifact", async () => {
    const methodId = await fixtureMethodId();
    const result = showToolResult(await showPipelexMethod({ method_id: methodId }, context));
    const content = result.structuredContent;

    expect(content.status).toBe("ok");
    expect(content.method_id).toBe(methodId);
    expect(content.is_valid).toBe(true);
    expect(content.is_runnable).toBe(true);
    expect(content.pipe_ref).toBe(FIXTURE_PIPE_REF);
    expect(content.main_pipe?.pipe_ref).toBe(FIXTURE_PIPE_REF);
    // The template carries the one declared input, in the explicit envelope.
    expect(Object.keys(content.inputs ?? {})).toEqual([FIXTURE_INPUT_NAME]);
    expect(content.inputs?.[FIXTURE_INPUT_NAME]).toHaveProperty("concept");
    expect(content.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
    expectViewArtifacts(result._meta as Record<string, unknown>);
    expectNoSource(result);
  });

  it("shows a published method by address, with its template and every view artifact", async () => {
    // The package whose entry pipe only its manifest names, which is what
    // this leg is about; it is also Python-free, so its run would pass the
    // execution-locus gate at the start.
    const result = showToolResult(
      await showPipelexMethod({ method_ref: PYTHON_FREE_METHOD_REF }, context),
    );
    const content = result.structuredContent;

    expect(content.status).toBe("ok");
    expect(content.method_ref).toBe(PYTHON_FREE_METHOD_REF);
    expect(content.is_valid).toBe(true);
    expect(content.is_runnable).toBe(true);
    // The package's manifest settles the entry pipe (`validate.e2e.ts` says
    // why naming it is the point), and the template is for that pipe.
    expect(content.pipe_ref).toBe("documents.extract_document_markdown");
    expect(Object.keys(content.inputs ?? {}).length).toBeGreaterThan(0);
    // This package declares its entry pipe only in its manifest; the route
    // states it as `default_pipe_ref`, and the graph is drawn from the
    // package's echoed files at that pipe, as it is for a saved method.
    expect(content.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
    expectViewArtifacts(result._meta as Record<string, unknown>);
    expectNoSource(result);
  });

  it("shows a published package that ships Python: only its run's start is gated", async () => {
    // `/v1/pipe-io` fetches a package's `.mthds` files alone, so no execution
    // locus is decided and the gate cannot fire; `/v1/validate`, which the
    // show read before, refused this package off a sandbox-hosted deployment.
    const result = showToolResult(
      await showPipelexMethod({ method_ref: PUBLISHED_METHOD_REF }, context),
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.pipe_ref).toBe(PUBLISHED_METHOD_PIPE_REF);
    expectViewArtifacts(result._meta as Record<string, unknown>);
    expectNoSource(result);
  });

  it("shows another pipe of a published method, and refuses one it does not declare", async () => {
    const named = await showPipelexMethod(
      { method_ref: PYTHON_FREE_METHOD_REF, pipe_ref: "documents.extract_document_text" },
      context,
    );
    expect(named.structuredContent.status).toBe("ok");
    expect(named.structuredContent.pipe_ref).toBe("documents.extract_document_text");
    expect(named.formPipeRef).toBe("documents.extract_document_text");
    // The entry pipe stays the method's own, and the graph is still drawn from it.
    expect(named.mainPipeRef).toBe("documents.extract_document_markdown");

    const unknown = await showPipelexMethod(
      { method_ref: PYTHON_FREE_METHOD_REF, pipe_ref: "documents.nope" },
      context,
    );
    const error = unknown.structuredContent.errors?.[0];
    expect(error?.location).toBe("pipe_ref");
    // Named from the whole-method answer: the route's own refusal names none.
    expect(error?.message).toContain("documents.extract_document_markdown");
  });
});
