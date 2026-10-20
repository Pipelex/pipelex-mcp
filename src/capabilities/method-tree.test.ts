import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TreeLimitExceededError, treeDigest } from "mthds";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GRAPH_PAGE_MARK } from "./graph-page.js";
import {
  FolderLimitError,
  describeTreeRefusal,
  isRunInputsPath,
  listFolderTree,
} from "./method-tree.js";
import type { FolderTree } from "./method-tree.js";

/**
 * The workshop's listing of a method folder. The membership rule itself is
 * `mthds`'s, held to the conformance corpus there; what this suite pins is
 * what the workshop puts on top of it — the run-inputs shim, the graph page,
 * the limits, the bounded read and the refusals' words — and the cases the
 * provisional lister it replaced was tested on, restated against the standard.
 */
describe("listFolderTree", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-tree-")));
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

  async function listing(limits = {}): Promise<FolderTree> {
    const result = await listFolderTree(root, limits);
    if (!result.ok) throw new Error(`listing failed: ${result.error.message}`);
    return result.tree;
  }

  async function members(): Promise<string[]> {
    return (await listing()).files.map((file) => file.path);
  }

  async function refusal(limits = {}) {
    const result = await listFolderTree(root, limits);
    if (result.ok) throw new Error("the listing was expected to be refused");
    return result.error;
  }

  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  it("lists every regular file by tree path, in byte order, with its size and SHA-256", async () => {
    await place("main.mthds", "domain = 1");
    await place("b/z.mthds");
    await place("Zeta/a.mthds");
    await place("a.html", "<p>");

    const tree = await listing();

    // Upper case sorts before lower case byte for byte.
    expect(tree.files).toEqual([
      { path: "Zeta/a.mthds", size: 1, sha256: sha256("x") },
      { path: "a.html", size: 3, sha256: sha256("<p>") },
      { path: "b/z.mthds", size: 1, sha256: sha256("x") },
      { path: "main.mthds", size: 10, sha256: sha256("domain = 1") },
    ]);
    expect(tree.digest).toBe(treeDigest(tree.files));
    expect(tree.totalSize).toBe(15);
    expect(tree.root).toBe(root);
  });

  it("leaves out every path with a segment starting with a dot", async () => {
    await place("main.mthds");
    await place(".env");
    await place(".hidden.mthds");
    await place(".git/config");
    await place(".venv/lib/site.mthds");
    await place(".pipelex/method.json", "{}");
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

  describe("a run's inputs file", () => {
    it("leaves out inputs.json and inputs.toml at any depth, reports them, and digests what is left", async () => {
      await place("main.mthds");
      await place("inputs.json", '{"invoice": "invoice-1.pdf"}');
      await place("inputs.toml", 'invoice = "invoice-2.pdf"');
      await place("examples/README.md");
      await place("examples/inputs.json");
      await place("runs/2026/inputs.json", "{}");
      await place("examples/invoice-inputs.json");

      const tree = await listing();

      expect(tree.files.map((file) => file.path)).toEqual([
        "examples/README.md",
        "examples/invoice-inputs.json",
        "main.mthds",
      ]);
      expect(tree.runInputs).toEqual([
        "examples/inputs.json",
        "inputs.json",
        "inputs.toml",
        "runs/2026/inputs.json",
      ]);
      expect(tree.digest).toBe(treeDigest(tree.files));
      expect(tree.has("inputs.json")).toBe(false);
      await expect(tree.readFile("inputs.json")).rejects.toThrow(/not a file of the method tree/);
    });

    it("keeps a directory of either name, leaving out only an inputs file inside it", async () => {
      await place("main.mthds");
      await place("inputs.json/sample.json");
      await place("inputs.json/inputs.json");
      await place("docs/inputs.toml/notes.md");

      const tree = await listing();

      expect(tree.files.map((file) => file.path)).toEqual([
        "docs/inputs.toml/notes.md",
        "inputs.json/sample.json",
        "main.mthds",
      ]);
      expect(tree.runInputs).toEqual(["inputs.json/inputs.json"]);
    });

    it("matches the names byte for byte, letter case included", async () => {
      await place("main.mthds");
      await place("Inputs.json");
      await place("inputs.jsonc");
      await place("inputs.json.bak");
      await place("examples/my-inputs.json");

      const tree = await listing();

      expect(tree.files.map((file) => file.path)).toEqual([
        "Inputs.json",
        "examples/my-inputs.json",
        "inputs.json.bak",
        "inputs.jsonc",
        "main.mthds",
      ]);
      expect(tree.runInputs).toEqual([]);
      expect(isRunInputsPath("a/inputs.toml")).toBe(true);
      expect(isRunInputsPath("a/INPUTS.TOML")).toBe(false);
    });

    it("refuses a symbolic link of either name, as the 0.32 standard refuses every link", async () => {
      // mthds 0.33 leaves such a link out unfollowed; the provisional lister did
      // too. Under 0.32 it is a link like any other, refused by name.
      await place("main.mthds");
      await place("data/sample.json", "{}");
      await fs.symlink(path.join(root, "data", "sample.json"), path.join(root, "inputs.json"));

      const error = await refusal();

      expect(error.code).toBe("symbolic_link");
      expect(error.names).toEqual(["inputs.json"]);
    });
  });

  it("leaves out the workshop's own graph page at the folder's top, and keeps any other file of that name", async () => {
    await place("main.mthds");
    await place("method-graph.html", `<!doctype html><html><head>${GRAPH_PAGE_MARK}</head></html>`);
    await place("docs/method-graph.html", `<head>${GRAPH_PAGE_MARK}</head>`);

    const tree = await listing();
    expect(tree.files.map((file) => file.path)).toEqual(["docs/method-graph.html", "main.mthds"]);
    expect(tree.graphPage).toBe("method-graph.html");
    expect(tree.digest).toBe(treeDigest(tree.files));

    await place("method-graph.html", "<html>the user's own page</html>");
    const mine = await listing();
    expect(mine.files.map((file) => file.path)).toContain("method-graph.html");
    expect(mine.graphPage).toBeUndefined();
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
      "steps/build/b.mthds",
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

    it("keeps one directory of an excluded directory's contents: docs/* then !docs/method/", async () => {
      await place(".gitignore", "docs/*\n!docs/method/\n");
      await place("main.mthds");
      await place("docs/readme.mthds");
      await place("docs/method/m.mthds");
      await place("docs/other/x.mthds");

      expect(await members()).toEqual(["docs/method/m.mthds", "main.mthds"]);
    });

    it("anchors a deeper pattern with a slash at its own directory, and reads a directory name as a literal", async () => {
      await place("main.mthds");
      await place("a/.gitignore", "/out\n*.tmp\n");
      await place("a/out/x.mthds");
      await place("a/b/out/y.mthds");
      await place("a/q.tmp");
      await place("[draft]/.gitignore", "*.tmp\n");
      await place("[draft]/n.tmp");
      await place("[draft]/k.mthds");
      await place("d/n.tmp");

      expect(await members()).toEqual([
        "[draft]/k.mthds",
        "a/b/out/y.mthds",
        "d/n.tmp",
        "main.mthds",
      ]);
    });
  });

  it("re-includes a file by negation inside a re-included directory, and nothing beside it", async () => {
    await place("main.mthds");
    await place(".gitignore", "build/\n*.tmp.mthds\n");
    await place("a/.gitignore", "!build/\n!keep.tmp.mthds\n");
    await place("a/build/keep.tmp.mthds");
    await place("a/build/other.tmp.mthds");
    await place("a/build/plain.mthds");
    await place("build/keep.tmp.mthds");

    expect(await members()).toEqual([
      "a/build/keep.tmp.mthds",
      "a/build/plain.mthds",
      "main.mthds",
    ]);
  });

  it("skips a byte-order mark at the head of a .gitignore", async () => {
    await place(".gitignore", "\uFEFFold.mthds\n");
    await place("main.mthds");
    await place("old.mthds");

    expect(await members()).toEqual(["main.mthds"]);
  });

  it("does not read a .gitignore that is a symbolic link", async () => {
    await place("main.mthds");
    await place("rules.txt", "main.mthds\n");
    await fs.symlink(path.join(root, "rules.txt"), path.join(root, ".gitignore"));

    expect(await members()).toEqual(["main.mthds", "rules.txt"]);
  });

  it("lists nothing of a folder that is itself a virtual environment", async () => {
    await place("pyvenv.cfg", "home = /usr/bin");
    await place("main.mthds");

    expect((await refusal()).code).toBe("empty_tree");
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
    await place("runs/run_2/backup.mthds");

    expect(await members()).toEqual(["main.mthds"]);
  });

  it("reads only the .gitignore files inside the folder, and roots the tree at it, not at a manifest above", async () => {
    const outer = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-outer-")));
    try {
      await fs.writeFile(path.join(outer, ".gitignore"), "*\n");
      await fs.writeFile(path.join(outer, "METHODS.toml"), '[package]\nexclude = ["method/*"]\n');
      const inner = path.join(outer, "method");
      await fs.mkdir(inner);
      await fs.writeFile(path.join(inner, "main.mthds"), "x");

      const result = await listFolderTree(inner, {});

      expect(result.ok && result.tree.files.map((file) => file.path)).toEqual(["main.mthds"]);
      expect(result.ok && result.tree.root).toBe(inner);
    } finally {
      await fs.rm(outer, { recursive: true, force: true });
    }
  });

  it("applies the exclude patterns of the folder's own METHODS.toml", async () => {
    await place("METHODS.toml", '[package]\nexclude = ["drafts/"]\n');
    await place("main.mthds");
    await place("drafts/old.mthds");

    expect(await members()).toEqual(["METHODS.toml", "main.mthds"]);
  });

  it("matches patterns case-sensitively, whatever the filesystem", async () => {
    await place(".gitignore", "Draft.mthds\n");
    await place("main.mthds");
    await place("draft.mthds");

    expect(await members()).toEqual(["draft.mthds", "main.mthds"]);
  });

  it("refuses a symbolic link the rule keeps, naming it, and leaves out one it excludes", async () => {
    await place("main.mthds");
    await place("real/target.mthds");
    await fs.symlink(path.join(root, "real"), path.join(root, "ignored-dir"));
    await fs.symlink(path.join(root, "real"), path.join(root, ".dot-link"));
    await place(".gitignore", "ignored-dir\n");

    expect(await members()).toEqual(["main.mthds", "real/target.mthds"]);

    await fs.symlink(path.join(root, "real", "target.mthds"), path.join(root, "link.mthds"));
    const error = await refusal();
    expect(error.code).toBe("symbolic_link");
    expect(error.names).toEqual(["link.mthds"]);
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
  });

  it("leaves out a nested repository below the folder, directory or submodule file, and says so when a reference leads into one", async () => {
    await place("main.mthds");
    await place(".git/HEAD", "ref: refs/heads/main");
    await place("vendor/lib/.git/HEAD", "ref: refs/heads/main");
    await place("vendor/lib/shared.mthds");
    await place("modules/sub/.git", "gitdir: ../../.git/modules/sub");
    await place("modules/sub/templates/report.html");
    await place("modules/own.mthds");

    const tree = await listing();

    // The folder's own .git makes it no nested repository.
    expect(tree.files.map((file) => file.path)).toEqual(["main.mthds", "modules/own.mthds"]);
    const resolution = await tree.resolveReference({
      holder: "main.mthds",
      reference: "modules/sub/templates/report.html",
      context: "path",
    });
    expect(resolution.kind).toBe("refused");
    if (resolution.kind === "refused") {
      expect(resolution.refusal.excludedBy).toBe("nested_repository");
      expect(resolution.refusal.excludedDirectory).toBe("modules/sub");
    }
  });

  describe("the limits", () => {
    it("refuses a folder past the file count before hashing, with words for the caller", async () => {
      await place("a.mthds");
      await place("b.mthds");
      await place("c/d.mthds");

      const error = await refusal({ maxFileCount: 2 });

      expect(error).toBeInstanceOf(TreeLimitExceededError);
      const text = describeTreeRefusal(error, "or list the method's files in files.");
      expect(text.message).toContain("more than 2 files");
      expect(text.hint).toMatch(/\.gitignore/);
      expect(text.hint.endsWith("or list the method's files in files.")).toBe(true);

      expect((await listing({ maxFileCount: 3 })).files).toHaveLength(3);
    });

    it("blames the deployment only for a limit it announced, and names the workshop's own scan limit as such", async () => {
      await place("a.mthds");
      await place("b.mthds");
      await place("c.mthds");

      const announced = await refusal({ maxFileCount: 2 });
      expect(announced).toBeInstanceOf(FolderLimitError);
      expect((announced as FolderLimitError).owner).toBe("deployment");
      expect(describeTreeRefusal(announced, "").message).toContain(
        "The Pipelex deployment this workshop talks to takes no method holding more than 2 files",
      );

      const ownBound = await refusal({ maxFileCount: 2, workshopSet: ["maxFileCount"] });
      expect((ownBound as FolderLimitError).owner).toBe("workshop");
      const text = describeTreeRefusal(ownBound, "");
      expect(text.message).toContain("the workshop's own scan limit");
      expect(text.message).not.toContain("The Pipelex deployment this workshop talks to takes");
    });

    it("refuses a file past the size limit and a folder past the total", async () => {
      await place("main.mthds", "x".repeat(10));
      await place("big.bin", "y".repeat(100));

      const tooBig = await refusal({ maxFileSize: 50 });
      expect(tooBig).toBeInstanceOf(TreeLimitExceededError);
      expect(describeTreeRefusal(tooBig, "").message).toContain("a file over 50 bytes");

      const tooMuch = await refusal({ maxTotalSize: 105 });
      expect(describeTreeRefusal(tooMuch, "").message).toContain("more than 105 bytes in all");
    });
  });

  describe("readFile", () => {
    it("returns a member's bytes as listed", async () => {
      await place("main.mthds", "domain = 1");
      const tree = await listing();

      expect(Buffer.from(await tree.readFile("main.mthds")).toString("utf8")).toBe("domain = 1");
    });

    it("refuses a member that grew since the listing, reading at most one byte past its listed size", async () => {
      await place("main.mthds", "short");
      const tree = await listing();
      await place("main.mthds", "short, and then a good deal longer");

      await expect(tree.readFile("main.mthds")).rejects.toThrow(
        /changed since the method tree was listed/,
      );
    });

    it("refuses a member whose bytes changed at the same size", async () => {
      await place("main.mthds", "aaaa");
      const tree = await listing();
      await place("main.mthds", "bbbb");

      await expect(tree.readFile("main.mthds")).rejects.toThrow(/changed since/);
    });

    it("refuses a member swapped for a symbolic link since the listing", async () => {
      await place("main.mthds", "aaaa");
      await place("elsewhere.txt", "aaaa");
      const tree = await listing();
      await fs.rm(path.join(root, "main.mthds"));
      await fs.symlink(path.join(root, "elsewhere.txt"), path.join(root, "main.mthds"));

      await expect(tree.readFile("main.mthds")).rejects.toMatchObject({ code: "symbolic_link" });
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a folder holding a directory it cannot read, naming it",
    async () => {
      await place("main.mthds");
      await place("locked/inner.mthds");
      await fs.chmod(path.join(root, "locked"), 0o000);

      const error = await refusal();

      expect(error.code).toBe("not_listable");
      expect(error.message).toContain("locked");
    },
  );
});
