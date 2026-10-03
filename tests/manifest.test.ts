import { spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * What the one manifest promises npm, which no build and no other test can
 * see: `package.json` is the package published as `@pipelex/mcp`, so its
 * `dependencies` are what every `npx @pipelex/mcp` user downloads, and its
 * `files` are the tarball. `.claude/rules/manifests.md` states the rules that
 * are judgment rather than testable.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  name: string;
  private?: boolean;
  workspaces?: string[];
  repository?: { type: string; url: string; directory?: string };
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Manifest;

describe("the manifest", () => {
  it("is the package npm publishes, from the repository root", () => {
    expect(manifest.name).toBe("@pipelex/mcp");
    expect(manifest.private).toBeUndefined();
    expect(manifest.workspaces).toBeUndefined();
    expect(manifest.repository).toEqual({
      type: "git",
      url: "https://github.com/Pipelex/pipelex-mcp",
    });
  });

  it("ships the workshop's executable, and nothing else of the tree", () => {
    expect(manifest.bin).toEqual({ "pipelex-mcp": "dist/main.js" });
    expect(manifest.files).toEqual(["dist", "README.md", "LICENSE"]);
  });

  it("declares @pipelex/mthds-ui for the build alone, and never @pipelex/mthds-form", () => {
    // The capabilities import only the graph page's embed serializer, which
    // tsup inlines; `@pipelex/mthds-form` arrives through `@pipelex/mthds-ui`,
    // and a direct entry would install a second copy.
    expect(manifest.dependencies).not.toHaveProperty("@pipelex/mthds-ui");
    expect(manifest.devDependencies).toHaveProperty("@pipelex/mthds-ui");
    for (const block of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      expect(block ?? {}).not.toHaveProperty("@pipelex/mthds-form");
    }
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it("builds the executable before npm packs it", () => {
    expect(manifest.scripts?.prepack).toBe("npm run build");
    expect(manifest.scripts?.build).toBe("tsup");
  });
});

/**
 * The publish guard is wired through npm's own lifecycle, so this drives a
 * real `npm publish --dry-run --offline` in a scratch package that carries the
 * manifest's guard scripts and the scripts they run. The scratch package has
 * its own name and an unroutable registry, so nothing could reach npm even if
 * `--dry-run` were ignored. Its dependencies are fixed specs rather than the
 * live manifest's, which a sprint pin or `make use-local-sdk` deliberately
 * changes, and `--ignore-scripts=false` keeps an npm configured to skip
 * lifecycle scripts from skipping the guard under test.
 */
describe("npm publish", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "publish-guard-"));
    await fs.mkdir(path.join(dir, "scripts"));
    for (const script of ["check-publishable.ts", "publish-guard.ts"]) {
      await fs.copyFile(path.join(ROOT, "scripts", script), path.join(dir, "scripts", script));
    }
    await fs.symlink(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function publishWith(sdkSpec: string): Promise<{ status: number | null; output: string }> {
    const scratch = {
      name: "@pipelex/mcp-publish-guard-probe",
      version: "0.0.0",
      type: "module",
      files: ["scripts"],
      publishConfig: { registry: "http://127.0.0.1:9/" },
      scripts: {
        prepublishOnly: manifest.scripts?.prepublishOnly,
        "check:publishable": manifest.scripts?.["check:publishable"],
      },
      dependencies: { "@pipelex/sdk": sdkSpec, zod: "^4.3.6" },
    };
    await fs.writeFile(path.join(dir, "package.json"), `${JSON.stringify(scratch, null, 2)}\n`);
    const result = spawnSync(
      "npm",
      ["publish", "--dry-run", "--offline", "--ignore-scripts=false"],
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        encoding: "utf8",
      },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it("refuses a sprint-pinned dependency, naming it, before it packs", async () => {
    const refused = await publishWith("0.28.1-sprint.g0123456789abcdef0123456789abcdef01234567");
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("@pipelex/sdk");
    expect(refused.output).toContain("a sprint prerelease");
  });

  it("refuses a git-pinned dependency, naming it", async () => {
    const refused = await publishWith(
      "github:Pipelex/pipelex-sdk#0123456789abcdef0123456789abcdef01234567",
    );
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain("@pipelex/sdk");
    expect(refused.output).toContain("a git source");
  });

  it("goes through with registry ranges", async () => {
    const published = await publishWith("^0.28.0");
    expect(published.output).toContain("is a registry range or tag");
    expect(published.status).toBe(0);
  });
});
