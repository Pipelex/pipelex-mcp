import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCodegenCheck } from "@pipelex/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { recordedTsZodReport } from "./codegen-fixture.js";
import { MAX_WALK_BYTES, MAX_WALK_CANDIDATES, writeCodegenTree } from "./codegen-writer.js";
import type { CodegenWriteRequest, CodegenWriteResult } from "./codegen-writer.js";

/**
 * No fakes here: the writer's whole job is what lands on a real filesystem, so
 * every case runs against a real `mkdtemp` working directory with the REAL
 * recorded engine response. `runCodegenCheck` verifies content hashes, so a
 * hand-written artifact set could not reach a `current` verdict at all — the
 * recording is what makes "the tree checks out" an assertion rather than a
 * hope.
 */

const report = await recordedTsZodReport();

/** Permission-driven cases cannot bite as root, so they are skipped there rather than made vacuous. */
const asRoot = process.getuid?.() === 0;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = "pipelex-codegen-writer-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function request(root: string, overrides: Partial<CodegenWriteRequest> = {}): CodegenWriteRequest {
  return {
    root,
    outputDir: "generated",
    artifacts: report.artifacts,
    lock: report.lock,
    lockFilename: report.lock_filename,
    ...overrides,
  };
}

function expectOk(result: CodegenWriteResult) {
  if (!result.ok) {
    throw new Error(`expected a successful write, got: ${result.error.message}`);
  }
  return result;
}

/** Every path under `dir`, relative and sorted — the "was anything created" assertion. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      found.push(path.relative(dir, absolute));
      if (entry.isDirectory()) {
        await visit(absolute);
      }
    }
  };
  await visit(dir);
  return found.sort();
}

describe("writeCodegenTree — the happy path", () => {
  it("creates the directory and writes every artifact and the lock, verbatim and current", async () => {
    const root = await makeTempDir();

    const result = expectOk(await writeCodegenTree(request(root)));

    expect(result.dir).toBe("generated");
    expect(result.isCurrent).toBe(true);
    expect(result.orphans).toEqual([]);
    expect(result.orphansTruncated).toBe(false);
    expect(result.drifts).toEqual([]);
    expect(result.written.map((artifact) => artifact.path).sort()).toEqual(
      report.artifacts.map((artifact) => artifact.path).sort(),
    );
    expect(result.written.map((artifact) => artifact.writtenTo).sort()).toEqual(
      report.artifacts.map((artifact) => path.join("generated", artifact.path)).sort(),
    );
    expect(result.lock.writtenTo).toBe(path.join("generated", "codegen.lock"));

    for (const artifact of report.artifacts) {
      expect(await fs.readFile(path.join(root, "generated", artifact.path), "utf8")).toBe(
        artifact.content,
      );
    }
    expect(await fs.readFile(path.join(root, "generated", "codegen.lock"), "utf8")).toBe(
      report.lock,
    );
  });

  it("creates a nested output_dir and reports written_to relative to the working directory", async () => {
    const root = await makeTempDir();

    const result = expectOk(
      await writeCodegenTree(request(root, { outputDir: "src/generated/demo" })),
    );

    expect(result.dir).toBe(path.join("src", "generated", "demo"));
    expect(result.written[0]?.writtenTo.startsWith(path.join("src", "generated", "demo"))).toBe(
      true,
    );
    expect(result.isCurrent).toBe(true);
  });

  it("accepts the working directory itself as output_dir", async () => {
    const root = await makeTempDir();

    const result = expectOk(await writeCodegenTree(request(root, { outputDir: "." })));

    expect(result.dir).toBe(".");
    expect(result.isCurrent).toBe(true);
  });

  it("writes a tree the SDK's own check independently reports current", async () => {
    const root = await makeTempDir();

    expectOk(await writeCodegenTree(request(root)));

    const dir = path.join(root, "generated");
    const check = await runCodegenCheck({
      lockContent: await fs.readFile(path.join(dir, "codegen.lock"), "utf8"),
      files: await Promise.all(
        report.artifacts.map(async (artifact) => ({
          path: artifact.path,
          content: await fs.readFile(path.join(dir, artifact.path), "utf8"),
        })),
      ),
    });

    expect(check.isCurrent).toBe(true);
    expect(check.crateFingerprint).toBe(report.crate_fingerprint);
  });
});

describe("writeCodegenTree — overwriting its own output", () => {
  it("overwrites a stamped .ts artifact and the engine's lock", async () => {
    const root = await makeTempDir();

    expectOk(await writeCodegenTree(request(root)));
    // A second generation into the same directory is the ordinary case, and
    // the inverse of the download tool's never-overwrite rule.
    const again = expectOk(await writeCodegenTree(request(root)));

    expect(again.isCurrent).toBe(true);
    expect(again.orphans).toEqual([]);
  });

  it("overwrites a stamped file whose body was hand-edited, without warning", async () => {
    const root = await makeTempDir();
    expectOk(await writeCodegenTree(request(root)));
    const target = path.join(root, "generated", report.artifacts[0]!.path);
    await fs.appendFile(target, "\n// a formatter ran over this directory\n", "utf8");

    const again = expectOk(await writeCodegenTree(request(root)));

    // The stamp says not to edit by hand; edits below it are discarded. A
    // formatter run over the generated directory must not become a permanent
    // block on regeneration.
    expect(again.isCurrent).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe(report.artifacts[0]!.content);
  });

  it("overwrites a lock whose header prose was reworded but keeps the `# codegen.lock` prefix", async () => {
    const root = await makeTempDir();
    expectOk(await writeCodegenTree(request(root)));
    const lockPath = path.join(root, "generated", "codegen.lock");
    await fs.writeFile(
      lockPath,
      report.lock.replace(/^#[^\n]*/, "# codegen.lock (regenerate with the Pipelex CLI)"),
      "utf8",
    );

    const again = expectOk(await writeCodegenTree(request(root)));

    expect(again.isCurrent).toBe(true);
    expect(await fs.readFile(lockPath, "utf8")).toBe(report.lock);
  });
});

