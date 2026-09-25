/**
 * A hermetic test of the break-glass targets' release-commit guard.
 *
 * `make publish` ships the workshop and `make deploy` the console, and each may
 * run only from the commit that released its own track. With two tracks, main
 * moves past a workshop release when the console releases, and its tip still
 * carries the workshop's released version with code that version never shipped;
 * a recovery from there would publish the wrong bytes under the right number.
 * The guard reads each track's version at HEAD and at its first parent through
 * `.github/scripts/track-version.sh`, so each case below builds a small history
 * in a temp repository holding that script and runs the guard target in it.
 * `check-release-ready` also holds HEAD to origin/main's tip, which a bare
 * repository beside the temp one stands in for.
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

async function commitVersions(versions: { workshop: string; console: string }): Promise<void> {
  await writeManifest("packages/workshop/package.json", versions.workshop);
  await writeManifest("packages/console/package.json", versions.console);
  git("add", "-A");
  git("commit", "-q", "-m", `workshop ${versions.workshop}, console ${versions.console}`);
}

function run(target: string): { status: number | null; output: string } {
  const result = spawnSync("make", ["-f", MAKEFILE, target], {
    cwd: repo,
    env: BASE_ENV,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function guard(track: "workshop" | "console"): { status: number | null; output: string } {
  return run(`check-${track}-released`);
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
  it("lets a track ship from the commit that raised its version, and refuses the other track", async () => {
    await commitVersions({ workshop: "0.20.0", console: "0.20.0" });
    await commitVersions({ workshop: "0.21.0", console: "0.20.0" });

    expect(guard("workshop").status).toBe(0);
    const refused = guard("console");
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("HEAD did not raise the console version");
  });

  it("refuses a track once the other track's release has moved main past its release commit", async () => {
    await commitVersions({ workshop: "0.20.0", console: "0.20.0" });
    await commitVersions({ workshop: "0.21.0", console: "0.20.0" });
    await commitVersions({ workshop: "0.21.0", console: "0.21.0" });

    const refused = guard("workshop");
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("it carries workshop 0.21.0 over its first parent's 0.21.0");
    expect(guard("console").status).toBe(0);
  });

  it("reads a parent from before the split through its root manifest", async () => {
    await writeManifest("package.json", "0.19.0");
    git("add", "-A");
    git("commit", "-q", "-m", "0.19.0, both servers");
    await fs.rm(path.join(repo, "package.json"));
    await commitVersions({ workshop: "0.19.0", console: "0.20.0" });

    expect(guard("console").status).toBe(0);
    expect(guard("workshop").status).not.toBe(0);
  });

  it("refuses a commit that lowers a track's version", async () => {
    await commitVersions({ workshop: "0.21.0", console: "0.21.0" });
    await commitVersions({ workshop: "0.21.0", console: "0.20.0" });

    const refused = guard("console");
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("it carries console 0.20.0 over its first parent's 0.21.0");
  });

  it("holds a clean main to origin/main's tip", async () => {
    await commitVersions({ workshop: "0.20.0", console: "0.20.0" });
    await commitVersions({ workshop: "0.20.0", console: "0.21.0" });
    const origin = `${repo}-origin.git`;
    spawnSync("git", ["init", "-q", "--bare", origin], { env: BASE_ENV });
    try {
      git("remote", "add", "origin", origin);
      git("push", "-q", "origin", "main");
      expect(run("check-release-ready").status).toBe(0);

      // origin/main moves on while this checkout stays on the older release.
      await commitVersions({ workshop: "0.21.0", console: "0.21.0" });
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
    await commitVersions({ workshop: "0.20.0", console: "0.20.0" });

    const refused = run("check-release-ready");
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("could not fetch origin/main");
  });

  it("refuses when a version cannot be read at all", async () => {
    await commitVersions({ workshop: "0.20.0", console: "0.20.0" });

    // The only commit has no first parent, so its parent's version is unreadable.
    expect(guard("workshop").status).not.toBe(0);
  });
});
