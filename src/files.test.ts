import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localFileResolver } from "./files.js";

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
