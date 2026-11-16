import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ApiResponseError,
  ApiUnreachableError,
  ArtifactAuthenticationError,
  artifactFilename,
  buildProblem,
  locateStoredReferences,
  mainStuffNode,
} from "@pipelex/sdk";
import type {
  DownloadArtifactsRequest,
  DownloadArtifactsResult,
  DownloadedArtifact,
  RunRead,
  RunResultArtifact,
  RunResults,
  RunResultState,
} from "@pipelex/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DOWNLOAD_MAX_FILE_BYTES,
  DOWNLOAD_MAX_TOTAL_BYTES,
  GENERATED_DIRECTORY_GITIGNORE,
  MAX_FOUND_AT_PATHS,
  artifactsToolResult,
  downloadMthdsArtifacts,
  validateArtifactsRequest,
} from "./artifacts.js";
import type { ArtifactClient, ArtifactsContext } from "./artifacts.js";
import {
  RECORDED_FAILED_RUNS,
  TIMED_OUT_RUN_PROBLEM,
  relayingArmOf,
} from "./failed-run-fixtures.js";
import { DEFAULT_API_URL } from "./shared.js";
import {
  PAGE_TEXT_URI,
  PICTURE_URI as DOSSIER_PICTURE_URI,
  DOCUMENT_URI,
  REPORT_TEXT_URI,
  STORED_PAGE,
  STORED_REPORT,
  briefResults,
  dossierResults,
  storedReportResults,
  workingMemoryFor,
} from "./stored-text-fixtures.js";

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

/** The content type the fake platform answers for each reference. */
const CONTENT_TYPES: Record<string, string> = {
  [PICTURE_URI]: "image/png",
  [REPORT_URI]: "application/pdf",
};

/** The stored bytes of each stored text, as the store answers them; any other text is gone. */
const TEXT_BODIES: Record<string, string> = {
  [REPORT_TEXT_URI]: "# Quarterly report\n\nThe whole of it, never loaded into a result.\n",
  [PAGE_TEXT_URI]: "Page one begins here, and goes on.\n",
};

/**
 * The SDK's `downloadArtifacts`, faked over the SDK's own pure half: the walk
 * is its `locateStoredReferences` guided by `mainStuffNode`, as the download
 * walks the results it is handed, and each name its `artifactFilename`, so
 * neither `found_at`, a file's kind nor a filename can drift from what the
 * released SDK answers. Only the network is faked — each file is written into
 * the directory the capability handed over, which must really exist, as
 * `resolveSaveDir` guarantees — and the verdict carries absolute paths, as the
 * SDK's does. A stored text the store does not hold is the item error the
 * SDK's fetch gives a 404.
 */
