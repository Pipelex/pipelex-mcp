/**
 * The environment `make smoke` starts the workshop in, apart from
 * `scripts/smoke.ts` so a test can import it: that script runs on import.
 *
 * The workshop reads the key saved in the home `.env` whenever its host passes
 * none (`src/credentials.ts`), from `PIPELEX_HOME` or else `~/.pipelex`, which
 * it finds through `os.homedir()`. The MCP SDK's base environment always
 * carries `HOME`, so a smoke run without `PIPELEX_E2E_API_KEY` would send the
 * developer's saved key, and the file's base URL with it, while the script
 * reports the key as not set. The child's `PIPELEX_HOME` is therefore an empty
 * temporary directory of its own, as in both Vitest configs, so the smoke run
 * sends the live targets' key or none at all.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { LiveApiTarget } from "../src/capabilities/e2e-support.js";

/**
 * The child's environment: the MCP SDK's safe base environment, the server's
 * two knobs set from the live pair, so the server resolves exactly the API the
 * script reports and never an ambient `PIPELEX_BASE_URL` meant for other
 * tools, and `home` as `PIPELEX_HOME`, so the server never reads a saved key.
 * `PIPELEX_API_KEY` is set only when the live pair carries a key.
 */
export function smokeChildEnv(
  target: LiveApiTarget,
  home: string,
  base: Record<string, string> = getDefaultEnvironment(),
): Record<string, string> {
  const env: Record<string, string> = {
    ...base,
    PIPELEX_BASE_URL: target.baseUrl,
    PIPELEX_HOME: home,
  };
  if (target.apiKey === undefined) {
    delete env.PIPELEX_API_KEY;
  } else {
    env.PIPELEX_API_KEY = target.apiKey;
  }
  return env;
}

/** An empty home for the child, removed when the script exits. */
export function emptySmokeHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "pipelex-mcp-smoke-home-"));
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
  return home;
}
