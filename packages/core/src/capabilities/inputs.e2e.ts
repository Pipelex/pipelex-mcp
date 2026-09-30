/**
 * Live e2e — `mthds_inputs_template` against a real Pipelex API.
 *
 * The tool reads one `POST /v1/pipe-io` for the one pipe and projects the
 * template client-side from the pipe's input-form descriptor. The unit suite
 * fakes that answer, so only a live call proves three things: that the route
 * still serves a descriptor the standard's projection can walk, for inline
 * files, a published address and a saved method alike; that `explicit` still
 * changes the template's SHAPE, which a fake could only assert about itself;
 * and that the route's refusals of a pipe selection are still the typed `422`s
 * the tool locates at `pipe_ref`.
 *
 * Free: the route loads the method, runs no dry run and executes nothing.
 */

import { describe, expect, it } from "vitest";

import { buildMthdsInputs } from "./inputs.js";
import type { InputsContext } from "./inputs.js";
import {
  FIXTURE_BUNDLE,
  FIXTURE_BUNDLE_URI,
  FIXTURE_INPUT_NAME,
  FIXTURE_PIPE_REF,
  INVALID_BUNDLE,
  INVALID_BUNDLE_URI,
  PUBLISHED_METHOD_INPUT_NAME,
  PUBLISHED_METHOD_PIPE_REF,
  PUBLISHED_METHOD_REF,
  PYTHON_FREE_METHOD_REF,
  apiAdvertisesExtension,
  fixtureMethodId,
  liveApiConfig,
} from "./e2e-support.js";

const context: InputsContext = liveApiConfig();

/** Does this deployment resolve `method_ref` / `method_id` server-side on the tooling routes? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

const fixtureFiles = [{ content: FIXTURE_BUNDLE, uri: FIXTURE_BUNDLE_URI }];

/**
 * Two bundles whose domains each declare a `main_pipe`, so a request naming no
 * pipe has several entry pipes to choose from and the route refuses to choose.
 */
const TWO_ENTRY_PIPES_FILES = ["mcp_e2e_first", "mcp_e2e_second"].map((domain) => ({
  content: FIXTURE_BUNDLE.replace(/mcp_e2e_fixture/g, domain),
  uri: `e2e/${domain}.mthds`,
}));

