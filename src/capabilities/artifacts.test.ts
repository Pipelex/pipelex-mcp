import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type { ResolvedStorageUrl, RunResultState } from "@pipelex/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { openUniqueFile } from "./artifact-download.js";
import type { ArtifactDownloadResult, ArtifactDownloader } from "./artifact-download.js";
import {
  artifactFilename,
  artifactsToolResult,
  downloadMthdsArtifacts,
  validateArtifactsRequest,
} from "./artifacts.js";
import type { ArtifactClient, ArtifactsContext } from "./artifacts.js";
import { DEFAULT_API_URL } from "./shared.js";

const RUN_ID = "01JRUN0000000000000000TEST";
const PICTURE_URI = "pipelex-storage://runs/01JRUN/outputs/illustration.png";
const REPORT_URI = "pipelex-storage://runs/01JRUN/outputs/report";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = "pipelex-artifacts-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function completedState(mainStuff: unknown): RunResultState {
  return {
    state: "completed",
    pipeline_run_id: RUN_ID,
    result: { pipeline_run_id: RUN_ID, main_stuff: mainStuff },
  };
}

/** A client whose run is completed with `mainStuff` and resolves every URI to a link. */
function fakeClient(
  state: RunResultState,
  resolve: (uri: string) => Promise<ResolvedStorageUrl> = (uri) =>
    Promise.resolve({
      url: `https://bucket.example/${encodeURIComponent(uri)}?sig=x`,
      expires_at: "2026-08-29T12:00:00Z",
      content_type: uri.endsWith(".png") ? "image/png" : "application/pdf",
    }),
) {
  const resolved: string[] = [];
  const client: ArtifactClient = {
    getRunResult: () => Promise.resolve(state),
    resolveStorageUrl({ uri }) {
      resolved.push(uri);
      return resolve(uri);
    },
  };
  return { client, resolved };
}

/** A downloader that writes `bytes` through the real exclusive-create helper. */
function fakeDownloader(bytes: Uint8Array = PNG_BYTES) {
  const seen: Array<{ url: string; dir: string; baseName: string }> = [];
  const downloader: ArtifactDownloader = {
    async download(url, dir, baseName) {
      seen.push({ url, dir, baseName });
      const target = await openUniqueFile(dir, baseName);
      try {
        await target.handle.writeFile(bytes);
      } finally {
        await target.handle.close();
      }
      return { ok: true, saved: { path: target.path, size: bytes.byteLength } };
    },
  };
  return { downloader, seen };
}

function failingDownloader(failure: Extract<ArtifactDownloadResult, { ok: false }>["failure"]) {
  const downloader: ArtifactDownloader = {
    download: () => Promise.resolve({ ok: false, failure }),
  };
  return downloader;
}

function notFound(route: string): ApiResponseError {
  return new ApiResponseError(
    "HTTP 404",
    `${DEFAULT_API_URL}${route}`,
    404,
    "Not Found",
    "{}",
    "not_found",
    "Not found",
    undefined,
    undefined,
  );
}

async function contextIn(
  root: string,
  client: ArtifactClient,
  downloader: ArtifactDownloader,
): Promise<ArtifactsContext> {
  return { baseUrl: DEFAULT_API_URL, apiKey: "plx_sk_test", client, saveRoot: root, downloader };
}

describe("validateArtifactsRequest", () => {
  it("rejects a blank run id", () => {
    const errors = validateArtifactsRequest({ run_id: "  " });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.location).toBe("run_id");
  });

  it("rejects a blank or absolute dir at dir, before touching the filesystem", () => {
    expect(validateArtifactsRequest({ run_id: RUN_ID, dir: " " })[0]?.location).toBe("dir");
    const absolute = validateArtifactsRequest({ run_id: RUN_ID, dir: path.resolve("/tmp/x") });
    expect(absolute[0]?.location).toBe("dir");
    expect(absolute[0]?.message).toContain("relative");
  });

  it("accepts a run id alone or with a relative dir", () => {
    expect(validateArtifactsRequest({ run_id: RUN_ID })).toEqual([]);
    expect(validateArtifactsRequest({ run_id: RUN_ID, dir: "assets/run-1" })).toEqual([]);
  });
});

