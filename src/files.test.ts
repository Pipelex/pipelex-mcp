import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { treeDigest } from "mthds";

import { GRAPH_PAGE_FILENAME, GRAPH_PAGE_MARK } from "./capabilities/graph-page.js";
import type { ListingLimits } from "./capabilities/method-tree.js";
import type { MethodTreeRead } from "./capabilities/shared.js";
import { FALLBACK_TREE_LIMITS } from "./capabilities/tree-limits.js";
import { localFileResolver, localMethodFileResolver } from "./files.js";

const BUNDLE = 'domain = "demo"\nmain_pipe = "main"\n';

describe("localFileResolver", () => {
  let rootDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-root-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-outside-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("reads a file by relative path", async () => {
    await fs.mkdir(path.join(rootDir, "methods"));
    await fs.writeFile(path.join(rootDir, "methods", "bundle.mthds"), BUNDLE);

    const resolution = await localFileResolver(rootDir).resolve("methods/bundle.mthds");

    expect(resolution).toEqual({ ok: true, content: BUNDLE });
  });

  it("reads an absolute path inside the boundary", async () => {
    const target = path.join(rootDir, "bundle.mthds");
    await fs.writeFile(target, BUNDLE);

    const resolution = await localFileResolver(rootDir).resolve(target);

    expect(resolution).toEqual({ ok: true, content: BUNDLE });
  });

  it("follows a symlink that stays inside the boundary", async () => {
    await fs.writeFile(path.join(rootDir, "real.mthds"), BUNDLE);
    await fs.symlink(path.join(rootDir, "real.mthds"), path.join(rootDir, "link.mthds"));

    const resolution = await localFileResolver(rootDir).resolve("link.mthds");

    expect(resolution).toEqual({ ok: true, content: BUNDLE });
  });

  it("reports a missing file", async () => {
    const resolution = await localFileResolver(rootDir).resolve("missing.mthds");

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toBe("File not found: missing.mthds");
      expect(resolution.hint).toContain("working directory");
    }
  });

  it("reports a path whose parent component is a file as missing", async () => {
    await fs.writeFile(path.join(rootDir, "bundle.mthds"), BUNDLE);

    const resolution = await localFileResolver(rootDir).resolve("bundle.mthds/nested.mthds");

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/File not found/);
    }
  });

  it("rejects a relative path escaping the boundary", async () => {
    const outsideName = path.basename(outsideDir);
    await fs.writeFile(path.join(outsideDir, "secret.mthds"), BUNDLE);

    const resolution = await localFileResolver(rootDir).resolve(`../${outsideName}/secret.mthds`);

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/outside the server's working directory/);
    }
  });

  it("rejects an absolute path outside the boundary", async () => {
    const target = path.join(outsideDir, "secret.mthds");
    await fs.writeFile(target, BUNDLE);

    const resolution = await localFileResolver(rootDir).resolve(target);

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/outside the server's working directory/);
    }
  });

  it("rejects a symlink escaping the boundary", async () => {
    const target = path.join(outsideDir, "secret.mthds");
    await fs.writeFile(target, BUNDLE);
    await fs.symlink(target, path.join(rootDir, "sneaky.mthds"));

    const resolution = await localFileResolver(rootDir).resolve("sneaky.mthds");

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/outside the server's working directory/);
    }
  });

  it("rejects a directory", async () => {
    // A .mthds-suffixed directory passes the extension check, so this exercises
    // the regular-file branch rather than tripping the extension gate first.
    await fs.mkdir(path.join(rootDir, "bundle.mthds"));

    const resolution = await localFileResolver(rootDir).resolve("bundle.mthds");

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/not a regular file/);
    }
  });

  it("rejects a file without the .mthds extension without reading it", async () => {
    await fs.writeFile(path.join(rootDir, ".env"), "SECRET=shh\n");

    const resolution = await localFileResolver(rootDir).resolve(".env");

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/not a \.mthds file/);
      // The secret must not leak into the failure surface.
      expect(resolution.message).not.toContain("SECRET");
      expect(resolution.hint).not.toContain("SECRET");
    }
  });

  it("accepts a .mthds path case-insensitively", async () => {
    await fs.writeFile(path.join(rootDir, "Bundle.MTHDS"), BUNDLE);

    const resolution = await localFileResolver(rootDir).resolve("Bundle.MTHDS");

    expect(resolution).toEqual({ ok: true, content: BUNDLE });
  });

  it("reports an unresolvable root directory", async () => {
    const resolution = await localFileResolver(path.join(rootDir, "gone")).resolve("bundle.mthds");

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/working directory/);
    }
  });
});

