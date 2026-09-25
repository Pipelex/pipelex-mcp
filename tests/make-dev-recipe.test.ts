/**
 * A hermetic test of the console dev recipe (`make dev` / `make dev-tunnel`).
 *
 * Makefile logic that reads configuration is untested by construction, and this
 * recipe carries real logic: the precedence between the make command line,
 * `.env`, the shell and the defaults; the `--port` pin; and the guard's
 * refusals. `make -n` prints a recipe without executing it, so the expansion can
 * be asserted on directly, and the recipe's prelude (everything before the final
 * `npm run …`) can be executed under `sh` in a temp directory with a free port
 * to check every guard verdict. Nothing here touches the network, the repo's own
 * `.env`, or a real server.
 *
 * It lives at the top of `src/` because the hermetic suite's `include` and the
 * TypeScript root are both `src/`; it is about the Makefile, not a module.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A minimal environment on purpose: a parent `make test` would otherwise hand its
// own MAKEFLAGS / MAKELEVEL / overrides to the child make, and the developer's
// shell could leak the very variables whose precedence is under test.
const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

const NPM_TAIL = /;\s*npm run (dev|dev:tunnel) -- --port "\$CONSOLE_PORT"\s*$/;
const GUARD_START = 'case "${PIPELEX_MCP_RESOURCE_INDICATOR:-}"';

const hasLsof = spawnSync("lsof", ["-v"], { env: BASE_ENV }).status === 0;

function expand(target: string, ...overrides: string[]): string {
  const raw = execFileSync("make", ["-n", "--no-print-directory", target, ...overrides], {
    cwd: REPO_ROOT,
    env: BASE_ENV,
    encoding: "utf8",
  });
  // GNU make 4 keeps a recipe's backslash-newlines; 3.81 joins them. Normalize.
  return raw.replace(/\\\n\s*/g, " ");
}

function preludeOf(recipe: string): string {
  expect(recipe).toMatch(NPM_TAIL);
  return recipe.replace(NPM_TAIL, "");
}