describe("mthds_inputs_template (live)", () => {
  it("projects the declared input as a json template and resolves the main pipe", async () => {
    const result = await buildMthdsInputs({ files: fixtureFiles }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.pipe_ref).toBe(FIXTURE_PIPE_REF);
    expect(result.structuredContent.format).toBe("json");
    expect(result.structuredContent.explicit).toBe(true);

    // The declared input must survive the wire. A template that dropped every
    // field would still be an object, which is why the key is asserted by name.
    const template = result.structuredContent.inputs;
    expect(template).toBeDefined();
    expect(Object.keys(template ?? {})).toContain(FIXTURE_INPUT_NAME);

    // The unselected format field is absent, not null or empty.
    expect(result.structuredContent.inputs_toml).toBeUndefined();

    // The template is duplicated into the summary on purpose — it is the small
    // payload the model carries onward to mthds_run.
    expect(result.summary).toContain(FIXTURE_INPUT_NAME);
    expect(result.summary).toContain("```json");
  });

  it("returns the toml template — and only the toml template — for format: toml", async () => {
    const result = await buildMthdsInputs({ files: fixtureFiles, format: "toml" }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.format).toBe("toml");
    expect(typeof result.structuredContent.inputs_toml).toBe("string");
    expect(result.structuredContent.inputs_toml).toContain(FIXTURE_INPUT_NAME);
    expect(result.structuredContent.inputs).toBeUndefined();
    expect(result.summary).toContain("```toml");
  });

  it("changes the template shape when explicit is false", async () => {
    const explicit = await buildMthdsInputs({ files: fixtureFiles, explicit: true }, context);
    const compact = await buildMthdsInputs({ files: fixtureFiles, explicit: false }, context);

    expect(compact.structuredContent.explicit).toBe(false);

    const explicitItem = explicit.structuredContent.inputs?.[FIXTURE_INPUT_NAME];
    const compactItem = compact.structuredContent.inputs?.[FIXTURE_INPUT_NAME];

    // The explicit envelope is `{ concept, content }`; the fixture declares
    // `topic = "Text"`, so the compact form is the bare scalar.
    //
    // The compact side is asserted by SHAPE, never by the placeholder's wording:
    // that prose belongs to the projection, and pinning it would make this
    // canary cry wolf on a copy tweak. A type check also fails when the key is
    // dropped entirely — an inequality against the explicit envelope would have
    // passed on `undefined`, which is a drift canary going green on an empty
    // template.
    expect(explicitItem).toHaveProperty("concept");
    expect(typeof compactItem).toBe("string");
  });

  it("answers an invalid bundle with a produced verdict, never an error", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: INVALID_BUNDLE, uri: INVALID_BUNDLE_URI }] },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.validation_errors?.length ?? 0).toBeGreaterThan(0);
    expect(result.structuredContent.inputs).toBeUndefined();
  });

  it("refuses an unknown pipe_ref at pipe_ref, with the route's reason", async () => {
    const result = await buildMthdsInputs(
      { files: fixtureFiles, pipe_ref: "mcp_e2e_fixture.no_such_pipe" },
      context,
    );

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("pipe_ref");
    expect(error?.message).toContain("no_such_pipe");
    expect(error?.retryable).toBe(false);
  });

  it("refuses a method with several entry pipes at pipe_ref, then projects the one named", async () => {
    const refused = await buildMthdsInputs({ files: TWO_ENTRY_PIPES_FILES }, context);

    expect(refused.structuredContent.status).toBe("error");
    expect(refused.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(refused.structuredContent.errors?.[0]?.location).toBe("pipe_ref");

    const named = await buildMthdsInputs(
      { files: TWO_ENTRY_PIPES_FILES, pipe_ref: "mcp_e2e_second.name_one_word" },
      context,
    );
    expect(named.structuredContent.status).toBe("ok");
    expect(named.structuredContent.pipe_ref).toBe("mcp_e2e_second.name_one_word");
    expect(Object.keys(named.structuredContent.inputs ?? {})).toEqual([FIXTURE_INPUT_NAME]);
  });
});

// GATED on the live API, not on a date: the selectors are server pass-throughs
// on `POST /v1/pipe-io`, which a deployment on the pre-selector platform build
// answers with a request-shape error that is not drift. See
// `apiAdvertisesExtension`. The addresses are pinned at a tag so the assertions
// can be exact: a published address is only a stable fixture at an immutable ref.
describe.skipIf(!SERVES_SELECTORS)("mthds_inputs_template by selector (live)", () => {
  it("projects a published method's template by address", async () => {
    // A package that ships Python: the route fetches its `.mthds` files alone,
    // so the execution-locus gate cannot fire here.
    const result = await buildMthdsInputs({ method_ref: PUBLISHED_METHOD_REF }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    // Named, not merely non-empty: the entry pipe came from the package rather
    // than from anything this repo sent, and its declared input survived the
    // projection — a template that lost every field would pass a bare `is_valid`.
    expect(result.structuredContent.pipe_ref).toBe(PUBLISHED_METHOD_PIPE_REF);
    expect(Object.keys(result.structuredContent.inputs ?? {})).toEqual([
      PUBLISHED_METHOD_INPUT_NAME,
    ]);
  });

  it("takes the entry pipe a package names only in its manifest", async () => {
    const result = await buildMthdsInputs({ method_ref: PYTHON_FREE_METHOD_REF }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.pipe_ref).toBe("documents.extract_document_markdown");
    expect(Object.keys(result.structuredContent.inputs ?? {}).length).toBeGreaterThan(0);
  });

  it("projects a saved method's template from its id alone", async () => {
    const result = await buildMthdsInputs({ method_id: await fixtureMethodId() }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    // The seeded copy of the fixture, not the inline one: an edit to
    // FIXTURE_BUNDLE that was never re-seeded fails here as a stale seed.
    expect(result.structuredContent.pipe_ref).toBe(FIXTURE_PIPE_REF);
    expect(Object.keys(result.structuredContent.inputs ?? {})).toEqual([FIXTURE_INPUT_NAME]);
  });

  it("refuses an unknown method id at method_id", async () => {
    const result = await buildMthdsInputs(
      { method_id: "mt_00000000-0000-4000-8000-000000000000" },
      context,
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(false);
  });
});
