/**
 * Live e2e — the by-id fetch-and-forward leg (`fetchMethodFiles`).
 *
 * `getMethodClosure` has the same blind spot `listMethods` had: a hand-written
 * narrow interface, a faked client in every unit test, and no live coverage at
 * all. Since the selector unification it backs the id-only paths of
 * `mthds_inputs_template` and `mthds_prepare_inputs` (the build routes and the
 * client-side prepare walk have no server-side `method_id`); `mthds_validate`
 * forwards its selector to the server instead and its live coverage lives in
 * `validate.e2e.ts`, gated on the hosted deploy.
 *
 * The suite proves the leg twice over: directly, and then through one capability
 * end to end — the fetched source must actually project a template, not merely
 * arrive.
 */

import { describe, expect, it } from "vitest";

import { buildMthdsInputs } from "./inputs.js";
import type { InputsContext } from "./inputs.js";
import { FIXTURE_PIPE_REF, fixtureMethodId, liveApiConfig, liveClient } from "./e2e-support.js";
import { fetchMethodFiles } from "./shared.js";

const inputsContext: InputsContext = liveApiConfig();

const NO_SOURCE_HINT = "Add MTHDS content to the method before using it by id.";

/**
 * Every assertion below reads the SEEDED copy of the fixture, not the inline one,
 * so an edit to FIXTURE_BUNDLE that was never re-seeded fails them exactly the way
 * real drift would — and points the reader at `../pipelex-sdk-js`, which is the
 * wrong repo. Name the cheaper cause on the assertions that can have it.
 */
const STALE_SEED_HINT =
  "the stored fixture disagrees with e2e-support.ts — if FIXTURE_BUNDLE changed since the last " +
  "`make seed-e2e-fixture`, this is a stale seed rather than API drift; re-seed before chasing it";

describe("fetchMethodFiles (live)", () => {
  it("resolves a stored method's closure and labels every file with the method id", async () => {
    const methodId = await fixtureMethodId();

    const fetched = await fetchMethodFiles(() => liveClient(), methodId, {
      noSourceHint: NO_SOURCE_HINT,
    });

    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;

    expect(fetched.files.length).toBeGreaterThan(0);
    for (const file of fetched.files) {
      // Provenance: the MCP surface spells it `uri`, and diagnostics locate to it.
      expect(file.uri).toBe(methodId);
      expect(typeof file.content).toBe("string");
      expect(file.content).not.toBe("");
    }

    // Not merely "some content": this is the bundle the seed script stored.
    expect(fetched.files.map((file) => file.content).join("\n"), STALE_SEED_HINT).toContain(
      "mcp_e2e_fixture",
    );
  });

  it("classifies an unknown method id as an input_domain no-verdict at method_id", async () => {
    const fetched = await fetchMethodFiles(
      () => liveClient(),
      "mt_00000000-0000-4000-8000-000000000000",
      { noSourceHint: NO_SOURCE_HINT },
    );

    expect(fetched.ok).toBe(false);
    if (fetched.ok) return;

    expect(fetched.reason).toBe("fetch");
    expect(fetched.error.class).toBe("input_domain");
    expect(fetched.error.location).toBe("method_id");
    expect(fetched.error.retryable).toBe(false);
  });
});

describe("by-id capability paths (live)", () => {
  it("projects a stored method's inputs template from its id alone", async () => {
    const result = await buildMthdsInputs({ method_id: await fixtureMethodId() }, inputsContext);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.pipe_ref, STALE_SEED_HINT).toBe(FIXTURE_PIPE_REF);
  });
});
