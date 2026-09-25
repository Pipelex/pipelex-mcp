/**
 * Live e2e — `mthds_inputs_template` against a real Pipelex API.
 *
 * Two things are only observable live. First, that exactly one of `inputs` /
 * `inputs_toml` comes back per requested format: the capability treats a valid
 * report missing its format-selected field as a hard error, so a rename on the
 * API side turns into a `runtime` no-verdict rather than a silent empty
 * template. Second, that `explicit` still changes the template's SHAPE — a
 * fixture asserting a bare scalar would be lying about what the API returns.
 */

import { describe, expect, it } from "vitest";

import { buildMthdsInputs } from "./inputs.js";
import type { InputsContext } from "./inputs.js";
import {
  FIXTURE_BUNDLE,
  FIXTURE_BUNDLE_URI,
  FIXTURE_INPUT_NAME,
  FIXTURE_PIPE_REF,
  PUBLISHED_METHOD_INPUT_NAME,
  PUBLISHED_METHOD_PIPE_REF,
  PUBLISHED_METHOD_REF,
  apiAdvertisesExtension,
  liveApiConfig,
} from "./e2e-support.js";

const context: InputsContext = liveApiConfig();

/** Does this deployment resolve `method_ref` server-side on the build routes? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

const fixtureFiles = [{ content: FIXTURE_BUNDLE, uri: FIXTURE_BUNDLE_URI }];

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
    // `topic = "Text"`, so the compact form is the bare scalar. If the API ever
    // collapsed the two, this is where it shows.
    //
    // The compact side is asserted by SHAPE, never by the placeholder's wording:
    // that prose belongs to the API, and pinning it would make this canary cry
    // wolf on a copy tweak. A type check also fails when the key is dropped
    // entirely — an inequality against the explicit envelope would have passed
    // on `undefined`, which is a drift canary going green on an empty template.
    expect(explicitItem).toHaveProperty("concept");
    expect(typeof compactItem).toBe("string");
  });

  it("classifies an unknown pipe_ref as an input_domain no-verdict at pipe_ref", async () => {
    const result = await buildMthdsInputs(
      { files: fixtureFiles, pipe_ref: "mcp_e2e_fixture.no_such_pipe" },
      context,
    );

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("pipe_ref");
    expect(error?.retryable).toBe(false);
  });

  // GATED on the live API, not on a date: `method_ref` rides the build envelope
  // (`POST /v1/build/inputs`) and is resolved server-side, which an environment
  // on the pre-selector platform build answers as a request-shape error — a
  // failure that is not drift. See `apiAdvertisesExtension`.
  //
  // The package is pinned at a tag so the assertions below can be exact: a
  // published address is only a stable fixture at an immutable ref.
  it.skipIf(!SERVES_SELECTORS)("projects a published method's template by address", async () => {
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
});
