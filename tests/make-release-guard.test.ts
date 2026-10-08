/**
 * A hermetic test of the break-glass publish's release-commit guard.
 *
 * `make publish` ships the workshop, and only from the commit that released it:
 * a tip that did not raise the version still carries the released number with
 * code that version never shipped, and a recovery from there would publish the
 * wrong bytes under the right number. The guard reads the workshop's version at
 * HEAD and at its first parent through `.github/scripts/track-version.sh`, so
 * each case below builds a small history in a temp repository holding that
 * script and runs the guard target in it, across the three layouts the history
 * holds: the root manifest before the workspace split, the workshop member's
 * manifest during it, and the root manifest again after the flatten. `check-release-ready` also holds HEAD
 * to origin/main's tip, which a bare repository beside the temp one stands in
 * for.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAKEFILE = path.join(REPO_ROOT, "Makefile");
const TRACK_VERSION = path.join(REPO_ROOT, ".github", "scripts", "track-version.sh");

// A minimal environment, as in the other Makefile tests: a parent `make test`
// would hand its MAKEFLAGS to the child. The identity lets `git commit` run
// without reading anybody's git configuration.
const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let repo: string;

function git(...args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, env: BASE_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function writeManifest(relative: string, version: string): Promise<void> {
  const file = path.join(repo, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ name: "x", version })}\n`);
}

/** A commit of the current layout: one root manifest carrying the version. */
async function commitVersion(version: string): Promise<void> {
  await writeManifest("package.json", version);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", `workshop ${version}`);
}

/**
 * A commit of the workspace layout (pipelex-mcp#89 to the flatten): the version
 * in the workshop member's manifest, and a root manifest carrying none.
 */
async function commitWorkspaceVersion(version: string): Promise<void> {
  await fs.writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "pipelex-mcp", private: true })}\n`,
  );
  await writeManifest("packages/workshop/package.json", version);
  git("add", "-A");
  git("commit", "-q", "-m", `workshop ${version}, from the workspace`);
}

function run(target: string): { status: number | null; output: string } {
  const result = spawnSync("make", ["-f", MAKEFILE, target], {
    cwd: repo,
    env: BASE_ENV,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function guard(): { status: number | null; output: string } {
  return run("check-workshop-released");
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "release-guard-"));
  git("init", "-q", "-b", "main");
  await fs.mkdir(path.join(repo, ".github", "scripts"), { recursive: true });
  await fs.copyFile(TRACK_VERSION, path.join(repo, ".github", "scripts", "track-version.sh"));
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("the break-glass release guard", () => {
  it("lets the workshop ship from the commit that raised its version", async () => {
    await commitVersion("0.20.0");
    await commitVersion("0.21.0");

    expect(guard().status).toBe(0);
  });

  it("refuses a commit that keeps the version its first parent carried", async () => {
    await commitVersion("0.20.0");
    await commitVersion("0.21.0");
    await commitVersion("0.21.0");

    const refused = guard();
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("it carries 0.21.0 over its first parent's 0.21.0");
  });

  it("reads a parent from before the split through its root manifest", async () => {
    await commitVersion("0.19.0");
    await commitWorkspaceVersion("0.20.0");

    expect(guard().status).toBe(0);
  });

  it("reads a parent from the workspace layout through the workshop member", async () => {
    await commitWorkspaceVersion("0.22.0");
    await fs.rm(path.join(repo, "packages"), { recursive: true });
    await commitVersion("0.23.0");

    expect(guard().status).toBe(0);
  });

  it("refuses a flattening commit that keeps the workspace layout's version", async () => {
    await commitWorkspaceVersion("0.22.0");
    await fs.rm(path.join(repo, "packages"), { recursive: true });
    await commitVersion("0.22.0");

    const refused = guard();
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("it carries 0.22.0 over its first parent's 0.22.0");
  });

  it("refuses a commit that lowers the version", async () => {
    await commitVersion("0.21.0");
    await commitVersion("0.20.0");

    const refused = guard();
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("it carries 0.20.0 over its first parent's 0.21.0");
  });

  it("holds a clean main to origin/main's tip", async () => {
    await commitVersion("0.20.0");
    await commitVersion("0.21.0");
    const origin = `${repo}-origin.git`;
    spawnSync("git", ["init", "-q", "--bare", origin], { env: BASE_ENV });
    try {
      git("remote", "add", "origin", origin);
      git("push", "-q", "origin", "main");
      expect(run("check-release-ready").status).toBe(0);

      // origin/main moves on while this checkout stays on the older release.
      await commitVersion("0.22.0");
      git("push", "-q", "origin", "main");
      git("reset", "-q", "--hard", "HEAD^");
      const refused = run("check-release-ready");
      expect(refused.status).not.toBe(0);
      expect(refused.output).toContain("HEAD is not origin/main's tip");
    } finally {
      await fs.rm(origin, { recursive: true, force: true });
    }
  });

  it("refuses when origin/main cannot be fetched", async () => {
    await commitVersion("0.20.0");

    const refused = run("check-release-ready");
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("could not fetch origin/main");
  });

  it("refuses when a version cannot be read at all", async () => {
    await commitVersion("0.20.0");

    // The only commit has no first parent, so its parent's version is unreadable.
    expect(guard().status).not.toBe(0);
  });
});