function runPrelude(prelude: string, dir: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync("sh", ["-c", prelude], {
    cwd: dir,
    env: { ...BASE_ENV, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function canBind(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    // A machine without IPv6 answers EADDRNOTAVAIL for ::1; that is not "held".
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRNOTAVAIL"));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

// A port outside the OS ephemeral ranges (macOS hands out 49152+, Linux 32768+),
// so that another process's outgoing connection or IPC listener cannot take it
// between this check and the guard's own. The wildcard bind alone would not see
// a loopback-only holder, so the loopback addresses are checked as well.
async function pickPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = 20000 + Math.floor(Math.random() * 10000);
    if (
      (await canBind(candidate)) &&
      (await canBind(candidate, "127.0.0.1")) &&
      (await canBind(candidate, "::1"))
    ) {
      return candidate;
    }
  }
  throw new Error("no free port found in 20000-29999");
}

function hold(port: number, host?: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function release(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function expectAscending(haystack: string, needles: string[]): void {
  let last = -1;
  for (const needle of needles) {
    const at = haystack.indexOf(needle);
    expect(at, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
    expect(at, `expected ${JSON.stringify(needle)} after the previous marker`).toBeGreaterThan(
      last,
    );
    last = at;
  }
}

describe("the console dev recipe", () => {
  let dir: string;
  let port: number;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-make-dev-"));
    port = await pickPort();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("expansion", () => {
    it("sources .env, then puts the command-line overrides back, then guards, then pins --port", () => {
      const recipe = expand("dev", "PIPELEX_BASE_URL=http://from-cli:3", "CONSOLE_PORT=6999");
      expectAscending(recipe, [
        '_cli_PIPELEX_BASE_URL="$PIPELEX_BASE_URL"',
        ". ./.env",
        'CONSOLE_PORT="$_cli_CONSOLE_PORT"; export CONSOLE_PORT',
        'PIPELEX_BASE_URL="$_cli_PIPELEX_BASE_URL"; export PIPELEX_BASE_URL',
        "-> console API target",
        GUARD_START,
      ]);
      expect(recipe).toMatch(/npm run dev -- --port "\$CONSOLE_PORT"\s*$/);
    });

    it("puts nothing back when nothing was given on the command line", () => {
      expect(expand("dev")).not.toContain("_cli_");
    });

    it("reads the port from the shell, never from make", () => {
      const recipe = expand("dev", "CONSOLE_PORT=6999");
      expect(recipe).not.toContain("6999");
    });

    it("dev-tunnel shares the guard and the pin", () => {
      const recipe = expand("dev-tunnel");
      expect(recipe).toContain(GUARD_START);
      expect(recipe).toMatch(/npm run dev:tunnel -- --port "\$CONSOLE_PORT"\s*$/);
    });
  });

  describe("precedence", () => {
    it(".env beats the shell", async () => {
      await fs.writeFile(path.join(dir, ".env"), "PIPELEX_BASE_URL=http://from-dotenv:1\n");
      const run = runPrelude(preludeOf(expand("dev")), dir, {
        CONSOLE_PORT: String(port),
        PIPELEX_BASE_URL: "http://from-shell:2",
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("-> console API target: http://from-dotenv:1");
    });

    it("the make command line beats .env, and a value with a space survives the trip", async () => {
      await fs.writeFile(path.join(dir, ".env"), "PIPELEX_BASE_URL=http://from-dotenv:1\n");
      // make exports a command-line variable into the recipe's environment; the
      // prelude is run outside make here, so that export is reproduced by hand.
      const run = runPrelude(preludeOf(expand("dev", "PIPELEX_BASE_URL=http://from cli:3")), dir, {
        CONSOLE_PORT: String(port),
        PIPELEX_BASE_URL: "http://from cli:3",
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("-> console API target: http://from cli:3");
    });

    it("the shell stands when .env is silent, and the server default when everything is", () => {
      const prelude = preludeOf(expand("dev"));
      const fromShell = runPrelude(prelude, dir, {
        CONSOLE_PORT: String(port),
        PIPELEX_BASE_URL: "http://from-shell:2",
      });
      expect(fromShell.stdout).toContain("-> console API target: http://from-shell:2");
      const nothing = runPrelude(prelude, dir, { CONSOLE_PORT: String(port) });
      expect(nothing.stdout).toContain(
        "-> console API target: https://api.pipelex.com (the server default)",
      );
    });

    it(".env can set the port the guard checks", async () => {
      const dotenvPort = await pickPort();
      await fs.writeFile(path.join(dir, ".env"), `CONSOLE_PORT=${dotenvPort}\n`);
      const run = runPrelude(preludeOf(expand("dev")), dir, {
        CONSOLE_PORT: String(port),
        PIPELEX_MCP_RESOURCE_INDICATOR: `http://localhost:${port}/`,
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`listens on port ${dotenvPort}`);
    });
  });

  describe("the guard", () => {
    function verdict(indicator: string | undefined, env: NodeJS.ProcessEnv = {}) {
      const prelude = preludeOf(expand("dev"));
      return runPrelude(prelude, dir, {
        CONSOLE_PORT: String(port),
        ...(indicator === undefined ? {} : { PIPELEX_MCP_RESOURCE_INDICATOR: indicator }),
        ...env,
      });
    }

    it("accepts the exact origin on the port, IPv6 included, an unset value, and a tunnel URL", () => {
      for (const indicator of [
        undefined,
        "",
        `http://localhost:${port}/`,
        `http://127.0.0.1:${port}/`,
        `http://[::1]:${port}/`,
        "https://abc.alpic.dev/",
      ]) {
        const run = verdict(indicator);
        expect(run.status, `${JSON.stringify(indicator)}: ${run.stderr}`).toBe(0);
      }
    });

    it("refuses the right port in the wrong shape, and says so", () => {
      for (const indicator of [
        `http://localhost:${port}`,
        `http://localhost:${port}/mcp`,
        `http://127.0.0.1:${port}/mcp`,
        `http://[::1]:${port}`,
      ]) {
        const run = verdict(indicator);
        expect(run.status, JSON.stringify(indicator)).toBe(1);
        expect(run.stderr, JSON.stringify(indicator)).toContain("trailing slash");
        expect(run.stderr, JSON.stringify(indicator)).not.toContain("listens on port");
      }
    });

    it("refuses any other loopback origin as a port mismatch, an implied 80 included", () => {
      for (const indicator of [
        `http://localhost:${port + 1}/`,
        `http://localhost:${port}1/`,
        "http://localhost/",
        "http://127.0.0.1/",
        "http://[::1]:3000/",
      ]) {
        const run = verdict(indicator);
        expect(run.status, JSON.stringify(indicator)).toBe(1);
        expect(run.stderr, JSON.stringify(indicator)).toContain(`listens on port ${port}`);
      }
    });

    it("refuses a port that is not a port number, as such", () => {
      const letters = verdict(undefined, { CONSOLE_PORT: "abc" });
      expect(letters.status).toBe(1);
      expect(letters.stderr).toContain("must be a port number");
      const outOfRange = verdict(undefined, { CONSOLE_PORT: "70000" });
      expect(outOfRange.status).toBe(1);
      expect(outOfRange.stderr).toContain("between 1 and 65535");
    });

    it("refuses a held port", async () => {
      const holder = await hold(port);
      try {
        const run = verdict(undefined);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(`port ${port} is already in use`);
      } finally {
        await release(holder);
      }
    });

    it.skipIf(!hasLsof)("refuses a port held on loopback only", async () => {
      const holder = await hold(port, "127.0.0.1");
      try {
        const run = verdict(undefined);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(`port ${port} is already in use`);
      } finally {
        await release(holder);
      }
    });
  });
});
