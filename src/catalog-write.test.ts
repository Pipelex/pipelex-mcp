import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ApiResponseError,
  ApiUnreachableError,
  MethodFileTransferError,
  RequestArgumentError,
} from "@pipelex/sdk";
import type {
  MethodData,
  MethodDetail,
  MethodDraftInput,
  MethodTreeSource,
  MethodVersion,
  MethodVersionSummary,
  MethodWriteInput,
  PipelexValidationResult,
  SavedMethodFile,
} from "@pipelex/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LINK_FILE_NAME,
  apiHostOf,
  linkLockFile,
  readMethodLink,
} from "./capabilities/catalog-link.js";
import {
  MAX_INLINE_SOURCE_BYTES,
  buildCatalogWriteContext,
  getMthdsMethod,
  saveMethodToolResult,
  saveMthdsMethod,
} from "./capabilities/catalog-write.js";
import type { CatalogWriteClient, CatalogWriteContext } from "./capabilities/catalog-write.js";
import { DEFAULT_API_URL, createPipelexApiClient } from "./capabilities/shared.js";
import type { Problem } from "./capabilities/shared.js";
import { GRAPH_PAGE_MARK } from "./capabilities/graph-page.js";
import { localMethodFileResolver } from "./files.js";

// ── fixtures ────────────────────────────────────────────────────────

const validReport = {
  is_valid: true,
  bundle_blueprint: { domain: "demo", main_pipe: "main" },
  pipe_io_contracts: {},
  validated_pipes: [],
  pending_signatures: [],
  liftable_pipes: [],
  warnings: [],
  is_runnable: true,
  message: "ok",
  rendered_markdown: "# Valid",
} as unknown as PipelexValidationResult;

const invalidReport = {
  is_valid: false,
  is_runnable: false,
  pending_signatures: [],
  message: "invalid",
  errors: [
    {
      code: "method.pipe_type_invalid",
      detail: "Pipe 'demo.main' has no usable type (reason: unknown_type).",
      params: { pipe: "demo.main", reason: "unknown_type" },
      location: { pipe: "demo.main", file: "bundle.mthds" },
    },
  ],
  rendered_markdown: "# Invalid",
} as unknown as PipelexValidationResult;

/** A validation context answering `report`, which must be asked about a tree, never a selector. */
function validationAnswering(report: PipelexValidationResult, capture?: { source?: unknown }) {
  return {
    baseUrl: DEFAULT_API_URL,
    client: {
      async validate(source: unknown): Promise<PipelexValidationResult> {
        if (typeof source !== "object" || source === null || !("tree" in source)) {
          throw new Error("a save validates the tree it read, never a selector");
        }
        if (capture !== undefined) {
          capture.source = source;
        }
        return report;
      },
    },
  } as unknown as CatalogWriteContext["validation"];
}

function linkFileOf(structured: {
  status: string;
}): { written: boolean; reason?: string } | undefined {
  return (structured as { link_file?: { written: boolean; reason?: string } }).link_file;
}

// ── the fake catalog's bytes ────────────────────────────────────────

/**
 * Every byte a test's catalog stores, by SHA-256. A listing names a file by
 * its hash, and the fake download writes from here, so no test follows a link
 * or sends a request to fetch a file.
 */
const blobs = new Map<string, Uint8Array>();

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A file of a saved tree as a method read lists it, its bytes kept in {@link blobs}. */
function savedFile(treePath: string, content: string | Uint8Array): SavedMethodFile {
  const bytes = bytesOf(content);
  const sha256 = sha256Of(bytes);
  blobs.set(sha256, bytes);
  return {
    path: treePath,
    sha256,
    size: bytes.byteLength,
    url: `https://blobs.example.test/${sha256}`,
    expires_at: "2026-09-20T13:00:00Z",
  };
}