async function savingDownload(request: DownloadArtifactsRequest): Promise<DownloadArtifactsResult> {
  const results = request.results;
  const { files, texts } = locateStoredReferences(
    results?.main_stuff,
    results === undefined ? null : mainStuffNode(results),
  );
  const artifacts: DownloadedArtifact[] = [];
  for (const location of files) {
    const contentType = CONTENT_TYPES[location.uri] ?? null;
    const target = path.join(request.dir, artifactFilename(location, contentType, "main_stuff"));
    await fs.writeFile(target, PNG_BYTES, { flag: "wx" });
    artifacts.push({
      uri: location.uri,
      kind: "file",
      found_at: location.found_at,
      path: target,
      content_type: contentType,
      size: PNG_BYTES.byteLength,
      error: null,
    });
  }
  for (const location of texts) {
    const body = TEXT_BODIES[location.uri];
    if (body === undefined) {
      artifacts.push({
        uri: location.uri,
        kind: "text",
        found_at: location.found_at,
        path: null,
        content_type: location.mime_type,
        size: null,
        error: { code: "not_found", detail: "The stored file is no longer available (HTTP 404)." },
      });
      continue;
    }
    const target = path.join(request.dir, artifactFilename(location, null, "main_stuff"));
    await fs.writeFile(target, body, { flag: "wx" });
    artifacts.push({
      uri: location.uri,
      kind: "text",
      found_at: location.found_at,
      path: target,
      content_type: location.mime_type,
      size: Buffer.byteLength(body),
      error: null,
    });
  }
  return verdictOf(artifacts);
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

/** A picture that is the whole output: a path of `$.url`, so the SDK names it after the scope. */
const PICTURE_ONLY = { url: PICTURE_URI };
const PICTURE_ONLY_FILE = path.join(RUN_DIR, "main_stuff.png");

/** The status read a failed arm is followed by; every other arm must not make one. */
function noStatusRead(): Promise<RunRead> {
  return Promise.reject(new Error("getRunStatus must not be called"));
}

/**
 * A client over a fixed run state whose download is `download`; every download
 * request is recorded. `statusRead` answers the status read a failed arm is
 * followed by.
 */
function fakeClient(
  state: RunResultState,
  download: (
    request: DownloadArtifactsRequest,
  ) => Promise<DownloadArtifactsResult> = savingDownload,
  statusRead?: RunRead,
) {
  const requests: DownloadArtifactsRequest[] = [];
  const reads: string[] = [];
  const selections: (readonly RunResultArtifact[] | undefined)[] = [];
  const loads: (boolean | undefined)[] = [];
  const client: ArtifactClient = {
    getRunResult(runId, options) {
      reads.push(runId);
      selections.push(options?.artifacts);
      loads.push(options?.loadStoredTexts);
      return Promise.resolve(narrowed(state, options?.artifacts));
    },
    getRunStatus: statusRead === undefined ? noStatusRead : () => Promise.resolve(statusRead),
    downloadArtifacts(request) {
      requests.push(request);
      return download(request);
    },
  };
  return { client, requests, reads, selections, loads };
}

/**
 * A completed read the way the SDK answers a narrowed one: every artifact the
 * selection left out is absent, so a projection reading an artifact its read
 * did not ask for finds nothing, which the assertions would see.
 */
function narrowed(
  state: RunResultState,
  selection: readonly RunResultArtifact[] | undefined,
): RunResultState {
  if (state.state !== "completed" || selection === undefined) return state;
  const selected = new Set<string>(selection);
  const result = Object.fromEntries(
    Object.entries(state.result).filter(([key]) => key === "pipeline_run_id" || selected.has(key)),
  ) as unknown as RunResults;
  return { ...state, result };
}

/**
 * An answer of the API as the SDK reads it: a problem document as it came, or,
 * when the body is none, by its status alone.
 */
function apiError(route: string, status: number, problem?: object): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}${route}`,
    status,
    "Error",
    problem === undefined ? "{}" : JSON.stringify(problem),
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
    const problems = validateArtifactsRequest({ run_id: "  " });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "run_id", reason: "empty" },
      location: { field: "run_id" },
    });
  });

  it("rejects a blank or absolute dir at dir, before touching the filesystem", () => {
    expect(validateArtifactsRequest({ run_id: RUN_ID, dir: " " })[0]).toMatchObject({
      params: { argument: "dir", reason: "empty" },
      location: { field: "dir" },
    });
    const absolute = validateArtifactsRequest({ run_id: RUN_ID, dir: path.resolve("/tmp/x") });
    expect(absolute[0]).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "dir", reason: "absolute" },
      location: { field: "dir" },
    });
    expect(absolute[0]?.message).toContain("relative");
  });

  it("rejects a dir that climbs out of the working directory, on its own text", () => {
    const climbing = validateArtifactsRequest({ run_id: RUN_ID, dir: "../elsewhere" });

    expect(climbing).toHaveLength(1);
    expect(climbing[0]).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "dir", reason: "outside_workspace" },
      location: { field: "dir" },
    });
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
      getRunStatus: noStatusRead,
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
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.not_configured",
      retry: "no",
      params: { setting: "working_directory" },
    });
    expect(result.structuredContent.problem?.message).toContain("npx @pipelex/mcp");
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

  it("reports a failed run as a produced verdict with no files, saying why it failed", async () => {
    const root = await makeTempDir();
    const { resultsArm, statusRead } = RECORDED_FAILED_RUNS.sandboxProvisioning;
    const { client, requests } = fakeClient(resultsArm, savingDownload, statusRead);
    const runError = statusRead.error;
    if (runError == null) throw new Error("the recording carries the run's problem");

    const result = await downloadMthdsArtifacts(
      { run_id: statusRead.pipeline_run_id },
      contextIn(root, client),
    );

    // The arm nests no problem, so the run's own comes from the status read.
    expect(resultsArm.error).toBeNull();
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: statusRead.pipeline_run_id,
      state: "failed",
      run_status: "FAILED",
      run_error: runError,
    });
    expect(result.summary).toContain(`## ${runError.title}`);
    expect(result.summary).toContain(runError.detail);
    expect(result.summary).toContain(runError.next_step.detail);
    expect(result.summary).toContain("`pipelex.sandbox.unavailable`");
    expect(result.summary).toContain(
      `For support: Run ${statusRead.pipeline_run_id} · pipelex.sandbox.unavailable · ended ${statusRead.finished_at ?? ""}`,
    );
    expect(result.summary).toContain("produces no output and no files");
    expect(requests).toEqual([]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("carries the problem a failed arm relays, its retry verdict included", async () => {
    const root = await makeTempDir();
    const { relayedArm, statusRead } = RECORDED_FAILED_RUNS.extractJobFailure;
    const { client } = fakeClient(relayedArm, savingDownload, { ...statusRead, error: null });

    const result = await downloadMthdsArtifacts(
      { run_id: relayedArm.pipeline_run_id },
      contextIn(root, client),
    );

    // The status read carries none here, so the run's problem is the arm's.
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: relayedArm.pipeline_run_id,
      state: "failed",
      run_status: "FAILED",
      run_error: relayedArm.error,
    });
    expect(result.structuredContent.run_error).toMatchObject({
      code: "provider.failed",
      retry: "yes",
      next_step: { kind: "retry" },
    });
    expect(result.summary).toContain("retry yes");
  });

  it("keeps the run problem's own message, and bounds a detail too long to relay whole", async () => {
    const root = await makeTempDir();
    const longDetail = `The run was stopped at the one-hour limit. ${"Its last step was still waiting. ".repeat(100)}`;
    const arm = relayingArmOf(RUN_ID, {
      ...TIMED_OUT_RUN_PROBLEM,
      detail: longDetail,
      message: "The run took longer than this deployment allows.",
    });
    const { client, requests } = fakeClient(arm);

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    const runError = result.structuredContent.run_error;
    expect(runError).toMatchObject({
      code: "run.timed_out",
      domain: TIMED_OUT_RUN_PROBLEM.domain,
      retry: TIMED_OUT_RUN_PROBLEM.retry,
      message: "The run took longer than this deployment allows.",
    });
    expect(runError?.detail.startsWith("The run was stopped at the one-hour limit.")).toBe(true);
    expect(runError?.detail).toMatch(/more characters left out\]$/);
    expect(result.summary).toContain("The run took longer than this deployment allows.");
    expect(requests).toEqual([]);
  });

  it("saves the output of a completed run that references no stored file, and downloads nothing", async () => {
    const root = await makeTempDir();
    const mainStuff = { answer: 42, link: "https://example.com/not-storage.png" };
    const { client, requests } = fakeClient(completedState(mainStuff));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "out" },
      contextIn(root, client),
    );

    // The SDK's own walk decides there is nothing to fetch, and answers an
    // empty verdict without a request of its own: the output is walked once.
    expect(requests).toHaveLength(1);
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
    const { client, requests, selections, loads } = fakeClient({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: results,
    });

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    // The one results read asks for the main output alone: it is both the file
    // written first and the scope the download walks, and nothing in it is
    // shaped like a stored text, so the working memory and the forms are never
    // read, nor the graph, the contracts or the usage records. Its stored
    // texts would stay references, which the download saves as files.
    expect(selections).toEqual([["main_stuff"]]);
    expect(loads).toEqual([false]);

    // The run is read once, here, and handed over: no second read by id, the
    // default scope named, plain http refused against an https API, and the
    // run's own folder as the target when the caller names none.
    expect(requests).toEqual([
      {
        results,
        dir: path.join(await fs.realpath(root), RUN_DIR),
        scope: "main_stuff",
        allowHttp: false,
        maxBytes: DOWNLOAD_MAX_FILE_BYTES,
        maxTotalBytes: DOWNLOAD_MAX_TOTAL_BYTES,
      },
    ]);
    // Each file is named after the first field it fills; the report's key
    // carries no extension, so its content type supplies one.
    const picture = path.join(RUN_DIR, "image.png");
    const report = path.join(RUN_DIR, "nested-1-document.pdf");
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "completed",
      scope: "main_stuff",
      output: { path: OUTPUT_PATH, size: Buffer.byteLength(outputBytes(results.main_stuff)) },
      artifacts: [
        {
          uri: PICTURE_URI,
          found_at: ["$.image.url", "$.nested[0].url"],
          path: picture,
          content_type: "image/png",
          size: 4,
        },
        {
          uri: REPORT_URI,
          found_at: ["$.nested[1].document.url"],
          path: report,
          content_type: "application/pdf",
          size: 4,
        },
      ],
      saved_paths: [OUTPUT_PATH, picture, report],
      all_saved: true,
    });
    expect(result.summary).toContain("its main output and 2 file(s)");
    expect(result.summary).toContain(`\`${OUTPUT_PATH}\``);
    // The prose names the field each file fills, and says when the output
    // repeats a reference rather than listing the file twice.
    expect(result.summary).toContain(
      `- \`${picture}\` (image/png, 4 B) ← \`$.image.url\` (and 1 more)`,
    );
    expect(result.summary).toContain(
      `- \`${report}\` (application/pdf, 4 B) ← \`$.nested[1].document.url\``,
    );
    expect(result.summary).toContain(await fs.realpath(root));
  });

  it("saves a stored text through the SDK's download and lists it under texts, never as a file", async () => {
    const root = await makeTempDir();
    const { client, requests, selections, loads } = fakeClient({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: storedReportResults(),
    });

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    // The output may hold a stored text, so the facts that tell one from a
    // file by concept are read beside it, the forms included, and handed over
    // with it; the SDK saves the text itself.
    expect(selections).toEqual([["main_stuff"], ["working_memory", "output_form", "input_form"]]);
    expect(loads).toEqual([false, false]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.results).toEqual(storedReportResults());
    expect(requests[0]?.maxTotalBytes).toBe(DOWNLOAD_MAX_TOTAL_BYTES);
    const text = path.join(RUN_DIR, "main_stuff.md");
    const size = Buffer.byteLength(TEXT_BODIES[REPORT_TEXT_URI]!);
    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "completed",
      scope: "main_stuff",
      output: { path: OUTPUT_PATH, size: Buffer.byteLength(outputBytes(STORED_REPORT)) },
      texts: [
        {
          uri: REPORT_TEXT_URI,
          found_at: ["$.url"],
          path: text,
          mime_type: "text/markdown",
          size,
        },
      ],
      artifacts: [],
      saved_paths: [OUTPUT_PATH, text],
      all_saved: true,
    });
    // main_stuff.json is still the output as returned: the reference.
    expect(await fs.readFile(path.join(root, OUTPUT_PATH), "utf8")).toBe(
      outputBytes(STORED_REPORT),
    );
    expect(result.summary).toContain(
      `- \`${text}\` (stored text, text/markdown, ${size} B) ← \`$.url\``,
    );
    expect(result.summary).toContain("1 stored text(s)");
    expect(result.summary).not.toContain("references no stored files");
  });

  it("saves the output and every reference when the concept read fails, listing the stored texts by shape", async () => {
    const root = await makeTempDir();
    const fake = fakeClient({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: dossierResults(),
    });
    const firstRead = fake.client.getRunResult.bind(fake.client);
    const client: ArtifactClient = {
      ...fake.client,
      getRunResult: (runId, options) =>
        options?.artifacts?.includes("working_memory")
          ? Promise.reject(apiError(`/v1/runs/${RUN_ID}/results`, 504))
          : firstRead(runId, options),
    };

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    // The download goes on with the output it read: main_stuff.json first,
    // then every reference through the SDK, which, given no concepts, saves
    // each one as a file; the ones shaped like a stored text's are listed as
    // texts, with the MIME type their reference states, never as files.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.output?.path).toBe(OUTPUT_PATH);
    expect(fake.requests).toHaveLength(1);
    const { texts, artifacts, all_saved } = result.structuredContent;
    expect(texts?.map((item) => [item.uri, item.found_at, item.mime_type])).toEqual([
      [REPORT_TEXT_URI, ["$.report.url"], "text/markdown"],
      [PAGE_TEXT_URI, ["$.pages[0].url"], "text/plain"],
    ]);
    expect(texts?.every((item) => item.path !== undefined)).toBe(true);
    expect(artifacts?.map((item) => item.uri)).toEqual([DOCUMENT_URI, DOSSIER_PICTURE_URI]);
    expect(all_saved).toBe(true);
    expect(result.summary).toContain("its main output, 2 stored text(s) and 2 file(s)");
    expect(result.summary).toContain("the read failed");
    expect(result.summary).toContain("shaped like a stored text's");
  });

  it("lists a stored text by shape when the results name no concept, and says why", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: STORED_REPORT },
    });

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.texts?.map((item) => [item.uri, item.mime_type])).toEqual([
      [REPORT_TEXT_URI, "text/markdown"],
    ]);
    expect(result.structuredContent.artifacts).toEqual([]);
    expect(result.summary).toContain("its results name no concept for the output");
    expect(result.summary).not.toContain("Calling again");
  });

  it("splits the SDK's verdict into the stored texts and the files, told apart by concept", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: dossierResults(),
    });

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(requests).toHaveLength(1);
    const { texts, artifacts, saved_paths, all_saved } = result.structuredContent;
    expect(texts?.map((item) => [item.found_at, item.path, item.mime_type])).toEqual([
      [["$.report.url"], path.join(RUN_DIR, "report.md"), "text/markdown"],
      [["$.pages[0].url"], path.join(RUN_DIR, "pages-0.txt"), "text/plain"],
    ]);
    // The document is text/plain too, and stays a file: its concept is native.Document.
    expect(artifacts?.map((item) => item.uri)).toEqual([DOCUMENT_URI, DOSSIER_PICTURE_URI]);
    expect(saved_paths).toEqual([
      OUTPUT_PATH,
      path.join(RUN_DIR, "report.md"),
      path.join(RUN_DIR, "pages-0.txt"),
      path.join(RUN_DIR, "notes.txt"),
      path.join(RUN_DIR, "cover.png"),
    ]);
    expect(all_saved).toBe(true);
    expect(result.summary).toContain("its main output, 2 stored text(s) and 2 file(s)");
  });

  it("tells a stored text by a concept only the input form describes", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: briefResults(),
    });

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.texts?.map((item) => [item.found_at, item.path])).toEqual([
      [["$.body.url"], path.join(RUN_DIR, "body.md")],
    ]);
    expect(result.structuredContent.artifacts).toEqual([]);
    expect(result.structuredContent.all_saved).toBe(true);
  });

  it("keeps a stored text that could not be saved as its own error, beside what was saved", async () => {
    const root = await makeTempDir();
    const missing = {
      ...STORED_PAGE,
      url: "pipelex-storage://org/runs/01JRUN/generated/gone/value.txt",
    };
    const pages = { items: [STORED_PAGE, missing] };
    const { client } = fakeClient({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: pages,
        working_memory: workingMemoryFor("native.Text", pages),
      },
    });

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.all_saved).toBe(false);
    const [saved, failed] = result.structuredContent.texts ?? [];
    expect(saved?.path).toBe(path.join(RUN_DIR, "items-0.txt"));
    expect(failed?.path).toBeUndefined();
    expect(failed?.mime_type).toBe("text/plain");
    expect(failed?.error?.code).toBe("input.reference_not_found");
    expect(result.structuredContent.saved_paths).toEqual([
      OUTPUT_PATH,
      path.join(RUN_DIR, "items-0.txt"),
    ]);
    expect(result.summary).toContain("`$.items[1].url`");
    expect(result.summary).toContain("failed");
  });

  it("names the stored texts saved before a credential was refused part-way through", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      { state: "completed", pipeline_run_id: RUN_ID, result: dossierResults() },
      async (request) => {
        const saved = path.join(request.dir, "report.md");
        await fs.writeFile(saved, TEXT_BODIES[REPORT_TEXT_URI]!);
        throw new ArtifactAuthenticationError(
          "The resolve route refused the credential (401) part-way through the download.",
          401,
          verdictOf([
            {
              uri: REPORT_TEXT_URI,
              kind: "text",
              found_at: ["$.report.url"],
              path: saved,
              content_type: "text/markdown",
              size: 4,
              error: null,
            },
            {
              uri: PAGE_TEXT_URI,
              kind: "text",
              found_at: ["$.pages[0].url"],
              path: null,
              content_type: "text/plain",
              size: null,
              error: { code: "aborted", detail: "stopped on a credential failure" },
            },
          ]),
        );
      },
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem?.code).toBe("auth.invalid_credential");
    expect(result.structuredContent).not.toHaveProperty("state");
    expect(result.structuredContent).not.toHaveProperty("artifacts");
    expect(result.structuredContent.saved_paths).toEqual([
      OUTPUT_PATH,
      path.join(RUN_DIR, "report.md"),
    ]);
    // Every text of the verdict rides, the failed one too, as a failed file
    // does beside a saved one: a consumer learns which text did not land.
    expect(result.structuredContent.texts?.map((item) => item.path)).toEqual([
      path.join(RUN_DIR, "report.md"),
      undefined,
    ]);
    expect(result.structuredContent.texts?.[1]?.error?.code).toBe("client.aborted");
    expect(result.summary).toContain("1 stored text(s)");
  });

  it("lists a failed stored text beside a file saved before a credential refusal", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      { state: "completed", pipeline_run_id: RUN_ID, result: dossierResults() },
      async (request) => {
        const saved = path.join(request.dir, "notes.txt");
        await fs.writeFile(saved, "notes");
        throw new ArtifactAuthenticationError(
          "The resolve route refused the credential (401) part-way through the download.",
          401,
          verdictOf([
            {
              uri: PAGE_TEXT_URI,
              kind: "text",
              found_at: ["$.pages[0].url"],
              path: null,
              content_type: "text/plain",
              size: null,
              error: { code: "aborted", detail: "stopped on a credential failure" },
            },
            {
              uri: DOCUMENT_URI,
              kind: "file",
              found_at: ["$.notes.url"],
              path: saved,
              content_type: "text/plain",
              size: 5,
              error: null,
            },
          ]),
        );
      },
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.texts).toEqual([
      expect.objectContaining({
        uri: PAGE_TEXT_URI,
        found_at: ["$.pages[0].url"],
        error: expect.objectContaining({ code: "client.aborted" }),
      }),
    ]);
    expect(result.structuredContent.artifacts?.map((item) => item.path)).toEqual([
      path.join(RUN_DIR, "notes.txt"),
    ]);
    expect(result.structuredContent.saved_paths).toEqual([
      OUTPUT_PATH,
      path.join(RUN_DIR, "notes.txt"),
    ]);
  });

  it("bounds the paths an entry lists, counting the rest, when the output repeats one reference", async () => {
    const root = await makeTempDir();
    const pages = Array.from({ length: MAX_FOUND_AT_PATHS + 5 }, () => ({
      source: { url: PICTURE_URI },
    }));
    const { client } = fakeClient(completedState({ pages }), savingDownload);

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    // One file, whatever the repetition: the first path named it and is kept,
    // the list stops at the cap, and the count covers the rest.
    const [entry] = result.structuredContent.artifacts ?? [];
    expect(result.structuredContent.artifacts).toHaveLength(1);
    expect(entry?.found_at).toEqual(
      Array.from({ length: MAX_FOUND_AT_PATHS }, (_, index) => `$.pages[${index}].source.url`),
    );
    expect(entry?.found_at_omitted).toBe(5);
    expect(entry?.path).toBe(path.join(RUN_DIR, "pages-0-source.png"));
    expect(result.summary).toContain(
      `← \`$.pages[0].source.url\` (and ${MAX_FOUND_AT_PATHS + 4} more)`,
    );
  });

  it("creates a relative dir inside the working directory before the SDK writes into it", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient(completedState(PICTURE_ONLY), savingDownload);

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "assets/run-1" },
      contextIn(root, client),
    );

    expect(requests[0]?.dir).toBe(path.join(await fs.realpath(root), "assets", "run-1"));
    expect(result.structuredContent.saved_paths).toEqual([
      path.join("assets", "run-1", "main_stuff.json"),
      path.join("assets", "run-1", "main_stuff.png"),
    ]);
    await expect(
      fs.stat(path.join(root, "assets", "run-1", "main_stuff.png")),
    ).resolves.toBeTruthy();
  });

  it("derives the plain-http opt-in from the base URL, and lets the override win", async () => {
    const root = await makeTempDir();
    const local = fakeClient(completedState(PICTURE_ONLY), savingDownload);
    await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      contextIn(root, local.client, { baseUrl: "http://localhost:8081" }),
    );
    expect(local.requests[0]?.allowHttp).toBe(true);

    const overridden = fakeClient(completedState(PICTURE_ONLY), savingDownload);
    await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      contextIn(root, overridden.client, { allowHttp: true }),
    );
    expect(overridden.requests[0]?.allowHttp).toBe(true);
  });

  it("refuses a dir escaping the working directory as a refused argument at dir, saving nothing", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient(completedState(PICTURE_ONLY));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "../outside" },
      contextIn(root, client),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "dir", reason: "outside_workspace" },
      location: { field: "dir" },
    });
    expect(requests).toEqual([]);
  });

  it("keeps partial success as a produced verdict — a failed sibling never hides a saved file", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      completedState({ a: { url: PICTURE_URI }, b: { url: REPORT_URI } }),
      async (request) => {
        const saved = path.join(request.dir, "a.png");
        await fs.writeFile(saved, PNG_BYTES);
        return verdictOf([
          {
            uri: PICTURE_URI,
            kind: "file",
            found_at: ["$.a.url"],
            path: saved,
            content_type: "image/png",
            size: 4,
            error: null,
          },
          {
            uri: REPORT_URI,
            kind: "file",
            found_at: ["$.b.url"],
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
      path.join(RUN_DIR, "a.png"),
    ]);
    // A file that was not saved still says which field it would have filled,
    // and why, as the SDK reads the fetch boundary's code, its sentence kept.
    const failed = result.structuredContent.artifacts?.[1];
    expect(Object.keys(failed ?? {}).sort()).toEqual(["content_type", "error", "found_at", "uri"]);
    expect(failed).toMatchObject({ uri: REPORT_URI, found_at: ["$.b.url"], content_type: null });
    expect(failed?.error).toMatchObject({
      code: "input.reference_not_found",
      domain: "input",
      retry: "no",
      next_step: { kind: "change_input" },
      params: { input: REPORT_URI },
      message: "The stored file is no longer available (HTTP 404).",
    });
    expect(result.summary).toContain("its main output and 1 of 2 file(s)");
    const line = result.summary
      .split("\n")
      .find((text) => text.startsWith(`- \`$.b.url\` (\`${REPORT_URI}\`) — failed: `));
    expect(line).toContain("The stored file is no longer available (HTTP 404).");
    expect(line).toContain("(`input.reference_not_found`)");
    expect(line).toContain("Next step: Point the input");
  });

  it("reads the download's own per-file codes into the core codes they are", async () => {
    const root = await makeTempDir();
    const uris = ["a", "b", "c", "d", "e", "f"].map(
      (name) => `pipelex-storage://runs/01JRUN/outputs/${name}.png`,
    );
    const failures: [string, string][] = [
      ["too_large", "The file is larger than the per-file limit."],
      ["total_limit_exceeded", "The download reached the call's total limit."],
      [
        "write_failed",
        "The file could not be created: EACCES: permission denied, open '/x/a.png'.",
      ],
      ["aborted", "The download was stopped before this file."],
      ["resolve_failed", "The bulk resolve route failed for this reference."],
      ["redirect_refused", "The store answered with a redirect."],
    ];
    const { client } = fakeClient(
      completedState(Object.fromEntries(uris.map((uri, index) => [`k${index}`, { url: uri }]))),
      () =>
        Promise.resolve(
          verdictOf(
            failures.map(([code, detail], index) => ({
              uri: uris[index] ?? "",
              kind: "file",
              found_at: [`$.k${index}.url`],
              path: null,
              content_type: null,
              size: null,
              error: { code, detail },
            })),
          ),
        ),
    );

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "out" },
      contextIn(root, client),
    );

    expect(result.structuredContent.status).toBe("ok");
    const errors = result.structuredContent.artifacts?.map((item) => item.error);
    expect(errors?.[0]).toMatchObject({
      code: "client.download_limit_exceeded",
      params: { limit: DOWNLOAD_MAX_FILE_BYTES },
      message: failures[0]?.[1],
    });
    expect(errors?.[1]).toMatchObject({
      code: "client.download_limit_exceeded",
      params: { limit: DOWNLOAD_MAX_TOTAL_BYTES },
    });
    expect(errors?.[2]).toMatchObject({
      code: "client.write_failed",
      params: { path: "out", reason: "EACCES" },
      location: { field: "dir" },
    });
    expect(errors?.[3]).toMatchObject({ code: "client.aborted", retry: "yes" });
    expect(errors?.[4]).toMatchObject({ code: "runtime.unavailable", retry: "yes" });
    // A code of the fetch boundary stays the SDK's to read.
    expect(errors?.[5]).toMatchObject({
      code: "client.link_refused",
      params: { reason: "redirect" },
    });
    for (const [index, error] of (errors ?? []).entries()) {
      expect(error?.message).toBe(failures[index]?.[1]);
    }
  });

  it("names the files saved before a credential refusal, on a no-verdict error", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(
      completedState({ a: { url: PICTURE_URI }, b: { url: REPORT_URI } }),
      async (request) => {
        const saved = path.join(request.dir, "a.png");
        await fs.writeFile(saved, PNG_BYTES);
        throw new ArtifactAuthenticationError(
          "The resolve route refused the credential (401) part-way through the download.",
          401,
          verdictOf([
            {
              uri: PICTURE_URI,
              kind: "file",
              found_at: ["$.a.url"],
              path: saved,
              content_type: "image/png",
              size: 4,
              error: null,
            },
            {
              uri: REPORT_URI,
              kind: "file",
              found_at: ["$.b.url"],
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
    expect(result.structuredContent.problem).toMatchObject({
      code: "auth.invalid_credential",
      domain: "account",
      retry: "no",
    });
    expect(result.summary).toContain("The API key is read from PIPELEX_API_KEY.");
    expect(result.summary).toContain("the run's main output and 1 file(s) were saved");
    expect(result.summary).toContain(`- \`${path.join(RUN_DIR, "a.png")}\``);
    // The files are on the caller's disk, so a machine consumer reads them
    // from the structured result rather than out of the prose — and calling
    // again would write suffixed copies beside them, not overwrite them. The
    // output was written before the download began, so it is among them.
    expect(result.structuredContent.output?.path).toBe(OUTPUT_PATH);
    expect(result.structuredContent.saved_paths).toEqual([
      OUTPUT_PATH,
      path.join(RUN_DIR, "a.png"),
    ]);
    expect(result.structuredContent.artifacts).toEqual([
      {
        uri: PICTURE_URI,
        found_at: ["$.a.url"],
        path: path.join(RUN_DIR, "a.png"),
        content_type: "image/png",
        size: 4,
      },
      {
        uri: REPORT_URI,
        found_at: ["$.b.url"],
        content_type: null,
        error: expect.objectContaining({
          code: "client.aborted",
          message: "stopped on a credential failure",
        }),
      },
    ]);
    // No verdict was produced, so nothing here may read as one.
    expect(result.structuredContent.state).toBeUndefined();
    expect(result.structuredContent.all_saved).toBeUndefined();
  });

  it("leaves artifacts out of a credential refused before any file was saved", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState(PICTURE_ONLY), () =>
      Promise.reject(
        new ArtifactAuthenticationError(
          "The resolve route refused the credential (401); no artifact was downloaded.",
          401,
          verdictOf([
            {
              uri: PICTURE_URI,
              kind: "file",
              found_at: ["$.url"],
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

    const problem = result.structuredContent.problem;
    expect(problem).toMatchObject({ code: "auth.invalid_credential", retry: "no" });
    // The summary opens on the refusal itself, the key's rather than an
    // unreachable API's, and never claims the run was not saved: its output was.
    expect(result.summary.split("\n")[0]).toBe(`## ${problem?.title ?? ""}`);
    expect(result.summary).toContain("The API key is read from PIPELEX_API_KEY.");
    expect(result.summary).not.toContain("could not be saved");
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
      return savingDownload(request);
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
    // The answer is the API's, but the fix is the caller's: naming dir.
    expect(empty.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      retry: "no",
      params: { argument: "dir", reason: "required" },
      location: { field: "dir" },
    });
    expect(empty.structuredContent.problem?.message).toContain("Pass dir");
    // `runs/` was created by the first save, so it alone carries the mark.
    expect(await fs.readdir(path.join(root, "runs"))).toEqual([".gitignore", "runevil"]);
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

  describe("the mark on a directory it creates", () => {
    const readMark = (root: string, ...segments: string[]) =>
      fs.readFile(path.join(root, ...segments, ".gitignore"), "utf8");
    const hasMark = (root: string, ...segments: string[]) =>
      fs.lstat(path.join(root, ...segments, ".gitignore")).then(
        () => true,
        () => false,
      );

    it("writes a .gitignore of * into runs/ when it creates it, says so once, and lists it nowhere", async () => {
      const root = await makeTempDir();
      const { client } = fakeClient(completedState({ answer: 42 }));

      const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

      expect(await readMark(root, "runs")).toBe(GENERATED_DIRECTORY_GITIGNORE);
      expect(GENERATED_DIRECTORY_GITIGNORE).toBe("*\n");
      // runs/ covers everything below it, so the run's own folder needs none.
      expect(await hasMark(root, RUN_DIR)).toBe(false);
      expect(result.structuredContent.saved_paths).toEqual([OUTPUT_PATH]);
      expect(result.summary).toContain("Created `runs` and gave it a `.gitignore` of `*`");
      expect(result.summary.split(".gitignore").length - 1).toBe(1);
    });

    it("marks the run's folder alone when runs/ already exists, leaving runs/ as it was", async () => {
      const root = await makeTempDir();
      await fs.mkdir(path.join(root, "runs"));
      const { client } = fakeClient(completedState({ answer: 42 }));

      await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

      expect(await hasMark(root, "runs")).toBe(false);
      expect(await readMark(root, RUN_DIR)).toBe("*\n");
    });

    it("marks only the directory the run lands in for a dir it names, never the ancestors it creates", async () => {
      const root = await makeTempDir();
      await fs.mkdir(path.join(root, "work"));
      const { client } = fakeClient(completedState({ answer: 42 }));

      const result = await downloadMthdsArtifacts(
        { run_id: RUN_ID, dir: "work/assets/run-1" },
        contextIn(root, client),
      );

      expect(await hasMark(root, "work")).toBe(false);
      // A directory the caller names is theirs to keep: an ancestor this call
      // created stays unmarked, so a file put there later is not hidden.
      expect(await hasMark(root, "work", "assets")).toBe(false);
      expect(await readMark(root, "work", "assets", "run-1")).toBe("*\n");
      expect(result.summary).toContain(
        `Created \`${path.join("work", "assets", "run-1")}\` and gave it a \`.gitignore\` of \`*\``,
      );
    });

    it("never marks a directory it found, nor touches the .gitignore one holds", async () => {
      const root = await makeTempDir();
      await fs.mkdir(path.join(root, "out"));
      await fs.writeFile(path.join(root, "out", ".gitignore"), "custom\n");
      await fs.mkdir(path.join(root, "plain"));
      const { client } = fakeClient(completedState({ answer: 42 }));

      const results = [
        await downloadMthdsArtifacts({ run_id: RUN_ID, dir: "out" }, contextIn(root, client)),
        await downloadMthdsArtifacts({ run_id: RUN_ID, dir: "plain" }, contextIn(root, client)),
        await downloadMthdsArtifacts({ run_id: RUN_ID, dir: "." }, contextIn(root, client)),
      ];

      expect(await readMark(root, "out")).toBe("custom\n");
      expect(await hasMark(root, "plain")).toBe(false);
      expect(await hasMark(root)).toBe(false);
      for (const result of results) expect(result.summary).not.toContain(".gitignore");
    });

    it("removes the directories it created when it cannot mark them, so a retry marks them", async () => {
      const root = await makeTempDir();
      await fs.mkdir(path.join(root, "work"));
      const { client, requests } = fakeClient(completedState({ answer: 42 }));
      const realWriteFile = fs.writeFile.bind(fs);
      const writeFile = vi.spyOn(fs, "writeFile").mockImplementation((file, data, options) => {
        if (typeof file === "string" && path.basename(file) === ".gitignore") {
          return Promise.reject(
            Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
          );
        }
        return realWriteFile(file, data, options);
      });
      let failed: Awaited<ReturnType<typeof downloadMthdsArtifacts>>;
      let defaultFailed: Awaited<ReturnType<typeof downloadMthdsArtifacts>>;
      try {
        failed = await downloadMthdsArtifacts(
          { run_id: RUN_ID, dir: "work/assets/run-1" },
          contextIn(root, client),
        );
        defaultFailed = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));
      } finally {
        writeFile.mockRestore();
      }

      for (const [result, marked] of [
        [failed, path.join("work", "assets", "run-1")],
        [defaultFailed, "runs"],
      ] as const) {
        expect(result.structuredContent.status).toBe("error");
        expect(result.structuredContent.problem).toMatchObject({
          code: "client.write_failed",
          params: { path: path.join(marked, ".gitignore"), reason: "ENOSPC" },
          location: { field: "dir" },
        });
        expect(result.structuredContent.problem?.message).toContain("ENOSPC");
      }
      expect(requests).toEqual([]);
      // Back to what it found: work/ stays, everything below it is gone.
      expect(await fs.readdir(root)).toEqual(["work"]);
      expect(await fs.readdir(path.join(root, "work"))).toEqual([]);

      const retried = await downloadMthdsArtifacts(
        { run_id: RUN_ID, dir: "work/assets/run-1" },
        contextIn(root, client),
      );

      expect(retried.structuredContent.status).toBe("ok");
      expect(await readMark(root, "work", "assets", "run-1")).toBe("*\n");
    });

    it("marks nothing when the run has nothing to save yet", async () => {
      const root = await makeTempDir();
      const { client } = fakeClient({
        state: "running",
        pipeline_run_id: RUN_ID,
        retry_after_seconds: 5,
      });

      await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

      expect(await fs.readdir(root)).toEqual([]);
    });
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
        const { client, requests } = fakeClient(completedState(PICTURE_ONLY));

        const result = await downloadMthdsArtifacts(
          { run_id: RUN_ID, dir: "locked" },
          contextIn(root, client),
        );

        expect(result.structuredContent.status).toBe("error");
        expect(result.structuredContent.problem).toMatchObject({
          code: "client.write_failed",
          retry: "no",
          params: { path: path.join("locked", "main_stuff.json"), reason: "EACCES" },
          location: { field: "dir" },
        });
        expect(result.structuredContent.problem?.message).toContain("main_stuff.json");
        expect(result.summary).toContain("Could not write main_stuff.json in locked");
        // Nothing was saved, so nothing reads as saved.
        expect(result.structuredContent.saved_paths).toBeUndefined();
        // A directory that cannot take the output will not take the files.
        expect(requests).toEqual([]);
        expect(await fs.readdir(locked)).toEqual([]);
      } finally {
        await fs.chmod(locked, 0o755);
      }
    },
  );

  it("refuses a climbing dir before the run is read, so a run still running refuses it too", async () => {
    const root = await makeTempDir();
    const { client, requests, reads } = fakeClient(completedState({ answer: 42 }));

    const result = await downloadMthdsArtifacts(
      { run_id: RUN_ID, dir: "../elsewhere" },
      contextIn(root, client),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "dir", reason: "outside_workspace" },
      location: { field: "dir" },
    });
    // The refusal is on the request itself: the run is never even read, so a
    // check moved back inside the download path would fail this.
    expect(reads).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reads a deployment without the bulk resolve route as a route it does not serve, naming the API in use", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState(PICTURE_ONLY), () =>
      Promise.reject(apiError("/v1/resolve-storage-url/bulk", 404)),
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.problem).toMatchObject({
      code: "request.not_found",
      retry: "no",
    });
    expect(result.summary).toContain(
      "The Pipelex API in use is the one PIPELEX_BASE_URL names, else the hosted Pipelex API.",
    );
    // The output was written before the bulk route was asked, so the refusal
    // still says where it is, and nothing reads as a download verdict.
    expect(result.structuredContent.output?.path).toBe(OUTPUT_PATH);
    expect(result.structuredContent.saved_paths).toEqual([OUTPUT_PATH]);
    expect(result.structuredContent.artifacts).toBeUndefined();
    expect(await fs.readFile(path.join(root, OUTPUT_PATH), "utf8")).toBe(
      outputBytes({ url: PICTURE_URI }),
    );
  });

  it("never reads a whole-request 400 on the bulk route as the caller's input", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState(PICTURE_ONLY), () =>
      Promise.reject(apiError("/v1/resolve-storage-url/bulk", 400)),
    );

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    // An answer that is no problem document, read by the SDK by its status.
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.response_unreadable",
      domain: "runtime",
      params: { status: 400 },
    });
    expect(result.structuredContent.problem?.location).toBeUndefined();
  });

  it("relays the API's problem for an unknown run id unchanged (no verdict)", async () => {
    const root = await makeTempDir();
    const notFound = buildProblem(
      "run.not_found",
      { pipeline_run_id: RUN_ID },
      { status: 404, extra: { request_id: "req_results_404" } },
    );
    const client: ArtifactClient = {
      getRunStatus: noStatusRead,
      getRunResult: () => Promise.reject(apiError(`/v1/runs/${RUN_ID}/results`, 404, notFound)),
      downloadArtifacts: () => Promise.reject(new Error("must not be called")),
    };

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(notFound);
    expect(result.summary).toContain(notFound.detail);
    expect(result.summary).toContain("`run.not_found`");
    expect(result.summary).toContain("Request id: `req_results_404`");
  });

  it("says where the key came from when the results route refuses it, before anything is saved", async () => {
    const root = await makeTempDir();
    const client: ArtifactClient = {
      getRunStatus: noStatusRead,
      getRunResult: () => Promise.reject(apiError(`/v1/runs/${RUN_ID}/results`, 401)),
      downloadArtifacts: () => Promise.reject(new Error("must not be called")),
    };

    const bare = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(bare.structuredContent.problem).toMatchObject({
      code: "auth.missing_credential",
      domain: "account",
    });
    expect(bare.summary.split("\n")[0]).toBe(`## ${bare.structuredContent.problem?.title ?? ""}`);
    expect(bare.summary).toContain("The API key is read from PIPELEX_API_KEY.");

    const noted = await downloadMthdsArtifacts(
      { run_id: RUN_ID },
      contextIn(root, client, { apiNotes: { apiKey: "Sign in again with the login command." } }),
    );

    expect(noted.summary).toContain("Sign in again with the login command.");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reads an unreachable API as retryable, naming the API in use", async () => {
    const root = await makeTempDir();
    const client: ArtifactClient = {
      getRunStatus: noStatusRead,
      getRunResult: () =>
        Promise.reject(
          new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
        ),
      downloadArtifacts: () => Promise.reject(new Error("must not be called")),
    };

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.problem).toMatchObject({
      code: "client.unreachable",
      retry: "yes",
      params: { base_url: DEFAULT_API_URL },
    });
    expect(result.summary).toContain("PIPELEX_BASE_URL");
  });

  it("treats a completed report without main_stuff as an answer it could not read", async () => {
    const root = await makeTempDir();
    const { client, requests } = fakeClient(completedState(null));

    const result = await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.response_unreadable",
      domain: "runtime",
      retry: "no",
    });
    expect(result.structuredContent.problem?.message).toContain("main_stuff");
    expect(requests).toEqual([]);
  });
});

describe("artifactsToolResult", () => {
  it("surfaces the per-file outcome in content and flags no-verdict results as errors", async () => {
    const root = await makeTempDir();
    const { client } = fakeClient(completedState(PICTURE_ONLY), savingDownload);
    const ok = artifactsToolResult(
      await downloadMthdsArtifacts({ run_id: RUN_ID }, contextIn(root, client)),
    );
    const bad = artifactsToolResult(
      await downloadMthdsArtifacts({ run_id: " " }, contextIn(root, client)),
    );

    expect(ok.isError).toBe(false);
    expect(ok.content[0]?.text).toContain(`\`${PICTURE_ONLY_FILE}\``);
    expect(ok).not.toHaveProperty("_meta");
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain("run_id must not be empty.");
    expect(bad.content[0]?.text).toContain("`client.argument_invalid`");
    expect(bad.structuredContent.problem?.location).toEqual({ field: "run_id" });
  });
});
