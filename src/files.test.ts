import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GRAPH_PAGE_FILENAME } from "./capabilities/graph-page.js";
import {
  MAX_FOLDER_MTHDS_FILE_BYTES,
  MAX_FOLDER_MTHDS_FILES,
  resolveSubmittedFiles,
} from "./capabilities/shared.js";
import type { MethodDirResolution } from "./capabilities/shared.js";
import { MAX_TEMPLATE_FILE_BYTES, MAX_TEMPLATE_FILES } from "./capabilities/template-files.js";
import { localBundleFileResolver, localFileResolver } from "./files.js";

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

describe("localBundleFileResolver", () => {
  let rootDir: string;
  let outsideDir: string;
  // Bytes no UTF-8 decode survives: a NUL, a lone continuation byte, a high byte.
  const TEMPLATE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xff, 0x0a]);
  const MIB = 1024 * 1024;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-root-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-outside-"));
    await placeBundle("methods/invoice/invoice.mthds", ["templates/invoice.xlsx"]);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  /** A `.mthds` file whose `PipeDocGen` steps fill `templateFiles`, one step each. */
  function docGenBundle(templateFiles: readonly string[]): string {
    const steps = templateFiles.map((templateFile, index) =>
      [
        `[pipe.render_${index}]`,
        'type = "PipeDocGen"',
        'description = "Fill the template"',
        'inputs = { invoice = "Invoice" }',
        'output = "Document"',
        `template_file = "${templateFile}"`,
      ].join("\n"),
    );
    return ['domain = "invoice"', ...steps].join("\n\n") + "\n";
  }

  async function placeBundle(relative: string, templateFiles: readonly string[]) {
    const target = path.join(rootDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, docGenBundle(templateFiles));
  }

  async function placeTemplate(relative: string, bytes: Uint8Array = TEMPLATE_BYTES) {
    const target = path.join(rootDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }

  /** A template file of `size` zero bytes, sparse on disk. */
  async function placeSparseTemplate(relative: string, size: number) {
    const target = path.join(rootDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "");
    await fs.truncate(target, size);
  }

  function submit(paths: readonly string[]) {
    return resolveSubmittedFiles(
      paths.map((submitted) => ({ path: submitted })),
      localBundleFileResolver(rootDir),
    );
  }

  it("reads .mthds files as text, as the plain resolver does", async () => {
    const resolution = await localBundleFileResolver(rootDir).resolve(
      "methods/invoice/invoice.mthds",
    );

    expect(resolution).toEqual({
      ok: true,
      content: docGenBundle(["templates/invoice.xlsx"]),
    });
  });

  it("names the template suffixes when its text arm refuses an extension", async () => {
    const resolution = await localBundleFileResolver(rootDir).resolve("notes.txt");

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toBe("Path is not a .mthds file: notes.txt");
      expect(resolution.hint).toContain(".html, .xlsx, .docx, .pptx");
    }
  });

  it("sends a template file's exact bytes under the template_file of the step naming it", async () => {
    await placeTemplate("methods/invoice/templates/invoice.xlsx");

    const resolution = await submit([
      "methods/invoice/templates/invoice.xlsx",
      "methods/invoice/invoice.mthds",
    ]);

    expect(resolution.errors).toEqual([]);
    expect(Object.keys(resolution.resources)).toEqual(["templates/invoice.xlsx"]);
    expect([...resolution.resources["templates/invoice.xlsx"]!]).toEqual([...TEMPLATE_BYTES]);
  });

  it("keys each template by its own step in a bundle spread over several directories", async () => {
    // The .mthds files share no directory but methods/: each template is
    // keyed from the directory of the file whose step names it.
    await placeBundle("methods/shared/concepts.mthds", []);
    await placeBundle("methods/invoice/steps/render.mthds", ["report.html"]);
    await placeTemplate("methods/invoice/templates/invoice.xlsx");
    await placeTemplate("methods/invoice/steps/report.html");

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      "methods/shared/concepts.mthds",
      "methods/invoice/steps/render.mthds",
      "methods/invoice/templates/invoice.xlsx",
      "./methods/invoice/steps/report.html",
    ]);

    expect(resolution.errors).toEqual([]);
    expect(Object.keys(resolution.resources).sort()).toEqual([
      "report.html",
      "templates/invoice.xlsx",
    ]);
  });

  it("sends a template under the canonical form of the step's template_file", async () => {
    await placeBundle("methods/invoice/invoice.mthds", ["./templates//invoice.xlsx"]);
    await placeTemplate("methods/invoice/templates/invoice.xlsx");

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      path.join(rootDir, "methods", "invoice", "templates", "invoice.xlsx"),
    ]);

    expect(resolution.errors).toEqual([]);
    expect(Object.keys(resolution.resources)).toEqual(["templates/invoice.xlsx"]);
  });

  it("refuses a template file no step names, saying where the steps look", async () => {
    await placeTemplate("methods/invoice/templates/invoice.xlsx");
    await placeTemplate("methods/invoice/invoice.xlsx");

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      "methods/invoice/invoice.xlsx",
    ]);

    expect(resolution.resources).toEqual({});
    expect(resolution.errors).toHaveLength(1);
    expect(resolution.errors[0]).toMatchObject({
      class: "input_domain",
      location: "files[1].path",
      retryable: false,
    });
    expect(resolution.errors[0]?.message).toContain("named by no PipeDocGen step");
    expect(resolution.errors[0]?.message).toContain("methods/invoice/templates/invoice.xlsx");
  });

  it("refuses the flowchart page mthds_validate writes, which no step names", async () => {
    await fs.writeFile(
      path.join(rootDir, "methods", "invoice", GRAPH_PAGE_FILENAME),
      "<html></html>",
    );
    await placeTemplate("methods/invoice/templates/invoice.xlsx");

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      "methods/invoice/templates/invoice.xlsx",
      `methods/invoice/${GRAPH_PAGE_FILENAME}`,
    ]);

    expect(resolution.errors.map((error) => error.location)).toEqual(["files[2].path"]);
    expect(resolution.errors[0]?.message).toContain("named by no PipeDocGen step");
  });

  it("names nothing from a .mthds file that does not parse, or from a template_file leaving the bundle", async () => {
    await fs.writeFile(
      path.join(rootDir, "methods", "invoice", "broken.mthds"),
      '[pipe.render\ntype = "PipeDocGen"\ntemplate_file = "templates/invoice.xlsx"\n',
    );
    await placeBundle("methods/invoice/invoice.mthds", ["../invoice.xlsx"]);
    await placeTemplate("methods/invoice.xlsx");
    await placeTemplate("methods/invoice/templates/invoice.xlsx");

    const resolution = await submit([
      "methods/invoice/broken.mthds",
      "methods/invoice/invoice.mthds",
      "methods/invoice.xlsx",
      "methods/invoice/templates/invoice.xlsx",
    ]);

    expect(resolution.errors.map((error) => error.location)).toEqual([
      "files[2].path",
      "files[3].path",
    ]);
  });

  it("refuses one template_file naming a different file beside each of two .mthds files", async () => {
    await placeBundle("methods/a/a.mthds", ["letter.docx"]);
    await placeBundle("methods/b/b.mthds", ["letter.docx"]);
    await placeTemplate("methods/a/letter.docx");
    await placeTemplate("methods/b/letter.docx", new Uint8Array([0x01]));

    const resolution = await submit([
      "methods/a/a.mthds",
      "methods/b/b.mthds",
      "methods/a/letter.docx",
      "methods/b/letter.docx",
    ]);

    expect(resolution.resources).toEqual({});
    expect(resolution.errors.map((error) => error.location)).toEqual([
      "files[2].path",
      "files[3].path",
    ]);
    expect(resolution.errors[0]?.message).toContain('"letter.docx"');
  });

  it("sends a file submitted twice once, under any spelling of its path", async () => {
    await placeTemplate("methods/invoice/templates/invoice.xlsx");
    const spellings = [
      "methods/invoice/templates/invoice.xlsx",
      "./methods/invoice/../invoice/templates/invoice.xlsx",
      path.join(rootDir, "methods", "invoice", "templates", "invoice.xlsx"),
    ];
    // On a filesystem that ignores case, another spelling of the same file.
    const upper = path.join(rootDir, "methods", "invoice", "Templates", "Invoice.xlsx");
    const ignoresCase = await fs.stat(upper).then(
      () => true,
      () => false,
    );
    if (ignoresCase) spellings.push("methods/invoice/Templates/Invoice.xlsx");

    const resolution = await submit(["methods/invoice/invoice.mthds", ...spellings]);

    expect(resolution.errors).toEqual([]);
    expect(Object.keys(resolution.resources)).toEqual(["templates/invoice.xlsx"]);
  });

  it("counts the files sent, after a file submitted twice is counted once", async () => {
    const names = Array.from({ length: 20 }, (_, index) => `templates/t${index}.docx`);
    await placeBundle("methods/invoice/invoice.mthds", names);
    for (const name of names) await placeTemplate(`methods/invoice/${name}`);
    const submitted = names.map((name) => `methods/invoice/${name}`);

    const twice = await submit(["methods/invoice/invoice.mthds", ...submitted, ...submitted]);

    expect(twice.errors).toEqual([]);
    expect(Object.keys(twice.resources)).toHaveLength(names.length);
  });

  it("refuses more template files than the runner takes, at files", async () => {
    const names = Array.from(
      { length: MAX_TEMPLATE_FILES + 1 },
      (_, index) => `templates/t${index}.docx`,
    );
    await placeBundle("methods/invoice/invoice.mthds", names);
    for (const name of names) await placeTemplate(`methods/invoice/${name}`);

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      ...names.map((name) => `methods/invoice/${name}`),
    ]);

    expect(resolution.errors).toHaveLength(1);
    expect(resolution.errors[0]?.location).toBe("files");
    expect(resolution.errors[0]?.message).toContain(String(MAX_TEMPLATE_FILES));
  });

  it("holds the template files to the gateway's quota with each one base64-encoded", async () => {
    // Under the runner's 10 MiB of raw bytes, over the gateway's 10 MiB once
    // encoded: refused at the file that crosses it.
    const names = ["templates/a.docx", "templates/b.docx", "templates/c.docx"];
    await placeBundle("methods/invoice/invoice.mthds", names);
    for (const name of names)
      await placeSparseTemplate(`methods/invoice/${name}`, Math.round(2.8 * MIB));
    const submitted = names.map((name) => `methods/invoice/${name}`);

    const over = await submit(["methods/invoice/invoice.mthds", ...submitted]);

    expect(over.errors.map((error) => error.location)).toEqual(["files[3].path"]);
    expect(over.errors[0]?.message).toContain("base64-encoded");

    const under = await submit(["methods/invoice/invoice.mthds", ...submitted.slice(0, 2)]);
    expect(under.errors).toEqual([]);
    expect(Object.keys(under.resources)).toEqual(names.slice(0, 2));
  });

  it("decides everything before reading a template file", async () => {
    // A file the steps name but no one may read, beside a file no step names:
    // the refusal is the unnamed file alone, so the unreadable one was never opened.
    await placeTemplate("methods/invoice/templates/invoice.xlsx");
    await fs.chmod(path.join(rootDir, "methods", "invoice", "templates", "invoice.xlsx"), 0o000);
    await placeTemplate("methods/invoice/stray.docx");

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      "methods/invoice/templates/invoice.xlsx",
      "methods/invoice/stray.docx",
    ]);

    expect(resolution.errors.map((error) => error.location)).toEqual(["files[2].path"]);
    expect(resolution.errors[0]?.message).toContain("named by no PipeDocGen step");
  });

  it("refuses a suffix outside the template list without touching the file", async () => {
    await fs.writeFile(path.join(rootDir, "methods", "invoice", ".env"), "SECRET=shh\n");

    const resolution = await localBundleFileResolver(rootDir).resolveTemplates!(
      [{ index: 1, path: "methods/invoice/.env" }],
      [{ path: "methods/invoice/invoice.mthds", named: [".env"] }],
      0,
    );

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.refusals).toHaveLength(1);
      expect(resolution.refusals[0]?.index).toBe(1);
      expect(resolution.refusals[0]?.message).toBe(
        "Path is not a template file: methods/invoice/.env",
      );
      expect(JSON.stringify(resolution)).not.toContain("SECRET");
    }
  });

  it("refuses a template a step reaches only through a symlink out of its directory", async () => {
    // pipelex's loader refuses such a file, so it is not sent.
    await placeTemplate("shared/invoice.xlsx");
    await fs.mkdir(path.join(rootDir, "methods", "invoice", "templates"), { recursive: true });
    await fs.symlink(
      path.join(rootDir, "shared", "invoice.xlsx"),
      path.join(rootDir, "methods", "invoice", "templates", "invoice.xlsx"),
    );

    for (const submitted of ["methods/invoice/templates/invoice.xlsx", "shared/invoice.xlsx"]) {
      const resolution = await submit(["methods/invoice/invoice.mthds", submitted]);

      expect(resolution.errors.map((error) => error.location)).toEqual(["files[1].path"]);
      expect(resolution.errors[0]?.message).toContain(
        "A symlink does not make a file part of the method",
      );
    }
  });

  it("refuses a symlink whose target leaves the workspace", async () => {
    await placeBundle("methods/invoice/invoice.mthds", ["letter.docx"]);
    await fs.writeFile(path.join(outsideDir, "secret.docx"), TEMPLATE_BYTES);
    await fs.symlink(
      path.join(outsideDir, "secret.docx"),
      path.join(rootDir, "methods", "invoice", "letter.docx"),
    );

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      "methods/invoice/letter.docx",
    ]);

    expect(resolution.errors.map((error) => error.location)).toEqual(["files[1].path"]);
    expect(resolution.errors[0]?.message).toMatch(/outside the server's working directory/);
  });

  it("follows a symlink that stays in the step's directory, keyed by the step", async () => {
    await placeBundle("methods/invoice/invoice.mthds", ["report.html"]);
    await placeTemplate("methods/invoice/templates/v2.html");
    await fs.symlink(
      path.join(rootDir, "methods", "invoice", "templates", "v2.html"),
      path.join(rootDir, "methods", "invoice", "report.html"),
    );

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      "methods/invoice/report.html",
    ]);

    expect(resolution.errors).toEqual([]);
    expect(Object.keys(resolution.resources)).toEqual(["report.html"]);
  });

  it("refuses a template file over the per-file limit on its size, before reading it", async () => {
    await placeSparseTemplate(
      "methods/invoice/templates/invoice.xlsx",
      MAX_TEMPLATE_FILE_BYTES + 1,
    );

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      "methods/invoice/templates/invoice.xlsx",
    ]);

    expect(resolution.errors.map((error) => error.location)).toEqual(["files[1].path"]);
    expect(resolution.errors[0]?.message).toMatch(/too large/);
    expect(resolution.errors[0]?.message).toContain(String(MAX_TEMPLATE_FILE_BYTES));
  });

  it("reports a missing template and a directory carrying a template suffix", async () => {
    await fs.mkdir(path.join(rootDir, "methods", "invoice", "folder.html"));

    const resolution = await submit([
      "methods/invoice/invoice.mthds",
      "methods/invoice/gone.xlsx",
      "methods/invoice/folder.html",
    ]);

    expect(resolution.errors.map((error) => error.location)).toEqual([
      "files[1].path",
      "files[2].path",
    ]);
    expect(resolution.errors[0]?.message).toBe("File not found: methods/invoice/gone.xlsx");
    expect(resolution.errors[1]?.message).toMatch(/not a regular file/);
  });

  it("is not how the plain resolver reads: it has no template arm", () => {
    expect(localFileResolver(rootDir).resolveTemplates).toBeUndefined();
    expect(localFileResolver(rootDir).resolveMethodDir).toBeUndefined();
  });

  describe("resolveMethodDir", () => {
    async function folder(methodDir: string): Promise<MethodDirResolution> {
      return localBundleFileResolver(rootDir).resolveMethodDir!(methodDir);
    }

    async function sent(methodDir: string): Promise<string[]> {
      const resolution = await folder(methodDir);
      if (!resolution.ok) throw new Error(resolution.refusals.map((r) => r.message).join("; "));
      return resolution.sent;
    }

    async function refusalOf(methodDir: string): Promise<{ message: string; hint: string }> {
      const resolution = await folder(methodDir);
      if (resolution.ok) throw new Error(`expected a refusal, sent ${resolution.sent.join(", ")}`);
      expect(resolution.refusals).toHaveLength(1);
      return resolution.refusals[0]!;
    }

    it("sends the .mthds files and the templates their steps name, and nothing else", async () => {
      await placeTemplate("methods/invoice/templates/invoice.xlsx");
      await placeBundle("methods/invoice/steps/render.mthds", ["report.html"]);
      await placeTemplate("methods/invoice/steps/report.html");
      await placeTemplate("methods/invoice/templates/unused.docx");
      await placeTemplate("methods/invoice/README.md");
      await placeTemplate("methods/invoice/.env");

      const resolution = await folder("methods/invoice");

      expect(resolution).toMatchObject({ ok: true });
      if (!resolution.ok) return;
      expect(resolution.files).toEqual([
        {
          path: path.join("methods", "invoice", "invoice.mthds"),
          content: docGenBundle(["templates/invoice.xlsx"]),
        },
        {
          path: path.join("methods", "invoice", "steps", "render.mthds"),
          content: docGenBundle(["report.html"]),
        },
      ]);
      // Keyed by the step naming each one: the subfolder's bundle keys its
      // template from its own directory, as with the file list.
      expect(Object.keys(resolution.resources).sort()).toEqual([
        "report.html",
        "templates/invoice.xlsx",
      ]);
      expect([...resolution.resources["templates/invoice.xlsx"]!]).toEqual([...TEMPLATE_BYTES]);
      expect(resolution.sent).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
        path.join("methods", "invoice", "steps", "render.mthds"),
        path.join("methods", "invoice", "steps", "report.html"),
        path.join("methods", "invoice", "templates", "invoice.xlsx"),
      ]);
    });

    it("sends the folder's top-level .mthds files first, then the rest by tree path", async () => {
      await placeBundle("methods/invoice/a/first.mthds", []);
      await placeBundle("methods/invoice/zeta.mthds", []);

      expect(await sent("methods/invoice")).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
        path.join("methods", "invoice", "zeta.mthds"),
        path.join("methods", "invoice", "a", "first.mthds"),
      ]);
    });

    it("leaves out dot segments, __pycache__, node_modules and what a .gitignore excludes", async () => {
      await placeBundle("methods/invoice/.drafts/old.mthds", []);
      await placeBundle("methods/invoice/__pycache__/cached.mthds", []);
      await placeBundle("methods/invoice/node_modules/pkg/dep.mthds", []);
      await fs.writeFile(path.join(rootDir, "methods", "invoice", ".gitignore"), "scratch/\n");
      await placeBundle("methods/invoice/scratch/try.mthds", []);
      await fs.mkdir(path.join(rootDir, "methods", "invoice", "steps"));
      await fs.writeFile(
        path.join(rootDir, "methods", "invoice", "steps", ".gitignore"),
        "*.mthds\n!keep.mthds\n",
      );
      await placeBundle("methods/invoice/steps/drop.mthds", []);
      await placeBundle("methods/invoice/steps/keep.mthds", []);

      expect(await sent("methods/invoice")).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
        path.join("methods", "invoice", "steps", "keep.mthds"),
      ]);
    });

    it("sends a run directory's .mthds file unless the directory is marked with a .gitignore of *", async () => {
      // No name-based guard: a pre-existing runs/ without the mark is part of
      // the folder, and its .mthds files are sent and listed.
      await placeBundle("methods/invoice/runs/run_1/copy.mthds", []);
      await placeTemplate("methods/invoice/runs/run_1/main_stuff.json");

      expect(await sent("methods/invoice")).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
        path.join("methods", "invoice", "runs", "run_1", "copy.mthds"),
      ]);

      await fs.writeFile(path.join(rootDir, "methods", "invoice", "runs", ".gitignore"), "*\n");

      expect(await sent("methods/invoice")).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
      ]);
    });

    it("leaves a template that is missing, or that the rule excludes, for the runner to report", async () => {
      await placeBundle("methods/invoice/invoice.mthds", [
        "templates/invoice.xlsx",
        "templates/gone.docx",
        "build/report.html",
      ]);
      await placeTemplate("methods/invoice/templates/invoice.xlsx");
      await placeTemplate("methods/invoice/build/report.html");
      await fs.writeFile(path.join(rootDir, "methods", "invoice", ".gitignore"), "build/\n");

      const resolution = await folder("methods/invoice");

      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(Object.keys(resolution.resources)).toEqual(["templates/invoice.xlsx"]);
      expect(resolution.sent).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
        path.join("methods", "invoice", "templates", "invoice.xlsx"),
      ]);
    });

    it("refuses a template the folder holds only in another case, naming both spellings", async () => {
      await placeBundle("methods/invoice/invoice.mthds", ["Templates/Invoice.docx"]);
      await placeTemplate("methods/invoice/templates/invoice.docx");

      const refusal = await refusalOf("methods/invoice");

      expect(refusal.message).toBe(
        `A PipeDocGen step of ${path.join("methods", "invoice", "invoice.mthds")} names the template_file "Templates/Invoice.docx", which leads to ${path.join("methods", "invoice", "Templates", "Invoice.docx")}, and the folder holds ${path.join("methods", "invoice", "templates", "invoice.docx")}, spelled in another case.`,
      );
      expect(refusal.hint).toContain("case-sensitively");
    });

    it("refuses a template reference into a nested repository, naming it", async () => {
      await placeBundle("methods/invoice/invoice.mthds", ["vendor/kit/report.html"]);
      await placeTemplate("methods/invoice/vendor/kit/.git", new TextEncoder().encode("gitdir: x"));
      await placeTemplate("methods/invoice/vendor/kit/report.html");

      const refusal = await refusalOf("methods/invoice");

      expect(refusal.message).toContain(
        `which leads into ${path.join("methods", "invoice", "vendor", "kit")}, a nested git repository`,
      );
      expect(refusal.hint).toContain("nested repository");
    });

    it("refuses a folder that is itself a virtual environment, saying why", async () => {
      await placeBundle("methods/invoice/invoice.mthds", []);
      await placeTemplate("methods/invoice/pyvenv.cfg", new TextEncoder().encode("home = x"));

      const refusal = await refusalOf("methods/invoice");

      expect(refusal.message).toContain("holds a pyvenv.cfg file");
      expect(refusal.message).toContain("Python virtual environment");
    });

    it("leaves out a virtual environment and a nested repository, sending neither's files", async () => {
      await placeTemplate("methods/invoice/templates/invoice.xlsx");
      await placeTemplate("methods/invoice/venv/pyvenv.cfg", new TextEncoder().encode("home = x"));
      await placeBundle("methods/invoice/venv/lib/stray.mthds", []);
      await placeTemplate("methods/invoice/vendor/repo/.git/HEAD", new TextEncoder().encode("ref"));
      await placeBundle("methods/invoice/vendor/repo/other.mthds", []);

      expect(await sent("methods/invoice")).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
        path.join("methods", "invoice", "templates", "invoice.xlsx"),
      ]);
    });

    it("never reads a file a step names without a template suffix", async () => {
      await placeBundle("methods/invoice/invoice.mthds", ["notes.txt", "secrets.env"]);
      await placeTemplate("methods/invoice/notes.txt");
      await placeTemplate("methods/invoice/secrets.env");

      expect(await sent("methods/invoice")).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
      ]);
    });

    it.each([
      ["decomposed on disk, composed in the step", "NFD", "NFC"],
      ["composed on disk, decomposed in the step", "NFC", "NFD"],
    ] as const)(
      "finds a template whose name is %s, reads it by its name on disk and sends it under the step's key",
      async (_label, onDisk, inStep) => {
        const stored = `modèle.html`.normalize(onDisk);
        const named = `templates/${`modèle.html`.normalize(inStep)}`;
        expect(stored).not.toBe(`modèle.html`.normalize(inStep));
        await placeBundle("methods/invoice/invoice.mthds", [named]);
        await placeTemplate(`methods/invoice/templates/${stored}`);

        const resolution = await folder("methods/invoice");

        if (!resolution.ok) throw new Error(resolution.refusals.map((r) => r.message).join("; "));
        expect(Object.keys(resolution.resources)).toEqual([named]);
        expect(resolution.resources[named]).toEqual(TEMPLATE_BYTES);
        // A tree path is in NFC whatever the disk holds, as the standard lists it.
        expect(resolution.sent).toEqual([
          path.join("methods", "invoice", "invoice.mthds"),
          path.join("methods", "invoice", "templates", `modèle.html`.normalize("NFC")),
        ]);
      },
    );

    it("refuses a case near-miss whatever the normalization of either spelling", async () => {
      await placeBundle("methods/invoice/invoice.mthds", [
        `Templates/Modèle.html`.normalize("NFD"),
      ]);
      await placeTemplate(`methods/invoice/templates/${`modèle.html`.normalize("NFC")}`);

      const refusal = await refusalOf("methods/invoice");

      expect(refusal.message).toContain("spelled in another case");
    });

    it("sends a template named by two steps once per key, read once", async () => {
      await placeBundle("methods/invoice/invoice.mthds", [
        "templates/invoice.xlsx",
        "./templates/invoice.xlsx",
      ]);
      await placeTemplate("methods/invoice/templates/invoice.xlsx");

      const resolution = await folder("methods/invoice");

      expect(resolution.ok && Object.keys(resolution.resources)).toEqual([
        "templates/invoice.xlsx",
      ]);
      expect(resolution.ok && resolution.sent).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
        path.join("methods", "invoice", "templates", "invoice.xlsx"),
      ]);
    });

    it("reads the working directory itself as a folder", async () => {
      await placeBundle("main.mthds", []);

      expect(await sent(".")).toEqual([
        "main.mthds",
        path.join("methods", "invoice", "invoice.mthds"),
      ]);
    });

    it("refuses a folder outside the working directory, by path or through a link", async () => {
      await fs.writeFile(path.join(outsideDir, "main.mthds"), docGenBundle([]));

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
      await placeTemplate("methods/invoice/templates/invoice.xlsx");
      await fs.symlink(
        path.join(rootDir, "methods", "invoice", "templates", "invoice.xlsx"),
        path.join(rootDir, "methods", "invoice", "templates", "alias.xlsx"),
      );

      const refusal = await refusalOf("methods/invoice");
      expect(refusal.message).toContain("holds a symbolic link, 'templates/alias.xlsx'");
      expect(refusal.hint).toContain("never followed");

      await fs.writeFile(path.join(rootDir, "methods", "invoice", ".gitignore"), "alias.xlsx\n");
      expect(await sent("methods/invoice")).toEqual([
        path.join("methods", "invoice", "invoice.mthds"),
        path.join("methods", "invoice", "templates", "invoice.xlsx"),
      ]);
    });

    it("holds the .mthds files to the runner's count and per-file size", async () => {
      for (let index = 1; index < MAX_FOLDER_MTHDS_FILES; index += 1) {
        await placeBundle(`methods/invoice/steps/s${String(index).padStart(2, "0")}.mthds`, []);
      }
      expect(await sent("methods/invoice")).toHaveLength(MAX_FOLDER_MTHDS_FILES);

      await placeBundle("methods/invoice/steps/one-more.mthds", []);
      const count = await refusalOf("methods/invoice");
      expect(count.message).toContain(
        `holds ${MAX_FOLDER_MTHDS_FILES + 1} .mthds files, over the ${MAX_FOLDER_MTHDS_FILES} one request takes`,
      );
      expect(count.hint).toContain(".gitignore");

      await fs.rm(path.join(rootDir, "methods", "invoice", "steps"), { recursive: true });
      await placeSparseTemplate("methods/invoice/huge.mthds", MAX_FOLDER_MTHDS_FILE_BYTES + 1);
      const size = await refusalOf("methods/invoice");
      expect(size.message).toBe(
        `${path.join("methods", "invoice", "huge.mthds")} is ${MAX_FOLDER_MTHDS_FILE_BYTES + 1} bytes, over the ${MAX_FOLDER_MTHDS_FILE_BYTES} bytes one .mthds file may be.`,
      );
    });

    it("refuses an empty .mthds file", async () => {
      await placeTemplate("methods/invoice/blank.mthds", new TextEncoder().encode("  \n"));

      expect((await refusalOf("methods/invoice")).message).toBe(
        `${path.join("methods", "invoice", "blank.mthds")} is empty.`,
      );
    });

    it("holds the named templates to the request's count, before reading one", async () => {
      const names = Array.from(
        { length: MAX_TEMPLATE_FILES + 1 },
        (_, index) => `templates/t${index}.docx`,
      );
      await placeBundle("methods/invoice/invoice.mthds", names);
      for (const name of names) await placeTemplate(`methods/invoice/${name}`);

      const refusal = await refusalOf("methods/invoice");
      expect(refusal.message).toContain(String(MAX_TEMPLATE_FILES));
      expect(refusal.hint).toContain("have the steps share template files");
    });

    it("holds the named templates to the gateway's quota with each one base64-encoded", async () => {
      const names = ["templates/a.docx", "templates/b.docx", "templates/c.docx"];
      await placeBundle("methods/invoice/invoice.mthds", names);
      for (const name of names)
        await placeSparseTemplate(`methods/invoice/${name}`, Math.round(2.8 * MIB));

      const refusal = await refusalOf("methods/invoice");
      expect(refusal.message).toContain("base64-encoded");

      await placeBundle("methods/invoice/invoice.mthds", names.slice(0, 2));
      const under = await folder("methods/invoice");
      expect(under.ok && Object.keys(under.resources)).toEqual(names.slice(0, 2));
    });

    it("refuses a template over the per-file limit on its size", async () => {
      await placeSparseTemplate("methods/invoice/templates/invoice.xlsx", 6 * MIB);

      expect((await refusalOf("methods/invoice")).message).toBe(
        `${path.join("methods", "invoice", "templates", "invoice.xlsx")} is 6.0 MiB, over the ${MAX_TEMPLATE_FILE_BYTES / MIB}.0 MiB one template file may be.`,
      );
    });
  });
});