/** A saved tree, in tree path order as the platform lists it. */
function treeOf(contents: Record<string, string | Uint8Array>): SavedMethodFile[] {
  return Object.entries(contents)
    .map(([treePath, content]) => savedFile(treePath, content))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * `writeMethodTree` as the SDK's: the destination must be absent or empty, and
 * every file lands at its path with the bytes its hash names.
 */
async function writeFromBlobs(
  files: readonly SavedMethodFile[],
  options: { destination: string },
): Promise<void> {
  const present = await fs.readdir(options.destination).catch(() => [] as string[]);
  if (present.length > 0) {
    throw new Error(`${options.destination} is not empty`);
  }
  await fs.mkdir(options.destination, { recursive: true });
  for (const file of files) {
    const bytes = blobs.get(file.sha256);
    if (bytes === undefined) {
      throw new MethodFileTransferError(`No stored bytes for ${file.path}.`, {
        operation: "download",
        reason: "storage_error",
        sha256: file.sha256,
        path: file.path,
      });
    }
    const target = path.join(options.destination, ...file.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

/** Every file of a tree a save sent, as text, read through the source the SDK reads. */
async function sentContents(
  tree: MethodTreeSource | null | undefined,
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const file of tree?.files ?? []) {
    contents[file.path] = new TextDecoder().decode(await tree!.readFile(file.path));
  }
  return contents;
}

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function storedMethod(overrides: Partial<MethodDetail> = {}): MethodDetail {
  return {
    method_id: "mt_one",
    org_id: "org_1",
    created_by_user_id: "user_1",
    name: "Summarize PDF",
    files: treeOf({ "bundle.mthds": 'domain = "demo"' }),
    input_data: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-20T12:00:00Z",
    draft_digest: DIGEST_A,
    latest_version: null,
    latest_published: null,
    ...overrides,
  };
}

/** A published version's summary; its tree digest defaults to the draft's, so the draft is unchanged. */
function versionSummary(overrides: Partial<MethodVersionSummary> = {}): MethodVersionSummary {
  return {
    version: 2,
    tree_digest: DIGEST_A,
    crate_fingerprint: "crate-fp",
    runner_version: "0.78.0",
    description: null,
    published_at: "2026-09-19T08:00:00Z",
    published_by: "user_1",
    ...overrides,
  };
}

/** A stored method published as version 2, with the draft ahead of it unless `ahead` is false. */
function publishedMethod(overrides: Partial<MethodDetail> = {}, ahead = true): MethodDetail {
  return storedMethod({
    latest_version: 2,
    latest_published: versionSummary(ahead ? { tree_digest: DIGEST_B } : {}),
    ...overrides,
  });
}

/** A stored version of `mt_one`. */
function storedVersion(overrides: Partial<MethodVersion> = {}): MethodVersion {
  return {
    ...versionSummary(),
    method_id: "mt_one",
    files: treeOf({ "bundle.mthds": 'domain = "version_two"' }),
    ...overrides,
  };
}

/**
 * A platform refusal as the hosted API answers it: a problem document, which
 * the SDK reads as it came, its request id on the header, and the error the
 * SDK raises for it, whose message names the route (`API <METHOD> <path>
 * failed (<status>): <detail>`) and whose `apiUrl` is the base URL. The
 * method is the route's usual one; nothing reads it.
 */
function platformRefusal(
  route: string,
  status: number,
  problem: { code: string; title: string; detail: string; domain: string } & Record<
    string,
    unknown
  >,
): ApiResponseError {
  const method = route.endsWith("/draft")
    ? "PUT"
    : route === "/v1/methods" || route.startsWith("/v1/blobs/") || route === "/v1/validate"
      ? "POST"
      : "GET";
  return new ApiResponseError(
    `API ${method} ${route} failed (${status}): ${problem.detail}`,
    "https://api-dev.pipelex.com",
    status,
    "Refused",
    JSON.stringify({
      type: `https://docs.pipelex.com/errors/${problem.code}`,
      status,
      retry: "no",
      next_step: { kind: "change_input", detail: "Change the request, then send it again." },
      ...problem,
    }),
    { headers: { "x-request-id": `req_${status}` } },
  );
}

/** The 409 the draft write answers for a stale token. */
function draftConflict(): ApiResponseError {
  return platformRefusal("/v1/methods/mt_one/draft", 409, {
    code: "pipelex.catalog.update_conflict",
    title: "The method changed since your token",
    detail: "The method's draft changed since expected_updated_at.",
    domain: "input",
    next_step: { kind: "reread", detail: "Read the method again, then decide what to send." },
    location: { field: "expected_updated_at" },
  });
}

/** The 401 the platform answers a call that carries no key. */
function refusedKey(route: string): ApiResponseError {
  return platformRefusal(route, 401, {
    code: "auth.missing_credential",
    title: "No credential was sent",
    detail: "This route needs a credential, and the request carried none.",
    domain: "account",
    next_step: {
      kind: "check_credentials",
      detail: "Send the request with a credential this runtime accepts.",
    },
  });
}

/**
 * The platform's refusal by role: the key was accepted, and the role its owner
 * holds does not allow a method change, which is how a runner's save is met.
 */
function roleRefusal(route: string, detail: string): ApiResponseError {
  return platformRefusal(route, 403, {
    code: "auth.forbidden",
    title: "The credential does not permit this",
    detail,
    domain: "account",
    params: { requirement: "method_write" },
    next_step: {
      kind: "request_access",
      detail: "Ask for 'method_write' on this account, then send the request again.",
    },
  });
}

const RUNNER_CHANGE_DETAIL =
  "Your role in this organization is runner: it runs the organization's published versions and changes no method.";

/**
 * A client whose every call to the platform throws — each test opts into the
 * one it needs. Its download writes from {@link blobs}, which sends nothing.
 */
const clientNotCalled: CatalogWriteClient = {
  async getMethod(): Promise<MethodDetail> {
    throw new Error("getMethod must not be called in this test");
  },
  async createMethod(): Promise<MethodData> {
    throw new Error("createMethod must not be called in this test");
  },
  async writeDraft(): Promise<MethodData> {
    throw new Error("writeDraft must not be called in this test");
  },
  async renameMethod(): Promise<MethodData> {
    throw new Error("renameMethod must not be called in this test");
  },
  async getMethodVersion(): Promise<MethodVersion> {
    throw new Error("getMethodVersion must not be called in this test");
  },
  async publishMethod(): Promise<never> {
    throw new Error("publishMethod must not be called in this test");
  },
  writeMethodTree: writeFromBlobs,
};

/** `GET /v1/version` as a platform that resolves version selectors answers it. */
async function versionsSupported(): Promise<unknown> {
  return { version: "1.0.0", extensions: ["runs", "method_versions"] };
}

/** `GET /v1/version` as a platform that does not resolve them yet answers it. */
async function versionsUnsupported(): Promise<unknown> {
  return { version: "1.0.0", extensions: ["runs"] };
}

let root: string;
let home: string;
let savedHome: string | undefined;

// Every save and pull takes the workshop's write lock, which lives under the
// home directory, and `os.homedir()` reads HOME on every call: each test gets
// a home of its own, outside the working directory, so none contends with
// another file's, writes into the real one, or leaves anything in `root`.
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "catalog-write-")));
  home = await fs.mkdtemp(path.join(tmpdir(), "catalog-write-home-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

function contextFor(
  client: CatalogWriteClient,
  validation: CatalogWriteContext["validation"],
): CatalogWriteContext {
  return {
    baseUrl: "https://api-dev.pipelex.com",
    client,
    resolver: localMethodFileResolver(root, { save: true }),
    saveRoot: root,
    validation,
  };
}

async function writeBundle(dir: string, files: Record<string, string | Uint8Array>): Promise<void> {
  await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

/** Write a link file's bytes as given, making the folder's `.pipelex` first. */
async function writeLinkFile(file: string, content: string, encoding: BufferEncoding = "utf8") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, encoding);
}

/** The one problem of a call that produced no result; a test expecting one fails on anything else. */
function problemOf(structured: { status: string; problem?: Problem }): Problem {
  if (structured.status !== "error" || structured.problem === undefined) {
    throw new Error(`expected a problem: ${JSON.stringify(structured)}`);
  }
  return structured.problem;
}

/** What every no-result summary renders of its problem: its title, detail, next step and code. */
function expectProblemSummary(summary: string, problem: Problem): void {
  expect(summary).toContain(`## ${problem.title}`);
  expect(summary).toContain(problem.detail);
  expect(summary).toContain(problem.next_step.detail);
  expect(summary).toContain(`\`${problem.code}\``);
}

// ── mthds_save_method ───────────────────────────────────────────────

describe("saveMthdsMethod", () => {
  it("creates when method_id is absent, sending the folder's whole tree", async () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x10]);
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "pipes/extra.mthds": 'pipe = "extra"',
      "funcs/helpers.py": "def total(items):\n    return sum(items)\n",
      "templates/letter.docx": docx,
      "data/rates.csv": "code,rate\nEUR,1\n",
    });

    let sent: MethodWriteInput | undefined;
    const validated: { source?: unknown } = {};
    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(input) {
            sent = input;
            return storedMethod({ name: "Demo" });
          },
        },
        validationAnswering(validReport, validated),
      ),
    );

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      is_valid: true,
      saved: "created",
      files_sent: [
        path.join("methods/demo", "bundle.mthds"),
        path.join("methods/demo", "data", "rates.csv"),
        path.join("methods/demo", "funcs", "helpers.py"),
        path.join("methods/demo", "pipes", "extra.mthds"),
        path.join("methods/demo", "templates", "letter.docx"),
      ],
    });
    // A tree, in tree path order, every file at its path: no order rule is
    // left for the caller, since the platform reads the listed description
    // from the first .mthds file in path order that declares one.
    expect(sent).not.toHaveProperty("files");
    expect(sent).not.toHaveProperty("contents");
    expect(sent?.tree?.files.map((file) => file.path)).toEqual([
      "bundle.mthds",
      "data/rates.csv",
      "funcs/helpers.py",
      "pipes/extra.mthds",
      "templates/letter.docx",
    ]);
    expect(sent?.tree?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The bytes the SDK sends are the bytes on disk, binary ones included.
    expect(await sent?.tree?.readFile("templates/letter.docx")).toEqual(docx);
    expect((await sentContents(sent?.tree))["funcs/helpers.py"]).toContain("return sum(items)");
    // The validation saw the same tree, from the same read: every file, by hash.
    const validatedTree = (validated.source as { tree: MethodTreeSource }).tree;
    expect(validatedTree.files).toEqual(sent?.tree?.files);
    expect(validatedTree.digest).toBe(sent?.tree?.digest);
    expect(await validatedTree.readFile("templates/letter.docx")).toEqual(docx);
    expect(result.summary).toContain("5 files, listed in files_sent");
  });

  it("leaves a run's inputs file and the workshop's graph page out of the saved tree, naming the page", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "inputs.json": '{"text": "one run\'s data"}',
      "method-graph.html": `<!doctype html>\n${GRAPH_PAGE_MARK}\n<html></html>\n`,
    });

    let sent: MethodWriteInput | undefined;
    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(input) {
            sent = input;
            return storedMethod({ name: "Demo" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(sent?.tree?.files.map((file) => file.path)).toEqual(["bundle.mthds"]);
    expect(result.structuredContent).toMatchObject({
      files_sent: [path.join("methods/demo", "bundle.mthds")],
    });
    // The standard leaves the inputs file out, unlisted; the page is the
    // workshop's own to leave out, so the summary names it.
    expect(result.summary).toContain(
      `Left out, as never part of a method: \`${path.join("methods/demo", "method-graph.html")}\`, the page mthds_validate regenerates.`,
    );
    expect(result.summary).not.toContain("inputs.json");
  });

  it("writes the link file beside the root file and reports it", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod() {
            return storedMethod({ name: "Demo" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({
      link_file: { path: path.join("methods/demo", LINK_FILE_NAME), written: true },
    });
    const link = await readMethodLink(path.join(root, "methods/demo"));
    expect(link.kind).toBe("link");
    expect(link.kind === "link" && link.link).toMatchObject({
      method_id: "mt_one",
      name: "Demo",
      api_host: "api-dev.pipelex.com",
      synced_updated_at: "2026-09-20T12:00:00Z",
    });
    expect(result.summary).toContain("commit it");
  });

  it("saves an invalid bundle as a draft, with the verdict beside the save", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": "broken" });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod() {
            return storedMethod({ name: "Demo" });
          },
        },
        validationAnswering(invalidReport),
      ),
    );

    // A produced verdict: status ok, discriminated on is_valid, and the draft
    // saved all the same — a draft is work in progress, and a publish is where
    // validity is required.
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      is_valid: false,
      saved: "created",
      method_id: "mt_one",
      link_file: { written: true },
    });
    // The verdict's faults, relayed as the API sent them, one problem item each.
    expect(result.structuredContent).toMatchObject({
      validation_errors: [
        {
          code: "method.pipe_type_invalid",
          params: { pipe: "demo.main", reason: "unknown_type" },
          location: { pipe: "demo.main", file: "bundle.mthds" },
        },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty("validation_warnings");
    expect(result.summary).toContain("NOT valid");
    expect(result.summary).toContain("a publish refuses it");
  });

  it("validates the tree it saves, an empty nested .mthds file included, leaving the verdict to the runner", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "drafts/next.mthds": "",
    });
    let sent: MethodWriteInput | undefined;
    const validated: { source?: unknown } = {};

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(input) {
            sent = input;
            return storedMethod({ name: "Demo" });
          },
        },
        validationAnswering(invalidReport, validated),
      ),
    );

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      is_valid: false,
      saved: "created",
    });
    expect(result.structuredContent).not.toHaveProperty("not_validated");
    const paths = ["bundle.mthds", "drafts/next.mthds"];
    expect(sent?.tree?.files.map((file) => file.path)).toEqual(paths);
    expect(
      (validated.source as { tree: MethodTreeSource }).tree.files.map((file) => file.path),
    ).toEqual(paths);
    expect(result.summary).toContain("NOT valid");
  });

  it("refuses the save when validation produces no verdict", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const unreachable = {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validate(): Promise<PipelexValidationResult> {
          throw new ApiUnreachableError(
            "down",
            "https://api-dev.pipelex.com/v1/validate",
            "ECONNREFUSED",
          );
        },
      },
    } as unknown as CatalogWriteContext["validation"];

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(clientNotCalled, unreachable),
    );

    // The validation's own problem, as the SDK read it, and a summary that
    // renders why no verdict came, not only that none did.
    const problem = problemOf(result.structuredContent);
    expect(problem).toMatchObject({ code: "client.unreachable", domain: "runtime", retry: "yes" });
    expectProblemSummary(result.summary, problem);
    expect(result.summary).toContain("validating it produced no verdict");
  });

  it("saves a method holding Python unvalidated when the deployment refuses to load it", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "tools/helpers.py": "def helper():\n    return 1\n",
    });
    const sandboxOnly = {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validate(): Promise<PipelexValidationResult> {
          throw platformRefusal("/v1/validate", 501, {
            code: "pipelex.deployment.custom_code_requires_sandbox",
            title: "Custom code needs a sandbox-hosted deployment",
            detail: "This method ships custom Python (.py); it needs a sandbox-hosted deployment",
            domain: "operator",
            next_step: {
              kind: "use_another_deployment",
              detail: "Run it on a sandbox-hosted deployment.",
            },
          });
        },
      },
    } as unknown as CatalogWriteContext["validation"];
    let sent: MethodWriteInput | undefined;

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(input) {
            sent = input;
            return storedMethod({ name: "Demo" });
          },
        },
        sandboxOnly,
      ),
    );

    // Saved, the refusal beside it and no verdict claimed either way.
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      saved: "created",
      method_id: "mt_one",
      validation_refused: {
        code: "pipelex.deployment.custom_code_requires_sandbox",
        domain: "operator",
        retry: "no",
        detail: "This method ships custom Python (.py); it needs a sandbox-hosted deployment",
        request_id: "req_501",
      },
      files_sent: [
        path.join("methods/demo", "bundle.mthds"),
        path.join("methods/demo", "tools", "helpers.py"),
      ],
    });
    expect(result.structuredContent).not.toHaveProperty("is_valid");
    expect(result.structuredContent).not.toHaveProperty("is_runnable");
    expect(sent?.tree?.files.map((file) => file.path)).toEqual([
      "bundle.mthds",
      "tools/helpers.py",
    ]);
    expect(result.summary).toContain("NOT validated");
    expect(result.summary).toContain("sandbox-hosted deployment.");
    expect(result.summary).toContain("Run it on a sandbox-hosted deployment.");
    expect(result.summary).not.toContain("NOT valid.");
  });

  it("requires a name to create", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const problem = problemOf(result.structuredContent);
    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "name", reason: "missing" },
      location: { field: "name" },
    });
    expect(problem.message).toContain("name is required to create a method.");
    expectProblemSummary(result.summary, problem);
  });

  it("writes the draft through method_id, sending neither input_data nor the name", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    let sentId: string | undefined;
    let sent: MethodDraftInput | undefined;
    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(id, input) {
            sentId = id;
            sent = input;
            return storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      saved: "updated",
      name: "Summarize PDF",
      updated_at: "2026-09-21T09:00:00Z",
      latest_version: null,
      publish_state: "never_published",
    });
    expect(sentId).toBe("mt_one");
    // The draft route keeps input_data on omission, so the form inputs a webapp
    // user saved survive; the name is the method's, renamed by its own call.
    expect(sent).not.toHaveProperty("input_data");
    expect(sent).not.toHaveProperty("name");
    // No token was given, so none is sent: the write is last-writer-wins.
    expect(sent).not.toHaveProperty("expected_updated_at");
    // The link carries the draft's new token, for the next write.
    const link = await readMethodLink(path.join(root, "methods/demo"));
    expect(link.kind === "link" && link.link.synced_updated_at).toBe("2026-09-21T09:00:00Z");
    expect(link.kind === "link" && link.link).not.toHaveProperty("synced_version");
    expect(result.summary).toContain("The draft of **Summarize PDF** was saved");
    expect(result.summary).toContain("`mt_one@draft`");
    expect(result.summary).toContain("only when the user asks");
  });

  it("forwards expected_updated_at to the draft write as its compare-and-swap", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    let sent: MethodDraftInput | undefined;
    await saveMthdsMethod(
      {
        method_dir: "methods/demo",
        method_id: "mt_one",
        expected_updated_at: "2026-09-20T12:00:00Z",
      },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(_id, input) {
            sent = input;
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(sent?.expected_updated_at).toBe("2026-09-20T12:00:00Z");
  });

  it("sends the link file's token when the caller gave none, and says where it came from", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-19T00:00:00Z",
      }),
    });

    let sent: MethodDraftInput | undefined;
    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(_id, input): Promise<MethodData> {
            sent = input;
            throw draftConflict();
          },
          async getMethod() {
            return storedMethod({ updated_at: "2026-09-20T12:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    // A save from a linked directory never replaces a draft somebody saved
    // since the directory synced: the link's token is the compare-and-swap.
    expect(sent?.expected_updated_at).toBe("2026-09-19T00:00:00Z");
    const error = problemOf(result.structuredContent);
    // The catalog's own problem, relayed, its message naming both tokens.
    expect(error).toMatchObject({
      code: "pipelex.catalog.update_conflict",
      domain: "input",
      retry: "no",
      location: { field: "expected_updated_at" },
      request_id: "req_409",
    });
    expect(error.message).toContain(`as this folder's ${LINK_FILE_NAME} records`);
    expect(error.message).toContain("the draft's current updated_at");
    // Refused: the link is left as it was.
    const link = await readMethodLink(path.join(root, "methods/demo"));
    expect(link.kind === "link" && link.link.synced_updated_at).toBe("2026-09-19T00:00:00Z");
  });

  it("refuses a save from a directory holding a pulled version unless the token is passed", async () => {
    const link = {
      method_id: "mt_one",
      name: "Summarize PDF",
      api_host: "api-dev.pipelex.com",
      synced_updated_at: "2026-09-20T12:00:00Z",
      synced_version: 2,
    };
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "version_two"',
      [LINK_FILE_NAME]: JSON.stringify(link),
    });

    // Saving a pulled version replaces the draft with it: a restore, which the
    // link's own token must not make silent.
    const validated: { source?: unknown } = {};
    const refused = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one" },
      contextFor(clientNotCalled, validationAnswering(validReport, validated)),
    );
    // The link alone refuses it, so nothing is read or validated first.
    expect(validated.source).toBeUndefined();
    const error = problemOf(refused.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "expected_updated_at", reason: "version_pulled" },
      location: { field: "expected_updated_at" },
    });
    expect(error.message).toContain("holds version 2");
    expect(error.message).toContain('expected_updated_at "2026-09-20T12:00:00Z"');
    expectProblemSummary(refused.summary, error);
    expect(refused.summary).toContain("holds version 2");

    // With the token, after the user asked, the restore goes through.
    let sent: MethodDraftInput | undefined;
    const restored = await saveMthdsMethod(
      {
        method_dir: "methods/demo",
        method_id: "mt_one",
        expected_updated_at: "2026-09-20T12:00:00Z",
      },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(_id, input) {
            sent = input;
            return storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );
    expect(restored.structuredContent.status).toBe("ok");
    expect(sent?.expected_updated_at).toBe("2026-09-20T12:00:00Z");
    const relinked = await readMethodLink(path.join(root, "methods/demo"));
    expect(relinked.kind === "link" && relinked.link).toMatchObject({
      synced_updated_at: "2026-09-21T09:00:00Z",
    });
    expect(relinked.kind === "link" && relinked.link).not.toHaveProperty("synced_version");
  });

  it("refuses a save from a directory whose last pull never finished", async () => {
    for (const fields of [
      { synced_updated_at: "2026-09-20T12:00:00Z", partial_pull: true },
      { synced_updated_at: "" },
    ]) {
      await writeBundle("methods/demo", {
        "bundle.mthds": 'domain = "demo"',
        [LINK_FILE_NAME]: JSON.stringify({
          method_id: "mt_one",
          name: "Summarize PDF",
          api_host: "api-dev.pipelex.com",
          ...fields,
        }),
      });

      const result = await saveMthdsMethod(
        { method_dir: "methods/demo", method_id: "mt_one" },
        contextFor(clientNotCalled, validationAnswering(validReport)),
      );

      const error = problemOf(result.structuredContent);
      expect(error).toMatchObject({
        code: "client.argument_invalid",
        domain: "input",
        params: { argument: "method_dir", reason: "partial_pull" },
        location: { field: "method_dir" },
      });
      expect(error.message).toContain("was interrupted");
      expect(error.message).toContain("Pull the method into the folder again");
    }
  });

  it("refuses a save from a directory whose link cannot be read, and leaves the link alone", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: "<<<<<<< HEAD",
    });

    // Read as no link, the save would send no token and replace the draft
    // whatever it holds now.
    const refused = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );
    const error = problemOf(refused.structuredContent);
    expect(error).toMatchObject({
      code: "client.file_unreadable",
      domain: "input",
      retry: "no",
      params: {
        path: path.join("methods/demo", LINK_FILE_NAME),
        reason: "link_unreadable",
      },
      location: { field: "method_dir" },
    });
    expect(error.message).toContain("cannot be read");
    expect(error.message).toContain("merge conflict");

    // An explicit token is its own guard; the broken link is still not touched.
    const saved = await saveMthdsMethod(
      {
        method_dir: "methods/demo",
        method_id: "mt_one",
        expected_updated_at: "2026-09-20T12:00:00Z",
      },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft() {
            return storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );
    expect(saved.structuredContent.status).toBe("ok");
    expect(saved.summary).toContain("cannot be read");
    expect(await fs.readFile(path.join(root, "methods/demo", LINK_FILE_NAME), "utf8")).toBe(
      "<<<<<<< HEAD",
    );
  });

  /** A draft compare-and-swapped as the platform does, with its version 2 stored beside it. */
  function platformDraft(initial: Record<string, string>) {
    const state = {
      files: treeOf(initial),
      content: Object.values(initial).join("\n"),
      updatedAt: "T0",
      writes: 0,
    };
    const client: CatalogWriteClient = {
      ...clientNotCalled,
      async writeDraft(_id, input) {
        if (
          input.expected_updated_at !== undefined &&
          input.expected_updated_at !== state.updatedAt
        ) {
          throw draftConflict();
        }
        const contents = await sentContents(input.tree);
        state.writes += 1;
        state.files = treeOf(contents);
        state.content = Object.values(contents).join("\n");
        state.updatedAt = `T${state.writes}`;
        return storedMethod({ files: state.files, updated_at: state.updatedAt });
      },
      async getMethod() {
        return storedMethod({
          files: state.files,
          updated_at: state.updatedAt,
          latest_version: 2,
          latest_published: versionSummary({ tree_digest: DIGEST_B }),
        });
      },
      async getMethodVersion() {
        return storedVersion();
      },
    };
    return { state, client };
  }

  /** A validation whose first call waits for `release`, counting every call. */
  function gatedValidation() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counts = { validations: 0 };
    const validation = {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validate(): Promise<PipelexValidationResult> {
          counts.validations += 1;
          if (counts.validations === 1) await gate;
          return validReport;
        },
      },
    } as unknown as CatalogWriteContext["validation"];
    return { validation, counts, release: () => release() };
  }

  it("refuses the older of two overlapping saves from one directory, never replacing the newer draft", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "older"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "T0",
      }),
    });
    const { state, client } = platformDraft({ "bundle.mthds": 'domain = "demo"' });
    const { validation, counts, release } = gatedValidation();
    const save = () =>
      saveMthdsMethod(
        { method_dir: "methods/demo", method_id: "mt_one" },
        contextFor(client, validation),
      );

    const first = save();
    await vi.waitFor(() => expect(counts.validations).toBe(1));
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "newer"' });
    // No turn is held across the first save's validation, so the second runs
    // to the end while the first waits on the platform.
    const second = await save();
    expect(second.structuredContent).toMatchObject({ status: "ok", updated_at: "T1" });
    expect(state.content).toContain("newer");
    release();

    // Both read the same token, and the platform takes only one write under
    // it: the older bytes are refused rather than replace the newer draft.
    const error = problemOf((await first).structuredContent);
    expect(error).toMatchObject({
      code: "pipelex.catalog.update_conflict",
      location: { field: "expected_updated_at" },
    });
    expect(state.content).toContain("newer");
    expect(state.writes).toBe(1);
    const link = await readMethodLink(path.join(root, "methods/demo"));
    expect(link.kind === "link" && link.link.synced_updated_at).toBe("T1");
  });

  it("lets a pull land while a save validates, and leaves its version marker standing", async () => {
    const { state, client } = platformDraft({ "bundle.mthds": 'domain = "demo"' });
    await writeBundle("work", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "T0",
      }),
    });
    const { validation, counts, release } = gatedValidation();
    const context = contextFor(client, validation);

    const saving = saveMthdsMethod({ method_dir: "work", method_id: "mt_one" }, context);
    await vi.waitFor(() => expect(counts.validations).toBe(1));
    // The save holds no turn while it waits on the platform, so the pull is
    // not delayed by it.
    const pulled = await getMthdsMethod({ method_id: "mt_one@2", output_dir: "work" }, context);
    expect(pulled.structuredContent.status).toBe("ok");
    release();

    const saved = await saving;
    // The save sent the bytes it read before the pull, under the token they
    // were read against.
    expect(saved.structuredContent).toMatchObject({ status: "ok", saved: "updated" });
    expect(state.content).toContain('domain = "demo"');
    // Its link write found the pull's link, not the one it read, and left it:
    // the directory holds version 2, and the link still says so.
    expect(linkFileOf(saved.structuredContent)).toMatchObject({ written: false });
    expect(saved.summary).toContain("was not refreshed");
    const link = await readMethodLink(path.join(root, "work"));
    expect(link.kind === "link" && link.link.synced_version).toBe(2);

    // So an ordinary save is refused rather than restoring version 2.
    const after = await saveMthdsMethod(
      { method_dir: "work", method_id: "mt_one" },
      contextFor(client, validationAnswering(validReport)),
    );
    expect(problemOf(after.structuredContent)).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "expected_updated_at", reason: "version_pulled" },
      location: { field: "expected_updated_at" },
    });
    expect(state.writes).toBe(1);
  });

  it("refuses a save whose link moved while it read the files, sending nothing", async () => {
    // A writer that takes no write lock — an editor, a git checkout, an older
    // workshop pulling version 2 — moves the link while the save reads the
    // files, so the save sees it move by the time its own files are in hand:
    // the bytes may be that writer's, or a mix.
    await writeBundle("work", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "T0",
      }),
    });
    const local = localMethodFileResolver(root, { save: true });
    const context: CatalogWriteContext = {
      ...contextFor(clientNotCalled, validationAnswering(validReport)),
      resolver: {
        ...local,
        async readMethodTree(location, options) {
          await writeLinkFile(
            path.join(root, "work", LINK_FILE_NAME),
            JSON.stringify({
              method_id: "mt_one",
              name: "Summarize PDF",
              api_host: "api-dev.pipelex.com",
              synced_updated_at: "T0",
              partial_pull: true,
            }),
            "utf8",
          );
          return local.readMethodTree!(location, options);
        },
      },
    };

    const result = await saveMthdsMethod({ method_dir: "work", method_id: "mt_one" }, context);

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.workspace_busy",
      domain: "runtime",
      retry: "yes",
      params: { path: path.join("work", LINK_FILE_NAME) },
      location: { field: "method_dir" },
    });
    expect(error.message).toContain("changed while this save read the files");
    expect(error.message).toContain("Nothing was sent");
  });

  it("leaves a link another process wrote while the save waited on the platform", async () => {
    const { state, client } = platformDraft({ "bundle.mthds": 'domain = "demo"' });
    await writeBundle("work", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "T0",
      }),
    });
    const { validation, counts, release } = gatedValidation();
    const saving = saveMthdsMethod(
      { method_dir: "work", method_id: "mt_one" },
      contextFor(client, validation),
    );
    await vi.waitFor(() => expect(counts.validations).toBe(1));
    // Written straight to disk, outside this process's turn, as another
    // workshop process pulling version 2 would leave it.
    const theirs = JSON.stringify({
      method_id: "mt_one",
      name: "Summarize PDF",
      api_host: "api-dev.pipelex.com",
      synced_updated_at: "T0",
      synced_version: 2,
    });
    await writeLinkFile(path.join(root, "work", LINK_FILE_NAME), theirs, "utf8");
    release();

    const saved = await saving;
    expect(saved.structuredContent).toMatchObject({ status: "ok" });
    expect(state.writes).toBe(1);
    expect(linkFileOf(saved.structuredContent)).toMatchObject({ written: false });
    expect(linkFileOf(saved.structuredContent)?.reason).toContain(
      "another save or pull rewrote it",
    );
    expect(await fs.readFile(path.join(root, "work", LINK_FILE_NAME), "utf8")).toBe(theirs);
  });

  it("reports a link that became unreadable while the save waited as changed", async () => {
    // Round 2: a link turned into a merge conflict mid-save was reported as one
    // that was always unreadable, not as a change this save did not make.
    const { client } = platformDraft({ "bundle.mthds": 'domain = "demo"' });
    await writeBundle("work", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "T0",
      }),
    });
    const { validation, counts, release } = gatedValidation();
    const saving = saveMthdsMethod(
      { method_dir: "work", method_id: "mt_one" },
      contextFor(client, validation),
    );
    await vi.waitFor(() => expect(counts.validations).toBe(1));
    const conflicted = "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n";
    await writeLinkFile(path.join(root, "work", LINK_FILE_NAME), conflicted, "utf8");
    release();

    const saved = await saving;
    expect(saved.structuredContent).toMatchObject({ status: "ok" });
    expect(linkFileOf(saved.structuredContent)?.reason).toContain(
      "it became unreadable while this call ran",
    );
    expect(saved.summary).toContain("It no longer holds what this save read");
    expect(await fs.readFile(path.join(root, "work", LINK_FILE_NAME), "utf8")).toBe(conflicted);
  });

  it("reads mt_…@draft as the bare id, and refuses a version", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    let sentId: string | undefined;
    const drafted = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one@draft" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(id) {
            sentId = id;
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );
    expect(drafted.structuredContent.status).toBe("ok");
    expect(sentId).toBe("mt_one");

    const versioned = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one@3" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );
    const error = problemOf(versioned.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "method_id", reason: "version_selector" },
      location: { field: "method_id" },
    });
    expect(error.message).toContain('"mt_one"');
  });

  it("renames through its own call when the name changed, after the draft write", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const calls: string[] = [];
    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "New name", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft() {
            calls.push("writeDraft");
            return storedMethod();
          },
          async renameMethod(_id, input) {
            calls.push(`renameMethod:${input.name}`);
            return storedMethod({ name: "New name" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(calls).toEqual(["writeDraft", "renameMethod:New name"]);
    expect(result.structuredContent).toMatchObject({ saved: "renamed", name: "New name" });
    expect(result.summary).toContain("renamed from **Summarize PDF**");
  });

  it("keeps the draft write's token when the rename reports a draft that moved", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "New name", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft() {
            return storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
          },
          async renameMethod() {
            // Somebody saved the draft between the two calls.
            return storedMethod({ name: "New name", updated_at: "2026-09-21T09:05:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    // Adopting the rename's token would let the next save from here replace
    // the other writer's draft unseen.
    expect(result.structuredContent).toMatchObject({
      saved: "renamed",
      name: "New name",
      updated_at: "2026-09-21T09:00:00Z",
    });
    const link = await readMethodLink(path.join(root, "methods/demo"));
    expect(link.kind === "link" && link.link.synced_updated_at).toBe("2026-09-21T09:00:00Z");
    expect(result.summary).toContain("changed again right after this save");
    // The token this save recorded is already stale: no publish is offered under it.
    expect(result.summary).not.toContain("expected_draft_updated_at");
    expect(result.summary).toContain("2026-09-21T09:05:00Z");
  });

  it("does not rename when the name is unchanged", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      {
        method_dir: "methods/demo",
        name: "Summarize PDF",
        method_id: "mt_one",
      },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft() {
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({ saved: "updated" });
  });

  it("keeps a name renamed elsewhere when the name passed is the link's older one", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
    });

    const renames: string[] = [];
    const client: CatalogWriteClient = {
      ...clientNotCalled,
      async writeDraft() {
        return storedMethod({ name: "Renamed In Webapp", updated_at: "2026-09-21T09:00:00Z" });
      },
      async renameMethod(_id, input) {
        renames.push(input.name);
        return storedMethod({ name: input.name, updated_at: "2026-09-21T09:00:00Z" });
      },
    };
    const save = () =>
      saveMthdsMethod(
        {
          method_dir: "methods/demo",
          name: "Summarize PDF",
          method_id: "mt_one",
        },
        contextFor(client, validationAnswering(validReport)),
      );

    // The name read back out of the link would quietly undo the webapp's rename.
    const first = await save();
    expect(renames).toEqual([]);
    expect(first.structuredContent).toMatchObject({
      status: "ok",
      saved: "updated",
      name: "Renamed In Webapp",
    });
    expect(first.summary).toContain("keeps its stored name **Renamed In Webapp**");
    expect(first.summary).toContain("renamed elsewhere");
    expect(first.summary).toContain("renames the method back");
    const link = await readMethodLink(path.join(root, "methods/demo"));
    expect(link.kind === "link" && link.link.name).toBe("Renamed In Webapp");

    // The link now records the stored name, so the same name is a rename meant.
    const second = await save();
    expect(renames).toEqual(["Summarize PDF"]);
    expect(second.structuredContent).toMatchObject({ saved: "renamed", name: "Summarize PDF" });
  });

  it("reports a failed rename beside a saved draft", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft() {
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );
    // An empty name is refused by the input schema before anything is sent.
    expect(result.structuredContent.status).toBe("error");

    const failing = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "New name", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft() {
            return storedMethod();
          },
          async renameMethod(): Promise<MethodData> {
            throw new ApiUnreachableError(
              "down",
              "https://api-dev.pipelex.com/v1/methods/mt_one",
              "ECONNREFUSED",
            );
          },
        },
        validationAnswering(validReport),
      ),
    );

    // The rename's own problem, as the SDK read the failure, beside a saved draft.
    expect(failing.structuredContent).toMatchObject({
      status: "ok",
      saved: "updated",
      name: "Summarize PDF",
      rename_error: { code: "client.unreachable", domain: "runtime", retry: "yes" },
    });
    expect(failing.summary).toContain("rename to the requested name FAILED");
    expect(failing.summary).toContain("(client.unreachable)");
  });

  it("refuses the save when the draft moved since expected_updated_at, naming both tokens", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      {
        method_dir: "methods/demo",
        method_id: "mt_one",
        expected_updated_at: "2026-09-19T00:00:00Z",
      },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(): Promise<MethodData> {
            throw draftConflict();
          },
          async getMethod() {
            return storedMethod({ updated_at: "2026-09-20T12:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "pipelex.catalog.update_conflict",
      domain: "input",
      retry: "no",
      detail: "The method's draft changed since expected_updated_at.",
      location: { field: "expected_updated_at" },
      request_id: "req_409",
    });
    expect(error.message).toContain("2026-09-20T12:00:00Z");
    expect(error.message).toContain("2026-09-19T00:00:00Z");
    expect(error.message).toContain("Nothing was written");
    expectProblemSummary(result.summary, error);
    expect(result.summary).toContain("`req_409`");
    await expect(fs.access(path.join(root, "methods/demo", LINK_FILE_NAME))).rejects.toThrow();
  });

  it("says what callers of the bare id run, by what the platform resolves", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const save = (version: () => Promise<unknown>) =>
      saveMthdsMethod(
        { method_dir: "methods/demo", method_id: "mt_one" },
        contextFor(
          {
            ...clientNotCalled,
            async writeDraft() {
              return publishedMethod();
            },
            version,
          },
          validationAnswering(validReport),
        ),
      );

    const supported = await save(versionsSupported);
    expect(supported.structuredContent).toMatchObject({
      latest_version: 2,
      publish_state: "draft_ahead",
    });
    expect(supported.summary).toContain("still run version 2");
    expect(supported.summary).not.toContain("wherever the platform resolves versions");

    // A platform that reads a bare id as the draft: the save changes what
    // every caller runs, and the result says so rather than promise otherwise.
    const unsupported = await save(versionsUnsupported);
    expect(unsupported.summary).toContain("runs this draft from its next call, not version 2");
  });

  it("reads a create-side transport fault as an outcome unknown, never as retryable", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(): Promise<MethodData> {
            throw new ApiUnreachableError(
              "connection reset",
              "https://api-dev.pipelex.com/v1/methods",
              "ECONNRESET",
            );
          },
        },
        validationAnswering(validReport),
      ),
    );

    // The route honours an idempotency key the SDK cannot send, so a create
    // whose response was lost would mint a SECOND method on retry: the
    // structured result says the outcome is unknown, with the SDK's reading
    // kept in the message, and its step is to list the catalog first.
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.outcome_unknown",
      retry: "outcome_unknown",
      next_step: { kind: "refresh" },
    });
    expect(error.next_step.detail).toContain("mthds_list_methods");
    expect(error.message).toContain("client.unreachable");
    expectProblemSummary(result.summary, error);
  });

  it("reads a create that committed and lost its answer as an outcome unknown, pointing at the catalog", async () => {
    // The platform stores the method, then the connection drops before its
    // answer arrives: the real SDK client meets a reset after the request
    // left. A retry would create a second method, so nothing in the result
    // may say that asking again is safe.
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const created: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (method === "POST" && url.pathname === "/v1/methods") {
        created.push("mt_committed");
        const reset = Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
          syscall: "read",
        });
        return Promise.reject(new TypeError("fetch failed", { cause: reset }));
      }
      if (url.pathname === "/v1/version") {
        return Promise.resolve(Response.json({ version: "1.0.0", blob_store: false }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    try {
      const real = createPipelexApiClient({ baseUrl: DEFAULT_API_URL });
      const result = await saveMthdsMethod(
        { method_dir: "methods/demo", name: "Demo" },
        contextFor(
          { ...clientNotCalled, createMethod: (input) => real.createMethod(input) },
          validationAnswering(validReport),
        ),
      );

      expect(created).toEqual(["mt_committed"]);
      expect(result.structuredContent.status).toBe("error");
      const error = problemOf(result.structuredContent);
      expect(error.code).toBe("client.outcome_unknown");
      expect(error.retry).not.toBe("yes");
      expect(error.next_step.kind).not.toBe("retry");
      expect(error.next_step.detail).toContain("mthds_list_methods");
      expect(error.next_step.detail).toContain("method_id");
      expectProblemSummary(result.summary, error);
      // No link is written for a method whose id never came back.
      await expect(fs.stat(path.join(root, "methods/demo/.pipelex/method.json"))).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the plain problem of a create shown never to have left, and warns on any other", async () => {
    // Only a proof that the create was never sent, or that its route refused
    // it, keeps the failure's own problem: an argument the SDK refused, a
    // failure of a step before the create (the handshake, the blob route,
    // whatever their status), or a refusal the create's route answered. A
    // failure the SDK did not raise, or a 5xx from the create's route, may
    // have come after the method was written.
    const unavailable = {
      code: "runtime.unavailable",
      title: "The platform is unavailable",
      detail: "The platform could not take the request.",
      domain: "runtime",
    };
    const cases: { name: string; err: unknown; plain: string | undefined }[] = [
      {
        name: "an argument the SDK refused",
        err: new RequestArgumentError("createMethod() takes the method's tree in one form."),
        plain: "client.argument_invalid",
      },
      {
        name: "the blob route's 503",
        err: platformRefusal("/v1/blobs/missing", 503, unavailable),
        plain: "runtime.unavailable",
      },
      {
        name: "the handshake's 503",
        err: platformRefusal("/v1/version", 503, unavailable),
        plain: "runtime.unavailable",
      },
      {
        name: "the create route's 501",
        err: platformRefusal("/v1/methods", 501, {
          ...unavailable,
          code: "runtime.not_implemented",
        }),
        plain: "runtime.not_implemented",
      },
      {
        name: "the create route's 503",
        err: platformRefusal("/v1/methods", 503, unavailable),
        plain: undefined,
      },
      {
        name: "an abort the SDK did not raise",
        err: new DOMException("The operation was aborted.", "AbortError"),
        plain: undefined,
      },
      { name: "a wrapper's error", err: new Error("socket hang up"), plain: undefined },
    ];
    for (const { name, err, plain } of cases) {
      await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
      const result = await saveMthdsMethod(
        { method_dir: "methods/demo", name: "Demo" },
        contextFor(
          {
            ...clientNotCalled,
            createMethod(): Promise<MethodData> {
              return Promise.reject(err);
            },
          },
          validationAnswering(validReport),
        ),
      );

      const error = problemOf(result.structuredContent);
      if (plain === undefined) {
        expect(error, name).toMatchObject({
          code: "client.outcome_unknown",
          retry: "outcome_unknown",
          next_step: { kind: "refresh" },
        });
      } else {
        expect(error.code, name).toBe(plain);
        expect(result.summary, name).not.toContain("client.outcome_unknown");
      }
    }
  });

  it("keeps the plain problem of a create whose blob route failed before the create was sent", async () => {
    // The real client sends the tree by hash, the deployment announcing an
    // inline limit no tree passes, and the blob route fails: the create was
    // never posted, so nothing was minted and the outcome is known.
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const posted: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      posted.push(`${method} ${url.pathname}`);
      if (url.pathname === "/v1/version") {
        return Promise.resolve(
          Response.json({
            version: "1.0.0",
            blob_store: true,
            limits: { method_tree: { max_inline_bytes: 1 } },
          }),
        );
      }
      if (url.pathname === "/v1/blobs/missing") {
        return Promise.resolve(new Response("upstream unavailable", { status: 503 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
    try {
      const real = createPipelexApiClient({ baseUrl: DEFAULT_API_URL });
      const result = await saveMthdsMethod(
        { method_dir: "methods/demo", name: "Demo" },
        contextFor(
          { ...clientNotCalled, createMethod: (input) => real.createMethod(input) },
          validationAnswering(validReport),
        ),
      );

      expect(posted).toContain("POST /v1/blobs/missing");
      expect(posted).not.toContain("POST /v1/methods");
      const error = problemOf(result.structuredContent);
      expect(error.code).not.toBe("client.outcome_unknown");
      expect(result.summary).not.toContain("client.outcome_unknown");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("relays a refused key on the create as the key, not as connectivity", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(): Promise<MethodData> {
            throw refusedKey("/v1/methods");
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "auth.missing_credential",
      domain: "account",
      retry: "no",
      request_id: "req_401",
    });
    expectProblemSummary(result.summary, error);
    // Where the key came from, beside a refused credential, and no unknown
    // outcome: a refusal is an answer, so nothing was minted.
    expect(result.summary).toContain("PIPELEX_API_KEY");
    expect(result.summary).not.toContain("client.outcome_unknown");
  });

  it("relays a draft write refused by role as the role, with the server's sentence", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(): Promise<MethodData> {
            throw roleRefusal("/v1/methods/mt_one/draft", RUNNER_CHANGE_DETAIL);
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "auth.forbidden",
      domain: "account",
      retry: "no",
      detail: RUNNER_CHANGE_DETAIL,
      params: { requirement: "method_write" },
      next_step: { kind: "request_access" },
    });
    expect(error.location).toBeUndefined();
    expectProblemSummary(result.summary, error);
    const [content] = saveMethodToolResult(result).content;
    expect(content.text).toContain(RUNNER_CHANGE_DETAIL);
    expect(content.text).not.toMatch(/PIPELEX_API_KEY|log ?in/i);
  });

  it("keeps a create refused by role as the role, its outcome known", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(): Promise<MethodData> {
            throw roleRefusal("/v1/methods", RUNNER_CHANGE_DETAIL);
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({ code: "auth.forbidden", domain: "account", retry: "no" });
    expectProblemSummary(result.summary, error);
    // A refusal is an answer, so nothing was minted and the outcome is known.
    expect(result.summary).not.toContain("client.outcome_unknown");
  });

  it("warns that the method may exist when the create's answer came back unreadable", async () => {
    // A 2xx the SDK could not read is a create the platform accepted, which the
    // SDK reports as a final ApiResponseError: the method exists all the same.
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const posted: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (url.pathname === "/v1/version") {
        return Promise.resolve(Response.json({ version: "1.0.0", blob_store: false }));
      }
      posted.push(`${method} ${url.pathname}`);
      return Promise.resolve(new Response("", { status: 201 }));
    });
    try {
      const real = createPipelexApiClient({ baseUrl: DEFAULT_API_URL });
      const result = await saveMthdsMethod(
        { method_dir: "methods/demo", name: "Demo" },
        contextFor(
          { ...clientNotCalled, createMethod: (input) => real.createMethod(input) },
          validationAnswering(validReport),
        ),
      );

      // The create was accepted, so the method exists although its answer
      // could not be read: the outcome is unknown, the SDK's reading kept in
      // the message.
      const error = problemOf(result.structuredContent);
      expect(error).toMatchObject({
        code: "client.outcome_unknown",
        retry: "outcome_unknown",
        next_step: { kind: "refresh" },
      });
      expect(error.message).toContain("client.response_unreadable");
      expect(error.next_step.detail).toContain("mthds_list_methods");
      expect(posted).toEqual(["POST /v1/methods"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("relays a draft write's transport fault as retryable, PUT being idempotent", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(): Promise<MethodData> {
            throw new ApiUnreachableError(
              "connection reset",
              "https://api-dev.pipelex.com/v1/methods",
              "ECONNRESET",
            );
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({ code: "client.unreachable", retry: "yes" });
    expect(result.summary).not.toContain("client.outcome_unknown");
  });

  it("answers a malformed base URL as an error rather than throwing", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const context: CatalogWriteContext = {
      ...contextFor(clientNotCalled, validationAnswering(validReport)),
      baseUrl: "not a url",
      client: undefined,
    };

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one" },
      context,
    );

    // One problem, the SDK's reading of the base URL it could not use.
    const error = problemOf(result.structuredContent);
    expect(error.domain).toBeDefined();
    expect(error.retry).toBe("no");
    expectProblemSummary(result.summary, error);
  });

  it("rejects an empty method_dir", async () => {
    const result = await saveMthdsMethod(
      { method_dir: "", name: "Demo" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    expect(problemOf(result.structuredContent)).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "method_dir" },
      location: { field: "method_dir" },
    });
  });

  it("refuses a folder with no .mthds file at its top, sending nothing", async () => {
    await writeBundle("methods/empty", { "notes.md": "no method here" });

    const result = await saveMthdsMethod(
      { method_dir: "methods/empty", name: "Demo" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "method_dir" },
      location: { field: "method_dir" },
    });
    expect(error.message).toContain("no .mthds file at its top");
    // The save takes a folder and nothing else: its remedies never offer `files`.
    expect(error.message).not.toContain("in files");
    expect(error.message).toContain("then save the folder again");
  });

  it("refuses a folder holding a symbolic link, naming it, and offers no files argument", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    await fs.symlink("bundle.mthds", path.join(root, "methods", "demo", "alias.mthds"));

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      location: { field: "method_dir" },
    });
    expect(error.message).toContain("alias.mthds");
    expect(error.message).not.toContain("in files");
  });

  it("refuses a method_dir symlinked out of the working directory before reading its link", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "catalog-outside-")));
    await fs.writeFile(path.join(outside, "bundle.mthds"), 'domain = "demo"', "utf8");
    await fs.mkdir(path.join(outside, ".pipelex"));
    await writeLinkFile(path.join(outside, LINK_FILE_NAME), "not read", "utf8");
    await fs.symlink(outside, path.join(root, "escape"));

    try {
      const result = await saveMthdsMethod(
        { method_dir: "escape", name: "Demo" },
        contextFor(clientNotCalled, validationAnswering(validReport)),
      );

      expect(problemOf(result.structuredContent)).toMatchObject({
        code: "client.argument_invalid",
        domain: "input",
        location: { field: "method_dir" },
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a folder past the deployment's limits while it lists it", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "data/one.csv": "a\n",
      "data/two.csv": "b\n",
    });
    let handshakes = 0;

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async methodTreeLimits() {
            handshakes += 1;
            return { maxFileCount: 2 };
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(handshakes).toBe(1);
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      location: { field: "method_dir" },
    });
    expect(error.message).toContain("takes no method holding more than 2 files");
  });

  it("works without the limits handshake, holding the listing to the workshop's own limits", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async methodTreeLimits(): Promise<never> {
            throw new ApiUnreachableError(
              "down",
              "https://api-dev.pipelex.com/v1/version",
              "ECONNREFUSED",
            );
          },
          async createMethod() {
            return storedMethod({ name: "Demo" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", saved: "created" });
  });

  it("refuses a deployment that cannot read a folder as one without a working directory", async () => {
    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      { ...contextFor(clientNotCalled, validationAnswering(validReport)), saveRoot: undefined },
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.not_configured",
      retry: "no",
      params: { setting: "working_directory" },
    });
    expect(error.location).toBeUndefined();
    expect(error.message).toContain("npx @pipelex/mcp");
  });

  it("keeps an upload failure's own verdict, with no create retry warning", async () => {
    // The blobs go up before the create is sent, so no method was minted.
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(): Promise<MethodData> {
            throw new MethodFileTransferError("The upload of bundle.mthds was refused.", {
              operation: "upload",
              reason: "unreachable",
              path: "bundle.mthds",
            });
          },
        },
        validationAnswering(validReport),
      ),
    );

    // The SDK's problem for the transfer, unchanged: storage could not be
    // reached, which a later attempt can pass; no create was sent, so its
    // outcome is known.
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({ code: "runtime.unavailable", domain: "runtime", retry: "yes" });
    expect(result.summary).not.toContain("client.outcome_unknown");
  });
});

