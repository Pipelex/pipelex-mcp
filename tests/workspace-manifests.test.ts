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
 *
 * A sprint pin is the one exception, and it is held to the property the rule
 * exists for rather than to its spelling. While a sprint builds against an
 * unreleased branch, `wt pin` writes a git source into the one manifest
 * `.worktree.toml` names as the site (the core, for `@pipelex/sdk`), and the other
 * members keep their registry range. npm then installs the pinned commit once, at
 * the root, because its version sits inside those ranges; were it outside them,
 * npm would nest a registry copy beside it, and the two copies are exactly the
 * failure the rule prevents. So for a pinned package the lockfile must hold one
 * copy, resolved from the pinned commit. A pin never reaches a base branch, so on
 * `dev` and `main` every package takes the plain rule.
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

interface Lockfile {
  packages: Record<string, { version?: string; resolved?: string }>;
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

/** The commit a git-source spec pins (`github:owner/repo#<sha>`, `git+https://…#<sha>`), or undefined for a registry range. */
function pinnedCommit(spec: string): string | undefined {
  if (!/^(github:|git\+|git:)/.test(spec)) return undefined;
  return spec.split("#")[1] ?? "";
}

const lockfile = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")) as Lockfile;

/** Every copy of `name` the lockfile installs, hoisted or nested. */
function lockedCopies(name: string): { key: string; resolved: string }[] {
  return Object.entries(lockfile.packages)
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .map(([key, entry]) => ({ key, resolved: entry.resolved ?? "" }));
}

/** Every spec each package carries across the root and the members, keyed by package. */
function specsByPackage(): Map<string, Set<string>> {
  const specs = new Map<string, Set<string>>();
  for (const manifest of [root, ...members.map(({ manifest }) => manifest)]) {
    for (const [name, range] of declared(manifest)) {
      if (WORKSPACE_NAMES.has(name)) continue;
      specs.set(name, (specs.get(name) ?? new Set()).add(range));
    }
  }
  return specs;
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
    // A sprint pin in the core leaves the workshop on its registry range; the
    // one-copy check below is what holds the two together while it stands.
    const expected = Object.fromEntries(
      Object.entries(core.dependencies ?? {}).map(([name, spec]) => [
        name,
        pinnedCommit(spec) === undefined ? spec : expect.any(String),
      ]),
    );
    expect(workshop.dependencies).toMatchObject(expected);
  });

  it("keep skybridge to the console", () => {
    const holders = [root, ...members.map(({ manifest }) => manifest)]
      .filter((manifest) => declared(manifest).some(([name]) => name === "skybridge"))
      .map((manifest) => manifest.name);
    expect(holders).toEqual(["@pipelex/mcp-console"]);
  });

  it("carry one range for a package that several of them name", () => {
    const split = [...specsByPackage()]
      .filter(([, set]) => set.size > 1)
      .filter(([, set]) => [...set].every((spec) => pinnedCommit(spec) === undefined))
      .map(([name]) => name);
    expect(split).toEqual([]);
  });

  it("install a sprint-pinned package once, from the pinned commit", () => {
    for (const [name, set] of specsByPackage()) {
      const commits = [...set].map(pinnedCommit).filter((commit) => commit !== undefined);
      if (commits.length === 0) continue;
      // One commit, never two pins of one package at different commits.
      expect(commits, `${name}: pinned at more than one commit`).toHaveLength(1);
      const copies = lockedCopies(name);
      expect(
        copies.map(({ key }) => key),
        `${name}: the lockfile installs more than one copy`,
      ).toEqual([`node_modules/${name}`]);
      expect(copies[0]?.resolved, `${name}: the installed copy is not the pinned commit`).toContain(
        `#${commits[0]}`,
      );
    }
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
