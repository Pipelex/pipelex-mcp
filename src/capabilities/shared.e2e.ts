/**
 * Live e2e — the by-id fetch-and-forward leg (`fetchMethodFiles`).
 *
 * `getMethodClosure` has the same blind spot `listMethods` had: a hand-written
 * narrow interface, a faked client in every unit test, and no live coverage at
 * all. It is also the single leg behind EVERY files-or-`method_id` capability's
 * id-only path, so one wire change there breaks `mthds_validate`,
 * `mthds_inputs_template` and `mthds_prepare_inputs` at once.
 *
 * The suite proves the leg twice over: directly, and then through one capability
 * end to end — the fetched source must actually validate, not merely arrive.
 */

import { describe, expect, it } from "vitest";

import { buildMthdsInputs } from "./inputs.js";
import type { InputsContext } from "./inputs.js";
import {
  FIXTURE_PIPE_REF,
  INVALID_BUNDLE,
  INVALID_BUNDLE_URI,
  fixtureMethodId,
  liveApiConfig,
  liveClient,
} from "./e2e-support.js";
import { fetchMethodFiles } from "./shared.js";
import { validateMthds } from "./validate.js";
import type { ValidationContext } from "./validate.js";

const validationContext: ValidationContext = liveApiConfig();
const inputsContext: InputsContext = liveApiConfig();

const NO_SOURCE_HINT = "Add MTHDS content to the method before using it by id.";

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
    expect(fetched.files.map((file) => file.content).join("\n")).toContain("mcp_e2e_fixture");
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
  it("validates a stored method from its id alone", async () => {
    const result = await validateMthds({ method_id: await fixtureMethodId() }, validationContext);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.is_runnable).toBe(true);
  });

  it("projects a stored method's inputs template from its id alone", async () => {
    const result = await buildMthdsInputs({ method_id: await fixtureMethodId() }, inputsContext);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.pipe_ref).toBe(FIXTURE_PIPE_REF);
  });

  it("lets inline files win when both files and method_id are supplied", async () => {
    // The stored fixture validates and the inline bundle does not, so the
    // verdict itself says which source was used — no mocking required.
    const result = await validateMthds(
      {
        files: [{ content: INVALID_BUNDLE, uri: INVALID_BUNDLE_URI }],
        method_id: await fixtureMethodId(),
      },
      validationContext,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
  });
});