describe("the secret guard", () => {
  /** Key-shaped text assembled at run time, so no literal here looks like a key. None is real. */
  const fakeKey = ["plx_sk_", "f".repeat(32)].join("");
  const fakePem = ["-----BEGIN ", "RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"].join(
    "",
  );

  /** A client that records every call it gets, answering only the limits handshake. */
  function recordingClient(calls: string[]): CatalogWriteClient {
    const refuse = (name: string) => async (): Promise<never> => {
      calls.push(name);
      throw new Error(`${name} must not be called once the guard refused`);
    };
    return {
      getMethod: refuse("getMethod"),
      createMethod: refuse("createMethod"),
      writeDraft: refuse("writeDraft"),
      renameMethod: refuse("renameMethod"),
      getMethodVersion: refuse("getMethodVersion"),
      publishMethod: refuse("publishMethod"),
      writeMethodTree: refuse("writeMethodTree"),
      version: refuse("version"),
      async methodTreeLimits() {
        calls.push("methodTreeLimits");
        return { maxFileCount: 1000, maxFileSize: 32 * 1024 * 1024 };
      },
    };
  }

  /** A validation that records whether it was asked. */
  function recordingValidation(calls: string[]) {
    return {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validate(): Promise<never> {
          calls.push("validate");
          throw new Error("validate must not be called once the guard refused");
        },
      },
    } as unknown as CatalogWriteContext["validation"];
  }

  it("refuses a key pasted into a module before any request leaves, naming the file and never the key", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "funcs/client.py": `API_KEY = "${fakeKey}"\n`,
    });
    const calls: string[] = [];

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      { ...contextFor(recordingClient(calls), recordingValidation(calls)) },
    );

    // Only the limits handshake, a metadata read that carries no file, went
    // out: no validation, no upload, no create.
    expect(calls).toEqual(["methodTreeLimits"]);
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "method_dir", reason: "secret_suspected" },
      location: { field: "method_dir" },
    });
    expect(error.message).toContain(path.join("methods/demo", "funcs", "client.py"));
    expect(error.message).toContain("a Pipelex API key");
    expect(error.message).toContain("nothing was sent");
    expect(JSON.stringify(result)).not.toContain(fakeKey);
    expect(JSON.stringify(result)).not.toContain("f".repeat(32));
    // Refused before anything was written either: no link.
    await expect(fs.access(path.join(root, "methods/demo", LINK_FILE_NAME))).rejects.toThrow();
  });

  it("refuses a key file by its name, on an update too, and leaves the draft alone", async () => {
    // A DER key is binary and holds no PEM block, so only its name gives it away.
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "certs/server.key": new Uint8Array([0x30, 0x82, 0x04, 0xa4, 0x02, 0x01, 0x00, 0x02]),
    });
    const calls: string[] = [];

    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", method_id: "mt_one", expected_updated_at: "T0" },
      contextFor(recordingClient(calls), recordingValidation(calls)),
    );

    expect(calls).toEqual(["methodTreeLimits"]);
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_dir", reason: "secret_suspected" },
    });
    expect(error.message).toContain(path.join("methods/demo", "certs", "server.key"));
    expect(error.message).toContain("named like a key file");
    expect(error.message).toContain(".gitignore");
  });

  it("lets a secret the membership rule already keeps out stay where it is", async () => {
    // A .env file starts with a dot, so it is never a member of the tree.
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      ".env": `PIPELEX_API_KEY=${fakeKey}\n`,
      ".gitignore": "secrets/\n",
      "secrets/key.pem": fakePem,
    });

    let sent: MethodWriteInput | undefined;
    const result = await saveMthdsMethod(
      { method_dir: "methods/demo", name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(input) {
            sent = input;
            return storedMethod({ name: "Demo" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", saved: "created" });
    expect(sent?.tree?.files.map((file) => file.path)).toEqual(["bundle.mthds"]);
  });
});

// ── mthds_get_method ────────────────────────────────────────────────

describe("getMthdsMethod", () => {
  const readingClient = (stored: MethodDetail): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  it("writes the whole tree and the link file into an empty output_dir", async () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x10]);
    const stored = storedMethod({
      files: treeOf({
        "bundle.mthds": 'domain = "demo"',
        "pipes/extra.mthds": 'pipe = "extra"',
        "funcs/helpers.py": "x = 1\n",
        "templates/letter.docx": docx,
      }),
    });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "pulled" },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      output_dir: "pulled",
      files: [
        { path: "bundle.mthds", bytes: 15, written_to: path.join("pulled", "bundle.mthds") },
        { path: "funcs/helpers.py", written_to: path.join("pulled", "funcs", "helpers.py") },
        { path: "pipes/extra.mthds", written_to: path.join("pulled", "pipes", "extra.mthds") },
        {
          path: "templates/letter.docx",
          written_to: path.join("pulled", "templates", "letter.docx"),
        },
      ],
      link_file: { path: path.join("pulled", ".pipelex", "method.json"), written: true },
    });
    expect(await fs.readFile(path.join(root, "pulled/bundle.mthds"), "utf8")).toBe(
      'domain = "demo"',
    );
    expect(await fs.readFile(path.join(root, "pulled/pipes/extra.mthds"), "utf8")).toBe(
      'pipe = "extra"',
    );
    expect(
      new Uint8Array(await fs.readFile(path.join(root, "pulled/templates/letter.docx"))),
    ).toEqual(docx);
    expect((await readMethodLink(path.join(root, "pulled"))).kind).toBe("link");
    // No file passes through the conversation on this arm, and no link to one.
    const files = (result.structuredContent as { files: { content?: string }[] }).files;
    expect(files.every((file) => file.content === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("blobs.example.test");
    // The staging directory is gone, and nothing but the tree and its link is left.
    expect((await fs.readdir(path.join(root, "pulled"))).sort()).toEqual([
      ".pipelex",
      "bundle.mthds",
      "funcs",
      "pipes",
      "templates",
    ]);
  });

  it("writes nothing, and no link, when the download fails", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "pulled" },
      contextFor(
        {
          ...readingClient(storedMethod()),
          async writeMethodTree(): Promise<never> {
            throw new MethodFileTransferError("The download of bundle.mthds failed.", {
              operation: "download",
              reason: "mismatch",
              path: "bundle.mthds",
            });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(await fs.readdir(path.join(root, "pulled")).catch(() => [])).toEqual([]);
  });

  it("refuses a directory holding .mthds files with no link — somebody else's bundle", async () => {
    await writeBundle("theirs", { "bundle.mthds": "theirs" });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "theirs" },
      contextFor(readingClient(storedMethod()), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      domain: "input",
      retry: "no",
      params: { path: "theirs" },
      location: { field: "output_dir" },
    });
    expectProblemSummary(result.summary, error);
    expect(await fs.readFile(path.join(root, "theirs/bundle.mthds"), "utf8")).toBe("theirs");
  });

  it("refuses a pull into a folder still holding the old pipelex-method.json, writing nothing", async () => {
    const oldLink = JSON.stringify({ method_id: "mt_one", name: "Summarize PDF" });
    await writeBundle("old", { "pipelex-method.json": oldLink });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "old" },
      contextFor(readingClient(storedMethod()), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "output_dir", reason: "legacy_link_file" },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain(
      "mkdir -p .pipelex && git mv pipelex-method.json .pipelex/method.json",
    );
    expect(await fs.readdir(path.join(root, "old"))).toEqual(["pipelex-method.json"]);
  });

  it("refuses a directory linked to a different method", async () => {
    await writeBundle("other", { "bundle.mthds": "other" });
    await writeLinkFile(
      path.join(root, "other", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_other",
        name: "Other",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-01T00:00:00Z",
      }),
      "utf8",
    );

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "other" },
      contextFor(readingClient(storedMethod()), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      params: { path: "other" },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("mt_other");
  });

  it("refuses when the local files differ and the stored method has NOT moved — unsaved work", async () => {
    const stored = storedMethod({ updated_at: "2026-09-20T12:00:00Z" });
    await writeBundle("linked", { "bundle.mthds": "edited locally" });
    await writeLinkFile(
      path.join(root, "linked", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        // Equal to the stored updated_at: nobody else has saved since.
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
      "utf8",
    );

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "linked" },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("never saved");
    expect(await fs.readFile(path.join(root, "linked/bundle.mthds"), "utf8")).toBe(
      "edited locally",
    );
  });

  it("refuses when both have moved, unless overwrite says the stored version wins", async () => {
    const stored = storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
    const seed = async () => {
      await writeBundle("both", { "bundle.mthds": "edited locally" });
      await writeLinkFile(
        path.join(root, "both", LINK_FILE_NAME),
        JSON.stringify({
          method_id: "mt_one",
          name: "Summarize PDF",
          api_host: "api-dev.pipelex.com",
          synced_updated_at: "2026-09-20T12:00:00Z",
        }),
        "utf8",
      );
    };

    await seed();
    const refused = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "both" },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );
    expect(problemOf(refused.structuredContent)).toMatchObject({ code: "client.target_exists" });
    expect(problemOf(refused.structuredContent).message).toContain("overwrite: true");
    expect(await fs.readFile(path.join(root, "both/bundle.mthds"), "utf8")).toBe("edited locally");

    const forced = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "both", overwrite: true },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );
    expect(forced.structuredContent.status).toBe("ok");
    expect(await fs.readFile(path.join(root, "both/bundle.mthds"), "utf8")).toBe('domain = "demo"');
  });

  it("writes an identical linked directory without complaint, refreshing the link", async () => {
    const stored = storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
    await writeBundle("same", { "bundle.mthds": 'domain = "demo"' });
    await writeLinkFile(
      path.join(root, "same", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
      "utf8",
    );

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "same" },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent.status).toBe("ok");
    const link = await readMethodLink(path.join(root, "same"));
    expect(link.kind === "link" && link.link.synced_updated_at).toBe("2026-09-21T09:00:00Z");
  });

  it("returns the text files inline when no output_dir is given", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one" },
      contextFor(readingClient(storedMethod()), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", truncated: false });
    const files = (result.structuredContent as { files: { content?: string }[] }).files;
    expect(files[0]?.content).toBe('domain = "demo"');
    expect(result.structuredContent).not.toHaveProperty("output_dir");
  });

  it("returns a file that is not text by size alone, flagged as binary", async () => {
    const stored = storedMethod({
      files: treeOf({
        "bundle.mthds": 'domain = "demo"',
        "templates/letter.docx": new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]),
      }),
    });

    const result = await getMthdsMethod(
      { method_id: "mt_one" },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      files: [
        { path: "bundle.mthds", bytes: 15, content: 'domain = "demo"' },
        { path: "templates/letter.docx", bytes: 6, binary: true },
      ],
    });
    expect(result.summary).toContain("`templates/letter.docx` is not text");
    // The link a read lists is a bearer credential, and never leaves the tool.
    expect(JSON.stringify(result)).not.toContain("blobs.example.test");
  });

  it("downloads only the files that fit the inline budget, whole, and withholds the rest", async () => {
    const big = "x".repeat(MAX_INLINE_SOURCE_BYTES);
    const stored = storedMethod({
      files: treeOf({ "a.mthds": 'domain = "demo"', "b.mthds": big, "c.md": "small" }),
    });
    const downloaded: string[] = [];

    const result = await getMthdsMethod(
      { method_id: "mt_one" },
      contextFor(
        {
          ...readingClient(stored),
          async writeMethodTree(files, options) {
            downloaded.push(...files.map((file) => file.path));
            return writeFromBlobs(files, options);
          },
        },
        validationAnswering(validReport),
      ),
    );

    // In order, by whole file: the first that does not fit closes the budget.
    expect(downloaded).toEqual(["a.mthds"]);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      truncated: true,
      files: [
        { path: "a.mthds", content: 'domain = "demo"' },
        { path: "b.mthds", bytes: MAX_INLINE_SOURCE_BYTES },
        { path: "c.md", bytes: 5 },
      ],
    });
    const files = (result.structuredContent as { files: { content?: string }[] }).files;
    expect(files[1]).not.toHaveProperty("content");
    expect(result.summary).toContain("WITHHELD for size");
  });

  it("reports a failed inline download as no verdict, carrying no link", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one" },
      contextFor(
        {
          ...readingClient(storedMethod()),
          async writeMethodTree(): Promise<never> {
            throw new MethodFileTransferError("The download of bundle.mthds failed.", {
              operation: "download",
              reason: "unreachable",
              path: "bundle.mthds",
            });
          },
        },
        validationAnswering(validReport),
      ),
    );

    // The SDK's problem, unchanged: storage could not be reached, and this arm
    // writes nowhere the caller named, so nothing locates it.
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({ code: "runtime.unavailable", domain: "runtime", retry: "yes" });
    expect(error.location).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("blobs.example.test");
  });

  it("reports a method holding no file as a produced failure, not an empty success", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one" },
      contextFor(readingClient(storedMethod({ files: [] })), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    // A different answer from "no such method", which is the catalog's
    // pipelex.catalog.not_found: the method's package is empty.
    expect(error).toMatchObject({
      code: "method.package_invalid",
      domain: "method",
      retry: "no",
      params: { reason: "empty_tree" },
      location: { field: "method_id" },
    });
    expect(error.message).toContain("holds no file yet");
  });

  it("relays the catalog's 404 unchanged", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_missing" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod(): Promise<MethodDetail> {
            throw platformRefusal("/v1/methods/mt_missing", 404, {
              code: "pipelex.catalog.not_found",
              title: "The method was not found",
              detail: "Method not found",
              domain: "input",
            });
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "pipelex.catalog.not_found",
      domain: "input",
      retry: "no",
      detail: "Method not found",
      request_id: "req_404",
    });
    expectProblemSummary(result.summary, error);
  });

  it("relays a refused key as the key, not as connectivity", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod(): Promise<MethodDetail> {
            throw refusedKey("/v1/methods/mt_one");
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "auth.missing_credential",
      domain: "account",
      retry: "no",
    });
    expectProblemSummary(result.summary, error);
    expect(result.summary).toContain("PIPELEX_API_KEY");
    expect(result.summary).toContain("`req_401`");
  });
});

