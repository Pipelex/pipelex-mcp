import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ApiResponseError, ApiUnreachableError, ArtifactAuthenticationError } from "@pipelex/sdk";
import type {
  DownloadArtifactsRequest,
  DownloadArtifactsResult,
  DownloadedArtifact,
  RunResults,
  RunResultState,
} from "@pipelex/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
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
/** Where a save lands with no `dir`: one folder per run, named from the API's answer. */
const RUN_DIR = path.join("runs", RUN_ID);
const OUTPUT_PATH = path.join(RUN_DIR, "main_stuff.json");

/** The bytes the output file must hold: the value as the API returned it, formatted for a person. */
function outputBytes(mainStuff: unknown): string {
  return `${JSON.stringify(mainStuff, null, 2)}\n`;
}

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

/** One file the fake SDK download saves: its reference, its bare name, its type. */
interface FakeFile {
  uri: string;
  name: string;
  content_type: string | null;
}

/**
 * The SDK's `downloadArtifacts`, faked: it writes each file into the directory
 * the capability handed it — so the directory must really exist, which is what
 * `resolveSaveDir` guarantees — and answers the verdict the SDK would, with
 * absolute paths.
 */
function savingDownload(files: FakeFile[]) {
  return async (request: DownloadArtifactsRequest): Promise<DownloadArtifactsResult> => {
    const artifacts: DownloadedArtifact[] = [];
    for (const file of files) {
      const target = path.join(request.dir, file.name);
      await fs.writeFile(target, PNG_BYTES);
      artifacts.push({
        uri: file.uri,
        path: target,
        content_type: file.content_type,
        size: PNG_BYTES.byteLength,
        error: null,
      });
    }
    return verdictOf(artifacts);
  };
}

function verdictOf(artifacts: DownloadedArtifact[]): DownloadArtifactsResult {
  const saved_paths = artifacts.flatMap((item) => (item.error === null ? [item.path] : []));
  return {
    scope: "main_stuff",
    artifacts,
    saved_paths,
    all_saved: saved_paths.length === artifacts.length,
  };
}

const BOTH_FILES: FakeFile[] = [
  { uri: PICTURE_URI, name: "illustration.png", content_type: "image/png" },
  { uri: REPORT_URI, name: "report.pdf", content_type: "application/pdf" },
];

/** A client over a fixed run state whose download is `download`; every download request is recorded. */
function fakeClient(
  state: RunResultState,
  download: (
    request: DownloadArtifactsRequest,
  ) => Promise<DownloadArtifactsResult> = savingDownload(BOTH_FILES),
) {
  const requests: DownloadArtifactsRequest[] = [];
  const reads: string[] = [];
  const client: ArtifactClient = {
    getRunResult(runId) {
      reads.push(runId);
      return Promise.resolve(state);
    },
    downloadArtifacts(request) {
      requests.push(request);
      return download(request);
    },
  };
  return { client, requests, reads };
}

