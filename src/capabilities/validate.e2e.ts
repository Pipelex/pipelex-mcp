/**
 * Live e2e — `mthds_validate` against a real Pipelex API.
 *
 * The assertion that matters most here is not "the bundle validates": it is the
 * verdict-vs-no-verdict discipline. An INVALID bundle must come back as a
 * produced verdict (`status: "ok"`, `is_valid: false`, `validation_errors[]`),
 * never as an error result. That contract lives half in this repo and half in
 * the API's response shape, so it is exactly what wire drift corrupts first and
 * exactly what a mocked suite cannot see.
 */

import { describe, expect, it } from "vitest";

import type { PipelexValidationReport } from "@pipelex/sdk";

import {
  FIXTURE_BUNDLE,
  FIXTURE_BUNDLE_URI,
  FIXTURE_INPUT_NAME,
  FIXTURE_PIPE_REF,
  INVALID_BUNDLE,
  INVALID_BUNDLE_URI,
  apiAdvertisesExtension,
  liveApiConfig,
  liveClient,
} from "./e2e-support.js";
import { validateMthds } from "./validate.js";
import type { ValidationContext } from "./validate.js";

// No `client` seam and no `resolver`: the real client, inline files only.
const context: ValidationContext = liveApiConfig();

/** Does this deployment resolve `method_id` / `method_ref` server-side? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

describe("mthds_validate (live)", () => {
  it("returns a runnable verdict, a Markdown summary, and a graph on the view-only channel", async () => {
    const result = await validateMthds(
      { files: [{ content: FIXTURE_BUNDLE, uri: FIXTURE_BUNDLE_URI }] },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.is_runnable).toBe(true);
    expect(result.structuredContent.pending_signatures).toEqual([]);
    expect(result.structuredContent.validation_errors).toBeUndefined();
    expect(result.structuredContent.errors).toBeUndefined();

    // The summary is the API's own `rendered_markdown`; the capability treats a
    // report without it as a hard error, so an empty one means the render
    // contract moved.
    expect(result.summary.trim()).not.toBe("");

    // The graph and the IO contracts ride `_meta` and never `structuredContent`
    // — the model must not pay their tokens. `available_view_specs` is the
    // model's structured signal that they exist.
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
    expect(result.graphSpec).toBeDefined();
    expect(typeof result.graphSpec).toBe("object");
    expect(typeof result.pipeIoContracts).toBe("object");
    // The descriptor is the `views: ["input_form"]` opt-in round-tripping for
    // real — the spec keeps it off the report unless asked, so its arrival is
    // the live proof the token still works.
    expect(typeof result.inputForm).toBe("object");
    expect(typeof result.mainPipeRef).toBe("string");

    // The main pipe's signature — the wire shape the projection narrows, and
    // the one field here a mocked suite cannot vouch for. The fixture declares
    // `topic` and produces text, so both halves are asserted against what the
    // bundle actually says rather than against "something non-empty".
    const mainPipe = result.structuredContent.main_pipe;
    expect(mainPipe?.pipe_ref).toBe(FIXTURE_PIPE_REF);
    expect(mainPipe?.inputs).toEqual([
      {
        name: FIXTURE_INPUT_NAME,
        concept_ref: "native.Text",
        multiplicity: "single",
        required: true,
      },
    ]);
    expect(mainPipe?.output.concept_ref).toBe("native.Text");
    expect(mainPipe?.output.multiplicity).toBe("single");
    // The rendered line is the channel a ChatGPT install with a cached tool
    // list still receives, so it must survive the wire too.
    expect(result.summary).toContain(
      `\`${FIXTURE_PIPE_REF}(${FIXTURE_INPUT_NAME}: native.Text) -> native.Text\``,
    );
    expect(JSON.stringify(result.structuredContent)).not.toContain("graph_spec");
    expect(JSON.stringify(result.structuredContent)).not.toContain("pipe_io_contracts");
    // (No `input_form` containment check: the view KIND in
    // `available_view_specs` is legitimately spelled the same.)
    expect(result.structuredContent).not.toHaveProperty("input_form");
  });

  // GATED on the API deploy. `default_pipe_ref` landed on pipelex-api's `dev`
  // (#68, 7a476cd) after its 0.21.0 release, so no released runner serves it
  // yet and no hosted environment has it. Un-skip once `/v1/version` reports a
  // hosted implementation built on a pipelex-api past 0.21.0 — the probe IS
  // this assertion: the field arrives, or it does not.
  //
  // Worth un-skipping promptly rather than leaving parked: the projection
  // prefers the report's `default_pipe_ref` and falls back to the blueprint
  // derivation when the field is ABSENT, which is exactly what keeps every
  // assertion above green while a by-address signature quietly goes back to
  // naming a pipe a run will not execute. This is the one check the fallback
  // cannot stand in for, and it needs an unseamed client because the capability
  // returns the projection, not the report.
  it.skip("serves the effective entry pipe as its own report field (gated)", async () => {
    const report = await liveClient().validateFiles(
      [{ content: FIXTURE_BUNDLE, uri: FIXTURE_BUNDLE_URI }],
      { allowSignatures: true, render: ["markdown"], views: ["input_form"] },
    );

    expect(report.is_valid).toBe(true);
    // Inline files carry no manifest, so the effective entry is the closure's
    // own `main_pipe`, qualified — the same value the blueprint derivation
    // reaches. The point of the assertion is that the SERVER stated it.
    expect((report as PipelexValidationReport).default_pipe_ref).toBe(FIXTURE_PIPE_REF);
  });

  it("omits the graph when include_graph is false", async () => {
    const result = await validateMthds(
      { files: [{ content: FIXTURE_BUNDLE, uri: FIXTURE_BUNDLE_URI }], include_graph: false },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.graphSpec).toBeUndefined();
    // The form does not depend on the graph, and neither does the signature.
    expect(result.structuredContent.available_view_specs).toEqual(["input_form"]);
    expect(result.structuredContent.main_pipe?.output.concept_ref).toBe("native.Text");
  });

  it("reports an invalid bundle as a PRODUCED verdict, not an error", async () => {
    const result = await validateMthds(
      { files: [{ content: INVALID_BUNDLE, uri: INVALID_BUNDLE_URI }] },
      context,
    );

    // status "ok" with is_valid false: the API produced a verdict, and the
    // caller discriminates on is_valid — never on the transport.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.errors).toBeUndefined();

    const validationErrors = result.structuredContent.validation_errors;
    expect(Array.isArray(validationErrors)).toBe(true);
    expect(validationErrors?.length ?? 0).toBeGreaterThan(0);

    // The diagnostics are what an agent repairs from; an empty summary would
    // leave it nothing to explain.
    expect(result.summary.trim()).not.toBe("");
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.main_pipe).toBeUndefined();
  });

  it("rejects a request carrying no selector at all", async () => {
    const result = await validateMthds({}, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
  });
});

/**
 * GATED on the live API, not on a date: `mthds_validate`'s `method_id` and
 * `method_ref` legs are server pass-throughs (`POST /v1/validate` with a
 * selector body), which an environment on the pre-selector platform build
 * answers as a request-shape error — a failure that is not drift. The probe
 * asks `/v1/version` whether this deployment serves them; see
 * `apiAdvertisesExtension`.
 */
describe.skipIf(!SERVES_SELECTORS)("mthds_validate by selector (live)", () => {
  it("validates a stored method from its id alone (server-side resolution)", async () => {
    const { fixtureMethodId } = await import("./e2e-support.js");
    const result = await validateMthds({ method_id: await fixtureMethodId() }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.is_runnable).toBe(true);
  });

  it("validates a published method by address (server-side git resolution)", async () => {
    const result = await validateMthds(
      { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
  });
});
