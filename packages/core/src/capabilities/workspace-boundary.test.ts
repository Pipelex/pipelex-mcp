import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isInsideRoot, resolveSaveDir } from "./workspace-boundary.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = "pipelex-boundary-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("isInsideRoot", () => {
  const root = path.join(path.sep, "workspace", "project");

  it("accepts the root itself and anything under it", () => {
    expect(isInsideRoot(root, root)).toBe(true);
    expect(isInsideRoot(root, path.join(root, "src"))).toBe(true);
    expect(isInsideRoot(root, path.join(root, "src", "generated", "types.ts"))).toBe(true);
  });

  it("refuses a sibling whose name merely starts with the root's", () => {
    // The separator in the prefix test is what makes this a refusal rather
    // than a match — `project-evil` is not inside `project`.
    expect(isInsideRoot(root, `${root}-evil`)).toBe(false);
    expect(isInsideRoot(root, path.join(path.sep, "workspace", "other"))).toBe(false);
    expect(isInsideRoot(root, path.join(path.sep, "workspace"))).toBe(false);
  });
});

// The containment routine these cases cover was folded out of
// `capabilities/artifacts.ts`; they moved here unchanged but for the
// `location` argument the fold added.
describe("resolveSaveDir", () => {
  it("defaults to the root itself and creates a nested relative dir inside it", async () => {
    const root = await makeTempDir();

    const bare = await resolveSaveDir(root, undefined, "dir");
    const nested = await resolveSaveDir(root, "out/run-1", "dir");

    expect(bare).toMatchObject({ ok: true });
    if (!bare.ok) return;
    expect(bare.dir).toBe(await fs.realpath(root));
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.dir).toBe(path.join(await fs.realpath(root), "out", "run-1"));
    expect((await fs.stat(nested.dir)).isDirectory()).toBe(true);
  });

  it("refuses a lexical escape without creating anything", async () => {
    const root = await makeTempDir();
    const sibling = path.join(path.dirname(root), path.basename(root) + "-escaped");

    const result = await resolveSaveDir(root, `../${path.basename(sibling)}`, "dir");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.class).toBe("input_domain");
    expect(result.error.location).toBe("dir");
    await expect(fs.stat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlink inside the workspace that points outside it — before mkdir", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir("pipelex-boundary-outside-");
    await fs.symlink(outside, path.join(root, "link"));

    const result = await resolveSaveDir(root, "link/sub", "dir");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.location).toBe("dir");
    expect(result.error.message).toContain("outside");
    // The escape was caught on the deepest existing ancestor: nothing was
    // created at the link's target.
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses a dir that is an existing regular file", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "notes.txt"), "x", "utf8");

    const result = await resolveSaveDir(root, "notes.txt", "dir");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.location).toBe("dir");
  });

  it("locates its refusals at the caller's own field name", async () => {
    const root = await makeTempDir();

    const result = await resolveSaveDir(root, "../escaped", "output_dir");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.location).toBe("output_dir");
    expect(result.error.message).toContain("output_dir");
  });
});
