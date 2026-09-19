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
  ALLOW_HTTP_ENV,
  allowsPlainHttp,
  artifactsToolResult,
  buildArtifactsContext,
  downloadMthdsArtifacts,
  itemToolError,
  parseAllowHttpOverride,
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

describe("the plain-http rule", () => {
  it("accepts plain http exactly when the configured API is itself plain http", () => {
    expect(allowsPlainHttp({ baseUrl: "http://localhost:8081" })).toBe(true);
    expect(allowsPlainHttp({ baseUrl: DEFAULT_API_URL })).toBe(false);
    // A malformed base URL refuses; the client constructor reports it as config.
    expect(allowsPlainHttp({ baseUrl: "not a url" })).toBe(false);
  });

  it("lets the explicit override win in both directions", () => {
    expect(allowsPlainHttp({ baseUrl: DEFAULT_API_URL, allowHttp: true })).toBe(true);
    expect(allowsPlainHttp({ baseUrl: "http://localhost:8081", allowHttp: false })).toBe(false);
  });

  it("reads the override from the environment, failing closed on an unrecognized value", () => {
    expect(parseAllowHttpOverride(undefined)).toBeUndefined();
    expect(parseAllowHttpOverride("  ")).toBeUndefined();
    expect(parseAllowHttpOverride("true")).toBe(true);
    expect(parseAllowHttpOverride(" TRUE ")).toBe(true);
    expect(parseAllowHttpOverride("1")).toBe(true);
    expect(parseAllowHttpOverride("false")).toBe(false);
    expect(parseAllowHttpOverride("0")).toBe(false);
    expect(parseAllowHttpOverride("yes")).toBe(false);

    expect(buildArtifactsContext({ [ALLOW_HTTP_ENV]: "true" }).allowHttp).toBe(true);
    expect(buildArtifactsContext({})).not.toHaveProperty("allowHttp");
    expect(buildArtifactsContext({}).baseUrl).toBe(DEFAULT_API_URL);
  });
});

describe("itemToolError", () => {
  it("classifies the SDK's per-item codes and locates each at its artifact entry", () => {
    expect(itemToolError({ code: "not_found", detail: "gone (HTTP 404)." }, 1)).toMatchObject({
      class: "input_domain",
      location: "artifacts[1].uri",
      message: "gone (HTTP 404).",
      retryable: false,
    });
    expect(itemToolError({ code: "too_large", detail: "over the cap" }, 0)).toMatchObject({
      class: "input_domain",
      retryable: false,
    });
    expect(itemToolError({ code: "forbidden", detail: "another org" }, 0)).toMatchObject({
      class: "input_domain",
      retryable: false,
    });
    for (const code of ["store_refused", "store_error", "timeout", "network", "resolve_failed"]) {
      expect(itemToolError({ code, detail: "x" }, 0)).toMatchObject({
        class: "runtime",
        retryable: true,
      });
    }
    expect(itemToolError({ code: "write_failed", detail: "EACCES" }, 0)).toMatchObject({
      class: "runtime",
      retryable: false,
    });
  });

  it("points a plain-http refusal at the override instead of the SDK option", () => {
    const error = itemToolError(
      { code: "plain_http_refused", detail: "pass allowHttp: true to accept it" },
      0,
    );

    expect(error.class).toBe("config");
    expect(error.message).not.toContain("allowHttp");
    expect(error.hint).toContain(`${ALLOW_HTTP_ENV}=true`);
  });

  it("reads a code it does not know as a retryable runtime fault", () => {
    expect(itemToolError({ code: "something_new", detail: "new failure" }, 2)).toMatchObject({
      class: "runtime",
      location: "artifacts[2].uri",
      message: "new failure",
      retryable: true,
    });
  });

  it("still names a failure when the route sent no detail with it", () => {
    // `detail` is typed but arrives verbatim off the wire, like the code, and
    // `message` is required on this tool's error schema.
    const missing = itemToolError({ code: "not_found", detail: undefined as unknown as string }, 0);
    expect(missing.message).toContain("gave no reason");
    expect(missing.message).toContain("not_found");
    expect(missing.class).toBe("input_domain");

    const blank = itemToolError({ code: "store_refused", detail: "   " }, 1);
    expect(blank.message).toContain("gave no reason");
  });

  it("reads a code naming an Object.prototype member as an unknown code, not as its member", () => {
    for (const code of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(itemToolError({ code, detail: "off the wire" }, 0)).toMatchObject({
        class: "runtime",
        location: "artifacts[0].uri",
        message: "off the wire",
        retryable: true,
      });
    }
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
    expect(result.summary).toContain("produces no files");
    expect(requests).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reports a completed run whose output references no stored file as nothing to save", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient(
      completedState({ answer: 42, link: "https://example.com/not-storage.png" }),
    );

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "out" },
      contextIn(root, client),
    );

    expect(requests).toEqual([]);
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "completed",
      scope: "main_stuff",
      artifacts: [],
      saved_paths: [],
      all_saved: true,
    });
    expect(result.summary).toContain("nothing to save");
    // No directory is created for a run with nothing to save in it.
    expect(await fs.readdir(root)).toEqual([]);
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
    // default scope named, and plain http refused against an https API.
    expect(requests).toEqual([
      {
        results,
        dir: await fs.realpath(root),
        scope: "main_stuff",
        allowHttp: false,
      },
    ]);
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "completed",
      scope: "main_stuff",
      artifacts: [
        { uri: PICTURE_URI, path: "illustration.png", content_type: "image/png", size: 4 },
        { uri: REPORT_URI, path: "report.pdf", content_type: "application/pdf", size: 4 },
      ],
      saved_paths: ["illustration.png", "report.pdf"],
      all_saved: true,
    });
    expect(result.summary).toContain("Saved 2 file(s)");
    expect(result.summary).toContain("`illustration.png`");
    expect(result.summary).toContain("`report.pdf`");
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
    expect(result.structuredContent.saved_paths).toEqual(["illustration.png"]);
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
    expect(result.summary).toContain("Saved 1 of 2");
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
    expect(result.summary).toContain("Before the refusal, 1 file(s) were saved");
    expect(result.summary).toContain("- `illustration.png`");
    // The files are on the caller's disk, so a machine consumer reads them
    // from the structured result rather than out of the prose — and calling
    // again would write suffixed copies beside them, not overwrite them.
    expect(result.structuredContent.saved_paths).toEqual(["illustration.png"]);
    expect(result.structuredContent.artifacts).toEqual([
      { uri: PICTURE_URI, path: "illustration.png", content_type: "image/png", size: 4 },
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
    expect(ok.content[0]?.text).toContain("`illustration.png`");
    expect(ok).not.toHaveProperty("_meta");
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("`run_id` — run_id must not be empty.");
  });
});
