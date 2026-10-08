import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LINK_FILE_NAME,
  LinkLockError,
  buildMethodLink,
  linkLockFile,
  readMethodLink,
  withLinkLock,
} from "./catalog-link.js";

const MODULE_PATH = fileURLToPath(new URL("./catalog-link.ts", import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), "..", "..");

let root: string;
let savedTmpdir: string | undefined;

// Each test keeps its lock under a temp directory of its own: `os.tmpdir()`
// reads TMPDIR on every call, so no test contends with another file's writes.
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-link-lock-"));
  savedTmpdir = process.env.TMPDIR;
  await fs.mkdir(path.join(root, "tmp"));
  process.env.TMPDIR = path.join(root, "tmp");
});

afterEach(async () => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  await fs.rm(root, { recursive: true, force: true });
});

/** Another connection to the lock, holding its transaction as another process would. */
async function holdElsewhere(): Promise<DatabaseSync> {
  await withLinkLock(async () => undefined);
  const other = new DatabaseSync(linkLockFile(), { timeout: 0 });
  other.exec("BEGIN EXCLUSIVE");
  return other;
}

describe("withLinkLock, the lock every workshop process takes to write", () => {
  it("waits while another holder has it, then runs", async () => {
    const other = await holdElsewhere();
    const order: string[] = [];
    setTimeout(() => {
      order.push("released");
      other.exec("COMMIT");
    }, 60);

    await withLinkLock(async () => {
      order.push("ran");
    });

    expect(order).toEqual(["released", "ran"]);
    other.close();
  });

  it("refuses, running nothing, when the holder outlasts the wait", async () => {
    const other = await holdElsewhere();
    let ran = false;

    const refused = await withLinkLock(
      async () => {
        ran = true;
      },
      { waitMs: 40 },
    ).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(LinkLockError);
    expect((refused as LinkLockError).busy).toBe(true);
    expect(ran).toBe(false);
    other.exec("COMMIT");
    other.close();
  });

  it("is free the moment a holder's process dies, with nothing to judge abandoned", async () => {
    // Round 4: a lock written as a file had to be judged abandoned and broken,
    // and two processes breaking one at once could each let a writer in.
    await withLinkLock(async () => undefined);
    const holder = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { DatabaseSync } = require("node:sqlite");',
          "const lock = new DatabaseSync(process.argv[1], { timeout: 0 });",
          'lock.exec("BEGIN EXCLUSIVE");',
          'process.stdout.write("holding\\n");',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        linkLockFile(),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve) => {
      holder.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("holding")) resolve();
      });
    });

    let killedAt = 0;
    setTimeout(() => {
      killedAt = Date.now();
      holder.kill("SIGKILL");
    }, 80);
    const acquiredAt = await withLinkLock(async () => Date.now(), { waitMs: 5_000 });

    expect(killedAt).toBeGreaterThan(0);
    expect(acquiredAt).toBeGreaterThanOrEqual(killedAt);
  });

  it.skipIf(typeof process.getuid !== "function")(
    "keeps its directory private to the user, and refuses one it cannot trust",
    async () => {
      const dir = path.dirname(linkLockFile());
      await fs.mkdir(dir, { mode: 0o755 });
      await fs.chmod(dir, 0o755);

      await withLinkLock(async () => undefined);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);

      // A shared temp directory where the name is already something else.
      process.env.TMPDIR = path.join(root, "elsewhere");
      await fs.mkdir(process.env.TMPDIR);
      await fs.symlink(dir, path.dirname(linkLockFile()));
      const refused = await withLinkLock(async () => undefined).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(LinkLockError);
      expect((refused as LinkLockError).busy).toBe(false);
    },
  );

  it("loses no compare-and-swap between two real workshop processes", async () => {
    // Round 3: without the lock, two processes swapping one link lost about
    // half their swaps to each other — each compared, then each wrote — which
    // is how a version pull from a second process landed between a save's
    // compare and its write and the next save replaced the draft with it.
    const dir = path.join(root, "work");
    await fs.mkdir(dir);
    const link = buildMethodLink({
      apiHost: "api-dev.pipelex.com",
      methodId: "mt_one",
      name: "0",
      syncedUpdatedAt: "T0",
    });
    await fs.writeFile(
      path.join(dir, LINK_FILE_NAME),
      `${JSON.stringify(link, null, 2)}\n`,
      "utf8",
    );
    const script = path.join(root, "swap.mts");
    await fs.writeFile(
      script,
      [
        `import { buildMethodLink, inLinkTurn, readMethodLink, replaceMethodLink, withLinkLock } from ${JSON.stringify(pathToFileURL(MODULE_PATH).href)};`,
        "const [dir, countText] = process.argv.slice(2);",
        "let done = 0;",
        "while (done < Number(countText)) {",
        "  const swapped = await inLinkTurn(() => withLinkLock(async () => {",
        "    const read = await readMethodLink(dir);",
        '    if (read.kind !== "link") throw new Error("the link is gone");',
        '    const next = buildMethodLink({ apiHost: "api-dev.pipelex.com", methodId: "mt_one", name: String(Number(read.link.name) + 1), syncedUpdatedAt: "T0" });',
        "    return !(await replaceMethodLink(dir, dir, read, next)).changed;",
        "  }));",
        "  if (swapped) done += 1;",
        "}",
      ].join("\n"),
      "utf8",
    );
    const swaps = 150;
    const run = () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, dir, String(swaps)], {
          cwd: REPO_ROOT,
          env: process.env,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`swap process exited ${code}: ${stderr}`)),
        );
      });

    await Promise.all([run(), run()]);

    const final = await readMethodLink(dir);
    expect(final.kind === "link" ? final.link.name : final.kind).toBe(String(2 * swaps));
  }, 60_000);
});