describe("writeCodegenTree — the containment boundary", () => {
  it("refuses a `..` escape without creating anything", async () => {
    const root = await makeTempDir();
    const sibling = path.join(path.dirname(root), `${path.basename(root)}-escaped`);

    const result = await writeCodegenTree(request(root, { outputDir: "../escaped" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ class: "input_domain", location: "output_dir" });
    await expect(fs.stat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await tree(root)).toEqual([]);
  });

  it("refuses an absolute output_dir", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir("pipelex-codegen-outside-");

    const result = await writeCodegenTree(request(root, { outputDir: outside }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.location).toBe("output_dir");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses a symlinked ancestor pointing outside, before mkdir", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir("pipelex-codegen-outside-");
    await fs.symlink(outside, path.join(root, "link"));

    const result = await writeCodegenTree(request(root, { outputDir: "link/generated" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.location).toBe("output_dir");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("refuses an artifact path the API returned that leaves the generated directory", async () => {
    const root = await makeTempDir();

    const result = await writeCodegenTree(
      request(root, { artifacts: [{ path: "../escaped.ts", content: "// x\n" }] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The path came from the API, not from the caller — a runtime no-verdict.
    expect(result.error.class).toBe("runtime");
    expect(await tree(root)).toEqual(["generated"]);
  });

  it("creates no sub-directory when a later destination escapes", async () => {
    const root = await makeTempDir();

    const result = await writeCodegenTree(
      request(root, {
        artifacts: [
          { path: "models/types.ts", content: "// a\n" },
          { path: "../escaped.ts", content: "// b\n" },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Containment runs over EVERY destination before anything is created, so
    // the refusal leaves the tree byte-identical — directories included. This
    // is what separating `isInsideRoot` from `resolveSaveDir` buys.
    expect(await tree(root)).toEqual(["generated"]);
  });

  it("refuses a lock filename that leaves the generated directory", async () => {
    const root = await makeTempDir();

    const result = await writeCodegenTree(request(root, { lockFilename: "../codegen.lock" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.class).toBe("runtime");
    await expect(fs.stat(path.join(root, "codegen.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("writeCodegenTree — refusing foreign files", () => {
  it("refuses an unstamped artifact destination, leaving the directory byte-identical", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    const hand = path.join(dir, report.artifacts[0]!.path);
    await fs.writeFile(hand, "export const mine = 1;\n", "utf8");

    const before = await tree(root);
    const result = await writeCodegenTree(request(root));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ class: "input_domain", location: "output_dir" });
    expect(result.error.message).toContain(report.artifacts[0]!.path);
    // Nothing was written — not one of the OTHER artifacts either, which is
    // what "whole tree or nothing" means on the refusal path.
    expect(await tree(root)).toEqual(before);
    expect(await fs.readFile(hand, "utf8")).toBe("export const mine = 1;\n");
  });

  it("refuses a symlink at a destination rather than writing through it", async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir("pipelex-codegen-outside-");
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    const decoy = path.join(outside, "stolen.ts");
    await fs.writeFile(decoy, "// untouched\n", "utf8");
    await fs.symlink(decoy, path.join(dir, report.artifacts[0]!.path));

    const result = await writeCodegenTree(request(root));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.location).toBe("output_dir");
    expect(result.error.message).toContain("symlink");
    // `lstat`, not `stat`: the link target is what an overwrite would have hit.
    expect(await fs.readFile(decoy, "utf8")).toBe("// untouched\n");
  });

  it("refuses a directory sitting at a destination", async () => {
    const root = await makeTempDir();
    await fs.mkdir(path.join(root, "generated", report.artifacts[0]!.path), { recursive: true });

    const result = await writeCodegenTree(request(root));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("not a regular file");
  });

  it("refuses a user's TOML file that happens to be named codegen.lock", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "codegen.lock"), 'mine = "yes"\n', "utf8");

    const result = await writeCodegenTree(request(root));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ class: "input_domain", location: "output_dir" });
    expect(result.error.message).toContain("codegen.lock");
    expect(await fs.readFile(path.join(dir, "codegen.lock"), "utf8")).toBe('mine = "yes"\n');
  });

  it.skipIf(asRoot)("surfaces a non-ENOENT inspection failure as runtime", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, report.artifacts[0]!.path);
    await fs.writeFile(target, report.artifacts[0]!.content, "utf8");
    await fs.chmod(target, 0o000);

    try {
      const result = await writeCodegenTree(request(root));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Unreadable is not the same as foreign: the caller is not told their
      // directory holds someone else's file.
      expect(result.error.class).toBe("runtime");
    } finally {
      await fs.chmod(target, 0o644);
    }
  });
});

describe("writeCodegenTree — the post-write check", () => {
  it("reports a stamped file the lock does not track as an orphan, and leaves it on disk", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    // A stamped artifact from an earlier generation — same stamp syntax, a
    // name this lock does not list.
    const stale = path.join(dir, "models.py");
    await fs.writeFile(
      stale,
      ["# >>> pipelex-codegen-stamp >>>", "# <<< pipelex-codegen-stamp <<<", "x = 1", ""].join(
        "\n",
      ),
      "utf8",
    );

    const result = expectOk(await writeCodegenTree(request(root)));

    expect(result.orphans).toEqual(["models.py"]);
    expect(result.isCurrent).toBe(false);
    expect(result.drifts).toEqual([]);
    // D7: reported, never deleted.
    expect(await fs.stat(stale)).toBeDefined();
  });

  it("ignores an unstamped sibling file entirely", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "index.ts"), "export * from './types.js';\n", "utf8");

    const result = expectOk(await writeCodegenTree(request(root)));

    expect(result.orphans).toEqual([]);
    expect(result.isCurrent).toBe(true);
  });

  it("does not count a stamped file inside a pruned directory as an orphan", async () => {
    const root = await makeTempDir();
    const buried = path.join(root, "generated", "node_modules", "pkg");
    await fs.mkdir(buried, { recursive: true });
    await fs.writeFile(
      path.join(buried, "vendored.ts"),
      ["// >>> pipelex-codegen-stamp >>>", "// <<< pipelex-codegen-stamp <<<", ""].join("\n"),
      "utf8",
    );

    const result = expectOk(await writeCodegenTree(request(root)));

    expect(result.orphans).toEqual([]);
    expect(result.orphansTruncated).toBe(false);
    expect(result.isCurrent).toBe(true);
  });

  it("trips orphansTruncated on the entry bound rather than reporting a clean tree", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_WALK_CANDIDATES + 5 }, (_, index) =>
        fs.writeFile(
          path.join(dir, `noise-${String(index).padStart(4, "0")}.ts`),
          "// x\n",
          "utf8",
        ),
      ),
    );

    const result = expectOk(await writeCodegenTree(request(root)));

    expect(result.orphansTruncated).toBe(true);
    // The locked files are read back outside the bounds, so a tripped bound
    // never fabricates a `missing` drift for them.
    expect(result.drifts).toEqual([]);
  });

  it("trips orphansTruncated on the byte budget", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    const big = "// ".repeat(400_000);
    for (let index = 0; index < 6; index += 1) {
      await fs.writeFile(path.join(dir, `bulk-${index}.ts`), big, "utf8");
    }

    const result = expectOk(await writeCodegenTree(request(root)));

    expect(result.orphansTruncated).toBe(true);
    expect(result.drifts).toEqual([]);
  });

  it("refuses a single over-budget file without reading it", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    // Over the budget on its own AND undecodable: reading it would return the
    // `undecodableError` no-verdict, so a produced verdict proves the guard
    // refused it from its size, before the bytes were ever allocated.
    const oversize = Buffer.concat([
      Buffer.from("// ".repeat(MAX_WALK_BYTES), "utf8"),
      Buffer.from([0xff, 0xfe]),
    ]);
    await fs.writeFile(path.join(dir, "huge.ts"), oversize);

    const result = expectOk(await writeCodegenTree(request(root)));

    expect(result.orphansTruncated).toBe(true);
    expect(result.orphans).toEqual([]);
    expect(result.drifts).toEqual([]);
  });

  it("surfaces a stampable file that is not valid UTF-8 rather than reporting a false current", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "corrupt.py"), Buffer.from([0x23, 0xff, 0xfe, 0x0a]));

    const result = await writeCodegenTree(request(root));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `readFile(p, "utf8")` would have substituted U+FFFD and reported current.
    expect(result.error.class).toBe("runtime");
    expect(result.error.message).toContain("corrupt.py");
  });

  it("surfaces a corrupt lock as a runtime no-verdict, with the files left on disk", async () => {
    const root = await makeTempDir();

    const result = await writeCodegenTree(
      request(root, { lock: "# codegen.lock\nthis is not toml = = =\n" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.class).toBe("runtime");
    expect(result.error.message).toContain("lock");
    // The write happened; only the verification failed, so the tree is on disk
    // and the message says to check it.
    expect(result.error.hint).toContain("pipelex codegen check");
    expect(await fs.readFile(path.join(root, "generated", "codegen.lock"), "utf8")).toContain(
      "not toml",
    );
  });
});