// ── the link file ───────────────────────────────────────────────────

describe("the link file", () => {
  it("records the API host, which is what makes an unknown id diagnosable", () => {
    expect(apiHostOf("https://api-dev.pipelex.com/v1")).toBe("api-dev.pipelex.com");
    expect(apiHostOf("not a url")).toBe("not a url");
  });

  it("reads a malformed link as unreadable rather than absent", async () => {
    await fs.mkdir(path.join(root, "broken"), { recursive: true });
    await writeLinkFile(path.join(root, "broken", LINK_FILE_NAME), "{ not json", "utf8");

    // `none` would let a pull write; `unreadable` must refuse. A link nobody can
    // parse is still evidence that something claims the directory.
    expect(await readMethodLink(path.join(root, "broken"))).toMatchObject({ kind: "unreadable" });
  });

  it("reads a link missing a required field as unreadable", async () => {
    await fs.mkdir(path.join(root, "partial"), { recursive: true });
    await writeLinkFile(
      path.join(root, "partial", LINK_FILE_NAME),
      JSON.stringify({ method_id: "mt_one" }),
      "utf8",
    );

    expect(await readMethodLink(path.join(root, "partial"))).toMatchObject({ kind: "unreadable" });
  });

  it("reads an absent link as none", async () => {
    await fs.mkdir(path.join(root, "empty"), { recursive: true });
    expect(await readMethodLink(path.join(root, "empty"))).toEqual({ kind: "none" });
  });

  it("refuses a save from a folder still holding the old pipelex-method.json, sending nothing", async () => {
    const oldLink = JSON.stringify({ method_id: "mt_one", name: "Summarize PDF" });
    await writeBundle("methods/old", {
      "bundle.mthds": 'domain = "demo"',
      "pipelex-method.json": oldLink,
    });

    const result = await saveMthdsMethod(
      { method_dir: "methods/old", method_id: "mt_one" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "method_dir", reason: "legacy_link_file" },
      location: { field: "method_dir" },
    });
    expect(error.message).toContain("pipelex-method.json");
    expect(error.message).toContain(
      "mkdir -p .pipelex && git mv pipelex-method.json .pipelex/method.json",
    );
    // No link was written beside it: the folder is exactly as it was.
    expect((await fs.readdir(path.join(root, "methods/old"))).sort()).toEqual([
      "bundle.mthds",
      "pipelex-method.json",
    ]);
  });
});

