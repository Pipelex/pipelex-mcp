/**
 * A hermetic test of how the live targets (`make smoke`, `make test-e2e`, …)
 * pick the API they call.
 *
 * They read their own pair, `PIPELEX_E2E_BASE_URL` and `PIPELEX_E2E_API_KEY`,
 * never the `PIPELEX_BASE_URL` / `PIPELEX_API_KEY` that other tools and the
 * console share: a shell exporting the production pair for other tools used to
 * aim `make test-e2e` at production, where no fixture is seeded. The Makefile
 * resolves the pair and `e2e-support.ts` reads it, so both halves are pinned
 * here. The Makefile half runs `make -f` from a temp directory holding its own
 * `.env`, which is how nothing here reads the repo's `.env` or the developer's
 * shell; `make -n` prints the preflight's target line without running it, and
 * the two real runs below stop before any network call.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LIVE_DEFAULT_BASE_URL, liveApiTarget } from "./capabilities/e2e-support.js";

const MAKEFILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "Makefile");

// A minimal environment on purpose, as in `make-dev-recipe.test.ts`: a parent
// `make test` would hand its MAKEFLAGS to the child, and the developer's shell
// could leak the very variables under test.
const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

const PROD = "https://api.pipelex.com";
const STAGING = "https://api-staging.pipelex.com";
const LOCAL = "http://localhost:8081";

describe("liveApiTarget", () => {
  it("ignores the pair other tools use, defaulting to dev", () => {
    expect(liveApiTarget({ PIPELEX_BASE_URL: PROD, PIPELEX_API_KEY: "plx_sk_prod" })).toEqual({
      baseUrl: LIVE_DEFAULT_BASE_URL,
      apiKey: undefined,
    });
  });

  it("reads its own pair, an empty value counting as unset", () => {
    expect(
      liveApiTarget({ PIPELEX_E2E_BASE_URL: LOCAL, PIPELEX_E2E_API_KEY: "plx_sk_e2e" }),
    ).toEqual({
      baseUrl: LOCAL,
      apiKey: "plx_sk_e2e",
    });
    expect(liveApiTarget({ PIPELEX_E2E_BASE_URL: "", PIPELEX_E2E_API_KEY: "" })).toEqual({
      baseUrl: LIVE_DEFAULT_BASE_URL,
      apiKey: undefined,
    });
  });
});

describe("the live targets' preflight", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-make-live-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeDotenv(lines: string[]): Promise<void> {
    await fs.writeFile(path.join(dir, ".env"), `${lines.join("\n")}\n`);
  }

  function make(args: string[], shell: NodeJS.ProcessEnv = {}) {
    const result = spawnSync("make", ["-f", MAKEFILE, "--no-print-directory", ...args], {
      cwd: dir,
      env: { ...BASE_ENV, ...shell },
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  // The target line as `make -n` prints it: the URL inside the printf that
  // strips trailing slashes, then where each of the pair came from.
  function plan(shell: NodeJS.ProcessEnv = {}, ...overrides: string[]) {
    const { status, output } = make(["-n", "live-preflight", ...overrides], shell);
    expect(status, output).toBe(0);
    const line = output.split("\n").find((l) => l.includes("-> target:"));
    expect(line, output).toBeDefined();
    const match =
      /printf '%s' "([^"]*)".*PIPELEX_E2E_BASE_URL from ([^)]*)\); key: PIPELEX_E2E_API_KEY from (.*)"$/.exec(
        line ?? "",
      );
    expect(match, line).not.toBeNull();
    return { url: match?.[1], urlFrom: match?.[2], keyFrom: match?.[3], output };
  }

  it("goes to dev when nothing names its pair, whatever the shell and .env say about the other tools' pair", async () => {
    await writeDotenv(["PIPELEX_BASE_URL=http://localhost:8080", "PIPELEX_API_KEY=plx_sk_console"]);

    expect(plan({ PIPELEX_BASE_URL: PROD, PIPELEX_API_KEY: "plx_sk_prod" })).toMatchObject({
      url: "https://api-dev.pipelex.com",
      urlFrom: "the default",
      keyFrom: "nowhere",
    });
  });

  it("repeats the Makefile's default in e2e-support.ts", async () => {
    await writeDotenv([]);

    expect(plan().url).toBe(LIVE_DEFAULT_BASE_URL);
  });

  it("takes the pair from the shell when .env does not set it", async () => {
    await writeDotenv(["PIPELEX_BASE_URL=http://localhost:8080"]);

    expect(
      plan({ PIPELEX_E2E_BASE_URL: STAGING, PIPELEX_E2E_API_KEY: "plx_sk_shell" }),
    ).toMatchObject({ url: STAGING, urlFrom: "the shell", keyFrom: "the shell" });
  });

  it("prefers .env to the shell, and each value is taken from its own first source", async () => {
    await writeDotenv([`PIPELEX_E2E_BASE_URL=${LOCAL}`]);

    expect(
      plan({ PIPELEX_E2E_BASE_URL: STAGING, PIPELEX_E2E_API_KEY: "plx_sk_shell" }),
    ).toMatchObject({ url: LOCAL, urlFrom: ".env", keyFrom: "the shell" });
  });

  it("prefers the make command line to .env", async () => {
    await writeDotenv([`PIPELEX_E2E_BASE_URL=${LOCAL}`, "PIPELEX_E2E_API_KEY=plx_sk_dotenv"]);

    expect(plan({}, `PIPELEX_E2E_BASE_URL=${STAGING}`)).toMatchObject({
      url: STAGING,
      urlFrom: "the make command line",
      keyFrom: ".env",
    });
  });

  it("never prints the key itself", async () => {
    await writeDotenv(["PIPELEX_E2E_API_KEY=plx_sk_secret_from_dotenv"]);

    expect(plan({ PIPELEX_E2E_API_KEY: "plx_sk_secret_from_shell" }).output).not.toContain(
      "plx_sk_secret",
    );
  });

  it("refuses the other tools' pair on the command line instead of quietly going to dev", async () => {
    await writeDotenv([]);

    const { status, output } = make(["live-preflight", `PIPELEX_BASE_URL=${LOCAL}`]);

    expect(status).not.toBe(0);
    expect(output).toContain("the live targets read PIPELEX_E2E_BASE_URL and PIPELEX_E2E_API_KEY");
    expect(output).not.toContain("-> target:");
  });

  it("says the shell's PIPELEX_BASE_URL is ignored, and names the target it could not reach", async () => {
    // Port 1 on loopback refuses the connection at once, so this real run stops
    // at the reachability check without leaving the machine.
    await writeDotenv(["PIPELEX_E2E_BASE_URL=http://127.0.0.1:1/"]);

    const { status, output } = make(["live-preflight"], { PIPELEX_BASE_URL: PROD });

    expect(status).not.toBe(0);
    expect(output).toContain("-> target: http://127.0.0.1:1 (PIPELEX_E2E_BASE_URL from .env)");
    expect(output).toContain(
      "PIPELEX_BASE_URL / PIPELEX_API_KEY in the environment are ignored here",
    );
    expect(output).toContain("ERROR: no Pipelex API reachable at http://127.0.0.1:1");
  });
});
