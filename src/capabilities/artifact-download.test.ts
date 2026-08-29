import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { downloadArtifactToFile, openUniqueFile, writeFully } from "./artifact-download.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-artifact-download-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * A real loopback http server: the boundary accepts plain http on purpose (the
 * local stack's object store hands out http presigned links), and exercising
 * the real `fetch` → stream → file path is what proves the cap and the cleanup
 * hold on the wire rather than on a stubbed body.
 */
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("writeFully", () => {
  it("loops on short writes until the whole chunk is on disk", async () => {
    const calls: Array<[number, number]> = [];
    const writer = {
      write: async (_buffer: Uint8Array, offset: number, length: number) => {
        calls.push([offset, length]);
        return { bytesWritten: Math.min(length, 3) };
      },
    };

    await writeFully(writer, new Uint8Array(8));

    expect(calls).toEqual([
      [0, 8],
      [3, 5],
      [6, 2],
    ]);
  });

  it("fails rather than spin when the filesystem accepts nothing", async () => {
    const writer = { write: async () => ({ bytesWritten: 0 }) };

    await expect(writeFully(writer, new Uint8Array(4))).rejects.toThrow(/accepted no bytes/);
  });
});

describe("openUniqueFile", () => {
  it("creates the requested name when free and suffixes the stem on collision", async () => {
    const dir = await makeTempDir();

    const first = await openUniqueFile(dir, "picture.png");
    await first.handle.close();
    const second = await openUniqueFile(dir, "picture.png");
    await second.handle.close();
    const third = await openUniqueFile(dir, "picture.png");
    await third.handle.close();

    expect(path.basename(first.path)).toBe("picture.png");
    expect(path.basename(second.path)).toBe("picture-1.png");
    expect(path.basename(third.path)).toBe("picture-2.png");
  });

  it("suffixes a name with no extension too", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "report"), "existing", "utf8");

    const opened = await openUniqueFile(dir, "report");
    await opened.handle.close();

    expect(path.basename(opened.path)).toBe("report-1");
    // Never overwritten.
    await expect(fs.readFile(path.join(dir, "report"), "utf8")).resolves.toBe("existing");
  });
});

describe("downloadArtifactToFile", () => {
  it("streams a 200 body into a new file under the directory", async () => {
    const dir = await makeTempDir();
    const origin = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG_BYTES.byteLength });
      res.end(Buffer.from(PNG_BYTES));
    });

    const result = await downloadArtifactToFile(`${origin}/obj?sig=abc`, dir, "picture.png");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.saved.path).toBe(path.join(dir, "picture.png"));
    expect(result.saved.size).toBe(PNG_BYTES.byteLength);
    expect(new Uint8Array(await fs.readFile(result.saved.path))).toEqual(PNG_BYTES);
  });

  it("never overwrites an existing file — the second download gets a suffix", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "picture.png"), "keep me", "utf8");
    const origin = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(PNG_BYTES));
    });

    const result = await downloadArtifactToFile(`${origin}/obj`, dir, "picture.png");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.basename(result.saved.path)).toBe("picture-1.png");
    await expect(fs.readFile(path.join(dir, "picture.png"), "utf8")).resolves.toBe("keep me");
  });

  it("refuses a declared oversize from the headers, writing nothing", async () => {
    const dir = await makeTempDir();
    const origin = await serve((_req, res) => {
      res.writeHead(200, { "content-length": 1024 });
      res.end(Buffer.alloc(1024));
    });

    const result = await downloadArtifactToFile(`${origin}/obj`, dir, "big.bin", { maxBytes: 100 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.class).toBe("input_domain");
    expect(result.failure.retryable).toBe(false);
    expect(result.failure.message).toContain("limit");
    expect(result.failure.message).toContain("MiB");
    // Refused from the headers: no file was ever opened.
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("removes the partial file when a lying content-length passes the cap mid-stream", async () => {
    const dir = await makeTempDir();
    const origin = await serve((_req, res) => {
      // Declares a small body, sends a large one (chunked, no content-length).
      res.writeHead(200);
      res.write(Buffer.alloc(80));
      res.write(Buffer.alloc(80));
      res.end();
    });

    const result = await downloadArtifactToFile(`${origin}/obj`, dir, "liar.bin", {
      maxBytes: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.class).toBe("input_domain");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses a redirect outright", async () => {
    const dir = await makeTempDir();
    const origin = await serve((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" });
      res.end();
    });

    const result = await downloadArtifactToFile(`${origin}/obj`, dir, "moved.bin");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain("redirected");
    expect(result.failure.retryable).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("classifies a 404 as a vanished object and a 5xx as a retryable fault", async () => {
    const dir = await makeTempDir();
    const origin = await serve((req, res) => {
      res.writeHead(req.url === "/gone" ? 404 : 503);
      res.end();
    });

    const gone = await downloadArtifactToFile(`${origin}/gone`, dir, "gone.bin");
    const fault = await downloadArtifactToFile(`${origin}/fault`, dir, "fault.bin");

    expect(gone.ok).toBe(false);
    if (gone.ok) return;
    expect(gone.failure.class).toBe("input_domain");
    expect(gone.failure.retryable).toBe(false);

    expect(fault.ok).toBe(false);
    if (fault.ok) return;
    expect(fault.failure.class).toBe("runtime");
    expect(fault.failure.retryable).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses a link that is not http(s) before any request", async () => {
    const dir = await makeTempDir();

    const fileLink = await downloadArtifactToFile("file:///etc/passwd", dir, "passwd");
    const garbage = await downloadArtifactToFile("not a url", dir, "x");

    expect(fileLink.ok).toBe(false);
    if (fileLink.ok) return;
    expect(fileLink.failure.class).toBe("runtime");
    expect(fileLink.failure.message).toContain("file");
    expect(garbage.ok).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("refuses a link carrying credentials", async () => {
    const dir = await makeTempDir();

    const result = await downloadArtifactToFile("https://user:pw@example.com/obj", dir, "x");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain("credentials");
  });

  it("reports an unreachable host as a retryable network fault", async () => {
    const dir = await makeTempDir();
    // A listening-then-closed port: connection refused, promptly.
    const origin = await serve(() => {});
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    const result = await downloadArtifactToFile(`${origin}/obj`, dir, "x.bin");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.class).toBe("runtime");
    expect(result.failure.retryable).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