function apiError(route: string, status: number, message: string): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}${route}`,
    status,
    "Error",
    "{}",
    "error",
    message,
    undefined,
    undefined,
  );
}

function contextIn(
  root: string,
  client: ArtifactClient,
  overrides: Partial<ArtifactsContext> = {},
): ArtifactsContext {
  return { baseUrl: DEFAULT_API_URL, apiKey: "plx_sk_test", client, saveRoot: root, ...overrides };
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

  it("rejects a dir that climbs out of the working directory, on its own text", () => {
    const climbing = validateArtifactsRequest({ run_id: RUN_ID, dir: "../elsewhere" });

    expect(climbing).toHaveLength(1);
    expect(climbing[0]?.location).toBe("dir");
    expect(climbing[0]?.message).toContain("outside the server's working directory");
    expect(validateArtifactsRequest({ run_id: RUN_ID, dir: "out/../assets" })).toEqual([]);
  });

  it("accepts a run id alone or with a relative dir", () => {
    expect(validateArtifactsRequest({ run_id: RUN_ID })).toEqual([]);
    expect(validateArtifactsRequest({ run_id: RUN_ID, dir: "assets/run-1" })).toEqual([]);
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
      downloadArtifacts: () => Promise.reject(new Error("unreachable")),
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

  it("reports a running run as a produced verdict with the retry hint, creating nothing", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient({
      state: "running",
      pipeline_run_id: RUN_ID,
      retry_after_seconds: 3,
    });

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "out" },
      contextIn(root, client),
    );

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "running",
      retry_after_seconds: 3,
    });
    expect(result.summary).toContain("~3s");
    expect(result.summary).toContain("mthds_run_status");
    expect(requests).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reports a failed run as a produced verdict with no files", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient({
      state: "failed",
      pipeline_run_id: RUN_ID,
      status: "FAILED",
      message: "boom",
    });

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "failed",
      run_status: "FAILED",
      failure_message: "boom",
    });
    expect(result.summary).toContain("produces no output and no files");
    expect(requests).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("saves the output of a completed run that references no stored file, and downloads nothing", async () => {
    const root = await makeTempDir();
    const mainStuff = { answer: 42, link: "https://example.com/not-storage.png" };
    const { client, requests } = fakeClient(completedState(mainStuff));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "out" },
      contextIn(root, client),
    );

    expect(requests).toEqual([]);
    const outputPath = path.join("out", "main_stuff.json");
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "completed",
      scope: "main_stuff",
      output: { path: outputPath, size: Buffer.byteLength(outputBytes(mainStuff)) },
      artifacts: [],
      saved_paths: [outputPath],
      all_saved: true,
    });
    // The output is the whole point: a structured result with no files still
    // reaches the disk, byte for byte as the API returned it.
    expect(await fs.readFile(path.join(root, outputPath), "utf8")).toBe(outputBytes(mainStuff));
    expect(result.summary).toContain("references no stored files");
    expect(result.summary).toContain(`\`${outputPath}\``);
    expect(result.summary).toContain("rather than retyping it");
  });

  it("hands the results in hand to the SDK and reports its verdict relative to the working directory", async () => {
    const root = await makeTempDir();
    const results: RunResults = {
      pipeline_run_id: RUN_ID,
      main_stuff: {
        image: { url: PICTURE_URI, public_url: "https://presigned.example/illustration.png" },
        nested: [{ url: PICTURE_URI }, { document: { url: REPORT_URI } }],
      },
    };
    const { client, requests } = fakeClient({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: results,
    });

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    // The run is read once, here, and handed over: no second read by id, the
    // default scope named, plain http refused against an https API, and the
    // run's own folder as the target when the caller names none.
    expect(requests).toEqual([
      {
        results,
        dir: path.join(await fs.realpath(root), RUN_DIR),
        scope: "main_stuff",
        allowHttp: false,
      },
    ]);
    const picture = path.join(RUN_DIR, "illustration.png");
    const report = path.join(RUN_DIR, "report.pdf");
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "completed",
      scope: "main_stuff",
      output: { path: OUTPUT_PATH, size: Buffer.byteLength(outputBytes(results.main_stuff)) },
      artifacts: [
        { uri: PICTURE_URI, path: picture, content_type: "image/png", size: 4 },
        { uri: REPORT_URI, path: report, content_type: "application/pdf", size: 4 },
      ],
      saved_paths: [OUTPUT_PATH, picture, report],
      all_saved: true,
    });
    expect(result.summary).toContain("its main output and 2 file(s)");
    expect(result.summary).toContain(`\`${OUTPUT_PATH}\``);
    expect(result.summary).toContain(`\`${picture}\``);
    expect(result.summary).toContain(`\`${report}\``);
    expect(result.summary).toContain(await fs.realpath(root));
  });

  it("creates a relative dir inside the working directory before the SDK writes into it", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient(
      completedState({ url: PICTURE_URI }),
      savingDownload([BOTH_FILES[0]!]),
    );

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "assets/run-1" },
      contextIn(root, client),
    );

    expect(requests[0]?.dir).toBe(path.join(await fs.realpath(root), "assets", "run-1"));
    expect(result.structuredContent.saved_paths).toEqual([
      path.join("assets", "run-1", "main_stuff.json"),
      path.join("assets", "run-1", "illustration.png"),
    ]);
    await expect(
      fs.stat(path.join(root, "assets", "run-1", "illustration.png")),
    ).resolves.toBeTruthy();
  });

  it("derives the plain-http opt-in from the base URL, and lets the override win", async () => {
    const root = await makeTempDir();
    const local = fakeClient(
      completedState({ url: PICTURE_URI }),
      savingDownload([BOTH_FILES[0]!]),
    );
    await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      contextIn(root, local.client, { baseUrl: "http://localhost:8081" }),
    );
    expect(local.requests[0]?.allowHttp).toBe(true);

    const overridden = fakeClient(
      completedState({ url: PICTURE_URI }),
      savingDownload([BOTH_FILES[0]!]),
    );
    await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      contextIn(root, overridden.client, { allowHttp: true }),
    );
    expect(overridden.requests[0]?.allowHttp).toBe(true);
  });

  it("refuses a dir escaping the working directory as input_domain at dir, saving nothing", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient(completedState({ url: PICTURE_URI }));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "../outside" },
      contextIn(root, client),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "dir",
      retryable: false,
    });
    expect(requests).toEqual([]);
  });

  it("keeps partial success as a produced verdict — a failed sibling never hides a saved file", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      completedState({ a: { url: PICTURE_URI }, b: { url: REPORT_URI } }),
      async (request) => {
        const saved = path.join(request.dir, "illustration.png");
        await fs.writeFile(saved, PNG_BYTES);
        return verdictOf([
          { uri: PICTURE_URI, path: saved, content_type: "image/png", size: 4, error: null },
          {
            uri: REPORT_URI,
            path: null,
            content_type: null,
            size: null,
            error: {
              code: "not_found",
              detail: "The stored file is no longer available (HTTP 404).",
            },
          },
        ]);
      },
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.all_saved).toBe(false);
    expect(result.structuredContent.saved_paths).toEqual([
      OUTPUT_PATH,
      path.join(RUN_DIR, "illustration.png"),
    ]);
    expect(result.structuredContent.artifacts?.[1]).toEqual({
      uri: REPORT_URI,
      content_type: null,
      error: {
        class: "input_domain",
        location: "artifacts[1].uri",
        message: "The stored file is no longer available (HTTP 404).",
        hint: "The object behind this storage reference is gone; re-run the method to produce it again.",
        retryable: false,
      },
    });
    expect(result.summary).toContain("its main output and 1 of 2 file(s)");
    expect(result.summary).toContain(`\`${REPORT_URI}\` — failed`);
  });

  it("names the files saved before a credential refusal, on a no-verdict error", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      completedState({ a: { url: PICTURE_URI }, b: { url: REPORT_URI } }),
      async (request) => {
        const saved = path.join(request.dir, "illustration.png");
        await fs.writeFile(saved, PNG_BYTES);
        throw new ArtifactAuthenticationError(
          "The resolve route refused the credential (401) part-way through the download.",
          401,
          verdictOf([
            { uri: PICTURE_URI, path: saved, content_type: "image/png", size: 4, error: null },
            {
              uri: REPORT_URI,
              path: null,
              content_type: null,
              size: null,
              error: { code: "aborted", detail: "stopped on a credential failure" },
            },
          ]),
        );
      },
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      location: "PIPELEX_API_KEY",
      retryable: false,
    });
    expect(result.summary).toContain("the run's main output and 1 file(s) were saved");
    expect(result.summary).toContain(`- \`${path.join(RUN_DIR, "illustration.png")}\``);
    // The files are on the caller's disk, so a machine consumer reads them
    // from the structured result rather than out of the prose — and calling
    // again would write suffixed copies beside them, not overwrite them. The
    // output was written before the download began, so it is among them.
    expect(result.structuredContent.output?.path).toBe(OUTPUT_PATH);
    expect(result.structuredContent.saved_paths).toEqual([
      OUTPUT_PATH,
      path.join(RUN_DIR, "illustration.png"),
    ]);
    expect(result.structuredContent.artifacts).toEqual([
      {
        uri: PICTURE_URI,
        path: path.join(RUN_DIR, "illustration.png"),
        content_type: "image/png",
        size: 4,
      },
      {
        uri: REPORT_URI,
        content_type: null,
        error: expect.objectContaining({ class: "runtime", location: "artifacts[1].uri" }),
      },
    ]);
    // No verdict was produced, so nothing here may read as one.
    expect(result.structuredContent.state).toBeUndefined();
    expect(result.structuredContent.all_saved).toBeUndefined();
  });

  it("leaves artifacts out of a credential refused before any file was saved", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState({ url: PICTURE_URI }), () =>
      Promise.reject(
        new ArtifactAuthenticationError(
          "The resolve route refused the credential (401); no artifact was downloaded.",
          401,
          verdictOf([
            {
              uri: PICTURE_URI,
              path: null,
              content_type: null,
              size: null,
              error: { code: "aborted", detail: "stopped on a credential failure" },
            },
          ]),
        ),
      ),
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      location: "PIPELEX_API_KEY",
      retryable: false,
    });
    // Every item would be an `aborted` error inviting a retry the refusal
    // itself rules out, so only what is on disk rides: the output.
    expect(result.structuredContent.artifacts).toBeUndefined();
    expect(result.structuredContent.output?.path).toBe(OUTPUT_PATH);
    expect(result.structuredContent.saved_paths).toEqual([OUTPUT_PATH]);
    expect(result.summary).toContain(
      `Before the failure, the run's main output was saved as \`${OUTPUT_PATH}\`.`,
    );
  });

  it("writes the output before the SDK downloads anything, so the output keeps its name", async () => {
    const root = await makeTempDir();
    const mainStuff = { url: PICTURE_URI, caption: "a kitchen" };
    let outputAtDownload: string | undefined;
    const { client } = fakeClient(completedState(mainStuff), async (request) => {
      outputAtDownload = await fs.readFile(path.join(request.dir, "main_stuff.json"), "utf8");
      return savingDownload([BOTH_FILES[0]!])(request);
    });

    await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(outputAtDownload).toBe(outputBytes(mainStuff));
  });

  it("names the default folder from the run id the API answered, not the caller's argument", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      {
        state: "completed",
        pipeline_run_id: "run_answered-by-the-api",
        result: { pipeline_run_id: "run_answered-by-the-api", main_stuff: { answer: 42 } },
      },
      () => Promise.reject(new Error("must not be called")),
    );

    const result = await downloadMthdsArtifacts({ run_id: "run_typed" }, contextIn(root, client));

    expect(result.structuredContent.output?.path).toBe(
      path.join("runs", "run_answered-by-the-api", "main_stuff.json"),
    );
  });

  it("reduces the answered run id to a safe segment, and refuses one with nothing left", async () => {
    const root = await makeTempDir();
    const answered = (runId: string) =>
      fakeClient({
        state: "completed",
        pipeline_run_id: runId,
        result: { pipeline_run_id: runId, main_stuff: { answer: 42 } },
      }).client;

    // Containment would hold regardless; the segment is hygiene on top of it.
    const reduced = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      contextIn(root, answered("../../run.evil")),
    );
    expect(reduced.structuredContent.output?.path).toBe(
      path.join("runs", "runevil", "main_stuff.json"),
    );

    const empty = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      contextIn(root, answered("/../")),
    );
    expect(empty.structuredContent.status).toBe("error");
    expect(empty.structuredContent.errors?.[0]).toMatchObject({
      class: "runtime",
      location: "run_id",
      retryable: false,
    });
    expect(empty.structuredContent.errors?.[0]?.hint).toContain("dir");
    expect(await fs.readdir(path.join(root, "runs"))).toEqual(["runevil"]);
  });

  it('saves into the working directory itself when dir is "."', async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState({ answer: 42 }));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "." },
      contextIn(root, client),
    );

    expect(result.structuredContent.output?.path).toBe("main_stuff.json");
    expect(await fs.readdir(root)).toEqual(["main_stuff.json"]);
  });

  it("never overwrites an existing main_stuff.json — the new one takes a suffix", async () => {
    const root = await makeTempDir();
    await fs.mkdir(path.join(root, RUN_DIR), { recursive: true });
    await fs.writeFile(path.join(root, OUTPUT_PATH), "an earlier save\n");
    const { client } = fakeClient(completedState({ answer: 42 }));

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    const suffixed = path.join(RUN_DIR, "main_stuff-1.json");
    expect(result.structuredContent.output?.path).toBe(suffixed);
    expect(result.structuredContent.saved_paths).toEqual([suffixed]);
    expect(await fs.readFile(path.join(root, OUTPUT_PATH), "utf8")).toBe("an earlier save\n");
    expect(await fs.readFile(path.join(root, suffixed), "utf8")).toBe(outputBytes({ answer: 42 }));
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses at dir when the output cannot be written, and downloads nothing",
    async () => {
      const root = await makeTempDir();
      const locked = path.join(root, "locked");
      await fs.mkdir(locked);
      await fs.chmod(locked, 0o555);
      try {
        const { client, requests } = fakeClient(completedState({ url: PICTURE_URI }));

        const result = await downloadMthdsArtifacts(
          { run_id: RUN_ID, dir: "locked" },
          contextIn(root, client),
        );

        expect(result.structuredContent.status).toBe("error");
        expect(result.structuredContent.errors?.[0]).toMatchObject({
          class: "input_domain",
          location: "dir",
          retryable: false,
        });
        expect(result.structuredContent.errors?.[0]?.message).toContain("main_stuff.json");
        expect(result.summary).toContain("Nothing was saved");
        // A directory that cannot take the output will not take the files.
        expect(requests).toEqual([]);
        expect(await fs.readdir(locked)).toEqual([]);
      } finally {
        await fs.chmod(locked, 0o755);
      }
    },
  );

  it("refuses a climbing dir on a run that references no file, rather than reporting it saved", async () => {
    const root = await makeTempDir();
    const { client, requests, reads } = fakeClient(completedState({ answer: 42 }));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "../elsewhere" },
      contextIn(root, client),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "dir",
    });
    // The refusal is on the request itself: the run is never even read, so a
    // check moved back inside the download path would fail this.
    expect(reads).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("classifies a deployment without the bulk resolve route as config at PIPELEX_BASE_URL", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState({ url: PICTURE_URI }), () =>
      Promise.reject(apiError("/v1/resolve-storage-url/bulk", 404, "Not Found")),
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      retryable: false,
    });
    expect(result.structuredContent.errors?.[0]?.hint).toContain("/v1/resolve-storage-url/bulk");
    expect(result.summary).toContain("unreachable or misconfigured");
    // The output was written before the bulk route was asked, so the refusal
    // still says where it is, and nothing reads as a download verdict.
    expect(result.structuredContent.output?.path).toBe(OUTPUT_PATH);
    expect(result.structuredContent.saved_paths).toEqual([OUTPUT_PATH]);
    expect(result.structuredContent.artifacts).toBeUndefined();
    expect(await fs.readFile(path.join(root, OUTPUT_PATH), "utf8")).toBe(
      outputBytes({ url: PICTURE_URI }),
    );
  });

  it("classifies a whole-request 400 on the bulk route as config, not as the caller's input", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState({ url: PICTURE_URI }), () =>
      Promise.reject(apiError("/v1/resolve-storage-url/bulk", 400, "No organization context.")),
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      message: "No organization context.",
      retryable: false,
    });
    expect(result.structuredContent.errors?.[0]?.location).toBeUndefined();
    expect(result.structuredContent.errors?.[0]?.hint).toContain("organization");
  });

  it("classifies an unknown run id as input_domain at run_id (no verdict)", async () => {
    const root = await makeTempDir();
    const client: ArtifactClient = {
      getRunResult: () => Promise.reject(apiError(`/v1/runs/${RUN_ID}/results`, 404, "Not found")),
      downloadArtifacts: () => Promise.reject(new Error("must not be called")),
    };

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

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
      downloadArtifacts: () => Promise.reject(new Error("must not be called")),
    };

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      retryable: true,
    });
    expect(result.summary).toContain("unreachable or misconfigured");
  });

  it("treats a completed report without main_stuff as a runtime contract error", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient(completedState(null));

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "runtime",
      retryable: false,
    });
    expect(requests).toEqual([]);
  });
});

describe("artifactsToolResult", () => {
  it("surfaces the per-file outcome in content and flags no-verdict results as errors", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      completedState({ url: PICTURE_URI }),
      savingDownload([BOTH_FILES[0]!]),
    );
    const ok = artifactsToolResult(
      await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client)),
    );
    const bad = artifactsToolResult(
      await downloadMthdsArtifacts({ run_id: " " }, contextIn(root, client)),
    );

    expect(ok.isError).toBe(false);
    expect(ok.content[0]?.text).toContain(`\`${path.join(RUN_DIR, "illustration.png")}\``);
    expect(ok).not.toHaveProperty("_meta");
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("`run_id` — run_id must not be empty.");
  });
});
