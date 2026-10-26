/**
 * A hermetic test of the release-commit verdict and of the break-glass
 * publish's guard built on it.
 *
 * `.github/scripts/release-verdict.sh` decides whether a commit releases the
 * workshop: a commit with a parent when it raises the version its first parent
 * carries, strictly, and a commit with no parent, the repository's root commit,
 * as a release of the version it carries. `release.yml`'s `detect` job asks it
 * for the commit a push or a dispatch names, and `make publish`'s
 * `check-workshop-released` asks it for HEAD: a tip that did not raise the
 * version still carries the released number with code that version never
 * shipped, and a recovery from there would publish the wrong bytes under the
 * right number. Each case below builds a small history in a temp repository
 * holding the release scripts and runs the verdict or the guard target in it.
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
const SCRIPTS = path.join(REPO_ROOT, ".github", "scripts");
const RELEASE_SCRIPTS = ["track-version.sh", "release-verdict.sh"];

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

/** One commit whose root manifest carries `version`, or no version at all. */
async function commitVersion(version: string | null): Promise<void> {
  const manifest = version === null ? { name: "x" } : { name: "x", version };
  await fs.writeFile(path.join(repo, "package.json"), `${JSON.stringify(manifest)}\n`);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", `workshop ${version ?? "without a version"}`);
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

/** The verdict on `ref`, run in `cwd` from the scripts that checkout holds. */
function verdict(
  ref = "HEAD",
  cwd = repo,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [".github/scripts/release-verdict.sh", ref], {
    cwd,
    env: BASE_ENV,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "release-guard-"));
  git("init", "-q", "-b", "main");
  await fs.mkdir(path.join(repo, ".github", "scripts"), { recursive: true });
  for (const script of RELEASE_SCRIPTS) {
    await fs.copyFile(path.join(SCRIPTS, script), path.join(repo, ".github", "scripts", script));
  }
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe("the release verdict", () => {
  it("reads a commit that raises its first parent's version as a release", async () => {
    await commitVersion("0.20.0");
    await commitVersion("0.21.0");

    const result = verdict();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("version=0.21.0\nparent_version=0.20.0\nrelease=true\n");
  });

  it("reads a commit that keeps or lowers the version as no release", async () => {
    await commitVersion("0.21.0");
    await commitVersion("0.21.0");
    expect(verdict().stdout).toBe("version=0.21.0\nparent_version=0.21.0\nrelease=false\n");

    await commitVersion("0.20.0");
    expect(verdict().stdout).toBe("version=0.20.0\nparent_version=0.21.0\nrelease=false\n");
  });

  it("reads a root commit as a release of the version it carries", async () => {
    await commitVersion("0.27.1");

    const result = verdict();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("version=0.27.1\nparent_version=\nrelease=true\n");
  });

  it("reads a merge against its first parent alone", async () => {
    // A release merge: main at 0.20.0 takes a release branch carrying 0.21.0.
    await commitVersion("0.20.0");
    git("checkout", "-q", "-b", "release/v0.21.0");
    await commitVersion("0.21.0");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "Release v0.21.0", "release/v0.21.0");
    expect(verdict().stdout).toBe("version=0.21.0\nparent_version=0.20.0\nrelease=true\n");

    // A merge into main that brings no new version, whatever its second
    // parent carries, is no release.
    git("checkout", "-q", "-b", "chore/x", "HEAD^2");
    await fs.writeFile(path.join(repo, "notes.txt"), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "a change on top of the release branch");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "Merge chore/x", "chore/x");
    expect(verdict().stdout).toBe("version=0.21.0\nparent_version=0.21.0\nrelease=false\n");
  });

  it("gives no verdict when a shallow checkout lacks the parent, rather than a root commit's", async () => {
    await commitVersion("0.20.0");
    await commitVersion("0.20.0");
    const clone = `${repo}-shallow`;
    const cloned = spawnSync("git", ["clone", "-q", "--depth=1", `file://${repo}`, clone], {
      env: BASE_ENV,
      encoding: "utf8",
    });
    try {
      expect(cloned.status).toBe(0);

      const result = verdict("HEAD", clone);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("has a parent this checkout does not hold");
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
    }
  });

  it("gives no verdict when a version cannot be read", async () => {
    await commitVersion("0.20.0");
    await commitVersion(null);

    const result = verdict();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("carries no version");
  });
});

describe("the break-glass release guard", () => {
  it("lets the workshop ship from the commit that raised its version", async () => {
    await commitVersion("0.20.0");
    await commitVersion("0.21.0");

    expect(guard().status).toBe(0);
  });

  it("lets the workshop ship from a root commit, which has no parent", async () => {
    await commitVersion("0.27.1");

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
    await commitVersion(null);

    expect(guard().status).not.toBe(0);
  });
});