describe("localMethodFileResolver", () => {
  let rootDir: string;
  let outsideDir: string;
  // Bytes no UTF-8 decode survives: a NUL, a lone continuation byte, a high byte.
  const TEMPLATE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xff, 0x0a]);
  const MAX_BYTES = 1024;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-root-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-outside-"));
    await place("methods/invoice/invoice.mthds");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  async function place(relative: string, content: string | Uint8Array = BUNDLE) {
    const target = path.join(rootDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  /** A file of `size` zero bytes, sparse on disk. */
  async function placeSparse(relative: string, size: number) {
    const target = path.join(rootDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "");
    await fs.truncate(target, size);
  }

  it("reads .mthds files as text through resolve, as the plain resolver does", async () => {
    const resolution = await localMethodFileResolver(rootDir).resolve(
      "methods/invoice/invoice.mthds",
    );

    expect(resolution).toEqual({ ok: true, content: BUNDLE });
  });

  it("is not how the plain resolver reads: it reads no method file and no folder", () => {
    const plain = localFileResolver(rootDir);

    expect(plain.statMethodFile).toBeUndefined();
    expect(plain.readMethodFile).toBeUndefined();
    expect(plain.locateMethodDir).toBeUndefined();
    expect(plain.readMethodTree).toBeUndefined();
  });

  describe("statMethodFile", () => {
    function stat(submitted: string) {
      return localMethodFileResolver(rootDir).statMethodFile!(submitted);
    }

    it("answers a file's path as written, resolved and relative to the working directory, and its size", async () => {
      await place("methods/invoice/templates/invoice.xlsx", TEMPLATE_BYTES);

      const mthds = await stat("./methods/invoice/invoice.mthds");
      const template = await stat(path.join(rootDir, "methods/invoice/templates/invoice.xlsx"));

      expect(mthds).toEqual({
        ok: true,
        absolute: path.join(rootDir, "methods", "invoice", "invoice.mthds"),
        relative: path.join("methods", "invoice", "invoice.mthds"),
        size: new TextEncoder().encode(BUNDLE).byteLength,
      });
      expect(template).toEqual({
        ok: true,
        absolute: path.join(rootDir, "methods", "invoice", "templates", "invoice.xlsx"),
        relative: path.join("methods", "invoice", "templates", "invoice.xlsx"),
        size: TEMPLATE_BYTES.byteLength,
      });
    });

    it("answers a link inside the working directory under the link's own path", async () => {
      await fs.symlink(
        path.join(rootDir, "methods", "invoice", "invoice.mthds"),
        path.join(rootDir, "alias.mthds"),
      );

      expect(await stat("alias.mthds")).toMatchObject({
        ok: true,
        absolute: path.join(rootDir, "alias.mthds"),
        relative: "alias.mthds",
      });
    });

    it("refuses what a read refuses, a suffix, a path outside, a directory, without reading a byte", async () => {
      await fs.writeFile(path.join(outsideDir, "secret.mthds"), BUNDLE);
      await fs.mkdir(path.join(rootDir, "methods", "invoice", "report.html"));

      const suffix = await stat(".env");
      const outside = await stat(path.join(outsideDir, "secret.mthds"));
      const directory = await stat("methods/invoice/report.html");

      expect(suffix.ok === false && suffix.message).toBe(
        "Path is not a .mthds file or a template file: .env",
      );
      expect(outside.ok === false && outside.message).toContain(
        "Path resolves outside the server's working directory",
      );
      expect(directory.ok === false && directory.message).toMatch(/not a regular file/);
    });

    it("holds no file to a size, which the tree's limits do once every item is stated", async () => {
      await placeSparse("methods/invoice/templates/huge.docx", MAX_BYTES + 1);

      expect(await stat("methods/invoice/templates/huge.docx")).toMatchObject({
        ok: true,
        size: MAX_BYTES + 1,
      });
    });
  });

  describe("readMethodFile", () => {
    function read(submitted: string, maxBytes = MAX_BYTES) {
      return localMethodFileResolver(rootDir).readMethodFile!(submitted, { maxBytes });
    }

    it("reads a .mthds file and a template file as their exact bytes", async () => {
      await place("methods/invoice/templates/invoice.xlsx", TEMPLATE_BYTES);

      const mthds = await read("methods/invoice/invoice.mthds");
      const template = await read(path.join(rootDir, "methods/invoice/templates/invoice.xlsx"));

      expect(mthds).toEqual({ ok: true, bytes: new TextEncoder().encode(BUNDLE) });
      expect(template).toEqual({ ok: true, bytes: TEMPLATE_BYTES });
    });

    it("reads a link inside the working directory", async () => {
      await fs.symlink(
        path.join(rootDir, "methods", "invoice", "invoice.mthds"),
        path.join(rootDir, "alias.mthds"),
      );

      expect(await read("alias.mthds")).toEqual({
        ok: true,
        bytes: new TextEncoder().encode(BUNDLE),
      });
    });

    it.each([".env", "notes.txt", "id_rsa", "invoice.pdf"])(
      "refuses %s, a suffix outside .mthds and the template files, without touching it",
      async (name) => {
        // Nothing is placed: an extension refusal never reaches the filesystem.
        const resolution = await read(name);

        expect(resolution).toEqual({
          ok: false,
          message: `Path is not a .mthds file or a template file: ${name}`,
          hint: expect.stringContaining(".html, .xlsx, .docx, .pptx"),
        });
        expect(resolution.ok === false && resolution.hint).toContain("method_dir");
      },
    );

    it("refuses a path leaving the working directory, by path or through a link", async () => {
      await fs.writeFile(path.join(outsideDir, "secret.mthds"), BUNDLE);
      await fs.symlink(path.join(outsideDir, "secret.mthds"), path.join(rootDir, "sneaky.mthds"));

      for (const submitted of [
        `../${path.basename(outsideDir)}/secret.mthds`,
        path.join(outsideDir, "secret.mthds"),
        "sneaky.mthds",
      ]) {
        const resolution = await read(submitted);
        expect(resolution.ok === false && resolution.message).toBe(
          `Path resolves outside the server's working directory: ${submitted}`,
        );
      }
    });

    it("refuses a file over the deployment's limit on one file before reading it", async () => {
      await placeSparse("methods/invoice/templates/huge.docx", MAX_BYTES + 1);

      const resolution = await read("methods/invoice/templates/huge.docx");

      expect(resolution.ok === false && resolution.message).toBe(
        `File is too large: methods/invoice/templates/huge.docx is ${MAX_BYTES + 1} bytes, over the limit of ${MAX_BYTES} bytes the Pipelex deployment takes for one file of a method.`,
      );
      expect((await read("methods/invoice/templates/huge.docx", MAX_BYTES + 1)).ok).toBe(true);
    });

    it("reports a missing file and a directory carrying a method suffix", async () => {
      await fs.mkdir(path.join(rootDir, "methods", "invoice", "report.html"));

      const missing = await read("methods/invoice/gone.xlsx");
      const directory = await read("methods/invoice/report.html");

      expect(missing.ok === false && missing.message).toBe(
        "File not found: methods/invoice/gone.xlsx",
      );
      expect(directory.ok === false && directory.message).toMatch(/not a regular file/);
    });
  });

  describe("a method folder", () => {
    async function folder(
      methodDir: string,
      options: { limits?: ListingLimits; save?: boolean } = {},
    ): Promise<MethodTreeRead> {
      const resolver = localMethodFileResolver(rootDir, { save: options.save });
      const location = await resolver.locateMethodDir!(methodDir);
      if (!location.ok) return location;
      return resolver.readMethodTree!(location, { limits: options.limits ?? FALLBACK_TREE_LIMITS });
    }

    async function sent(methodDir: string): Promise<string[]> {
      const tree = await folder(methodDir);
      if (!tree.ok) throw new Error(tree.refusals.map((r) => r.message).join("; "));
      return tree.files.map((file) => file.path);
    }

    async function refusalOf(
      methodDir: string,
      options: { limits?: ListingLimits; save?: boolean } = {},
    ): Promise<{ message: string; hint: string }> {
      const tree = await folder(methodDir, options);
      if (tree.ok)
        throw new Error(`expected a refusal, read ${tree.files.map((f) => f.path).join(", ")}`);
      expect(tree.refusals).toHaveLength(1);
      return tree.refusals[0]!;
    }

    it("reads the whole tree, every file once, under its tree path", async () => {
      await place("methods/invoice/templates/invoice.xlsx", TEMPLATE_BYTES);
      await place("methods/invoice/steps/render.mthds");
      await place("methods/invoice/README.md", "# Invoice\n");
      await place("methods/invoice/samples/invoice.pdf", TEMPLATE_BYTES);
      await place("methods/invoice/.env", "TOKEN=nothing-real\n");

      const tree = await folder("methods/invoice");

      if (!tree.ok) throw new Error(tree.refusals.map((r) => r.message).join("; "));
      expect(tree.files.map((file) => file.path)).toEqual([
        "README.md",
        "invoice.mthds",
        "samples/invoice.pdf",
        "steps/render.mthds",
        "templates/invoice.xlsx",
      ]);
      expect(tree.digest).toBe(treeDigest(tree.files));
      expect([...tree.bytes.keys()]).toEqual(tree.files.map((file) => file.path));
      expect(tree.bytes.get("templates/invoice.xlsx")).toEqual(TEMPLATE_BYTES);
      expect(new TextDecoder().decode(tree.bytes.get("invoice.mthds"))).toBe(BUNDLE);
    });

    it("leaves out dot segments, __pycache__, node_modules, a run's inputs file and what a .gitignore excludes", async () => {
      await place("methods/invoice/.drafts/old.mthds");
      await place("methods/invoice/__pycache__/cached.mthds");
      await place("methods/invoice/node_modules/pkg/dep.mthds");
      await place("methods/invoice/inputs.json", "{}");
      await place("methods/invoice/examples/inputs.toml", "x = 1");
      await place("methods/invoice/.gitignore", "scratch/\n");
      await place("methods/invoice/scratch/try.mthds");
      await place("methods/invoice/steps/.gitignore", "*.mthds\n!keep.mthds\n");
      await place("methods/invoice/steps/drop.mthds");
      await place("methods/invoice/steps/keep.mthds");

      expect(await sent("methods/invoice")).toEqual(["invoice.mthds", "steps/keep.mthds"]);
    });

    it("reads a run directory unless it is marked with a .gitignore of *", async () => {
      await place("methods/invoice/runs/run_1/main_stuff.json", "{}");

      expect(await sent("methods/invoice")).toEqual([
        "invoice.mthds",
        "runs/run_1/main_stuff.json",
      ]);

      await place("methods/invoice/runs/.gitignore", "*\n");

      expect(await sent("methods/invoice")).toEqual(["invoice.mthds"]);
    });

    it("leaves out the workshop's own graph page at the folder's top, and names it", async () => {
      await place(`methods/invoice/${GRAPH_PAGE_FILENAME}`, `<head>${GRAPH_PAGE_MARK}</head>`);

      const tree = await folder("methods/invoice");

      expect(tree).toMatchObject({ ok: true, graphPage: GRAPH_PAGE_FILENAME });
      expect(tree.ok && tree.files.map((file) => file.path)).toEqual(["invoice.mthds"]);
    });

    it("refuses a folder that is itself a virtual environment, saying why", async () => {
      await place("methods/invoice/pyvenv.cfg", "home = x");

      const refusal = await refusalOf("methods/invoice");

      expect(refusal.message).toContain("holds a pyvenv.cfg file");
      expect(refusal.message).toContain("Python virtual environment");
    });

    it("leaves out a virtual environment and a nested repository, reading neither's files", async () => {
      await place("methods/invoice/venv/pyvenv.cfg", "home = x");
      await place("methods/invoice/venv/lib/stray.mthds");
      await place("methods/invoice/vendor/repo/.git/HEAD", "ref");
      await place("methods/invoice/vendor/repo/other.mthds");

      expect(await sent("methods/invoice")).toEqual(["invoice.mthds"]);
    });

    it("reads the working directory itself as a folder", async () => {
      await place("main.mthds");

      expect(await sent(".")).toEqual(["main.mthds", "methods/invoice/invoice.mthds"]);
    });

    it("refuses a folder outside the working directory, by path or through a link", async () => {
      await fs.writeFile(path.join(outsideDir, "main.mthds"), BUNDLE);

      const byPath = await refusalOf(`../${path.basename(outsideDir)}`);
      expect(byPath.message).toContain("resolves outside the server's working directory");

      const byAbsolute = await refusalOf(outsideDir);
      expect(byAbsolute.message).toContain("resolves outside the server's working directory");

      await fs.symlink(outsideDir, path.join(rootDir, "linked"));
      const byLink = await refusalOf("linked");
      expect(byLink.message).toContain("resolves outside the server's working directory");
      expect(byLink.hint).toContain("files");
    });

    it("refuses a missing folder and a file passed as a folder", async () => {
      const missing = await refusalOf("methods/nowhere");
      expect(missing.message).toBe("Folder not found: methods/nowhere");
      expect(missing.hint).toContain("working directory");

      const file = await refusalOf("methods/invoice/invoice.mthds");
      expect(file.message).toBe("method_dir is not a directory: methods/invoice/invoice.mthds");
      expect(file.hint).toContain("files");
    });

    it("words a save's refusals for a tool that takes a folder alone", async () => {
      const missing = await refusalOf("methods/nowhere", { save: true });
      expect(missing.hint).toContain("then save the folder again.");
      expect(missing.hint).not.toContain("files");

      const file = await refusalOf("methods/invoice/invoice.mthds", { save: true });
      expect(file.hint).toContain("its whole tree is what a save stores");
    });

    it("refuses a folder with no .mthds file at its top, naming the deeper ones", async () => {
      const refusal = await refusalOf("methods");

      expect(refusal.message).toBe(
        `methods holds no .mthds file at its top; it holds ${path.join("methods", "invoice", "invoice.mthds")} further down.`,
      );
      expect(refusal.hint).toContain(".gitignore");

      await fs.mkdir(path.join(rootDir, "empty"));
      expect((await refusalOf("empty")).message).toBe("empty holds no .mthds file at its top.");
    });

    it("refuses a symbolic link it does not skip, naming it, and passes one it skips", async () => {
      await place("methods/invoice/templates/invoice.xlsx", TEMPLATE_BYTES);
      await fs.symlink(
        path.join(rootDir, "methods", "invoice", "templates", "invoice.xlsx"),
        path.join(rootDir, "methods", "invoice", "templates", "alias.xlsx"),
      );

      const refusal = await refusalOf("methods/invoice");
      expect(refusal.message).toContain("holds a symbolic link, 'templates/alias.xlsx'");
      expect(refusal.hint).toContain("never followed");

      await place("methods/invoice/.gitignore", "alias.xlsx\n");
      expect(await sent("methods/invoice")).toEqual(["invoice.mthds", "templates/invoice.xlsx"]);
    });

    it("holds the tree to the limits it is handed while it lists it, saying whose they are", async () => {
      await place("methods/invoice/steps/render.mthds");
      await place("methods/invoice/README.md");

      const deployment = await refusalOf("methods/invoice", {
        limits: { ...FALLBACK_TREE_LIMITS, maxFileCount: 2, workshopSet: [] },
      });
      expect(deployment.message).toContain(
        "The Pipelex deployment this workshop talks to takes no method holding more than 2 files.",
      );
      expect(deployment.hint).toContain(".gitignore");

      await placeSparse("methods/invoice/samples/scan.pdf", 4096);
      const size = await refusalOf("methods/invoice", {
        limits: { ...FALLBACK_TREE_LIMITS, maxFileSize: 4095 },
      });
      expect(size.message).toContain("the workshop's own scan limit");
    });
  });
});
