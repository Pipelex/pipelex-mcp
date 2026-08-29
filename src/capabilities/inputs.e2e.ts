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
  liveApiConfig,
} from "./e2e-support.js";

const context: InputsContext = liveApiConfig();

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

  // GATED on the hosted deploy — Checkpoint 3 of `wip/addressing-methods/plan.md`.
  // `method_ref` rides the build envelope (`POST /v1/build/inputs`) and is
  // resolved server-side; api.pipelex.com does not serve it until that deploy,
  // so running this today fails for a reason that is not drift. Un-skip once it
  // lands.
  it.skip("projects a published method's template by address (gated)", async () => {
    const result = await buildMthdsInputs(
      { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
  });
});
