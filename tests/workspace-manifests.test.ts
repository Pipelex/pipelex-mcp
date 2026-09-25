import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The dependency boundary between the workspace's packages, which no build and
 * no other test can see.
 *
 * The workshop is the one package installed from a registry: its `dependencies`
 * are what every `npx @pipelex/mcp` user downloads, and tsup leaves external
 * exactly the packages they name while inlining everything else, the private
 * core included. So the core's runtime dependencies must be named again by the
 * workshop, with the same range. If one is missing, tsup inlines a second copy
 * of it into the bundle without a word (two copies of `zod` fail each other's
 * schema checks); if the ranges differ, the core is tested against one version
 * and shipped against another.
 *
 * A package named by several manifests carries one range in all of them, so a
 * dependency bump that reaches only some of them fails here rather than
 * installing two versions side by side.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  name: string;
  version?: string;
  private?: boolean;
  workspaces?: string[];
  bin?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function read(relative: string): Manifest {
  return JSON.parse(readFileSync(path.join(ROOT, relative, "package.json"), "utf8")) as Manifest;
}

const root = read(".");
const members = (root.workspaces ?? []).map((dir) => ({ dir, manifest: read(dir) }));
const byName = new Map(members.map(({ manifest }) => [manifest.name, manifest]));
const WORKSPACE_NAMES = new Set(byName.keys());

function member(name: string): Manifest {
  const manifest = byName.get(name);
  if (manifest === undefined) throw new Error(`no workspace member is named ${name}`);
  return manifest;
}

const core = member("@pipelex/mcp-core");
const workshop = member("@pipelex/mcp");
const consoleManifest = member("@pipelex/mcp-console");

function declared(manifest: Manifest): [string, string][] {
  return [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
    ...Object.entries(manifest.peerDependencies ?? {}),
  ];
}

describe("the workspace's manifests", () => {
  it("name the three packages the repository ships from", () => {
    expect([...WORKSPACE_NAMES].sort()).toEqual([
      "@pipelex/mcp",
      "@pipelex/mcp-console",
      "@pipelex/mcp-core",
    ]);
  });

  it("publish the workshop alone", () => {
    expect(root.private).toBe(true);
    expect(core.private).toBe(true);
    expect(consoleManifest.private).toBe(true);
    expect(workshop.private).toBeUndefined();
  });

  it("give the workshop no dependency on a package that is never published", () => {
    for (const name of Object.keys(workshop.dependencies ?? {})) {
      expect(WORKSPACE_NAMES.has(name), name).toBe(false);
    }
    expect(workshop.peerDependencies).toBeUndefined();
  });

  it("have the workshop declare every runtime dependency of the core it inlines", () => {
    expect(workshop.dependencies).toMatchObject(core.dependencies ?? {});
  });

  it("keep skybridge to the console", () => {
    const holders = [root, ...members.map(({ manifest }) => manifest)]
      .filter((manifest) => declared(manifest).some(([name]) => name === "skybridge"))
      .map((manifest) => manifest.name);
    expect(holders).toEqual(["@pipelex/mcp-console"]);
  });

  it("carry one range for a package that several of them name", () => {
    const ranges = new Map<string, Set<string>>();
    for (const manifest of [root, ...members.map(({ manifest }) => manifest)]) {
      for (const [name, range] of declared(manifest)) {
        if (WORKSPACE_NAMES.has(name)) continue;
        ranges.set(name, (ranges.get(name) ?? new Set()).add(range));
      }
    }
    const split = [...ranges].filter(([, set]) => set.size > 1).map(([name]) => name);
    expect(split).toEqual([]);
  });

  it("pin each workspace package where it is declared to the version the member carries", () => {
    for (const manifest of [root, ...members.map(({ manifest }) => manifest)]) {
      for (const [name, range] of declared(manifest)) {
        if (!WORKSPACE_NAMES.has(name)) continue;
        expect(range, `${manifest.name} -> ${name}`).toBe(member(name).version);
      }
    }
  });

  it("ship the workshop's executable, and nothing else of the tree", () => {
    expect(workshop.bin).toEqual({ "pipelex-mcp": "dist/main.js" });
    expect(workshop.files).toEqual(["dist", "README.md", "LICENSE"]);
  });
});