describe("buildCatalogWriteContext", () => {
  it("shares one API config between the write client and the validation leg", () => {
    const context = buildCatalogWriteContext({
      PIPELEX_API_KEY: "key",
      PIPELEX_BASE_URL: "https://api-dev.pipelex.com",
    } as NodeJS.ProcessEnv);

    expect(context.baseUrl).toBe("https://api-dev.pipelex.com");
    expect(context.validation.baseUrl).toBe(context.baseUrl);
  });
});

// ── the guard and the action, over one write set ────────────────────
//
// Every test here reproduces a defect four reviewers found and a verifier
// confirmed on disk, all of them one mistake: the guard reasoned about a
// narrower set than the write loop landed. The suite was green over all of
// them, which is why they are written against the filesystem rather than
// against a projection.

describe("the pull writes only what it may", () => {
  const reading = (stored: MethodDetail): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  const pythonMethod = () =>
    storedMethod({
      files: treeOf({ "bundle.mthds": 'domain = "demo"', "helpers.py": "# from the catalog\n" }),
    });

  async function linkInto(dir: string, synced: string, methodId = "mt_one"): Promise<void> {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await writeLinkFile(
      path.join(root, dir, LINK_FILE_NAME),
      JSON.stringify({
        method_id: methodId,
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: synced,
      }),
      "utf8",
    );
  }

  it("refuses a linked directory whose .py file carries unsaved edits", async () => {
    // The `.mthds` files are byte-identical, so a guard that compares only the
    // sources sees no difference at all — and the loop then overwrites the one
    // file that had changed.
    const stored = pythonMethod();
    await writeBundle("py", { "bundle.mthds": 'domain = "demo"' });
    await fs.writeFile(path.join(root, "py", "helpers.py"), "# MY LOCAL EDIT\n", "utf8");
    await linkInto("py", stored.updated_at);

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "py" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    expect(problemOf(result.structuredContent)).toMatchObject({ code: "client.target_exists" });
    expect(problemOf(result.structuredContent).message).toContain("helpers.py");
    expect(await fs.readFile(path.join(root, "py", "helpers.py"), "utf8")).toBe(
      "# MY LOCAL EDIT\n",
    );
  });

  it("refuses an unlinked directory holding a .py file the pull would land on", async () => {
    // No top-level `.mthds` file, so the old emptiness scan read this as empty.
    const stored = pythonMethod();
    await fs.mkdir(path.join(root, "occupied"), { recursive: true });
    await fs.writeFile(path.join(root, "occupied", "helpers.py"), "# THE USER'S\n", "utf8");

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "occupied" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    expect(problemOf(result.structuredContent)).toMatchObject({
      code: "client.target_exists",
      params: { path: "occupied" },
    });
    expect(problemOf(result.structuredContent).message).toContain("helpers.py");
    expect(await fs.readFile(path.join(root, "occupied", "helpers.py"), "utf8")).toBe(
      "# THE USER'S\n",
    );
  });

  it("refuses an unlinked directory holding a nested .mthds the pull would land on", async () => {
    const stored = storedMethod({
      files: treeOf({ "nested/other.mthds": 'domain = "demo"' }),
    });
    await fs.mkdir(path.join(root, "nest", "nested"), { recursive: true });
    await fs.writeFile(path.join(root, "nest", "nested", "other.mthds"), "theirs", "utf8");

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "nest" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(await fs.readFile(path.join(root, "nest", "nested", "other.mthds"), "utf8")).toBe(
      "theirs",
    );
  });

  it("refuses a stored file under a directory symlink into a dot directory, writing nothing", async () => {
    // `assets -> .claude` in a linked folder: the stored path `assets/settings.json`
    // has no dot segment, its leaf is absent (so no overwrite is needed), and its
    // real parent stays inside output_dir, which every older check accepted, so
    // the pull wrote `.claude/settings.json`. Every ancestor is now inspected.
    // `root` is a fresh temporary directory, never the checkout or a home.
    const stored = storedMethod({
      files: treeOf({
        "bundle.mthds": 'domain = "demo"',
        "assets/settings.json": '{"hooks": {"PreToolUse": []}}',
      }),
    });
    await fs.mkdir(path.join(root, "linked", ".claude"), { recursive: true });
    await fs.symlink(".claude", path.join(root, "linked", "assets"));
    await writeLinkFile(
      path.join(root, "linked", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: stored.updated_at,
      }),
      "utf8",
    );
    const linkBefore = await fs.readFile(path.join(root, "linked", LINK_FILE_NAME), "utf8");

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "linked" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      domain: "input",
      params: { path: "assets/settings.json" },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("`assets`");
    expect(await fs.readdir(path.join(root, "linked", ".claude"))).toEqual([]);
    await expect(fs.access(path.join(root, "linked", "bundle.mthds"))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "linked", LINK_FILE_NAME), "utf8")).toBe(linkBefore);
  });

  it("refuses a symlinked destination instead of writing through it", async () => {
    // `containedPath` is lexical, so the joined path looks contained while
    // `writeFile` lands at the link's target — outside the workspace entirely.
    // The link's target holds exactly what the pull would write, so the
    // ownership guard finds nothing differing and passes — which is the only
    // state in which the write loop is ever reached, and so the only state in
    // which this escape could happen. The symlink check is what stops it.
    const outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "catalog-outside-")));
    const victim = path.join(outside, "victim.mthds");
    await fs.writeFile(victim, 'domain = "demo"', "utf8");

    const stored = storedMethod();
    await linkInto("linkdest", stored.updated_at);
    await fs.symlink(victim, path.join(root, "linkdest", "bundle.mthds"));

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "linkdest" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    expect(problemOf(result.structuredContent)).toMatchObject({
      code: "client.target_exists",
      params: { path: "bundle.mthds" },
      location: { field: "output_dir" },
    });
    expect(problemOf(result.structuredContent).message).toContain("symlink");
    // Still a symlink: nothing was written through it, and nothing replaced it.
    expect((await fs.lstat(path.join(root, "linkdest", "bundle.mthds"))).isSymbolicLink()).toBe(
      true,
    );
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("refuses a stored file whose parent directory is a symlink out of the workspace", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "catalog-escape-")));
    const stored = storedMethod({
      files: treeOf({ "sub/x.mthds": 'domain = "demo"' }),
    });
    await fs.mkdir(path.join(root, "escape"), { recursive: true });
    await fs.symlink(outside, path.join(root, "escape", "sub"));

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "escape" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("refuses a pull that would link a whole project, naming the files it does not have", async () => {
    // output_dir "." at a project's root: no link, no .mthds of its own, and
    // none of the method's paths taken, which the older guards all let
    // through; the link would then claim the project, and the next save send it.
    await writeBundle(".", {
      "package.json": "{}",
      "src/index.ts": "export {};",
    });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "." },
      contextFor(reading(storedMethod()), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      domain: "input",
      params: { path: "." },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("`package.json`");
    expect(error.message).toContain("`src/index.ts`");
    expect(error.message).toContain("fresh folder");
    await expect(fs.access(path.join(root, "bundle.mthds"))).rejects.toThrow();
    await expect(fs.access(path.join(root, LINK_FILE_NAME))).rejects.toThrow();
  });

  it("refuses an unlinked folder whose tree gained a file while the pull downloaded, writing nothing", async () => {
    // The plan listed the folder before the download and outside the lock; a
    // file landing meanwhile would have been claimed by the link, and sent by
    // the next save as the method's own.
    await fs.mkdir(path.join(root, "fresh"), { recursive: true });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "fresh" },
      contextFor(
        {
          ...reading(storedMethod()),
          async writeMethodTree(files, options) {
            await fs.writeFile(path.join(root, "fresh", "notes.md"), "mine", "utf8");
            return writeFromBlobs(files, options);
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      params: { path: "fresh" },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("`notes.md`");
    await expect(fs.access(path.join(root, "fresh", "bundle.mthds"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "fresh", LINK_FILE_NAME))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "fresh", "notes.md"), "utf8")).toBe("mine");
  });

  it("pulls into an unlinked folder whose tree holds nothing else, dotfiles and run inputs aside", async () => {
    await writeBundle("fresh", { ".git/config": "[core]", "inputs.json": "{}" });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "fresh" },
      contextFor(reading(storedMethod()), validationAnswering(validReport)),
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(await fs.readFile(path.join(root, "fresh", "bundle.mthds"), "utf8")).toBe(
      'domain = "demo"',
    );
  });

  it("refuses a pull into an unlinked folder it cannot list, since it cannot tell it holds nothing else", async () => {
    await writeBundle("tangled", { "notes.md": "mine" });
    await fs.symlink("notes.md", path.join(root, "tangled", "alias.md"));

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "tangled" },
      contextFor(reading(storedMethod()), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      params: { path: "tangled" },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("could not be listed");
    await expect(fs.access(path.join(root, "tangled", "bundle.mthds"))).rejects.toThrow();
  });

  it("refuses a symlinked link file rather than overwriting what it points at", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "catalog-linkfile-")));
    const victim = path.join(outside, "theirs.json");
    await fs.writeFile(victim, "SOMETHING THE USER OWNS\n", "utf8");

    await fs.mkdir(path.join(root, "symlink"), { recursive: true });
    await fs.mkdir(path.join(root, "symlink", ".pipelex"), { recursive: true });
    await fs.symlink(victim, path.join(root, "symlink", LINK_FILE_NAME));

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "symlink" },
      contextFor(reading(storedMethod()), validationAnswering(validReport)),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(await fs.readFile(victim, "utf8")).toBe("SOMETHING THE USER OWNS\n");
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("leaves an interrupted pull owned, so the retry it advertises is permitted", async () => {
    // The second file goes into `sub/`, an empty directory nobody may write
    // in, so its creation fails after the first file has landed. (A
    // destination that merely exists would be refused by the occupancy guard
    // before the loop, which is the point of that guard, and a file in the
    // way would be refused as a file the method does not have.) The link went
    // down first, marked `partial_pull`, which is what lets the retry through
    // instead of reading as somebody else's bundle.
    const stored = storedMethod({
      files: treeOf({ "bundle.mthds": 'domain = "demo"', "sub/second.mthds": "second" }),
    });
    await fs.mkdir(path.join(root, "partial", "sub"), { recursive: true });
    await fs.chmod(path.join(root, "partial", "sub"), 0o555);

    const failed = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "partial" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );
    expect(failed.structuredContent.status).toBe("error");
    // Not a blind retry: the failure says what to fix, and that calling again
    // with the same output_dir resumes the pull once it is fixed.
    expect(problemOf(failed.structuredContent)).toMatchObject({
      code: "client.write_failed",
      domain: "input",
      retry: "no",
      params: { reason: "partly_written" },
      location: { field: "output_dir" },
    });
    expect(problemOf(failed.structuredContent).message).toContain(
      "calling again with the same output_dir resumes it once the cause is fixed",
    );

    const link = await readMethodLink(path.join(root, "partial"));
    expect(link.kind === "link" && link.link.partial_pull).toBe(true);

    await fs.chmod(path.join(root, "partial", "sub"), 0o755);
    const retried = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "partial" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    expect(retried.structuredContent.status).toBe("ok");
    expect(await fs.readFile(path.join(root, "partial", "sub", "second.mthds"), "utf8")).toBe(
      "second",
    );
    const settled = await readMethodLink(path.join(root, "partial"));
    expect(settled.kind === "link" && settled.link.partial_pull).toBeUndefined();
  });

  it("states only what it measured when the stored method has moved", async () => {
    // The routine teammate-update pull: nothing local was edited, and no source
    // hashes are recorded, so the tool must not assert that the directory
    // changed.
    const stored = storedMethod({
      updated_at: "2026-09-21T09:00:00Z",
      files: treeOf({ "bundle.mthds": "theirs" }),
    });
    await writeBundle("team", { "bundle.mthds": 'domain = "demo"' });
    await linkInto("team", "2026-09-20T12:00:00Z");

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "team" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      location: { field: "output_dir" },
    });
    expect(error.message).not.toContain("both this directory and the stored method have changed");
    expect(error.message).toContain("differs from the stored one");
    expect(error.message).toContain("overwrite: true");
  });
});