describe("artifactFilename", () => {
  it("takes the storage key's last segment", () => {
    expect(artifactFilename(PICTURE_URI, "image/png", 0)).toBe("illustration.png");
  });

  it("cannot name anything outside the target directory", () => {
    expect(artifactFilename("pipelex-storage://../../etc/passwd", null, 0)).toBe("passwd");
    expect(artifactFilename("pipelex-storage://a/..\\..\\secret.txt", null, 0)).toBe("secret.txt");
    // A key that is only dots has no usable name at all.
    expect(artifactFilename("pipelex-storage://..", null, 3)).toBe("artifact-4");
    expect(artifactFilename("pipelex-storage://", null, 0)).toBe("artifact-1");
  });

  it("never produces a hidden file and neutralizes unusual characters", () => {
    expect(artifactFilename("pipelex-storage://x/.env", null, 0)).toBe("env");
    expect(artifactFilename("pipelex-storage://x/my file (v2).PNG", null, 0)).toBe(
      "my_file__v2_.PNG",
    );
    expect(artifactFilename("pipelex-storage://x/a\u0000b\nc.pdf", null, 0)).toBe("a_b_c.pdf");
  });

  it("percent-decodes and drops a query or fragment", () => {
    expect(artifactFilename("pipelex-storage://x/hello%20world.pdf?token=1#frag", null, 0)).toBe(
      "hello_world.pdf",
    );
  });

  it("adds an extension from the content type only when the key has none", () => {
    expect(artifactFilename(REPORT_URI, "application/pdf", 0)).toBe("report.pdf");
    expect(artifactFilename(REPORT_URI, "image/png; charset=binary", 0)).toBe("report.png");
    expect(artifactFilename(REPORT_URI, "application/x-unknown", 0)).toBe("report");
    expect(artifactFilename(REPORT_URI, null, 0)).toBe("report");
    expect(artifactFilename(PICTURE_URI, "application/pdf", 0)).toBe("illustration.png");
  });

  it("caps the length while keeping the extension", () => {
    const name = artifactFilename(`pipelex-storage://x/${"a".repeat(300)}.png`, null, 0);

    expect(name.length).toBeLessThanOrEqual(128);
    expect(name.endsWith(".png")).toBe(true);
  });

  it("still caps a name whose extension alone exceeds the cap", () => {
    // A cap-length arithmetic that keeps the extension unconditionally hands
    // `slice` a negative start, which counts from the END and returns a name
    // LONGER than the cap. The extension is dropped instead.
    const name = artifactFilename(`pipelex-storage://x/stem.${"z".repeat(300)}`, null, 0);

    expect(name.length).toBeLessThanOrEqual(128);
  });
});