describe("writeCodegenTree — a failure mid-write", () => {
  it.skipIf(asRoot)("reports runtime naming what landed, with the retry hint", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    // The second destination is a stamped file this tool owns — so inspection
    // passes it — but it is read-only, so the write fails after the first
    // artifact has already landed.
    const second = path.join(dir, report.artifacts[1]!.path);
    await fs.writeFile(second, report.artifacts[1]!.content, "utf8");
    await fs.chmod(second, 0o444);

    try {
      const result = await writeCodegenTree(request(root));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.class).toBe("runtime");
      expect(result.error.message).toContain(report.artifacts[0]!.path);
      expect(result.error.retryable).toBe(true);
      // Regeneration overwrites its own files, so the retry finds the stamped
      // file it left and proceeds.
      expect(result.error.hint).toContain("same output_dir");
    } finally {
      await fs.chmod(second, 0o644);
    }
  });
});

describe("writeCodegenTree — sub-directory artifacts", () => {
  it("creates and contains a nested artifact path", async () => {
    const root = await makeTempDir();
    // No target emits a nested artifact today; this is what keeps the
    // containment true if one starts to. The lock is regenerated below so the
    // check still has something coherent to say about the tree.
    const nested = { path: "models/types.ts", content: report.artifacts[0]!.content };

    const result = await writeCodegenTree(request(root, { artifacts: [nested] }));

    // The lock does not list `models/types.ts`, so the verdict is not current —
    // what this case pins is that the file landed, contained, inside the tree.
    expectOk(result);
    expect(await fs.readFile(path.join(root, "generated", "models", "types.ts"), "utf8")).toBe(
      nested.content,
    );
  });
});
