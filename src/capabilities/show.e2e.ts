/**
 * Live e2e — `pipelex_show_method` against a real Pipelex API.
 *
 * The tool reads `POST /v1/validate` with the graph and both form descriptors
 * requested, then projects the inputs template client-side from the input-form
 * descriptor. The unit suite fakes that report, so only a live call proves the
 * route still serves each artifact the view and the template are built from,
 * for a saved method and a published one alike.
 *
 * Free: validation dry-runs the graph and executes nothing.
 */

import { describe, expect, it } from "vitest";

import {
  FIXTURE_INPUT_NAME,
  FIXTURE_PIPE_REF,
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

/** The form's keys, and the dry-run graph beside them. */
function expectViewArtifacts(meta: Record<string, unknown>) {
  expectFormArtifacts(meta);
  expect(meta.graph_spec, "_meta.graph_spec").toBeTypeOf("object");
  expect(meta.graph_spec, "_meta.graph_spec").not.toBeNull();
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
  });

  it("shows a published method by address, with its template and its form", async () => {
    // `/v1/validate` resolves an address through the execution-locus gate, so
    // this is the Python-free package (see `PYTHON_FREE_METHOD_REF`).
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
    // No graph here, and that is the API's documented answer rather than a
    // loss on this side: the route dry-runs the bundle's own `main_pipe`, and
    // this package declares its entry pipe only in its manifest, so
    // `graph_spec` is null while `default_pipe_ref` names the pipe. The form
    // and the template still come, and the view renders the form alone. The
    // ask to graph the manifest's entry pipe is L-260925-012c15; when it
    // lands, this becomes `expectViewArtifacts` like the by-id leg.
    expectFormArtifacts(result._meta as Record<string, unknown>);
    expect(content.available_view_specs).toEqual(["input_form"]);
  });
});