describe("the save writes a link only where one belongs", () => {
  /** The link report off either arm of the union, which only the ok arm declares. */
  const creating = (name = "Demo"): CatalogWriteClient => ({
    ...clientNotCalled,
    async createMethod() {
      return storedMethod({ name });
    },
  });

  const updating = (methodId: string, name = "Demo"): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return storedMethod({ method_id: methodId, name });
    },
    async writeDraft() {
      return storedMethod({ method_id: methodId, name });
    },
  });

  it("refuses to re-point a directory linked to a different method", async () => {
    // The link file is committed and shared, so a silent takeover would send a
    // teammate's next save to this method instead of theirs.
    await writeBundle("theirs", { "bundle.mthds": 'domain = "demo"' });
    await writeLinkFile(
      path.join(root, "theirs", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_teammate",
        name: "The teammate's method",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
      "utf8",
    );

    const result = await saveMthdsMethod(
      { method_dir: "theirs", name: "Mine" },
      contextFor(creating("Mine"), validationAnswering(validReport)),
    );

    // Nothing is created: the link is read BEFORE the catalog call, because a
    // duplicate cannot be undone from here — delete is admin-only — and the old
    // ordering reported the refusal about a second method that already existed.
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      domain: "input",
      retry: "no",
      params: { path: path.join("theirs", LINK_FILE_NAME) },
      location: { field: "method_id" },
    });
    expect(error.message).toContain("mt_teammate");
    expect(error.message).toContain('method_id: "mt_teammate"');
    const link = await readMethodLink(path.join(root, "theirs"));
    expect(link.kind === "link" && link.link.method_id).toBe("mt_teammate");
  });

  it("updates normally when the directory is linked to that same method", async () => {
    // The mismatch check must not cost the ordinary case anything.
    await writeBundle("mine", { "bundle.mthds": 'domain = "demo"' });
    await writeLinkFile(
      path.join(root, "mine", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_mine",
        name: "Mine",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
      "utf8",
    );

    const result = await saveMthdsMethod(
      { method_dir: "mine", name: "Mine", method_id: "mt_mine" },
      contextFor(updating("mt_mine", "Mine"), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok" });
    expect(linkFileOf(result.structuredContent)?.written).toBe(true);
  });

  it("refuses an update whose method_id is not the one the directory is linked to", async () => {
    // This used to run the PUT and report the mismatch afterwards, on the
    // grounds that the method really was saved by then. But the save that
    // "really happened" was a destructive rewrite of a DIFFERENT method with
    // this directory's bundle and name, the catalog keeps no earlier version,
    // and the summary then told the caller the directory was NOT linked — whose
    // advice, followed, overwrote the teammate's method for real. The mismatch
    // costs one local file read to see, and the create arm already reads it.
    await writeBundle("theirs", { "bundle.mthds": 'domain = "demo"' });
    await writeLinkFile(
      path.join(root, "theirs", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_teammate",
        name: "The teammate's method",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
      "utf8",
    );

    // `clientNotCalled` throws on every method, so reaching the catalog at all
    // — even the read — fails this test.
    const result = await saveMthdsMethod(
      { method_dir: "theirs", name: "Mine", method_id: "mt_mine" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      params: { path: path.join("theirs", LINK_FILE_NAME) },
      location: { field: "method_id" },
    });
    expect(error.message).toContain("mt_teammate");
    expect(error.message).toContain("mt_mine");
    // Copying the folder without its link is the deliberate fork, and the message has to name it.
    expect(error.message).toContain('method_id: "mt_teammate"');
    expect(error.message).toContain(`copy the folder without its ${LINK_FILE_NAME}`);
    const link = await readMethodLink(path.join(root, "theirs"));
    expect(link.kind === "link" && link.link.method_id).toBe("mt_teammate");
  });
});

// ── round 2: the write set is validated, not merely contained ────────

describe("the pull writes a method's tree and nothing else", () => {
  const readingClient = (stored: MethodDetail): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  const storedNamed = (files: { name: string; content: string }[]): MethodDetail =>
    storedMethod({ files: files.map((file) => savedFile(file.name, file.content)) });

  const pull = async (stored: MethodDetail, output_dir = "pulled") =>
    getMthdsMethod(
      { method_id: "mt_one", output_dir },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

  it("refuses a stored name with a dotted path component", async () => {
    // Where a workspace keeps what configures its tools, not its code.
    const result = await pull(
      storedNamed([
        { name: "bundle.mthds", content: 'domain = "demo"' },
        { name: ".github/workflows/pwn.mthds", content: "on: push" },
      ]),
      ".",
    );

    expect(problemOf(result.structuredContent)).toMatchObject({
      code: "method.package_invalid",
      domain: "method",
      params: { reason: "unsafe_file_path" },
      location: { file: ".github/workflows/pwn.mthds" },
    });
    expect(problemOf(result.structuredContent).message).toContain("beginning with a dot");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a stored file named like the link file", async () => {
    // The link is written LAST, so this landed, was overwritten by the link,
    // was reported as written anyway, and left the directory refusing every
    // later pull for a change nobody had made.
    const result = await pull(
      storedNamed([
        { name: "bundle.mthds", content: 'domain = "demo"' },
        { name: LINK_FILE_NAME, content: "{}" },
      ]),
    );

    expect(problemOf(result.structuredContent)).toMatchObject({
      code: "method.package_invalid",
      location: { file: LINK_FILE_NAME },
    });
    expect(problemOf(result.structuredContent).message).toContain(LINK_FILE_NAME);
    await expect(fs.readdir(path.join(root, "pulled"))).resolves.toEqual([]);
  });

  it("refuses two stored names that land on one file, case included", async () => {
    // `nameFiles` keeps both as distinct names, so this tool's own save
    // produces the pair; on a case-insensitive filesystem one silently
    // replaced the other and both were reported written.
    const result = await pull(
      storedNamed([
        { name: "Bundle.mthds", content: "first" },
        { name: "bundle.mthds", content: "second" },
      ]),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "method.package_invalid",
      location: { file: "bundle.mthds" },
    });
    expect(error.message).toContain("lands on the same file");
    await expect(fs.readdir(path.join(root, "pulled"))).resolves.toEqual([]);
  });

  it("refuses an unlinked directory holding a bundle of its own under other names", async () => {
    // The occupancy test asks about the write set; this asks the ownership
    // question. Landing beside a stranger's bundle and then claiming the whole
    // directory with a link file is what the link file exists to stop.
    await writeBundle("mixed", { "their_bundle.mthds": "theirs" });

    const result = await pull(
      storedNamed([{ name: "bundle.mthds", content: 'domain = "demo"' }]),
      "mixed",
    );

    expect(problemOf(result.structuredContent)).toMatchObject({
      code: "client.target_exists",
      params: { path: "mixed" },
    });
    expect(problemOf(result.structuredContent).message).toContain("their_bundle.mthds");
    expect(await fs.readdir(path.join(root, "mixed"))).toEqual(["their_bundle.mthds"]);
  });
});

describe("the pull resumes and refreshes without destroying work", () => {
  const readingClient = (stored: MethodDetail): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  const stored = storedMethod({
    updated_at: "2026-09-20T12:00:00Z",
    files: treeOf({ "bundle.mthds": "first v1", "second.mthds": "second v1" }),
  });

  const linkWith = async (dir: string, extra: Record<string, unknown> = {}) =>
    writeLinkFile(
      path.join(root, dir, LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
        ...extra,
      }),
      "utf8",
    );

  const pull = async (dir: string, overwrite?: boolean) =>
    getMthdsMethod(
      { method_id: "mt_one", output_dir: dir, ...(overwrite === undefined ? {} : { overwrite }) },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

  it("refuses to resume over a file edited since the interrupted pull", async () => {
    // The marker says a pull was interrupted and NOTHING more. Read as blanket
    // overwrite authority it destroyed an edit made between the failure and the
    // retry — silently, with no flag and no mention in the result. It rides in
    // a file the user is told to commit, so it can be stale or planted too.
    await writeBundle("resumed", {
      "bundle.mthds": "first v1",
      "second.mthds": "MY PRECIOUS LOCAL EDIT",
    });
    await linkWith("resumed", { partial_pull: true });

    const result = await pull("resumed");

    expect(problemOf(result.structuredContent)).toMatchObject({ code: "client.target_exists" });
    expect(problemOf(result.structuredContent).message).toContain("second.mthds");
    expect(await fs.readFile(path.join(root, "resumed/second.mthds"), "utf8")).toBe(
      "MY PRECIOUS LOCAL EDIT",
    );
  });

  it("still resumes an interrupted pull whose files are absent or identical", async () => {
    // The failure told the caller to call again, and this is that call.
    await writeBundle("resumable", { "bundle.mthds": "first v1" });
    await linkWith("resumable", { partial_pull: true });

    const result = await pull("resumable");

    expect(result.structuredContent).toMatchObject({ status: "ok" });
    expect(await fs.readFile(path.join(root, "resumable/second.mthds"), "utf8")).toBe("second v1");
    const link = await readMethodLink(path.join(root, "resumable"));
    expect(link.kind === "link" && link.link.partial_pull).toBeUndefined();
  });

  it("writes nothing when every destination already matches, refreshing the link alone", async () => {
    // Rewriting identical bytes woke watchers and — with one read-only source —
    // turned a pure link refresh into a mid-write failure that marked the
    // directory as an interrupted pull having written nothing at all.
    await writeBundle("identical", { "bundle.mthds": "first v1", "second.mthds": "second v1" });
    await linkWith("identical", { synced_updated_at: "2026-09-01T00:00:00Z" });
    const before = (await fs.stat(path.join(root, "identical/bundle.mthds"))).mtimeMs;
    await fs.chmod(path.join(root, "identical/bundle.mthds"), 0o444);

    const result = await pull("identical");

    expect(result.structuredContent).toMatchObject({ status: "ok" });
    expect((await fs.stat(path.join(root, "identical/bundle.mthds"))).mtimeMs).toBe(before);
    const link = await readMethodLink(path.join(root, "identical"));
    expect(link.kind === "link" && link.link.synced_updated_at).toBe("2026-09-20T12:00:00Z");
    await fs.chmod(path.join(root, "identical/bundle.mthds"), 0o644);
  });

  it("writes a destination the user deleted instead of calling it an unsaved change", async () => {
    // A file that is not there holds no work. Counting it as a difference named
    // the file the user had deleted, called it a change they never made, and
    // refused every pull that would have restored it — `overwrite` included.
    await writeBundle("gappy", { "bundle.mthds": "first v1" });
    await linkWith("gappy");

    const result = await pull("gappy");

    expect(result.structuredContent).toMatchObject({ status: "ok" });
    expect(await fs.readFile(path.join(root, "gappy/second.mthds"), "utf8")).toBe("second v1");
  });

  it("says the directory IS linked when only the link refresh failed", async () => {
    // "NOT linked" was the worst of the three readings: it told the caller to
    // pass a method_id they did not need, about a directory that would have
    // updated the right method on its own.
    await writeBundle("readonly-link", { "bundle.mthds": "first v1" });
    await linkWith("readonly-link", { synced_updated_at: "2026-09-01T00:00:00Z" });
    await fs.chmod(path.join(root, "readonly-link", LINK_FILE_NAME), 0o444);

    const result = await pull("readonly-link");

    expect(result.structuredContent).toMatchObject({ status: "ok" });
    expect(linkFileOf(result.structuredContent)?.written).toBe(false);
    expect(result.summary).toContain("IS linked");
    expect(result.summary).not.toContain("NOT linked");
    await fs.chmod(path.join(root, "readonly-link", LINK_FILE_NAME), 0o644);
  });
});

describe("a version pull whose link cannot be marked", () => {
  it("writes nothing, so its files never read as the draft's to a later save", async () => {
    const stored = storedMethod({
      latest_version: 2,
      latest_published: versionSummary({ tree_digest: DIGEST_B }),
    });
    await writeBundle("work", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: stored.updated_at,
      }),
    });
    await fs.chmod(path.join(root, "work", LINK_FILE_NAME), 0o444);

    try {
      const result = await getMthdsMethod(
        { method_id: "mt_one@2", output_dir: "work" },
        contextFor(
          {
            ...clientNotCalled,
            async getMethod() {
              return stored;
            },
            async getMethodVersion() {
              return storedVersion();
            },
          },
          validationAnswering(validReport),
        ),
      );

      // Written under the old link, version 2's files would carry the draft's
      // current token and no version marker, and an ordinary save would then
      // replace the draft with them, with no explicit token.
      const error = problemOf(result.structuredContent);
      expect(error).toMatchObject({
        code: "client.write_failed",
        domain: "input",
        retry: "no",
        params: { path: path.join("work", LINK_FILE_NAME), reason: "link_unwritable" },
        location: { field: "output_dir" },
      });
      expect(error.message).toContain("holding version 2");
      expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(
        'domain = "demo"',
      );
    } finally {
      await fs.chmod(path.join(root, "work", LINK_FILE_NAME), 0o644);
    }
  });
});

