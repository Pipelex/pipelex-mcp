/**
 * A hermetic test of how the live targets (`make smoke`, `make test-e2e`, …)
 * pick the API they call, and what they refuse before any request.
 *
 * They read their own pair, `PIPELEX_E2E_BASE_URL` and `PIPELEX_E2E_API_KEY`,
 * never the `PIPELEX_BASE_URL` / `PIPELEX_API_KEY` that other tools and the
 * server itself read: a shell exporting the production pair for other tools used to
 * aim `make test-e2e` at production, where no fixture is seeded. They take the
 * pair from the make command line or the environment, which the workspace's
 * `test-account run` fills with a registered key and what the registry expects
 * of it, and never from `.env`, which used to win over the environment. The
 * Makefile resolves the pair and `e2e-support.ts` reads it, so both halves are
 * pinned here. The Makefile half runs `make -f` from a temp directory holding
 * its own `.env`, which is how nothing here reads the repo's `.env` or the
 * developer's shell; `make -n` prints the preflight's target line without
 * running it, and the real runs below stop before any network call.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LIVE_DEFAULT_BASE_URL, liveApiTarget } from "../src/capabilities/e2e-support.js";

const MAKEFILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "Makefile");

// A minimal environment on purpose: a parent
// `make test` would hand its MAKEFLAGS to the child, and the developer's shell
// could leak the very variables under test.
const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

const PROD = "https://api.pipelex.com";
const STAGING = "https://api-staging.pipelex.com";
const LOCAL = "http://localhost:8081";
// Port 1 on loopback refuses a connection at once, so a real run that reached
// the reachability check stops there without leaving the machine.
const UNREACHABLE = "http://127.0.0.1:1";

// What `test-account run` sets beside the key; not secrets, so a test may print them.
const EXPECTATIONS = {
  PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID: "org_00000000-0000-4000-8000-000000000000",
  PIPELEX_E2E_API_KEY_EXPECTED_ROLE: "member",
  PIPELEX_E2E_API_KEY_EXPECTED_EMAIL: "qa+builder@example.com",
};

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

  it("goes to dev when nothing names its pair, whatever the environment and .env say", async () => {
    await writeDotenv([
      "PIPELEX_BASE_URL=http://localhost:8080",
      "PIPELEX_API_KEY=plx_sk_console",
      `PIPELEX_E2E_BASE_URL=${LOCAL}`,
      "PIPELEX_E2E_API_KEY=plx_sk_dotenv",
    ]);

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

  it("takes the pair from the environment, as test-account run hands it over", async () => {
    await writeDotenv(["PIPELEX_BASE_URL=http://localhost:8080"]);

    expect(
      plan({ PIPELEX_E2E_BASE_URL: STAGING, PIPELEX_E2E_API_KEY: "plx_sk_env" }),
    ).toMatchObject({ url: STAGING, urlFrom: "the environment", keyFrom: "the environment" });
  });

  it("never lets .env replace the pair the environment hands over", async () => {
    await writeDotenv([`PIPELEX_E2E_BASE_URL=${LOCAL}`, "PIPELEX_E2E_API_KEY=plx_sk_dotenv"]);

    expect(
      plan({ PIPELEX_E2E_BASE_URL: STAGING, PIPELEX_E2E_API_KEY: "plx_sk_env" }),
    ).toMatchObject({ url: STAGING, urlFrom: "the environment", keyFrom: "the environment" });
  });

  it("prefers the make command line to the environment", async () => {
    await writeDotenv([]);

    expect(
      plan(
        { PIPELEX_E2E_BASE_URL: LOCAL, PIPELEX_E2E_API_KEY: "plx_sk_env" },
        `PIPELEX_E2E_BASE_URL=${STAGING}`,
      ),
    ).toMatchObject({
      url: STAGING,
      urlFrom: "the make command line",
      keyFrom: "the environment",
    });
  });

  it("never prints the key itself", async () => {
    await writeDotenv(["PIPELEX_E2E_API_KEY=plx_sk_secret_from_dotenv"]);

    expect(plan({ PIPELEX_E2E_API_KEY: "plx_sk_secret_from_env" }).output).not.toContain(
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

  // The two refusals below aim at port 1 on loopback, so a request, had one
  // been sent, would fail at once without leaving the machine; that none is
  // sent shows as the reachability error's absence.
  it("refuses a run with no key before any request, naming test-account run, even with one in .env", async () => {
    await writeDotenv(["PIPELEX_E2E_API_KEY=plx_sk_dotenv"]);

    const { status, output } = make(["test-e2e"], {
      PIPELEX_E2E_BASE_URL: UNREACHABLE,
      ...EXPECTATIONS,
    });

    expect(status).not.toBe(0);
    expect(output).toContain("ERROR: PIPELEX_E2E_API_KEY is not set, so no request was sent.");
    expect(output).toContain("'test-account run pipelex-mcp -- make test-e2e'");
    expect(output).toContain("They never read .env.");
    expect(output).not.toContain("no Pipelex API reachable");
  });

  it("refuses a key without its expectations before any request, naming each one missing", async () => {
    await writeDotenv([]);

    const { status, output } = make(["seed-e2e-fixture"], {
      PIPELEX_E2E_BASE_URL: UNREACHABLE,
      PIPELEX_E2E_API_KEY: "plx_sk_env",
      PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID: EXPECTATIONS.PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID,
    });

    expect(status).not.toBe(0);
    expect(output).toContain(
      "ERROR: not set: PIPELEX_E2E_API_KEY_EXPECTED_ROLE PIPELEX_E2E_API_KEY_EXPECTED_EMAIL — nothing says which account PIPELEX_E2E_API_KEY must act for, so no request was sent.",
    );
    expect(output).toContain("'test-account run pipelex-mcp -- make seed-e2e-fixture'");
    expect(output).not.toContain("no Pipelex API reachable");
    expect(output).not.toContain("plx_sk_env");
  });

  it("says the environment's PIPELEX_BASE_URL is ignored, and names the target it could not reach", async () => {
    await writeDotenv([]);

    const { status, output } = make(["live-preflight"], {
      PIPELEX_BASE_URL: PROD,
      PIPELEX_E2E_BASE_URL: `${UNREACHABLE}/`,
      PIPELEX_E2E_API_KEY: "plx_sk_env",
      ...EXPECTATIONS,
    });

    expect(status).not.toBe(0);
    expect(output).toContain(
      `-> target: ${UNREACHABLE} (PIPELEX_E2E_BASE_URL from the environment)`,
    );
    expect(output).toContain(
      "PIPELEX_BASE_URL / PIPELEX_API_KEY in the environment are ignored here",
    );
    expect(output).toContain(`ERROR: no Pipelex API reachable at ${UNREACHABLE}`);
    expect(output).toContain(
      "start the OSS runner with 'make -C api run' in a checkout of Pipelex/pipelex",
    );
  });
});
