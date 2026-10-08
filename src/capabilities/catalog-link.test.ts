import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LINK_FILE_NAME,
  LinkLockError,
  buildMethodLink,
  linkLockPath,
  readMethodLink,
  withLinkLock,
} from "./catalog-link.js";

const MODULE_PATH = fileURLToPath(new URL("./catalog-link.ts", import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(MODULE_PATH), "..", "..");

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-link-lock-"));
});

afterEach(async () => {
  await fs.rm(await linkLockPath(root), { force: true });
  await fs.rm(root, { recursive: true, force: true });
});

/** Stand in for another workshop process holding the lock of `dir`. */
async function holdAs(dir: string, holder: { pid: number; at?: number }): Promise<string> {
  const lockPath = await linkLockPath(dir);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid: holder.pid,
      host: os.hostname(),
      at: holder.at ?? Date.now(),
      nonce: "other",
    }),
    "utf8",
  );
  return lockPath;
}

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  if (child.pid === undefined) throw new Error("the child process had no pid");
  return child.pid;
}

describe("withLinkLock, the lock other workshop processes take", () => {
  it("waits while another live process holds the directory, then runs", async () => {
    const lockPath = await holdAs(root, { pid: process.ppid });
    const order: string[] = [];
    setTimeout(() => {
      order.push("released");
      void fs.rm(lockPath, { force: true });
    }, 60);

    await withLinkLock(root, async () => {
      order.push("ran");
    });

    expect(order).toEqual(["released", "ran"]);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("refuses, running nothing, when the holder outlasts the wait", async () => {
    await holdAs(root, { pid: process.ppid });
    let ran = false;

    await expect(
      withLinkLock(
        root,
        async () => {
          ran = true;
        },
        { waitMs: 40 },
      ),
    ).rejects.toBeInstanceOf(LinkLockError);
    expect(ran).toBe(false);
  });

  it("breaks a lock whose holder's process is gone", async () => {
    await holdAs(root, { pid: await deadPid() });

    await expect(withLinkLock(root, async () => "ran", { waitMs: 40 })).resolves.toBe("ran");
  });

  it("breaks a lock held far longer than any write takes", async () => {
    await holdAs(root, { pid: process.ppid, at: Date.now() - 60_000 });

    await expect(withLinkLock(root, async () => "ran", { waitMs: 40 })).resolves.toBe("ran");
  });

  it("gives two spellings of one directory one lock", async () => {
    const real = path.join(root, "work");
    await fs.mkdir(real);
    await fs.symlink(real, path.join(root, "alias"));

    expect(await linkLockPath(path.join(root, "alias"))).toBe(await linkLockPath(real));
    expect(await linkLockPath(path.join(root, "work", "not-yet"))).toBe(
      await linkLockPath(path.join(root, "alias", "not-yet")),
    );
  });

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
        "  const swapped = await inLinkTurn(() => withLinkLock(dir, async () => {",
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