describe("a draft pull over a link that records a version", () => {
  const linked = {
    method_id: "mt_one",
    name: "Summarize PDF",
    api_host: "api-dev.pipelex.com",
    synced_updated_at: "2026-09-19T00:00:00Z",
    synced_version: 2,
  };

  it("writes nothing when the link cannot be updated, so it never says the draft is a version", async () => {
    await writeBundle("work", {
      "bundle.mthds": 'domain = "version_two"',
      [LINK_FILE_NAME]: JSON.stringify(linked),
    });
    await fs.chmod(path.join(root, "work", LINK_FILE_NAME), 0o444);

    try {
      const result = await getMthdsMethod(
        { method_id: "mt_one", output_dir: "work", overwrite: true },
        contextFor(
          {
            ...clientNotCalled,
            async getMethod() {
              return storedMethod();
            },
            async getMethodVersion() {
              return storedVersion();
            },
          },
          validationAnswering(validReport),
        ),
      );

      const error = problemOf(result.structuredContent);
      expect(error).toMatchObject({
        code: "client.write_failed",
        params: { reason: "link_unwritable" },
        location: { field: "output_dir" },
      });
      expect(error.message).toContain("record of version 2 could not be cleared");
      expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(
        'domain = "version_two"',
      );
    } finally {
      await fs.chmod(path.join(root, "work", LINK_FILE_NAME), 0o644);
    }
  });

  it("reads no version when overwrite already decides, the draft having moved", async () => {
    await writeBundle("work", {
      "bundle.mthds": 'domain = "edited here"',
      [LINK_FILE_NAME]: JSON.stringify(linked),
    });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "work", overwrite: true },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );

    // clientNotCalled's getMethodVersion would throw: overwrite decided first.
    expect(result.structuredContent).toMatchObject({ status: "ok", version: "draft" });
    expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(
      'domain = "demo"',
    );
  });
});

describe("a pull lands only on the link it planned against", () => {
  it("writes nothing when the link moved between its plan and its landing", async () => {
    // The directory last pulled version 2; pulling the draft reads version 2
    // to recognise its files as stored. Another workshop process rewrites the
    // link meanwhile, so the plan is about a directory that is gone.
    const linked = {
      method_id: "mt_one",
      name: "Summarize PDF",
      api_host: "api-dev.pipelex.com",
      synced_updated_at: "2026-09-20T12:00:00Z",
      synced_version: 2,
    };
    const theirs = JSON.stringify({ ...linked, synced_version: 3 });
    await writeBundle("work", {
      "bundle.mthds": 'domain = "version_two"',
      [LINK_FILE_NAME]: JSON.stringify(linked),
    });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "work" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return storedMethod();
          },
          async getMethodVersion() {
            await writeLinkFile(path.join(root, "work", LINK_FILE_NAME), theirs, "utf8");
            return storedVersion();
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.workspace_busy",
      domain: "runtime",
      retry: "yes",
      params: { path: path.join("work", LINK_FILE_NAME) },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain(
      "changed after this pull read it — another save or pull rewrote it",
    );
    expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(
      'domain = "version_two"',
    );
    expect(await fs.readFile(path.join(root, "work", LINK_FILE_NAME), "utf8")).toBe(theirs);
  });
});

describe("round 1 of the convergence review", () => {
  const link = {
    method_id: "mt_one",
    name: "Summarize PDF",
    api_host: "api-dev.pipelex.com",
    synced_updated_at: "2026-09-20T12:00:00Z",
  };

  it("creates one method when two creates from one directory overlap", async () => {
    // Both used to read the directory unclaimed and both minted a method; the
    // second's link write then found the first's link and wrote nothing,
    // leaving a duplicate only an administrator can delete.
    await writeBundle("fresh", { "bundle.mthds": 'domain = "demo"' });
    let created = 0;
    const client: CatalogWriteClient = {
      ...clientNotCalled,
      async createMethod() {
        created += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return storedMethod({ method_id: `mt_new${created}`, name: "Fresh" });
      },
    };
    const save = () =>
      saveMthdsMethod(
        { method_dir: "fresh", name: "Fresh" },
        contextFor(client, validationAnswering(validReport)),
      );

    // Each save reads its arguments' paths before it queues, so either can
    // take the turn first: one creates, the other is refused, in either order.
    const results = await Promise.all([save(), save()]);
    const isCreated = (result: (typeof results)[number]) =>
      (result.structuredContent as { status: string }).status === "ok";
    const winner = results.find(isCreated);
    const loser = results.find((result) => !isCreated(result));

    expect(created).toBe(1);
    expect(winner?.structuredContent).toMatchObject({ status: "ok", saved: "created" });
    if (loser === undefined) throw new Error("expected one of the two creates to be refused");
    expect(problemOf(loser.structuredContent)).toMatchObject({
      code: "client.target_exists",
      location: { field: "method_id" },
    });
    expect(problemOf(loser.structuredContent).message).toContain("mt_new1");
  });

  it("refuses a pull whose file was edited while it read a version, keeping the edit", async () => {
    // The plan read the file as version 2's bytes, then waited on the platform
    // for version 2; an edit landing meanwhile moved no link, and the pull
    // wrote the draft over it.
    await writeBundle("work", {
      "bundle.mthds": 'domain = "version_two"',
      [LINK_FILE_NAME]: JSON.stringify({ ...link, synced_version: 2 }),
    });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "work" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return storedMethod();
          },
          async getMethodVersion() {
            await fs.writeFile(
              path.join(root, "work", "bundle.mthds"),
              'domain = "edited"',
              "utf8",
            );
            return storedVersion();
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.workspace_busy",
      domain: "runtime",
      retry: "yes",
      params: { path: "work" },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("`bundle.mthds` changed after this pull read it");
    expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(
      'domain = "edited"',
    );
  });

  it("refuses a pull when a save refreshed the link while the method was read", async () => {
    // Read after the method, the link was ahead of it: the pull wrote the older
    // draft back and moved the link to its older token.
    await writeBundle("work", { [LINK_FILE_NAME]: JSON.stringify(link) });
    const refreshed = JSON.stringify({ ...link, synced_updated_at: "2026-09-21T09:00:00Z" });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "work", overwrite: true },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            await writeLinkFile(path.join(root, "work", LINK_FILE_NAME), refreshed, "utf8");
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(problemOf(result.structuredContent)).toMatchObject({
      code: "client.workspace_busy",
      retry: "yes",
    });
    expect(problemOf(result.structuredContent).message).toContain(
      "changed after this pull read it — another save or pull rewrote it",
    );
    expect(await fs.readFile(path.join(root, "work", LINK_FILE_NAME), "utf8")).toBe(refreshed);
    await expect(fs.access(path.join(root, "work", "bundle.mthds"))).rejects.toThrow();
  });

  it("refuses a pull whose link became unreadable while the method was read", async () => {
    // Round 2: a link turned into a merge conflict after the pull read it was
    // taken for a failed link write, not a change, and the pull wrote its files
    // under a link it no longer knew anything about.
    await writeBundle("work", { [LINK_FILE_NAME]: JSON.stringify(link) });
    const conflicted = `<<<<<<< HEAD\n${JSON.stringify(link)}\n=======\n{}\n>>>>>>> theirs\n`;

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "work", overwrite: true },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            await writeLinkFile(path.join(root, "work", LINK_FILE_NAME), conflicted, "utf8");
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.workspace_busy",
      retry: "yes",
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("changed after this pull read it — it became unreadable");
    expect(await fs.readFile(path.join(root, "work", LINK_FILE_NAME), "utf8")).toBe(conflicted);
    await expect(fs.access(path.join(root, "work", "bundle.mthds"))).rejects.toThrow();
  });

  it("names the bare id for the draft where the platform does not resolve versions", async () => {
    await writeBundle("work", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify(link),
    });

    const result = await saveMthdsMethod(
      { method_dir: "work", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft() {
            return storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
          },
          version: versionsUnsupported,
        } as CatalogWriteClient,
        validationAnswering(validReport),
      ),
    );

    // A suffix is refused there, so `@draft` would cost the caller a round trip.
    expect(result.summary).toContain(
      "pass method_id `mt_one`, the bare id, which reads the draft here",
    );
  });
});

