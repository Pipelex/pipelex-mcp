import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listMethodTree } from "./method-tree.js";
import type { MethodTreeListing } from "./method-tree.js";

describe("listMethodTree", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-tree-"));
  });

  afterEach(async () => {
    await fs.chmod(path.join(root, "locked"), 0o755).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function place(relative: string, content = "x") {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async function listing(options: { maxEntries?: number } = {}): Promise<MethodTreeListing> {
    const result = await listMethodTree(root, options);
    if (!result.ok) throw new Error(`listing failed at ${result.path}: ${result.message}`);
    return result.listing;
  }

  async function members(): Promise<string[]> {
    return (await listing()).files.map((file) => file.path);
  }

  it("lists every regular file by tree path, in byte order, with its size", async () => {
    await place("main.mthds", "domain = 1");
    await place("b/z.mthds");
    await place("Zeta/a.mthds");
    await place("a.html", "<p>");

    const result = await listing();

    // Upper case sorts before lower case byte for byte.
    expect(result.files).toEqual([
      { path: "Zeta/a.mthds", size: 1 },
      { path: "a.html", size: 3 },
      { path: "b/z.mthds", size: 1 },
      { path: "main.mthds", size: 10 },
    ]);
    expect(result.symlinks).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("leaves out every path with a segment starting with a dot", async () => {
    await place("main.mthds");
    await place(".env");
    await place(".hidden.mthds");
    await place(".git/config");
    await place(".venv/lib/site.mthds");
    await place("steps/.cache/old.mthds");
    await place("steps/render.mthds");

    expect(await members()).toEqual(["main.mthds", "steps/render.mthds"]);
  });

  it("leaves out __pycache__ and node_modules at any depth, as directories only", async () => {
    await place("main.mthds");
    await place("__pycache__/x.mthds");
    await place("node_modules/pkg/index.mthds");
    await place("steps/__pycache__/y.mthds");
    await place("steps/deep/node_modules/z.mthds");
    // A file carrying the name is no directory, so the default does not reach it.
    await place("steps/node_modules");

    expect(await members()).toEqual(["main.mthds", "steps/node_modules"]);
  });

  it("reads a .gitignore with git's semantics: patterns, negation, anchoring, directory-only", async () => {
    await place(".gitignore", ["*.log", "/build", "out/", "!keep.log"].join("\n"));
    await place("main.mthds");
    await place("debug.log");
    await place("keep.log");
    await place("build/a.mthds");
    await place("steps/build/b.mthds");
    await place("out/c.mthds");
    await place("steps/out/d.mthds");
    await place("steps/out.mthds");

    expect(await members()).toEqual([
      "keep.log",
      "main.mthds",
      // Anchored /build reaches the root's build/ only.
      "steps/build/b.mthds",
      // out/ is directory-only, so the file named out.mthds stays.
      "steps/out.mthds",
    ]);
  });

  it("reads a nested .gitignore relative to its own directory, a deeper one overriding a shallower", async () => {
    await place(".gitignore", "*.xlsx\n");
    await place("main.mthds");
    await place("top.xlsx");
    await place("steps/.gitignore", "!report.xlsx\n/local.mthds\n");
    await place("steps/report.xlsx");
    await place("steps/other.xlsx");
    await place("steps/local.mthds");
    await place("steps/render.mthds");
    await place("steps/inner/local.mthds");

    expect(await members()).toEqual([
      "main.mthds",
      "steps/inner/local.mthds",
      "steps/render.mthds",
      "steps/report.xlsx",
    ]);
  });

  // The expectations below are what `git add -n -A` adds from the same tree,
  // recorded with git 2.x: they pin git's reading, not this module's.
  describe("as git reads several .gitignore files together", () => {
    it("lets a deeper !build/ re-include what a shallower build/ excludes, at any depth below it", async () => {
      await place(".gitignore", "build/\n");
      await place("a/.gitignore", "!build/\n");
      await place("main.mthds");
      await place("build/x.mthds");
      await place("a/build/keep.mthds");
      await place("a/b/build/deep.mthds");

      expect(await members()).toEqual(["a/b/build/deep.mthds", "a/build/keep.mthds", "main.mthds"]);
    });

    it("re-includes a file by negation inside a re-included directory, and nothing beside it", async () => {
      await place(".gitignore", "build/\n*.tmp.mthds\n");
      await place("a/.gitignore", "!build/\n!keep.tmp.mthds\n");
      await place("a/build/keep.tmp.mthds");
      await place("a/build/other.tmp.mthds");
      await place("a/build/plain.mthds");
      await place("build/keep.tmp.mthds");

      expect(await members()).toEqual(["a/build/keep.tmp.mthds", "a/build/plain.mthds"]);
    });

    it("keeps one directory of an excluded directory's contents: docs/* then !docs/method/", async () => {
      await place(".gitignore", "docs/*\n!docs/method/\n");
      await place("main.mthds");
      await place("docs/readme.mthds");
      await place("docs/method/m.mthds");
      await place("docs/other/x.mthds");

      expect(await members()).toEqual(["docs/method/m.mthds", "main.mthds"]);
    });

    it("anchors a deeper pattern with a slash at its own directory, and reads a directory name as a literal", async () => {
      await place("a/.gitignore", "/out\n*.tmp\n");
      await place("a/out/x.mthds");
      await place("a/b/out/y.mthds");
      await place("a/q.tmp");
      await place("[draft]/.gitignore", "*.tmp\n");
      await place("[draft]/n.tmp");
      await place("[draft]/k.mthds");
      await place("d/n.tmp");

      expect(await members()).toEqual(["[draft]/k.mthds", "a/b/out/y.mthds", "d/n.tmp"]);
    });
  });

  it("re-includes nothing under a directory a .gitignore excludes", async () => {
    await place(".gitignore", "runs/\n!runs/keep.mthds\n");
    await place("main.mthds");
    await place("runs/keep.mthds");
    await place("runs/inner/.gitignore", "!*\n");
    await place("runs/inner/x.mthds");

    expect(await members()).toEqual(["main.mthds"]);
  });

  it("hides a directory holding a .gitignore of *, the mark a run-artifacts directory carries", async () => {
    await place("main.mthds");
    await place("runs/.gitignore", "*\n");
    await place("runs/run_1/main_stuff.json");
    await place("runs/run_1/copy.mthds");
    await place("runs/run_2/backup.mthds");

    expect(await members()).toEqual(["main.mthds"]);
  });

  it("reads only the .gitignore files inside the root", async () => {
    // A .gitignore above the root excludes everything; the walk never reads it.
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-outer-"));
    try {
      await fs.writeFile(path.join(outer, ".gitignore"), "*\n");
      const inner = path.join(outer, "method");
      await fs.mkdir(inner);
      await fs.writeFile(path.join(inner, "main.mthds"), "x");

      const result = await listMethodTree(inner);

      expect(result.ok && result.listing.files.map((file) => file.path)).toEqual(["main.mthds"]);
    } finally {
      await fs.rm(outer, { recursive: true, force: true });
    }
  });

  it("matches patterns case-sensitively, whatever the filesystem", async () => {
    await place(".gitignore", "Draft.mthds\n");
    await place("main.mthds");
    await place("draft.mthds");

    expect(await members()).toEqual(["draft.mthds", "main.mthds"]);
  });

  it("skips a byte-order mark at the head of a .gitignore", async () => {
    await place(".gitignore", "﻿old.mthds\n");
    await place("main.mthds");
    await place("old.mthds");

    expect(await members()).toEqual(["main.mthds"]);
  });

  it("lists a symbolic link the rule keeps as an error, and leaves out one it excludes", async () => {
    await place("main.mthds");
    await place("real/target.mthds");
    await fs.symlink(path.join(root, "real", "target.mthds"), path.join(root, "link.mthds"));
    await fs.symlink(path.join(root, "real"), path.join(root, "linked-dir"));
    await fs.symlink(path.join(root, "real"), path.join(root, "ignored-dir"));
    await fs.symlink(path.join(root, "real"), path.join(root, ".dot-link"));
    await place(".gitignore", "ignored-dir\n");

    const result = await listing();

    expect(result.symlinks).toEqual(["link.mthds", "linked-dir"]);
    expect(result.files.map((file) => file.path)).toEqual(["main.mthds", "real/target.mthds"]);
  });

  it("does not read a .gitignore that is a symbolic link", async () => {
    await place("main.mthds");
    await place("rules.txt", "main.mthds\n");
    await fs.symlink(path.join(root, "rules.txt"), path.join(root, ".gitignore"));

    expect(await members()).toEqual(["main.mthds", "rules.txt"]);
  });

  it("leaves out a directory holding pyvenv.cfg, whatever its name and with no .gitignore", async () => {
    await place("main.mthds");
    await place("venv/pyvenv.cfg", "home = /usr/bin");
    await place("venv/lib/site-packages/pkg/data.mthds");
    await place("tools/env-3.12/pyvenv.cfg");
    await place("tools/env-3.12/bin/activate");
    await place("tools/keep.mthds");
    // A directory named pyvenv.cfg marks nothing.
    await place("odd/pyvenv.cfg/inner.mthds");

    expect(await members()).toEqual([
      "main.mthds",
      "odd/pyvenv.cfg/inner.mthds",
      "tools/keep.mthds",
    ]);
    expect((await listing()).rootIsVirtualEnvironment).toBe(false);
  });

  it("lists nothing of a root that is itself a virtual environment, and says so", async () => {
    await place("pyvenv.cfg", "home = /usr/bin");
    await place("main.mthds");
    await place("lib/site-packages/pkg/data.mthds");

    const result = await listing();

    expect(result.files).toEqual([]);
    expect(result.rootIsVirtualEnvironment).toBe(true);
  });

  it("leaves out a nested repository below the root, directory or submodule file, and names it", async () => {
    await place("main.mthds");
    await place(".git/HEAD", "ref: refs/heads/main");
    await place("vendor/lib/.git/HEAD", "ref: refs/heads/main");
    await place("vendor/lib/shared.mthds");
    await place("modules/sub/.git", "gitdir: ../../.git/modules/sub");
    await place("modules/sub/templates/report.html");
    await place("modules/own.mthds");

    const result = await listing();

    // The root's own .git makes the root no nested repository.
    expect(result.files.map((file) => file.path)).toEqual(["main.mthds", "modules/own.mthds"]);
    expect(result.nestedRepositories).toEqual(["modules/sub", "vendor/lib"]);
  });

  it("stops at the entry bound and says the listing is truncated", async () => {
    await place("a.mthds");
    await place("b.mthds");
    await place("c/d.mthds");

    const bounded = await listing({ maxEntries: 2 });
    expect(bounded.truncated).toBe(true);
    expect(bounded.files.map((file) => file.path)).toEqual(["a.mthds", "b.mthds"]);

    // Files and directories both count.
    expect((await listing({ maxEntries: 4 })).truncated).toBe(false);
    expect((await listing({ maxEntries: 3 })).truncated).toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails on a directory it cannot read, naming its tree path",
    async () => {
      await place("main.mthds");
      await place("locked/inner.mthds");
      await fs.chmod(path.join(root, "locked"), 0o000);

      const result = await listMethodTree(root);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.path).toBe("locked");
        expect(result.message).toContain("EACCES");
      }
    },
  );
});
