import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CodegenValidReport } from "@pipelex/sdk";

/**
 * A REAL `ts-zod` codegen response, recorded from the engine, for the hermetic
 * writer tests.
 *
 * `runCodegenCheck` verifies content hashes, so the writer's tests need
 * artifacts whose stamps and lock actually agree — which nothing hermetic can
 * fabricate without a fourth copy of the hashing rule. So the bytes are
 * recorded rather than written: `__fixtures__/codegen-ts-zod/` holds the two
 * artifacts and the lock as REAL FILES with a `.recorded` suffix, and this
 * module is a loader, not the bytes. Byte-exactness is the whole point — a
 * file on disk is self-evidently verbatim where a TypeScript template literal
 * is one stray backtick or `${` away from silently different bytes, surfacing
 * as a hash mismatch rather than a syntax error. The suffix also keeps the
 * recordings out of `tsc`, ESLint and Prettier, and out of both bundles, by
 * construction rather than by reachability.
 *
 * The check is engine-version-agnostic (hashes only), so the recording never
 * goes stale for its purposes; proving a CURRENT engine still writes a
 * checkable tree is the live suite's job, not this one's.
 */

const FIXTURE_DIR = fileURLToPath(new URL("./__fixtures__/codegen-ts-zod/", import.meta.url));

interface RecordedManifest {
  target: CodegenValidReport["target"];
  kind: "types";
  crate_fingerprint: string;
  engine_version: string;
  message: string;
  lock_filename: string;
  artifact_paths: string[];
}

let cached: CodegenValidReport | undefined;

/** The recorded response, as `client.codegen()` returned it. Cached — the bytes never change. */
export async function recordedTsZodReport(): Promise<CodegenValidReport> {
  if (cached !== undefined) {
    return cached;
  }
  const manifest = JSON.parse(
    await fs.readFile(path.join(FIXTURE_DIR, "manifest.json"), "utf8"),
  ) as RecordedManifest;

  const artifacts = await Promise.all(
    manifest.artifact_paths.map(async (artifactPath) => ({
      path: artifactPath,
      content: await readRecorded(artifactPath),
    })),
  );

  cached = {
    is_valid: true,
    message: manifest.message,
    target: manifest.target,
    kind: manifest.kind,
    crate_fingerprint: manifest.crate_fingerprint,
    engine_version: manifest.engine_version,
    artifacts,
    lock: await readRecorded(manifest.lock_filename),
    lock_filename: manifest.lock_filename,
  };
  return cached;
}

async function readRecorded(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURE_DIR, `${name}.recorded`), "utf8");
}
