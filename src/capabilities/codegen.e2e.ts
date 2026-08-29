/**
 * Live e2e — `mthds_codegen` against a real Pipelex API.
 *
 * Two things are only observable live. First, that every target this client
 * hand-mirrors from the SDK's `CodegenTarget` is still one the engine serves:
 * the enum is typed from the SDK, so a target the SDK *dropped* fails
 * typecheck, but a target the *engine* dropped while the SDK still names it
 * would only show up here. Second, the trust chain: the artifacts and lock
 * the tool hands back must be byte-identical to what a local `pipelex codegen
 * types` run writes, and the SDK's offline `runCodegenCheck` — pure hashing,
 * no engine — is the same verdict the CLI computes over the same bytes. A
 * tree that passes it here would pass it on disk.
 */

import { runCodegenCheck } from "@pipelex/sdk";
import { describe, expect, it } from "vitest";

import { CODEGEN_TARGETS, generateMthdsCode } from "./codegen.js";
import type { CodegenContext } from "./codegen.js";
import {
  FIXTURE_BUNDLE,
  FIXTURE_BUNDLE_URI,
  INVALID_BUNDLE,
  INVALID_BUNDLE_URI,
  liveApiConfig,
} from "./e2e-support.js";

// No `client` seam and no `resolver`: the real client, inline files only.
const context: CodegenContext = liveApiConfig();

const fixtureFiles = [{ content: FIXTURE_BUNDLE, uri: FIXTURE_BUNDLE_URI }];

describe("mthds_codegen (live)", () => {
  for (const target of CODEGEN_TARGETS) {
    it(`generates ${target} artifacts whose lock the offline check accepts`, async () => {
      const result = await generateMthdsCode({ files: fixtureFiles, target }, context);

      expect(result.structuredContent.status).toBe("ok");
      expect(result.structuredContent.is_valid).toBe(true);
      expect(result.structuredContent.target).toBe(target);
      expect(result.structuredContent.kind).toBe("types");
      expect(result.structuredContent.errors).toBeUndefined();
      expect(typeof result.structuredContent.crate_fingerprint).toBe("string");
      expect(typeof result.structuredContent.engine_version).toBe("string");

      const artifacts = result.structuredContent.artifacts ?? [];
      const lock = result.structuredContent.lock;
      expect(artifacts.length).toBeGreaterThan(0);
      expect(lock?.filename).toBe("codegen.lock");
      // The fixture is a small method; nothing may be withheld, and every
      // artifact must carry its content — an empty file is a broken emitter.
      expect(result.structuredContent.truncated).toBe(false);
      for (const artifact of artifacts) {
        expect(typeof artifact.content).toBe("string");
        expect(artifact.content?.trim()).not.toBe("");
      }
      expect(typeof lock?.content).toBe("string");

      // The trust chain, end to end and free: the lock must govern exactly
      // these bytes. `CodegenTreeFile` is structurally `GeneratedArtifact`, so
      // the bounded artifacts feed straight in.
      const check = await runCodegenCheck({
        lockContent: lock?.content ?? "",
        files: artifacts.map((artifact) => ({
          path: artifact.path,
          content: artifact.content ?? "",
        })),
      });
      expect(check.drifts).toEqual([]);
      expect(check.isCurrent).toBe(true);
      expect(check.crateFingerprint).toBe(result.structuredContent.crate_fingerprint);

      // The summary carries the artifacts for hosts that read prose.
      for (const artifact of artifacts) {
        expect(result.summary).toContain(`## \`${artifact.path}\``);
      }
    });
  }

  it("emits both TypeScript files for ts-zod — types.ts and its binder", async () => {
    const result = await generateMthdsCode({ files: fixtureFiles, target: "ts-zod" }, context);

    const paths = (result.structuredContent.artifacts ?? [])
      .map((artifact) => artifact.path)
      .sort();
    expect(paths).toEqual(["binder.ts", "types.ts"]);
  });

  it("reports an unresolvable closure as a PRODUCED verdict, not an error", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: INVALID_BUNDLE, uri: INVALID_BUNDLE_URI }], target: "ts-zod" },
      context,
    );

    // status "ok" with is_valid false: the route produced a verdict, and the
    // caller discriminates on is_valid — never on the transport.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.errors).toBeUndefined();
    expect(result.structuredContent.artifacts).toBeUndefined();
    const validationErrors = result.structuredContent.validation_errors;
    expect(Array.isArray(validationErrors)).toBe(true);
    expect(validationErrors?.length ?? 0).toBeGreaterThan(0);
    expect(result.summary.trim()).not.toBe("");
  });

  it("rejects a request carrying no selector at all", async () => {
    const result = await generateMthdsCode({ target: "ts-zod" }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
  });
});

/**
 * GATED on the hosted deploy — Checkpoint 3 of `wip/addressing-methods/plan.md`.
 *
 * Both selectors are server pass-throughs on `POST /v1/codegen` (the runner
 * resolves the address, the hosted platform resolves the id), and the hosted
 * API does not serve selector bodies until the platform deploy that checkpoint
 * gates on has happened. Un-skip once it lands; against a hosted API that
 * predates it these calls come back as request-shape errors, which would fail
 * the suite for a reason that is not drift.
 *
 * Probed on 2026-08-29 to keep this gate honest. The local stack already
 * serves both, so the capability's mapping is exercised there by hand: an
 * address returns a stamped `is_valid` report, and so does a catalog id. The
 * hosted API is the half that is behind — `method_ref` answers `501`
 * `MethodRefNotSupported` ("no method registry is wired"), and `method_id` is
 * not yet in its request schema at all, so it answers `422` "provide exactly
 * one of `files` or `method_ref`". That second body is the one to re-probe
 * before un-skipping: it means the hosted route rejects the field rather than
 * failing to resolve it.
 */
describe.skip("mthds_codegen by selector (live, gated)", () => {
  it("generates from a stored method by id alone (server-side resolution)", async () => {
    const { fixtureMethodId } = await import("./e2e-support.js");
    const result = await generateMthdsCode(
      { method_id: await fixtureMethodId(), target: "ts-zod" },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.lock?.filename).toBe("codegen.lock");
  });

  it("generates from a published method by address (server-side git resolution)", async () => {
    const result = await generateMthdsCode(
      { method_ref: "github.com/Pipelex/methods/text_stats@v0.1.1", target: "ts-zod" },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
  });
});