describe("rounds 3 and 4 of the convergence review: the workshop's write lock", () => {
  const link = {
    method_id: "mt_one",
    name: "Summarize PDF",
    api_host: "api-dev.pipelex.com",
    synced_updated_at: "2026-09-20T12:00:00Z",
  };
  // The lock lives under the home directory, which every test here has to
  // itself (HOME, set above): a home whose lock folder is a plain file is one
  // where the lock cannot be taken at all, without waiting out its bound.
  beforeEach(async () => {
    await blockLock();
  });

  /** Put a plain file where the lock's directory goes, so no call can take the lock. */
  async function blockLock(): Promise<void> {
    const dir = path.dirname(linkLockFile());
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.writeFile(dir, "not a directory", "utf8");
  }

  it("refuses a pull, writing nothing, when the workshop's write lock cannot be taken", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "work" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );

    // Not busy: no retry takes a lock that cannot be opened, so it is not retryable.
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.write_failed",
      retry: "no",
      params: { path: "work", reason: "lock_unavailable" },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("write lock");
    expect(error.message).toContain("nothing was written");
    await expect(fs.access(path.join(root, "work", "bundle.mthds"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "work", LINK_FILE_NAME))).rejects.toThrow();
  });

  it("refuses a save, sending nothing, when the workshop's write lock cannot be taken for its read", async () => {
    // The save's read held no lock, so another workshop process's pull could
    // land while it read, and a caller passing expected_updated_at sent the mix.
    await writeBundle("work", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify(link),
    });
    await writeBundle("fresh", { "bundle.mthds": 'domain = "demo"' });
    const calls: string[] = [];
    const client: CatalogWriteClient = {
      ...clientNotCalled,
      async writeDraft() {
        calls.push("writeDraft");
        return storedMethod();
      },
      async createMethod() {
        calls.push("createMethod");
        return storedMethod();
      },
    };

    for (const input of [
      {
        method_dir: "work",
        method_id: "mt_one",
        expected_updated_at: "2026-09-20T12:00:00Z",
      },
      { method_dir: "fresh", name: "Fresh" },
    ]) {
      const result = await saveMthdsMethod(
        input,
        contextFor(client, validationAnswering(validReport)),
      );

      const error = problemOf(result.structuredContent);
      expect(error).toMatchObject({
        code: "client.write_failed",
        retry: "no",
        params: { reason: "lock_unavailable" },
        location: { field: "method_dir" },
      });
      expect(error.message).toContain("write lock");
      expect(error.message).toContain("sent nothing");
    }
    expect(calls).toEqual([]);
    expect(await fs.readFile(path.join(root, "work", LINK_FILE_NAME), "utf8")).toBe(
      JSON.stringify(link),
    );
    await expect(fs.access(path.join(root, "fresh", LINK_FILE_NAME))).rejects.toThrow();
  });

  it("keeps the save, and leaves its link unwritten, when the write lock is lost after the read", async () => {
    await writeBundle("work", {
      "bundle.mthds": 'domain = "demo"',
      [LINK_FILE_NAME]: JSON.stringify(link),
    });
    // The read takes the lock; it is blocked while the draft is written, so
    // the link write after it cannot take it.
    await fs.rm(path.dirname(linkLockFile()));

    const result = await saveMthdsMethod(
      { method_dir: "work", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft() {
            await blockLock();
            return storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", saved: "updated" });
    expect(linkFileOf(result.structuredContent)).toMatchObject({ written: false });
    expect(linkFileOf(result.structuredContent)?.reason).toContain("write lock");
    expect(await fs.readFile(path.join(root, "work", LINK_FILE_NAME), "utf8")).toBe(
      JSON.stringify(link),
    );
  });
});

describe("the pull says what the directory holds that the method does not", () => {
  const readingClient = (stored: MethodDetail): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  it("names a source the stored method no longer has, and deletes nothing", async () => {
    // The pull writes what the catalog holds NOW, so a file a teammate removed
    // was neither written nor noticed — and the link was refreshed anyway,
    // leaving the directory certifying a sync it does not have.
    const stored = storedMethod({
      updated_at: "2026-09-21T09:00:00Z",
      files: treeOf({ "bundle.mthds": "first v2" }),
    });
    await writeBundle("drifted", { "bundle.mthds": "first v1", "extra.mthds": "dropped" });
    await fs.writeFile(path.join(root, "drifted/helpers.py"), "x = 1", "utf8");
    await writeLinkFile(
      path.join(root, "drifted", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
      "utf8",
    );

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "drifted", overwrite: true },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      unmanaged: ["extra.mthds", "helpers.py"],
    });
    expect(result.summary).toContain("which this method does not");
    // It cannot tell a dropped file from the user's own, so it removes neither.
    expect(await fs.readFile(path.join(root, "drifted/extra.mthds"), "utf8")).toBe("dropped");
  });

  it("does not descend a vendored or dot directory, and does not call its files sources", async () => {
    // The walk descended everything: `node_modules` spent the 512-entry budget
    // and silenced the line altogether, and a `.venv` small enough to fit was
    // listed as sources "this method does not have". The link file is meant to
    // be COMMITTED, so a repository at output_dir is the expected case.
    const stored = storedMethod({
      files: treeOf({ "bundle.mthds": 'domain = "demo"' }),
    });
    await writeBundle("proj", {
      "bundle.mthds": 'domain = "demo"',
      ".venv/lib/site-packages/_virtualenv.py": "x = 1",
      ".git/hooks/note.py": "x = 1",
      "node_modules/pkg/index.py": "x = 1",
      "__pycache__/cached.py": "x = 1",
      "mine.py": "x = 1",
    });
    await writeLinkFile(
      path.join(root, "proj", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
      "utf8",
    );

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "proj", overwrite: true },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

    // The user's own stray source is named; nothing from the vendored trees is.
    expect(result.structuredContent).toMatchObject({ status: "ok", unmanaged: ["mine.py"] });
    // And the walk still finished, so the claim it makes is a complete one.
    expect(
      (result.structuredContent as { unmanaged_truncated?: boolean }).unmanaged_truncated,
    ).toBeUndefined();
  });

  it("says it could not finish rather than reporting a short list as the whole one", async () => {
    // The depth and budget bounds returned "incomplete"; the readdir catch
    // returned "complete", so an unreadable subtree shortened the list while
    // the line above went on claiming it named everything there was.
    const stored = storedMethod({
      files: treeOf({ "bundle.mthds": 'domain = "demo"' }),
    });
    await writeBundle("blocked", { "bundle.mthds": 'domain = "demo"', "seen.py": "x = 1" });
    await writeBundle("blocked/denied", { "hidden.py": "x = 1" });
    await writeLinkFile(
      path.join(root, "blocked", LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
      }),
      "utf8",
    );
    await fs.chmod(path.join(root, "blocked/denied"), 0o000);

    // root ignores the mode bits, so the denial this test needs would not
    // happen and every assertion below would be measuring the wrong thing.
    // Ask whether the directory is really unreadable rather than assuming it.
    const denied = await fs
      .readdir(path.join(root, "blocked/denied"))
      .then(() => false)
      .catch(() => true);
    if (!denied) {
      await fs.chmod(path.join(root, "blocked/denied"), 0o755);
      return;
    }

    try {
      const result = await getMthdsMethod(
        { method_id: "mt_one", output_dir: "blocked", overwrite: true },
        contextFor(readingClient(stored), validationAnswering(validReport)),
      );

      const structured = result.structuredContent as {
        unmanaged?: string[];
        unmanaged_truncated?: boolean;
      };
      // Reporting nothing rather than a partial list is the contract...
      expect(structured.unmanaged).toBeUndefined();
      // ...and saying so is what keeps it from reading as "there is nothing here".
      expect(structured.unmanaged_truncated).toBe(true);
      expect(result.summary).toContain("could not list what else");
      expect(result.summary).not.toContain("which this method does not");
    } finally {
      await fs.chmod(path.join(root, "blocked/denied"), 0o755);
    }
  });

  it("says it cannot tell when the folder's tree is past the deployment's limits", async () => {
    const stored = storedMethod({ files: treeOf({ "bundle.mthds": 'domain = "demo"' }) });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "crowded" },
      contextFor(
        {
          ...readingClient(stored),
          async methodTreeLimits() {
            return { maxFileCount: 1 };
          },
        },
        validationAnswering(validReport),
      ),
    );
    // The pulled tree alone fits; a second file of the user's does not.
    await fs.writeFile(path.join(root, "crowded", "notes.md"), "mine", "utf8");
    const again = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "crowded" },
      contextFor(
        {
          ...readingClient(stored),
          async methodTreeLimits() {
            return { maxFileCount: 1 };
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).not.toHaveProperty("unmanaged_truncated");
    expect(again.structuredContent).toMatchObject({ status: "ok", unmanaged_truncated: true });
    expect(again.structuredContent).not.toHaveProperty("unmanaged");
    expect(again.summary).toContain("NOT saying the folder holds only this method's files");
  });

  it("says nothing when the directory holds only this method's files", async () => {
    const stored = storedMethod({
      files: treeOf({ "bundle.mthds": 'domain = "demo"' }),
    });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "tidy" },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

    expect((result.structuredContent as { unmanaged?: string[] }).unmanaged).toBeUndefined();
    expect(result.summary).not.toContain("which this method does not");
  });
});

// ── drafts and versions ─────────────────────────────────────────────

describe("the pull reads the draft by default, and a version on @n", () => {
  const VERSION_TWO = 'domain = "version_two"';

  /** A client holding `stored` as the draft and {@link storedVersion} as version 2. */
  function versionedClient(
    stored: MethodDetail,
    seen: { versions: [string, number][] } = { versions: [] },
  ): CatalogWriteClient {
    return {
      ...clientNotCalled,
      async getMethod() {
        return stored;
      },
      async getMethodVersion(id, version) {
        seen.versions.push([id, version]);
        if (version !== 2) {
          throw platformRefusal(`/v1/methods/${id}/versions/${version}`, 404, {
            code: "pipelex.catalog.not_found",
            title: "The method was not found",
            detail: "No such version",
            domain: "input",
          });
        }
        return storedVersion();
      },
    };
  }

  async function linkTo(dir: string, fields: { synced: string; version?: number }): Promise<void> {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await writeLinkFile(
      path.join(root, dir, LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: fields.synced,
        ...(fields.version === undefined ? {} : { synced_version: fields.version }),
      }),
      "utf8",
    );
  }

  it("reads the draft for a bare id and for mt_…@draft, saying so", async () => {
    for (const methodId of ["mt_one", "mt_one@draft"]) {
      const result = await getMthdsMethod(
        { method_id: methodId },
        contextFor(versionedClient(publishedMethod()), validationAnswering(validReport)),
      );

      expect(result.structuredContent).toMatchObject({
        status: "ok",
        method_id: "mt_one",
        version: "draft",
        latest_version: 2,
        publish_state: "draft_ahead",
      });
    }
  });

  it("reads version n for mt_…@n, with the method's name", async () => {
    const seen = { versions: [] as [string, number][] };
    let handshakes = 0;
    const client = Object.assign(versionedClient(publishedMethod(), seen), {
      async version() {
        handshakes += 1;
        return { version: "1.0.0", extensions: ["runs", "method_versions"] };
      },
    });
    const result = await getMthdsMethod(
      { method_id: "mt_one@2" },
      contextFor(client, validationAnswering(validReport)),
    );

    expect(seen.versions).toEqual([["mt_one", 2]]);
    // Only the draft's sentences read the versions handshake; a version read asks nothing.
    expect(handshakes).toBe(0);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      method_id: "mt_one",
      name: "Summarize PDF",
      version: 2,
    });
    const files = (result.structuredContent as { files: { content?: string }[] }).files;
    expect(files.map((file) => file.content)).toEqual([VERSION_TWO]);
    expect(result.summary).toContain("Version 2 of **Summarize PDF**");
  });

  it("refuses a version the method never had, naming the ones it has", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one@7" },
      contextFor(versionedClient(publishedMethod()), validationAnswering(validReport)),
    );

    // The catalog's problem, relayed, its message saying what the method has.
    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "pipelex.catalog.not_found",
      domain: "input",
      retry: "no",
      detail: "No such version",
      request_id: "req_404",
    });
    expect(error.message).toContain("no version 7");
    expect(error.message).toContain("latest published version is 2");
    expect(error.message).toContain('"mt_one@<n>"');
    expectProblemSummary(result.summary, error);
  });

  it("refuses a suffix it cannot read before anything is sent", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one@latest" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    expect(problemOf(result.structuredContent)).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "method_id", reason: "not_a_selector" },
      location: { field: "method_id" },
    });
  });

  it("pulls a version over the draft it holds, and records the version in the link", async () => {
    const stored = publishedMethod();
    await writeBundle("work", { "bundle.mthds": 'domain = "demo"' });
    await linkTo("work", { synced: stored.updated_at });

    // The local files are the draft's, and the draft has not moved: without
    // reading them as stored, this would be refused as unsaved work.
    const result = await getMthdsMethod(
      { method_id: "mt_one@2", output_dir: "work" },
      contextFor(versionedClient(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", version: 2 });
    expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(VERSION_TWO);
    const link = await readMethodLink(path.join(root, "work"));
    expect(link.kind === "link" && link.link).toMatchObject({
      synced_updated_at: stored.updated_at,
      synced_version: 2,
    });
    expect(result.summary).toContain("now holds version 2, not the draft");
    expect(result.summary).toContain(`expected_updated_at ${stored.updated_at}`);
    expect(result.summary).toContain("a save without the token is refused");
    expect(result.summary).toContain("not one to publish under");
    expect(result.summary).toContain("publishes nothing");
  });

  it("records no version when the version pulled is the draft, file for file", async () => {
    const stored = publishedMethod({ files: storedVersion().files }, false);

    const result = await getMthdsMethod(
      { method_id: "mt_one@2", output_dir: "work" },
      contextFor(versionedClient(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", version: 2 });
    const link = await readMethodLink(path.join(root, "work"));
    expect(link.kind === "link" && link.link).toMatchObject({
      synced_updated_at: stored.updated_at,
    });
    expect(link.kind === "link" && link.link).not.toHaveProperty("synced_version");
    expect(result.summary).toContain("Version 2 is identical to the draft");
    expect(result.summary).not.toContain("not the draft");

    // The directory holds the draft, so an ordinary save goes through on the link's token.
    let sent: MethodDraftInput | undefined;
    const saved = await saveMthdsMethod(
      { method_dir: "work", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async writeDraft(_id, input) {
            sent = input;
            return storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );
    expect(saved.structuredContent).toMatchObject({ status: "ok", saved: "updated" });
    expect(sent?.expected_updated_at).toBe(stored.updated_at);
  });

  it("pulls the draft back over the version it last pulled", async () => {
    const stored = publishedMethod();
    await writeBundle("work", { "bundle.mthds": VERSION_TWO });
    await linkTo("work", { synced: stored.updated_at, version: 2 });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "work" },
      contextFor(versionedClient(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", version: "draft" });
    expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(
      'domain = "demo"',
    );
    // A draft pull clears the version: the directory holds the draft again.
    const link = await readMethodLink(path.join(root, "work"));
    expect(link.kind === "link" && link.link).not.toHaveProperty("synced_version");
  });

  it("still refuses a pull over local bytes the catalog stores nowhere", async () => {
    const stored = publishedMethod();
    await writeBundle("work", { "bundle.mthds": 'domain = "edited locally"' });
    await linkTo("work", { synced: stored.updated_at, version: 2 });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "work" },
      contextFor(versionedClient(stored), validationAnswering(validReport)),
    );

    const error = problemOf(result.structuredContent);
    expect(error).toMatchObject({
      code: "client.target_exists",
      params: { path: "work" },
      location: { field: "output_dir" },
    });
    expect(error.message).toContain("never saved");
    expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(
      'domain = "edited locally"',
    );
  });
});

describe("the link file's synced_version", () => {
  async function linkHolding(value: unknown): Promise<string> {
    const dir = path.join(root, `v-${JSON.stringify(value) ?? "absent"}`);
    await fs.mkdir(dir, { recursive: true });
    await writeLinkFile(
      path.join(dir, LINK_FILE_NAME),
      JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "2026-09-20T12:00:00Z",
        ...(value === undefined ? {} : { synced_version: value }),
      }),
      "utf8",
    );
    return dir;
  }

  it("is read as a version number, and absent or null means the draft", async () => {
    for (const [value, expected] of [
      [3, 3],
      [null, undefined],
      [undefined, undefined],
    ] as const) {
      const link = await readMethodLink(await linkHolding(value));
      expect(link.kind).toBe("link");
      expect(link.kind === "link" ? link.link.synced_version : "unread").toBe(expected);
    }
  });

  it("makes the link unreadable when it is present but not a version number", async () => {
    // Dropped, it would read as a directory holding the draft, and a save from
    // it would replace the draft with a version's files without the token a
    // restore needs.
    for (const value of [0, 1.5, "3", true]) {
      expect(await readMethodLink(await linkHolding(value))).toMatchObject({
        kind: "unreadable",
        reason: expect.stringContaining("synced_version"),
      });
    }
  });
});