describe("downloadMthdsArtifacts", () => {
  it("refuses instructively with no working directory, without calling the API", async () => {
    let calls = 0;
    const client: ArtifactClient = {
      getRunResult() {
        calls += 1;
        return Promise.resolve(completedState({}));
      },
      resolveStorageUrl: () => Promise.reject(new Error("unreachable")),
    };

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      { baseUrl: DEFAULT_API_URL, client },
    );

    expect(calls).toBe(0);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      location: "deployment",
      retryable: false,
    });
    expect(result.structuredContent.errors?.[0]?.hint).toContain("npx @pipelex/mcp");
  });

  it("reports a running run as a produced verdict with the retry hint", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient({
      state: "running",
      pipeline_run_id: RUN_ID,
      retry_after_seconds: 3,
    });

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "running",
      retry_after_seconds: 3,
    });
    expect(result.summary).toContain("~3s");
    expect(result.summary).toContain("mthds_run_status");
  });

  it("reports a failed run as a produced verdict with no files", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient({
      state: "failed",
      pipeline_run_id: RUN_ID,
      status: "FAILED",
      message: "boom",
    });

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "failed",
      run_status: "FAILED",
      failure_message: "boom",
    });
    expect(result.summary).toContain("produces no files");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reports a completed run whose output references no stored file as nothing to save", async () => {
    const root = await makeTempDir();
    const { client, resolved } = fakeClient(
      completedState({ answer: 42, link: "https://example.com/not-storage.png" }),
    );

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "out" },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(resolved).toEqual([]);
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "completed",
      artifacts: [],
      saved_paths: [],
      all_saved: true,
    });
    expect(result.summary).toContain("nothing to save");
    // No directory is created for a run with nothing to save in it.
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("saves every referenced file under the working directory, once each, with fresh links", async () => {
    const root = await makeTempDir();
    const { client, resolved } = fakeClient(
      completedState({
        image: { url: PICTURE_URI, public_url: "https://presigned.example/illustration.png" },
        nested: [{ url: PICTURE_URI }, { document: { url: REPORT_URI } }],
      }),
    );
    const { downloader, seen } = fakeDownloader();

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, downloader),
    );

    // Deduplicated, in discovery order; each resolved through the API rather
    // than fetched from the expiring public_url in the output.
    expect(resolved).toEqual([PICTURE_URI, REPORT_URI]);
    expect(seen.map((call) => call.url)).toEqual([
      `https://bucket.example/${encodeURIComponent(PICTURE_URI)}?sig=x`,
      `https://bucket.example/${encodeURIComponent(REPORT_URI)}?sig=x`,
    ]);
    expect(seen.map((call) => call.baseName)).toEqual(["illustration.png", "report.pdf"]);

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "completed",
      artifacts: [
        { uri: PICTURE_URI, path: "illustration.png", content_type: "image/png", size: 4 },
        { uri: REPORT_URI, path: "report.pdf", content_type: "application/pdf", size: 4 },
      ],
      saved_paths: ["illustration.png", "report.pdf"],
      all_saved: true,
    });
    expect(new Uint8Array(await fs.readFile(path.join(root, "illustration.png")))).toEqual(
      PNG_BYTES,
    );
    expect(result.summary).toContain("Saved 2 file(s)");
    expect(result.summary).toContain("`illustration.png`");
    expect(result.summary).toContain("`report.pdf`");
    expect(result.summary).toContain(await fs.realpath(root));
  });

  it("saves into a relative dir, reporting paths relative to the working directory", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState({ url: PICTURE_URI }));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "assets/run-1" },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(result.structuredContent.saved_paths).toEqual([
      path.join("assets", "run-1", "illustration.png"),
    ]);
    await expect(
      fs.stat(path.join(root, "assets", "run-1", "illustration.png")),
    ).resolves.toBeTruthy();
  });

  it("never overwrites a file the user already has", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "illustration.png"), "keep me", "utf8");
    const { client } = fakeClient(completedState({ url: PICTURE_URI }));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(result.structuredContent.saved_paths).toEqual(["illustration-1.png"]);
    await expect(fs.readFile(path.join(root, "illustration.png"), "utf8")).resolves.toBe("keep me");
  });

  it("refuses a dir escaping the working directory as input_domain at dir, saving nothing", async () => {
    const root = await makeTempDir();
    const { client, resolved } = fakeClient(completedState({ url: PICTURE_URI }));
    const { downloader, seen } = fakeDownloader();

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "../outside" },
      await contextIn(root, client, downloader),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "dir",
      retryable: false,
    });
    expect(resolved).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("keeps partial success as a produced verdict — a failed sibling never hides a saved file", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      completedState({ a: { url: PICTURE_URI }, b: { url: REPORT_URI } }),
      (uri) =>
        uri === REPORT_URI
          ? Promise.reject(notFound("/v1/resolve-storage-url"))
          : Promise.resolve({
              url: "https://bucket.example/pic",
              expires_at: "",
              content_type: "image/png",
            }),
    );

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.all_saved).toBe(false);
    expect(result.structuredContent.saved_paths).toEqual(["illustration.png"]);
    expect(result.structuredContent.artifacts?.[1]).toMatchObject({
      uri: REPORT_URI,
      error: { class: "input_domain", location: "artifacts[1].uri", retryable: false },
    });
    expect(result.structuredContent.artifacts?.[1]).not.toHaveProperty("path");
    expect(result.summary).toContain("Saved 1 of 2");
    expect(result.summary).toContain(`\`${REPORT_URI}\` — failed`);
  });

  it("locates a download-boundary refusal at the artifact entry", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState({ url: PICTURE_URI }));
    const downloader = failingDownloader({
      class: "runtime",
      message: "The object store returned HTTP 503 for the download.",
      hint: "retry",
      retryable: true,
    });

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, downloader),
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.all_saved).toBe(false);
    expect(result.structuredContent.artifacts?.[0]).toMatchObject({
      uri: PICTURE_URI,
      content_type: "image/png",
      error: { class: "runtime", location: "artifacts[0].uri", retryable: true },
    });
  });

  it("classifies an unknown run id as input_domain at run_id (no verdict)", async () => {
    const root = await makeTempDir();
    const client: ArtifactClient = {
      getRunResult: () => Promise.reject(notFound(`/v1/runs/${RUN_ID}/results`)),
      resolveStorageUrl: () => Promise.reject(new Error("must not be called")),
    };

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "run_id",
      retryable: false,
    });
    expect(result.summary).toContain("rejected the request");
  });

  it("classifies an unreachable API as retryable config", async () => {
    const root = await makeTempDir();
    const client: ArtifactClient = {
      getRunResult: () =>
        Promise.reject(
          new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
        ),
      resolveStorageUrl: () => Promise.reject(new Error("must not be called")),
    };

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      retryable: true,
    });
    expect(result.summary).toContain("unreachable or misconfigured");
  });

  it("treats a completed report without main_stuff as a runtime contract error", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState(null));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      await contextIn(root, client, fakeDownloader().downloader),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "runtime",
      retryable: false,
    });
  });
});

describe("artifactsToolResult", () => {
  it("surfaces the per-file outcome in content and flags no-verdict results as errors", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState({ url: PICTURE_URI }));
    const ok = artifactsToolResult(
      await downloadMthdsArtifacts(
        { run_id: RUN_ID },
        await contextIn(root, client, fakeDownloader().downloader),
      ),
    );
    const bad = artifactsToolResult(
      await downloadMthdsArtifacts(
        { run_id: " " },
        await contextIn(root, client, fakeDownloader().downloader),
      ),
    );

    expect(ok.isError).toBe(false);
    expect(ok.content[0]?.text).toContain("`illustration.png`");
    expect(ok).not.toHaveProperty("_meta");
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("`run_id` — run_id must not be empty.");
  });
});
