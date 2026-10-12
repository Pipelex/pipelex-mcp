import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_TEMPLATE_FILE_BYTES } from "./capabilities/shared.js";
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

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-root-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-outside-"));
    await fs.mkdir(path.join(rootDir, "methods", "invoice", "templates"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "methods", "invoice", "invoice.mthds"), BUNDLE);
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  async function placeTemplate(relative: string, bytes: Uint8Array = TEMPLATE_BYTES) {
    const target = path.join(rootDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }

  it("reads .mthds files as text, as the plain resolver does", async () => {
    const resolution = await localBundleFileResolver(rootDir).resolve(
      "methods/invoice/invoice.mthds",
    );

    expect(resolution).toEqual({ ok: true, content: BUNDLE });
  });

  it("names the template suffixes when its text arm refuses an extension", async () => {
    const resolution = await localBundleFileResolver(rootDir).resolve("notes.txt");

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toBe("Path is not a .mthds file: notes.txt");
      expect(resolution.hint).toContain(".html, .xlsx, .docx, .pptx");
    }
  });

  it("reads a template file as its exact bytes, keyed by its path from the bundle's directory", async () => {
    await placeTemplate("methods/invoice/templates/invoice.xlsx");

    const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(
      "methods/invoice/templates/invoice.xlsx",
      ["methods/invoice/invoice.mthds"],
    );

    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.key).toBe("templates/invoice.xlsx");
      expect([...resolution.bytes]).toEqual([...TEMPLATE_BYTES]);
    }
  });

  it("keys against the deepest directory holding every .mthds path", async () => {
    await fs.mkdir(path.join(rootDir, "methods", "invoice", "steps"));
    await fs.writeFile(path.join(rootDir, "methods", "invoice", "steps", "render.mthds"), BUNDLE);
    await placeTemplate("methods/invoice/steps/report.html");

    const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(
      "./methods/invoice/steps/report.html",
      ["methods/invoice/steps/render.mthds", "methods/invoice/invoice.mthds"],
    );

    expect(resolution).toMatchObject({ ok: true, key: "steps/report.html" });
  });

  it("takes an absolute path, and a suffix in any case, keeping the name as given", async () => {
    await placeTemplate("methods/invoice/Deck.PPTX");

    const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(
      path.join(rootDir, "methods", "invoice", "Deck.PPTX"),
      ["methods/invoice/invoice.mthds"],
    );

    expect(resolution).toMatchObject({ ok: true, key: "Deck.PPTX" });
  });

  it("refuses a suffix outside the template list without reading the file", async () => {
    await fs.writeFile(path.join(rootDir, "methods", "invoice", ".env"), "SECRET=shh\n");

    const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(
      "methods/invoice/.env",
      ["methods/invoice/invoice.mthds"],
    );

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toBe("Path is not a template file: methods/invoice/.env");
      expect(`${resolution.message} ${resolution.hint}`).not.toContain("SECRET");
    }
  });

  it("refuses a template outside the bundle's directory before touching the filesystem", async () => {
    // The file does not exist: a refusal that named it missing would have
    // looked for it, and this one never does.
    for (const submitted of ["methods/other/invoice.xlsx", "methods/invoice.xlsx", "../x.docx"]) {
      const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(submitted, [
        "methods/invoice/invoice.mthds",
      ]);

      expect(resolution.ok).toBe(false);
      if (!resolution.ok) {
        expect(resolution.message).toContain("outside the bundle's directory, methods/invoice");
      }
    }
  });

  it("refuses a symlink in the bundle's directory whose target lies elsewhere in the workspace", async () => {
    await placeTemplate("shared/invoice.xlsx");
    await fs.symlink(
      path.join(rootDir, "shared", "invoice.xlsx"),
      path.join(rootDir, "methods", "invoice", "templates", "invoice.xlsx"),
    );

    const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(
      "methods/invoice/templates/invoice.xlsx",
      ["methods/invoice/invoice.mthds"],
    );

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/outside the bundle's directory/);
      expect(resolution.message).toContain("A symlink does not make a file part of the method");
    }
  });

  it("refuses a symlink whose target leaves the workspace", async () => {
    await fs.writeFile(path.join(outsideDir, "secret.docx"), TEMPLATE_BYTES);
    await fs.symlink(
      path.join(outsideDir, "secret.docx"),
      path.join(rootDir, "methods", "invoice", "letter.docx"),
    );

    const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(
      "methods/invoice/letter.docx",
      ["methods/invoice/invoice.mthds"],
    );

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/outside the server's working directory/);
    }
  });

  it("follows a symlink that stays in the bundle's directory, keyed by the submitted name", async () => {
    await placeTemplate("methods/invoice/templates/v2.html");
    await fs.symlink(
      path.join(rootDir, "methods", "invoice", "templates", "v2.html"),
      path.join(rootDir, "methods", "invoice", "report.html"),
    );

    const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(
      "methods/invoice/report.html",
      ["methods/invoice/invoice.mthds"],
    );

    expect(resolution).toMatchObject({ ok: true, key: "report.html" });
  });

  it("refuses a template file over the per-file limit on its size, before reading it", async () => {
    const target = path.join(rootDir, "methods", "invoice", "big.docx");
    await fs.writeFile(target, "");
    await fs.truncate(target, MAX_TEMPLATE_FILE_BYTES + 1);

    const resolution = await localBundleFileResolver(rootDir).resolveTemplate!(
      "methods/invoice/big.docx",
      ["methods/invoice/invoice.mthds"],
    );

    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toMatch(/too large/);
      expect(resolution.message).toContain(String(MAX_TEMPLATE_FILE_BYTES));
    }
  });

  it("reports a missing template and a directory carrying a template suffix", async () => {
    await fs.mkdir(path.join(rootDir, "methods", "invoice", "folder.html"));
    const resolver = localBundleFileResolver(rootDir);

    const missing = await resolver.resolveTemplate!("methods/invoice/gone.xlsx", [
      "methods/invoice/invoice.mthds",
    ]);
    const directory = await resolver.resolveTemplate!("methods/invoice/folder.html", [
      "methods/invoice/invoice.mthds",
    ]);

    expect(missing).toMatchObject({
      ok: false,
      message: "File not found: methods/invoice/gone.xlsx",
    });
    expect(directory).toMatchObject({ ok: false });
    if (!directory.ok) expect(directory.message).toMatch(/not a regular file/);
  });

  it("is not how the plain resolver reads: it has no template arm", () => {
    expect(localFileResolver(rootDir).resolveTemplate).toBeUndefined();
  });
});
