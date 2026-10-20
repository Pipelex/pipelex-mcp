import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LINK_DIRECTORY_NAME,
  LINK_FILE_NAME,
  LinkLockError,
  NO_LINK,
  buildMethodLink,
  linkLockFile,
  readMethodLink,
  replaceMethodLink,
  withLinkLock,
} from "./catalog-link.js";

const MODULE_PATH = fileURLToPath(new URL("./catalog-link.ts", import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), "..", "..");

let root: string;
let savedHome: string | undefined;
let savedTmpdir: string | undefined;

// Each test keeps its lock under a home directory of its own: `os.homedir()`
// reads HOME on every call, so no test contends with another file's writes,
// and none writes into the real home directory.
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-link-lock-"));
  savedHome = process.env.HOME;
  savedTmpdir = process.env.TMPDIR;
  process.env.HOME = path.join(root, "home");
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
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

  it.skipIf(process.platform === "win32")(
    "keeps the lock under the home directory, whatever the temp directory is",
    async () => {
      // Under the temp directory, two processes of one user with two TMPDIRs
      // computed two lock files, and excluded nothing.
      process.env.TMPDIR = path.join(root, "one-tmp");
      const first = linkLockFile();
      process.env.TMPDIR = path.join(root, "another-tmp");

      await withLinkLock(async () => undefined);

      expect(linkLockFile()).toBe(first);
      expect(first).toBe(
        path.join(root, "home", ".local", "state", "pipelex-mcp", "write-lock.sqlite"),
      );
      expect((await fs.stat(first)).isFile()).toBe(true);
    },
  );

  it.skipIf(typeof process.getuid !== "function")(
    "keeps its directory private to the user, and refuses one it cannot trust",
    async () => {
      const dir = path.dirname(linkLockFile());
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await fs.mkdir(dir, { mode: 0o755 });
      await fs.chmod(dir, 0o755);

      await withLinkLock(async () => undefined);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);

      // A home directory where the name is already something else.
      process.env.HOME = path.join(root, "elsewhere");
      await fs.mkdir(path.dirname(path.dirname(linkLockFile())), { recursive: true });
      await fs.symlink(dir, path.dirname(linkLockFile()));
      const refused = await withLinkLock(async () => undefined).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(LinkLockError);
      expect((refused as LinkLockError).busy).toBe(false);
    },
  );

  it("reopens a lock file deleted since its last hold, so it still excludes a process started after", async () => {
    // A temp cleaner deleted the file under a process holding a kept
    // connection to it, which then locked the deleted file while every process
    // started later created a new one and locked that: the two excluded nothing.
    await withLinkLock(async () => undefined);
    await fs.rm(linkLockFile());
    const other = new DatabaseSync(linkLockFile(), { timeout: 0 });
    other.exec("BEGIN EXCLUSIVE");
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

  it("refuses a damaged lock file by name, and takes the lock once it is removed", async () => {
    // A connection that failed with anything but busy stayed kept for the
    // life of the process, and the refusal did not say which file to fix.
    const file = linkLockFile();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, "this is not a SQLite database. ".repeat(20), "utf8");

    const refused = await withLinkLock(async () => undefined).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(LinkLockError);
    expect((refused as LinkLockError).busy).toBe(false);
    expect((refused as LinkLockError).message).toContain(file);
    expect((refused as LinkLockError).message).toContain("remove that file if it is damaged");

    await fs.rm(file);
    await expect(withLinkLock(async () => "ran")).resolves.toBe("ran");
  });

  it("loses no compare-and-swap between two real workshop processes", async () => {
    // Round 3: without the lock, two processes swapping one link lost about
    // half their swaps to each other — each compared, then each wrote — which
    // is how a version pull from a second process landed between a save's
    // compare and its write and the next save replaced the draft with it.
    const dir = path.join(root, "work");
    await fs.mkdir(path.join(dir, LINK_DIRECTORY_NAME), { recursive: true });
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

describe("the link file lives in the folder's .pipelex directory", () => {
  const link = buildMethodLink({
    apiHost: "api-dev.pipelex.com",
    methodId: "mt_one",
    name: "Summarize PDF",
    syncedUpdatedAt: "T0",
  });

  it("is named .pipelex/method.json, outside every method tree", () => {
    // A segment starting with a dot is never a member of a method tree, so the
    // link is never saved as one of the method's files.
    expect(LINK_FILE_NAME).toBe(".pipelex/method.json");
  });

  it("makes .pipelex when it is missing, and reads back what it wrote", async () => {
    const dir = path.join(root, "work");
    await fs.mkdir(dir);

    const replaced = await replaceMethodLink(root, dir, NO_LINK, link);

    expect(replaced.report).toEqual({
      path: path.join("work", ".pipelex", "method.json"),
      written: true,
    });
    expect((await fs.lstat(path.join(dir, ".pipelex"))).isDirectory()).toBe(true);
    const read = await readMethodLink(dir);
    expect(read.kind === "link" ? read.link.method_id : read.kind).toBe("mt_one");
  });

  it("reads a folder without .pipelex as unlinked", async () => {
    const dir = path.join(root, "work");
    await fs.mkdir(dir);

    expect(await readMethodLink(dir)).toEqual({ kind: "none" });
  });

  it("never reads or writes through a .pipelex that is a symlink", async () => {
    const dir = path.join(root, "work");
    const elsewhere = path.join(root, "elsewhere");
    await fs.mkdir(dir);
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "method.json"), `${JSON.stringify(link)}\n`, "utf8");
    await fs.symlink(elsewhere, path.join(dir, ".pipelex"));

    const read = await readMethodLink(dir);
    expect(read.kind).toBe("unreadable");
    expect(read.kind === "unreadable" ? read.reason : "").toContain("is a symlink");

    const replaced = await replaceMethodLink(root, dir, read, link);
    expect(replaced.report.written).toBe(false);
    expect(await fs.readFile(path.join(elsewhere, "method.json"), "utf8")).toBe(
      `${JSON.stringify(link)}\n`,
    );
  });

  it("reads a .pipelex that is a file as unreadable, and leaves it alone", async () => {
    const dir = path.join(root, "work");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, ".pipelex"), "something else\n", "utf8");

    const read = await readMethodLink(dir);
    expect(read).toEqual({ kind: "unreadable", reason: "`.pipelex` is not a directory" });
    expect((await replaceMethodLink(root, dir, read, link)).report.written).toBe(false);
    expect(await fs.readFile(path.join(dir, ".pipelex"), "utf8")).toBe("something else\n");
  });
});
