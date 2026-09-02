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

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCodegenCheck } from "@pipelex/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { CODEGEN_TARGETS, generateMthdsCode } from "./codegen.js";
import type { CodegenContext } from "./codegen.js";
import {
  FIXTURE_BUNDLE,
  FIXTURE_BUNDLE_URI,
  INVALID_BUNDLE,
  INVALID_BUNDLE_URI,
  apiAdvertisesExtension,
  liveApiConfig,
} from "./e2e-support.js";

// No `client` seam and no `resolver`: the real client, inline files only.
const context: CodegenContext = liveApiConfig();

/** Does this deployment resolve `method_id` / `method_ref` server-side? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

const fixtureFiles = [{ content: FIXTURE_BUNDLE, uri: FIXTURE_BUNDLE_URI }];

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-codegen-e2e-"));
  tempDirs.push(dir);
  return dir;
}

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
 * The workshop's write arm, live. The hermetic writer suite runs against a
 * RECORDED engine response; this is what proves a CURRENT engine still writes
 * a tree the offline check accepts — and that the two policies the writer must
 * hold apart really behave that way on disk: regeneration overwrites its own
 * files, and a second target into the same directory produces orphans it never
 * deletes.
 */
describe("mthds_codegen output_dir (live)", () => {
  it("writes a checkable tree, overwrites its own regeneration, and reports a second target as orphans", async () => {
    const saveRoot = await makeTempDir();
    const workshop: CodegenContext = { ...context, saveRoot };
    const dir = path.join(saveRoot, "generated");

    const first = await generateMthdsCode(
      { files: fixtureFiles, target: "ts-zod", output_dir: "generated" },
      workshop,
    );

    expect(first.structuredContent.status).toBe("ok");
    expect(first.structuredContent.is_valid).toBe(true);
    expect(first.structuredContent.output_dir).toBe("generated");
    expect(first.structuredContent.is_current).toBe(true);
    expect(first.structuredContent.orphans).toEqual([]);
    expect(first.structuredContent.truncated).toBe(false);
    // Nothing rode the response: the whole point of the write arm.
    expect(first.structuredContent.artifacts?.every((a) => a.content === undefined)).toBe(true);
    expect(first.structuredContent.lock?.content).toBeUndefined();
    expect(await fs.readdir(dir)).toEqual(
      expect.arrayContaining(["binder.ts", "codegen.lock", "types.ts"]),
    );

    // A second opinion on the writer's own check, computed independently from
    // what is on disk.
    const check = await runCodegenCheck({
      lockContent: await fs.readFile(path.join(dir, "codegen.lock"), "utf8"),
      files: await Promise.all(
        ["binder.ts", "types.ts"].map(async (name) => ({
          path: name,
          content: await fs.readFile(path.join(dir, name), "utf8"),
        })),
      ),
    });
    expect(check.isCurrent).toBe(true);
    expect(check.crateFingerprint).toBe(first.structuredContent.crate_fingerprint);

    // Regeneration into the same directory: stamped files, so no refusal.
    const again = await generateMthdsCode(
      { files: fixtureFiles, target: "ts-zod", output_dir: "generated" },
      workshop,
    );
    expect(again.structuredContent.status).toBe("ok");
    expect(again.structuredContent.is_current).toBe(true);
    expect(again.structuredContent.orphans).toEqual([]);

    // A different target into the same directory: D7 in action — the TypeScript
    // files are now orphans, reported and left on disk.
    const mixed = await generateMthdsCode(
      { files: fixtureFiles, target: "python-pydantic", output_dir: "generated" },
      workshop,
    );
    expect(mixed.structuredContent.status).toBe("ok");
    expect(mixed.structuredContent.is_current).toBe(false);
    expect([...(mixed.structuredContent.orphans ?? [])].sort()).toEqual(["binder.ts", "types.ts"]);
    expect(mixed.structuredContent.drifts).toBeUndefined();
    expect(await fs.stat(path.join(dir, "types.ts"))).toBeDefined();
    expect(await fs.stat(path.join(dir, "models.py"))).toBeDefined();
  });

  it("refuses a foreign file in the target directory, writing nothing", async () => {
    const saveRoot = await makeTempDir();
    const dir = path.join(saveRoot, "generated");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "types.ts"), "export const mine = 1;\n", "utf8");

    const result = await generateMthdsCode(
      { files: fixtureFiles, target: "ts-zod", output_dir: "generated" },
      { ...context, saveRoot },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "output_dir",
    });
    expect(await fs.readdir(dir)).toEqual(["types.ts"]);
    expect(await fs.readFile(path.join(dir, "types.ts"), "utf8")).toBe("export const mine = 1;\n");
  });
});

/**
 * GATED on the live API, not on a date: both selectors are server pass-throughs
 * on `POST /v1/codegen` (the runner resolves the address, the hosted platform
 * resolves the id), which an environment on the pre-selector platform build
 * answers as a request-shape error — a failure that is not drift. The probe
 * asks `/v1/version` whether this deployment serves them; see
 * `apiAdvertisesExtension`.
 */
describe.skipIf(!SERVES_SELECTORS)("mthds_codegen by selector (live)", () => {
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
