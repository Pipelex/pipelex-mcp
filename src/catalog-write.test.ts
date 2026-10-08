import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type {
  MethodData,
  MethodDraftInput,
  MethodVersion,
  MethodVersionSummary,
  MethodWriteInput,
  PipelexValidationResult,
} from "@pipelex/sdk";
import { parseMethodFiles } from "mthds/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LINK_FILE_NAME, apiHostOf, readMethodLink } from "./capabilities/catalog-link.js";
import {
  buildCatalogWriteContext,
  getMthdsMethod,
  saveMthdsMethod,
  storedSourceFiles,
} from "./capabilities/catalog-write.js";
import type { CatalogWriteClient, CatalogWriteContext } from "./capabilities/catalog-write.js";
import { DEFAULT_API_URL, createPipelexApiClient } from "./capabilities/shared.js";
import type { ToolError } from "./capabilities/shared.js";
import { localFileResolver } from "./files.js";

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
  validation_errors: [
    { category: "blueprint_validation", message: "Unknown pipe type", source: "bundle.mthds" },
  ],
  rendered_markdown: "# Invalid",
} as unknown as PipelexValidationResult;

/** A validation context whose files arm answers `report` and whose selector arm must not fire. */
function validationAnswering(report: PipelexValidationResult, capture?: { files?: unknown }) {
  return {
    baseUrl: DEFAULT_API_URL,
    client: {
      async validate(): Promise<PipelexValidationResult> {
        throw new Error("the selector leg must not be called by a save");
      },
      async validateFiles(files: unknown): Promise<PipelexValidationResult> {
        if (capture !== undefined) {
          capture.files = files;
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

function storedMethod(overrides: Partial<MethodData> = {}): MethodData {
  return {
    method_id: "mt_one",
    org_id: "org_1",
    created_by_user_id: "user_1",
    name: "Summarize PDF",
    mthds: JSON.stringify([{ name: "bundle.mthds", content: 'domain = "demo"' }]),
    python: [],
    input_data: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-20T12:00:00Z",
    draft_digest: "a".repeat(64),
    latest_version: null,
    latest_published: null,
    ...overrides,
  };
}

/** A published version's summary; `source_digest` defaults to the draft's, so the draft is unchanged. */
function versionSummary(overrides: Partial<MethodVersionSummary> = {}): MethodVersionSummary {
  return {
    version: 2,
    source_digest: "a".repeat(64),
    crate_fingerprint: "crate-fp",
    runner_version: "0.78.0",
    description: null,
    published_at: "2026-09-19T08:00:00Z",
    published_by: "user_1",
    ...overrides,
  };
}

/** A stored method published as version 2, with the draft ahead of it unless `aheadOf` is false. */
function publishedMethod(overrides: Partial<MethodData> = {}, ahead = true): MethodData {
  return storedMethod({
    latest_version: 2,
    latest_published: versionSummary(ahead ? { source_digest: "b".repeat(64) } : {}),
    ...overrides,
  });
}

/** A stored version of `mt_one`. */
function storedVersion(overrides: Partial<MethodVersion> = {}): MethodVersion {
  return {
    ...versionSummary(),
    method_id: "mt_one",
    mthds: JSON.stringify([{ name: "bundle.mthds", content: 'domain = "version_two"' }]),
    python: [],
    ...overrides,
  };
}

/** The 409 the draft write answers for a stale token. */
function draftConflict(): ApiResponseError {
  return new ApiResponseError(
    "conflict",
    "https://api-dev.pipelex.com/v1/methods/mt_one/draft",
    409,
    "Conflict",
    "{}",
    undefined,
    "The method's draft changed since expected_updated_at.",
    undefined,
    "method_update_conflict",
  );
}

/** A client whose every arm throws — each test opts into the one it needs. */
const clientNotCalled: CatalogWriteClient = {
  async getMethod(): Promise<MethodData> {
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

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "catalog-write-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function contextFor(
  client: CatalogWriteClient,
  validation: CatalogWriteContext["validation"],
): CatalogWriteContext {
  return {
    baseUrl: "https://api-dev.pipelex.com",
    client,
    resolver: localFileResolver(root),
    pythonResolver: localFileResolver(root, ".py"),
    saveRoot: root,
    validation,
  };
}

async function writeBundle(dir: string, files: Record<string, string>): Promise<void> {
  await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

function errorsOf(structured: { status: string; errors?: ToolError[] }): ToolError[] {
  return structured.status === "error" ? (structured.errors ?? []) : [];
}

// ── mthds_save_method ───────────────────────────────────────────────

describe("saveMthdsMethod", () => {
  it("creates when method_id is absent, serializing the files root-first under their relative names", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "pipes/extra.mthds": 'pipe = "extra"',
    });

    let sent: MethodWriteInput | undefined;
    const result = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }, { path: "methods/demo/pipes/extra.mthds" }],
        name: "Demo",
      },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(input) {
            sent = input;
            return storedMethod({ name: "Demo", mthds: input.mthds });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent).toMatchObject({ is_valid: true, saved: "created" });
    // The order is load-bearing: the platform derives the listed description
    // from the first file, so the root must stay first through serialization.
    expect(parseMethodFiles(sent?.mthds)).toEqual([
      { name: "bundle.mthds", content: 'domain = "demo"' },
      { name: "pipes/extra.mthds", content: 'pipe = "extra"' },
    ]);
    // Omitted python is ABSENT, not empty: an empty array would clear whatever
    // Python is stored, which a save from an unchanged directory must not do.
    expect(sent).not.toHaveProperty("python");
  });

  it("writes the link file beside the root file and reports it", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "Demo" },
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
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "Demo" },
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
    expect(result.structuredContent).toHaveProperty("validation_errors");
    expect(result.summary).toContain("NOT valid");
    expect(result.summary).toContain("a publish refuses it");
  });

  it("refuses the save when validation produces no verdict", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const unreachable = {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validateFiles(): Promise<PipelexValidationResult> {
          throw new ApiUnreachableError(
            "down",
            "https://api-dev.pipelex.com/v1/validate",
            "ECONNREFUSED",
          );
        },
      },
    } as unknown as CatalogWriteContext["validation"];

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "Demo" },
      contextFor(clientNotCalled, unreachable),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.summary).toContain("no validation verdict");
  });

  it("requires a name to create", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }] },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    expect(errorsOf(result.structuredContent)[0]).toMatchObject({
      class: "input_domain",
      location: "name",
    });
  });

  it("writes the draft through method_id, sending neither input_data nor the name", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    let sentId: string | undefined;
    let sent: MethodDraftInput | undefined;
    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
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
        files: [{ path: "methods/demo/bundle.mthds" }],
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
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
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
    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ location: "expected_updated_at" });
    expect(error.message).toContain(`as this directory's ${LINK_FILE_NAME} records`);
    expect(error.hint).toContain("the draft's current updated_at");
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
    const refused = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );
    const [error] = errorsOf(refused.structuredContent);
    expect(error).toMatchObject({
      class: "input_domain",
      location: "expected_updated_at",
      retryable: false,
    });
    expect(error.message).toContain("holds version 2");
    expect(error.hint).toContain('expected_updated_at "2026-09-20T12:00:00Z"');
    expect(refused.summary).toContain("holds a published version");

    // With the token, after the user asked, the restore goes through.
    let sent: MethodDraftInput | undefined;
    const restored = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }],
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
        { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
        contextFor(clientNotCalled, validationAnswering(validReport)),
      );

      const [error] = errorsOf(result.structuredContent);
      expect(error).toMatchObject({ class: "input_domain", location: "link_dir" });
      expect(error.message).toContain("was interrupted");
      expect(error.hint).toContain("Pull the method into the directory again");
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
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );
    const [error] = errorsOf(refused.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "link_dir" });
    expect(error.message).toContain("cannot be read");
    expect(error.hint).toContain("merge conflict");

    // An explicit token is its own guard; the broken link is still not touched.
    const saved = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }],
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

  it("holds a save to the token its link recorded before its files were read", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "older"',
      [LINK_FILE_NAME]: JSON.stringify({
        method_id: "mt_one",
        name: "Summarize PDF",
        api_host: "api-dev.pipelex.com",
        synced_updated_at: "T0",
      }),
    });

    // One draft, compare-and-swapped as the platform does.
    let draft = { content: "", updatedAt: "T0", writes: 0 };
    const client: CatalogWriteClient = {
      ...clientNotCalled,
      async writeDraft(_id, input) {
        if (
          input.expected_updated_at !== undefined &&
          input.expected_updated_at !== draft.updatedAt
        ) {
          throw draftConflict();
        }
        draft = {
          content: input.mthds,
          updatedAt: `T${draft.writes + 1}`,
          writes: draft.writes + 1,
        };
        return storedMethod({ updated_at: draft.updatedAt });
      },
      async getMethod() {
        return storedMethod({ updated_at: draft.updatedAt });
      },
    };
    // The first validation waits until the second save has landed.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let validations = 0;
    const validation = {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validate(): Promise<PipelexValidationResult> {
          throw new Error("the selector leg must not be called by a save");
        },
        async validateFiles(): Promise<PipelexValidationResult> {
          validations += 1;
          if (validations === 1) await gate;
          return validReport;
        },
      },
    } as unknown as CatalogWriteContext["validation"];

    const first = saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
      contextFor(client, validation),
    );
    await vi.waitFor(() => expect(validations).toBe(1));
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "newer"' });
    const second = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
      contextFor(client, validation),
    );
    expect(second.structuredContent.status).toBe("ok");
    release();

    // The first save read its bytes against T0; the link moved to T1 while it
    // validated, and sending T1 would replace the newer draft with older bytes.
    const [error] = errorsOf((await first).structuredContent);
    expect(error).toMatchObject({ location: "expected_updated_at" });
    expect(draft.content).toContain("newer");
    const link = await readMethodLink(path.join(root, "methods/demo"));
    expect(link.kind === "link" && link.link.synced_updated_at).toBe("T1");
  });

  it("reads mt_…@draft as the bare id, and refuses a version", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    let sentId: string | undefined;
    const drafted = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one@draft" },
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
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one@3" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );
    const [error] = errorsOf(versioned.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(error.hint).toContain('"mt_one"');
  });

  it("renames through its own call when the name changed, after the draft write", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const calls: string[] = [];
    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "New name", method_id: "mt_one" },
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
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "New name", method_id: "mt_one" },
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
    expect(result.summary).toContain("2026-09-21T09:05:00Z");
  });

  it("does not rename when the name is unchanged", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }],
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

  it("reports a failed rename beside a saved draft", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "", method_id: "mt_one" },
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
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "New name", method_id: "mt_one" },
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

    expect(failing.structuredContent).toMatchObject({
      status: "ok",
      saved: "updated",
      name: "Summarize PDF",
      rename_error: { location: "PIPELEX_BASE_URL" },
    });
    expect(failing.summary).toContain("rename to the requested name FAILED");
  });

  it("refuses the save when the draft moved since expected_updated_at, naming both tokens", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }],
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

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({
      class: "input_domain",
      location: "expected_updated_at",
      retryable: false,
    });
    expect(error.message).toContain("2026-09-20T12:00:00Z");
    expect(error.message).toContain("2026-09-19T00:00:00Z");
    expect(error.message).toContain("Nothing was written");
    await expect(fs.access(path.join(root, "methods/demo", LINK_FILE_NAME))).rejects.toThrow();
  });

  it("says what callers of the bare id run, by what the platform resolves", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const save = (version: () => Promise<unknown>) =>
      saveMthdsMethod(
        { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
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

  it("classifies a create-side transport fault as NOT retryable", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "Demo" },
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
    // whose response was lost would mint a SECOND method on retry.
    const [error] = errorsOf(result.structuredContent);
    expect(error.retryable).toBe(false);
    expect(error.hint).toContain("mthds_list_methods");
  });

  it("warns that the method may exist when the create's answer came back unreadable", async () => {
    // A 2xx the SDK could not read is a create the platform accepted, which the
    // SDK reports as a final ApiResponseError: the method exists all the same.
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("", { status: 201 })));
    try {
      const real = createPipelexApiClient({ baseUrl: DEFAULT_API_URL });
      const result = await saveMthdsMethod(
        { files: [{ path: "methods/demo/bundle.mthds" }], name: "Demo" },
        contextFor(
          { ...clientNotCalled, createMethod: (input) => real.createMethod(input) },
          validationAnswering(validReport),
        ),
      );

      const [error] = errorsOf(result.structuredContent);
      expect(error.retryable).toBe(false);
      expect(error.hint).toContain("mthds_list_methods");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves a draft write's transport fault retryable, PUT being idempotent", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
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

    expect(errorsOf(result.structuredContent)[0]?.retryable).toBe(true);
  });

  it("answers a malformed base URL as an error rather than throwing", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const context: CatalogWriteContext = {
      ...contextFor(clientNotCalled, validationAnswering(validReport)),
      baseUrl: "not a url",
      client: undefined,
    };

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], method_id: "mt_one" },
      context,
    );

    expect(result.structuredContent.status).toBe("error");
    expect(errorsOf(result.structuredContent)).toHaveLength(1);
  });

  it("gates python on .py and locates the refusal at python[i]", async () => {
    await writeBundle("methods/demo", {
      "bundle.mthds": 'domain = "demo"',
      "notes.txt": "not python",
    });

    const result = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }],
        name: "Demo",
        python: [{ path: "methods/demo/notes.txt" }],
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    // The extension IS the read boundary, and the locator must name the caller's
    // own field rather than the shared resolver's `files[i]`.
    expect(error).toMatchObject({ class: "input_domain", location: "python[0].path" });
    expect(error.message).toContain(".py");
  });

  it("sends an empty python array through as the clear gesture", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    let sent: MethodWriteInput | undefined;
    await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "Demo", python: [] },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod(input) {
            sent = input;
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(sent?.python).toEqual([]);
  });

  it("refuses a file above the bundle directory rather than flattening its name", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    await writeBundle("methods", { "stray.mthds": 'pipe = "stray"' });

    const result = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }, { path: "methods/stray.mthds" }],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    // Located at the item, and raised before the resolver opens it: the file is
    // outside the bundle, so it is never read, let alone named.
    expect(error).toMatchObject({ class: "input_domain", location: "files[1].path" });
    expect(error.message).toContain("outside the bundle directory");
  });

  it("reports an inline-only save as unlinked, naming the consequence", async () => {
    const result = await saveMthdsMethod(
      { files: [{ content: 'domain = "demo"' }], name: "Demo" },
      contextFor(
        {
          ...clientNotCalled,
          async createMethod() {
            return storedMethod();
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({ link_file: { written: false } });
    expect(result.summary).toContain("SECOND method");
  });

  it("rejects an empty files array", async () => {
    const result = await saveMthdsMethod(
      { files: [], name: "Demo" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    expect(errorsOf(result.structuredContent)[0]).toMatchObject({ location: "files" });
  });
});

// ── mthds_get_method ────────────────────────────────────────────────

describe("getMthdsMethod", () => {
  const readingClient = (stored: MethodData): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  it("writes the sources and the link file into an empty output_dir", async () => {
    const stored = storedMethod({
      mthds: JSON.stringify([
        { name: "bundle.mthds", content: 'domain = "demo"' },
        { name: "pipes/extra.mthds", content: 'pipe = "extra"' },
      ]),
    });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "pulled" },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", output_dir: "pulled" });
    expect(await fs.readFile(path.join(root, "pulled/bundle.mthds"), "utf8")).toBe(
      'domain = "demo"',
    );
    expect(await fs.readFile(path.join(root, "pulled/pipes/extra.mthds"), "utf8")).toBe(
      'pipe = "extra"',
    );
    expect((await readMethodLink(path.join(root, "pulled"))).kind).toBe("link");
    // No source passes through the conversation on this arm.
    const files = (result.structuredContent as { files: { content?: string }[] }).files;
    expect(files.every((file) => file.content === undefined)).toBe(true);
  });

  it("refuses a directory holding .mthds files with no link — somebody else's bundle", async () => {
    await writeBundle("theirs", { "bundle.mthds": "theirs" });

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "theirs" },
      contextFor(readingClient(storedMethod()), validationAnswering(validReport)),
    );

    expect(errorsOf(result.structuredContent)[0]).toMatchObject({ location: "output_dir" });
    expect(await fs.readFile(path.join(root, "theirs/bundle.mthds"), "utf8")).toBe("theirs");
  });

  it("refuses a directory linked to a different method", async () => {
    await writeBundle("other", { "bundle.mthds": "other" });
    await fs.writeFile(
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

    const [error] = errorsOf(result.structuredContent);
    expect(error.message).toContain("mt_other");
  });

  it("refuses when the local files differ and the stored method has NOT moved — unsaved work", async () => {
    const stored = storedMethod({ updated_at: "2026-09-20T12:00:00Z" });
    await writeBundle("linked", { "bundle.mthds": "edited locally" });
    await fs.writeFile(
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

    const [error] = errorsOf(result.structuredContent);
    expect(error.message).toContain("never saved");
    expect(await fs.readFile(path.join(root, "linked/bundle.mthds"), "utf8")).toBe(
      "edited locally",
    );
  });

  it("refuses when both have moved, unless overwrite says the stored version wins", async () => {
    const stored = storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
    const seed = async () => {
      await writeBundle("both", { "bundle.mthds": "edited locally" });
      await fs.writeFile(
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
    expect(errorsOf(refused.structuredContent)[0]?.hint).toContain("overwrite: true");
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
    await fs.writeFile(
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

  it("returns the sources inline when no output_dir is given", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one" },
      contextFor(readingClient(storedMethod()), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", truncated: false });
    const files = (result.structuredContent as { files: { content?: string }[] }).files;
    expect(files[0]?.content).toBe('domain = "demo"');
    expect(result.structuredContent).not.toHaveProperty("output_dir");
  });

  it("reports a method with no MTHDS source as a produced failure, not an empty success", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one" },
      contextFor(readingClient(storedMethod({ mthds: "" })), validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    // A different answer from "no such method", which is a 404 at this same field.
    expect(error).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(error.message).toContain("no MTHDS source");
  });

  it("passes a 404 through as input_domain at method_id", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_missing" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod(): Promise<MethodData> {
            throw new ApiResponseError(
              "not found",
              "https://api-dev.pipelex.com/v1/methods/mt_missing",
              404,
              "Not Found",
              "{}",
              undefined,
              "Method not found",
              undefined,
              "not_found", // the platform names an unknown method by its code
            );
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(errorsOf(result.structuredContent)[0]).toMatchObject({ location: "method_id" });
  });
});

// ── the legacy raw-source shape ─────────────────────────────────────

describe("storedSourceFiles", () => {
  it("reads the catalog's named form", () => {
    expect(storedSourceFiles(storedMethod())).toEqual([
      { name: "bundle.mthds", content: 'domain = "demo"' },
    ]);
  });

  it("names a raw legacy source after the method, since the stored form carries none", () => {
    // parseMethodFiles throws on raw text by design and methodSourceToContents
    // returns contents without names, so neither hands the writer a filename.
    expect(
      storedSourceFiles(storedMethod({ mthds: 'domain = "demo"', name: "Summarize PDF!" })),
    ).toEqual([{ name: "summarize-pdf.mthds", content: 'domain = "demo"' }]);
  });

  it("reads a blank raw source as no source at all", () => {
    expect(storedSourceFiles(storedMethod({ mthds: "   " }))).toEqual([]);
  });

  it("says in the summary that a synthesized name is the tool's own", async () => {
    const stored = storedMethod({ mthds: 'domain = "demo"', name: "Summarize PDF" });
    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "legacy" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return stored;
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.summary).toContain("a name this tool invented");
    expect(await fs.readFile(path.join(root, "legacy/summarize-pdf.mthds"), "utf8")).toBe(
      'domain = "demo"',
    );
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
    await fs.writeFile(path.join(root, "broken", LINK_FILE_NAME), "{ not json", "utf8");

    // `none` would let a pull write; `unreadable` must refuse. A link nobody can
    // parse is still evidence that something claims the directory.
    expect(await readMethodLink(path.join(root, "broken"))).toMatchObject({ kind: "unreadable" });
  });

  it("reads a link missing a required field as unreadable", async () => {
    await fs.mkdir(path.join(root, "partial"), { recursive: true });
    await fs.writeFile(
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
  const reading = (stored: MethodData): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  const pythonMethod = () =>
    storedMethod({
      python: [{ name: "helpers.py", content: "# from the catalog\n" }],
    });

  async function linkInto(dir: string, synced: string, methodId = "mt_one"): Promise<void> {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(
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

    expect(errorsOf(result.structuredContent)[0]?.message).toContain("helpers.py");
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

    expect(errorsOf(result.structuredContent)[0]?.message).toContain("helpers.py");
    expect(await fs.readFile(path.join(root, "occupied", "helpers.py"), "utf8")).toBe(
      "# THE USER'S\n",
    );
  });

  it("refuses an unlinked directory holding a nested .mthds the pull would land on", async () => {
    const stored = storedMethod({
      mthds: JSON.stringify([{ name: "nested/other.mthds", content: 'domain = "demo"' }]),
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

    expect(errorsOf(result.structuredContent)[0]?.message).toContain("symlink");
    // Still a symlink: nothing was written through it, and nothing replaced it.
    expect((await fs.lstat(path.join(root, "linkdest", "bundle.mthds"))).isSymbolicLink()).toBe(
      true,
    );
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("refuses a stored file whose parent directory is a symlink out of the workspace", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "catalog-escape-")));
    const stored = storedMethod({
      mthds: JSON.stringify([{ name: "sub/x.mthds", content: 'domain = "demo"' }]),
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

  it("refuses a symlinked link file rather than overwriting what it points at", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "catalog-linkfile-")));
    const victim = path.join(outside, "theirs.json");
    await fs.writeFile(victim, "SOMETHING THE USER OWNS\n", "utf8");

    await fs.mkdir(path.join(root, "symlink"), { recursive: true });
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
    // The second file needs a `sub/` directory and `sub` is an ordinary file,
    // so its creation fails after the first file has landed. (A destination
    // that merely exists would be refused by the occupancy guard before the
    // loop, which is the point of that guard.) The link went down first,
    // marked `partial_pull`, which is what lets the retry through instead of
    // reading as somebody else's bundle.
    const stored = storedMethod({
      mthds: JSON.stringify([
        { name: "bundle.mthds", content: 'domain = "demo"' },
        { name: "sub/second.mthds", content: "second" },
      ]),
    });
    await fs.mkdir(path.join(root, "partial"), { recursive: true });
    await fs.writeFile(path.join(root, "partial", "sub"), "in the way", "utf8");

    const failed = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "partial" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );
    expect(failed.structuredContent.status).toBe("error");
    expect(errorsOf(failed.structuredContent)[0]?.retryable).toBe(true);

    const link = await readMethodLink(path.join(root, "partial"));
    expect(link.kind === "link" && link.link.partial_pull).toBe(true);

    await fs.rm(path.join(root, "partial", "sub"));
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
      mthds: JSON.stringify([{ name: "bundle.mthds", content: "theirs" }]),
    });
    await writeBundle("team", { "bundle.mthds": 'domain = "demo"' });
    await linkInto("team", "2026-09-20T12:00:00Z");

    const result = await getMthdsMethod(
      { method_id: "mt_one", output_dir: "team" },
      contextFor(reading(stored), validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error.message).not.toContain("both this directory and the stored method have changed");
    expect(error.message).toContain("differs from the stored one");
    expect(error.hint).toContain("overwrite: true");
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

  it("writes no link for an inline submission, whatever its provenance uri says", async () => {
    // `uri` is provenance for diagnostics and may be any label. Treating it as
    // a directory created one called `memory:` in the user's workspace.
    const result = await saveMthdsMethod(
      {
        files: [{ content: 'domain = "demo"', uri: "memory://draft.mthds" }],
        name: "Demo",
      },
      contextFor(creating(), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", saved: "created" });
    expect(linkFileOf(result.structuredContent)?.written).toBe(false);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("writes no link at the workspace root for a bare inline uri", async () => {
    // `path.dirname("bundle.mthds")` is `.`, which put the link at the root
    // where it could replace an unrelated one.
    const result = await saveMthdsMethod(
      { files: [{ content: 'domain = "demo"', uri: "bundle.mthds" }], name: "Demo" },
      contextFor(creating(), validationAnswering(validReport)),
    );

    expect(linkFileOf(result.structuredContent)?.written).toBe(false);
    expect(await readMethodLink(root)).toEqual({ kind: "none" });
  });

  it("refuses to re-point a directory linked to a different method", async () => {
    // The link file is committed and shared, so a silent takeover would send a
    // teammate's next save to this method instead of theirs.
    await writeBundle("theirs", { "bundle.mthds": 'domain = "demo"' });
    await fs.writeFile(
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
      { files: [{ path: "theirs/bundle.mthds" }], name: "Mine" },
      contextFor(creating("Mine"), validationAnswering(validReport)),
    );

    // Nothing is created: the link is read BEFORE the catalog call, because a
    // duplicate cannot be undone from here — delete is admin-only — and the old
    // ordering reported the refusal about a second method that already existed.
    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(error.message).toContain("mt_teammate");
    expect(error.hint).toContain('method_id: "mt_teammate"');
    const link = await readMethodLink(path.join(root, "theirs"));
    expect(link.kind === "link" && link.link.method_id).toBe("mt_teammate");
  });

  it("updates normally when the directory is linked to that same method", async () => {
    // The mismatch check must not cost the ordinary case anything.
    await writeBundle("mine", { "bundle.mthds": 'domain = "demo"' });
    await fs.writeFile(
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
      { files: [{ path: "mine/bundle.mthds" }], name: "Mine", method_id: "mt_mine" },
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
    await fs.writeFile(
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
      { files: [{ path: "theirs/bundle.mthds" }], name: "Mine", method_id: "mt_mine" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(error.message).toContain("mt_teammate");
    expect(error.message).toContain("mt_mine");
    // `link_dir` is the deliberate fork, and the hint has to name it.
    expect(error.hint).toContain('method_id: "mt_teammate"');
    expect(error.hint).toContain("link_dir");
    const link = await readMethodLink(path.join(root, "theirs"));
    expect(link.kind === "link" && link.link.method_id).toBe("mt_teammate");
  });

  it("blames `python` for a .py file outside the bundle directory, not `files`", async () => {
    await writeBundle("bundle", { "main.mthds": 'domain = "demo"' });
    await writeBundle("elsewhere", {});
    await fs.writeFile(path.join(root, "elsewhere", "helpers.py"), "x = 1", "utf8");

    const result = await saveMthdsMethod(
      {
        files: [{ path: "bundle/main.mthds" }],
        python: [{ path: "elsewhere/helpers.py" }],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    expect(errorsOf(result.structuredContent)[0]).toMatchObject({
      class: "input_domain",
      location: "python[0].path",
    });
  });
});

// ── round 2: the write set is validated, not merely contained ────────

describe("the pull writes method sources and nothing else", () => {
  const readingClient = (stored: MethodData): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  const storedNamed = (files: { name: string; content: string }[]): MethodData =>
    storedMethod({ mthds: JSON.stringify(files) });

  const pull = async (stored: MethodData, output_dir = "pulled") =>
    getMthdsMethod(
      { method_id: "mt_one", output_dir },
      contextFor(readingClient(stored), validationAnswering(validReport)),
    );

  it("refuses a stored name that is not a .mthds or .py file, creating nothing", async () => {
    // A method's file names come from whoever saved it, and `nameFiles` takes an
    // inline item's name straight from a caller-supplied `uri` — so the catalog
    // is an untrusted source of paths. Containment alone let one plant a CI
    // workflow in a workspace pulled into with `output_dir: "."`.
    const result = await pull(
      storedNamed([
        { name: "bundle.mthds", content: 'domain = "demo"' },
        { name: "workflows/pwn.yml", content: "on: push" },
      ]),
      ".",
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error.message).toContain("workflows/pwn.yml");
    expect(error.message).toContain("neither a `.mthds` nor a `.py` file");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a stored name with a dotted path component", async () => {
    // Where a workspace keeps what configures its tools, not its code.
    const result = await pull(
      storedNamed([
        { name: "bundle.mthds", content: 'domain = "demo"' },
        { name: ".github/workflows/pwn.mthds", content: "on: push" },
      ]),
      ".",
    );

    expect(errorsOf(result.structuredContent)[0].message).toContain("beginning with a dot");
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

    expect(errorsOf(result.structuredContent)[0].message).toContain(LINK_FILE_NAME);
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

    const [error] = errorsOf(result.structuredContent);
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

    expect(errorsOf(result.structuredContent)[0].message).toContain("their_bundle.mthds");
    expect(await fs.readdir(path.join(root, "mixed"))).toEqual(["their_bundle.mthds"]);
  });
});

describe("the pull resumes and refreshes without destroying work", () => {
  const readingClient = (stored: MethodData): CatalogWriteClient => ({
    ...clientNotCalled,
    async getMethod() {
      return stored;
    },
  });

  const stored = storedMethod({
    updated_at: "2026-09-20T12:00:00Z",
    mthds: JSON.stringify([
      { name: "bundle.mthds", content: "first v1" },
      { name: "second.mthds", content: "second v1" },
    ]),
  });

  const linkWith = async (dir: string, extra: Record<string, unknown> = {}) =>
    fs.writeFile(
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

    expect(errorsOf(result.structuredContent)[0].message).toContain("second.mthds");
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
      latest_published: versionSummary({ source_digest: "b".repeat(64) }),
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
      const [error] = errorsOf(result.structuredContent);
      expect(error).toMatchObject({ class: "runtime", location: "output_dir" });
      expect(error.message).toContain("holding version 2");
      expect(await fs.readFile(path.join(root, "work", "bundle.mthds"), "utf8")).toBe(
        'domain = "demo"',
      );
    } finally {
      await fs.chmod(path.join(root, "work", LINK_FILE_NAME), 0o644);
    }
  });
});

describe("the save reads only what belongs to the bundle", () => {
  const creating = (name = "Demo"): CatalogWriteClient => ({
    ...clientNotCalled,
    async createMethod() {
      return storedMethod({ name });
    },
  });

  it("never opens a .py file outside the bundle directory an inline uri declared", async () => {
    // The `.py` arm reads a file and UPLOADS it to the organization's catalog,
    // and the bundle directory comes from the first file's label — which an
    // inline item supplies freely. So this named the secrets' own directory and
    // had them published. The refusal must beat the read, not follow it.
    await writeBundle("app/config", {});
    await fs.writeFile(path.join(root, "app/config/settings.py"), 'AWS_SECRET = "hunter2"', "utf8");

    const result = await saveMthdsMethod(
      {
        files: [{ content: 'domain = "demo"', uri: "app/config/x.mthds" }],
        python: [{ path: "app/config/settings.py" }],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "python[0].path" });
    expect(error.message).toContain("no bundle directory");
  });

  it("refuses a blank .py rather than letting it erase the stored Python", async () => {
    // An all-blank set serializes to "", which is the platform's CLEAR
    // sentinel: the save reported "updated" and wiped the stored Python.
    await writeBundle("bundle", { "main.mthds": 'domain = "demo"' });
    await fs.writeFile(path.join(root, "bundle/empty.py"), "   \n", "utf8");

    const result = await saveMthdsMethod(
      {
        files: [{ path: "bundle/main.mthds" }],
        python: [{ path: "bundle/empty.py" }],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    expect(errorsOf(result.structuredContent)[0]).toMatchObject({
      class: "input_domain",
      location: "python[0].content",
    });
  });

  it("refuses a .py symlink pointing out of the bundle, before anything reads it", async () => {
    // The gate compared submitted STRINGS, while the resolver followed symlinks
    // and contained only against the workspace — so this uploaded the file the
    // link pointed at, as the method's Python, to the organization's catalog.
    // Nothing validates Python, so this arm was the live one.
    await writeBundle("bundle", { "main.mthds": 'domain = "demo"' });
    await fs.writeFile(path.join(root, ".env"), "OPENAI_API_KEY=sk-super-secret\n", "utf8");
    await fs.symlink(path.join(root, ".env"), path.join(root, "bundle", "helpers.py"));

    const result = await saveMthdsMethod(
      {
        files: [{ path: "bundle/main.mthds" }],
        python: [{ path: "bundle/helpers.py" }],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "python[0].path" });
    expect(error.message).toContain("symlink");
    // The point of the whole test: the secret is in nothing that came back.
    expect(JSON.stringify(result)).not.toContain("sk-super-secret");
  });

  it("refuses a .mthds symlink pointing out of the bundle", async () => {
    await writeBundle("bundle", { "main.mthds": 'domain = "demo"' });
    await fs.writeFile(path.join(root, "secrets.txt"), "TOKEN=leaked-token\n", "utf8");
    await fs.symlink(path.join(root, "secrets.txt"), path.join(root, "bundle", "leak.mthds"));

    const result = await saveMthdsMethod(
      {
        files: [{ path: "bundle/main.mthds" }, { path: "bundle/leak.mthds" }],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "files[1].path" });
    expect(JSON.stringify(result)).not.toContain("leaked-token");
  });

  it("allows a symlink that really does stay inside the bundle", async () => {
    // The boundary is WHERE the bytes are, not whether a link was used to name
    // them — a bundle that symlinks within itself is still one method's files.
    await writeBundle("bundle", { "main.mthds": 'domain = "demo"', "real.py": "x = 1" });
    await fs.symlink(path.join(root, "bundle", "real.py"), path.join(root, "bundle", "alias.py"));

    const result = await saveMthdsMethod(
      {
        files: [{ path: "bundle/main.mthds" }],
        python: [{ path: "bundle/alias.py" }],
        name: "Demo",
      },
      contextFor(creating(), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok" });
  });

  it("refuses to CREATE into a directory whose link file nobody can parse", async () => {
    // A link nobody can parse is not an empty slot: `readMethodLink` calls it
    // `unreadable` precisely because something claims the directory. That answer
    // used to be flattened to "no link", so the create ran, minted a second
    // method the tool cannot delete, and only then did the link write refuse —
    // the very ordering the create arm's comment says was fixed.
    await writeBundle("garbled", { "bundle.mthds": 'domain = "demo"' });
    await fs.writeFile(path.join(root, "garbled", LINK_FILE_NAME), "not json at all", "utf8");

    const result = await saveMthdsMethod(
      { files: [{ path: "garbled/bundle.mthds" }], name: "Demo" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "link_dir" });
    expect(error.message).toContain("cannot be read");
    expect(error.message).toContain("SECOND method");
    // And the file it could not read is still exactly as it was.
    expect(await fs.readFile(path.join(root, "garbled", LINK_FILE_NAME), "utf8")).toBe(
      "not json at all",
    );
  });
});

describe("the save refuses a name the pull could never write back", () => {
  const creating = (name = "Demo"): CatalogWriteClient => ({
    ...clientNotCalled,
    async createMethod() {
      return storedMethod({ name });
    },
  });

  it("refuses an inline uri that is neither a .mthds nor a .py file", async () => {
    // `storedNameReason` refuses this on the way back and there is no flag to
    // bypass it, so the save that accepted the name stored a method whose
    // written pull fails outright — and above the inline cap, for good.
    const result = await saveMthdsMethod(
      {
        files: [
          { content: 'domain = "demo"', uri: "main.mthds" },
          { content: "notes", uri: "notes.md" },
        ],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "files" });
    expect(error.message).toContain("notes.md");
    expect(error.message).toContain("could not be pulled back");
  });

  it("refuses a dot-leading path component, which a plain { path } submission carries", async () => {
    // No inline trickery needed for this one: the name comes straight off a
    // real file's path relative to the bundle root.
    await writeBundle("bundle", {
      "main.mthds": 'domain = "demo"',
      ".drafts/x.mthds": 'domain = "draft"',
    });

    const result = await saveMthdsMethod(
      {
        files: [{ path: "bundle/main.mthds" }, { path: "bundle/.drafts/x.mthds" }],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "files" });
    expect(error.message).toContain("component beginning with a dot");
  });

  it("refuses the link file's own name", async () => {
    const result = await saveMthdsMethod(
      {
        files: [
          { content: 'domain = "demo"', uri: "main.mthds" },
          { content: "{}", uri: LINK_FILE_NAME },
        ],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "files" });
    expect(error.message).toContain(LINK_FILE_NAME);
  });

  it("refuses two names differing only in case, across files and python alike", async () => {
    // The two arms write into ONE directory, so the collision is not per-arm:
    // on a case-insensitive filesystem these are one destination.
    const result = await saveMthdsMethod(
      {
        files: [{ content: 'domain = "demo"', uri: "main.mthds" }],
        python: [
          { content: "x = 1", uri: "Helper.py" },
          { content: "y = 2", uri: "helper.py" },
        ],
        name: "Demo",
      },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "python" });
    expect(error.message).toContain("differ only in case");
  });

  it("still saves a bundle whose names the pull would write", async () => {
    const result = await saveMthdsMethod(
      {
        files: [
          { content: 'domain = "demo"', uri: "main.mthds" },
          { content: 'domain = "two"', uri: "sub/other.mthds" },
        ],
        python: [{ content: "x = 1", uri: "helpers.py" }],
        name: "Demo",
      },
      contextFor(creating(), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", saved: "created" });
  });
});

describe("the pull says what the directory holds that the method does not", () => {
  const readingClient = (stored: MethodData): CatalogWriteClient => ({
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
      mthds: JSON.stringify([{ name: "bundle.mthds", content: "first v2" }]),
    });
    await writeBundle("drifted", { "bundle.mthds": "first v1", "extra.mthds": "dropped" });
    await fs.writeFile(path.join(root, "drifted/helpers.py"), "x = 1", "utf8");
    await fs.writeFile(
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
      mthds: JSON.stringify([{ name: "bundle.mthds", content: 'domain = "demo"' }]),
    });
    await writeBundle("proj", {
      "bundle.mthds": 'domain = "demo"',
      ".venv/lib/site-packages/_virtualenv.py": "x = 1",
      ".git/hooks/note.py": "x = 1",
      "node_modules/pkg/index.py": "x = 1",
      "__pycache__/cached.py": "x = 1",
      "mine.py": "x = 1",
    });
    await fs.writeFile(
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
      mthds: JSON.stringify([{ name: "bundle.mthds", content: 'domain = "demo"' }]),
    });
    await writeBundle("blocked", { "bundle.mthds": 'domain = "demo"', "seen.py": "x = 1" });
    await writeBundle("blocked/denied", { "hidden.py": "x = 1" });
    await fs.writeFile(
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
      expect(result.summary).toContain("could not finish reading");
      expect(result.summary).not.toContain("which this method does not");
    } finally {
      await fs.chmod(path.join(root, "blocked/denied"), 0o755);
    }
  });

  it("says nothing when the directory holds only this method's files", async () => {
    const stored = storedMethod({
      mthds: JSON.stringify([{ name: "bundle.mthds", content: 'domain = "demo"' }]),
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
    stored: MethodData,
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
          throw new ApiResponseError(
            "not found",
            `https://api-dev.pipelex.com/v1/methods/${id}/versions/${version}`,
            404,
            "Not Found",
            "{}",
            undefined,
            "No such version",
            undefined,
            "method_version_not_found",
          );
        }
        return storedVersion();
      },
    };
  }

  async function linkTo(dir: string, fields: { synced: string; version?: number }): Promise<void> {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(
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
    const result = await getMthdsMethod(
      { method_id: "mt_one@2" },
      contextFor(versionedClient(publishedMethod(), seen), validationAnswering(validReport)),
    );

    expect(seen.versions).toEqual([["mt_one", 2]]);
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

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(error.message).toContain("no version 7");
    expect(error.message).toContain("latest published version is 2");
  });

  it("refuses a suffix it cannot read before anything is sent", async () => {
    const result = await getMthdsMethod(
      { method_id: "mt_one@latest" },
      contextFor(clientNotCalled, validationAnswering(validReport)),
    );

    expect(errorsOf(result.structuredContent)[0]).toMatchObject({
      class: "input_domain",
      location: "method_id",
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
    // An omitted python keeps the draft's, so the restore must say what to send.
    expect(result.summary).toContain("python: []");
    expect(result.summary).toContain("not one to publish under");
    expect(result.summary).toContain("publishes nothing");
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

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "output_dir" });
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
    await fs.writeFile(
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
