import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type { MethodData, MethodWriteInput, PipelexValidationResult } from "@pipelex/sdk";
import { parseMethodFiles } from "mthds/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LINK_FILE_NAME, apiHostOf, readMethodLink } from "./catalog-link.js";
import {
  buildCatalogWriteContext,
  getMthdsMethod,
  saveMthdsMethod,
  storedSourceFiles,
} from "./catalog-write.js";
import type { CatalogWriteClient, CatalogWriteContext } from "./catalog-write.js";
import { DEFAULT_API_URL } from "./shared.js";
import type { ToolError } from "./shared.js";
import { localFileResolver } from "../local/files.js";

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
    ...overrides,
  };
}

/** A client whose every arm throws — each test opts into the one it needs. */
const clientNotCalled: CatalogWriteClient = {
  async getMethod(): Promise<MethodData> {
    throw new Error("getMethod must not be called in this test");
  },
  async createMethod(): Promise<MethodData> {
    throw new Error("createMethod must not be called in this test");
  },
  async updateMethod(): Promise<MethodData> {
    throw new Error("updateMethod must not be called in this test");
  },
};

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

  it("saves nothing at all when the bundle is invalid, and says so as a verdict", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": "broken" });

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "Demo" },
      contextFor(clientNotCalled, validationAnswering(invalidReport)),
    );

    // A produced verdict, not a no-verdict: status ok, discriminated on is_valid.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent).toMatchObject({ is_valid: false });
    expect(result.structuredContent).not.toHaveProperty("method_id");
    // Nothing anywhere: no link file either.
    await expect(fs.access(path.join(root, "methods/demo", LINK_FILE_NAME))).rejects.toThrow();
  });

  it("updates through method_id and carries the stored input_data back unchanged", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });
    const previous = storedMethod({ input_data: { topic: "pinned" } });

    let sent: MethodWriteInput | undefined;
    const result = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }],
        name: previous.name,
        method_id: "mt_one",
      },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return previous;
          },
          async updateMethod(_id, input) {
            sent = input;
            return storedMethod({ updated_at: "2026-09-21T09:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({ saved: "updated" });
    // The platform's write rewrites the whole row, so an omitted input_data
    // would erase the form inputs a webapp user had saved.
    expect(sent?.input_data).toEqual({ topic: "pinned" });
  });

  it("calls a changed name a rename", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "New name", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return storedMethod();
          },
          async updateMethod() {
            return storedMethod({ name: "New name" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    expect(result.structuredContent).toMatchObject({ saved: "renamed" });
  });

  it("refuses the save when expected_updated_at does not match, and writes nothing", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      {
        files: [{ path: "methods/demo/bundle.mthds" }],
        name: "Demo",
        method_id: "mt_one",
        expected_updated_at: "2026-09-19T00:00:00Z",
      },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return storedMethod({ updated_at: "2026-09-20T12:00:00Z" });
          },
        },
        validationAnswering(validReport),
      ),
    );

    const [error] = errorsOf(result.structuredContent);
    expect(error).toMatchObject({ class: "input_domain", location: "expected_updated_at" });
    expect(error.message).toContain("2026-09-20T12:00:00Z");
    await expect(fs.access(path.join(root, "methods/demo", LINK_FILE_NAME))).rejects.toThrow();
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

  it("leaves an update's transport fault retryable, PUT being idempotent", async () => {
    await writeBundle("methods/demo", { "bundle.mthds": 'domain = "demo"' });

    const result = await saveMthdsMethod(
      { files: [{ path: "methods/demo/bundle.mthds" }], name: "Demo", method_id: "mt_one" },
      contextFor(
        {
          ...clientNotCalled,
          async getMethod() {
            return storedMethod();
          },
          async updateMethod(): Promise<MethodData> {
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
              undefined,
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
    // `containedInDir` is lexical, so the joined path looks contained while
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
    async updateMethod() {
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

  it("still refuses to re-point the link when the save names another method_id", async () => {
    // The create is refused up front; an UPDATE of a genuinely different method
    // still happens, and it is the link write that must not follow it.
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
      { files: [{ path: "theirs/bundle.mthds" }], name: "Mine", method_id: "mt_mine" },
      contextFor(updating("mt_mine", "Mine"), validationAnswering(validReport)),
    );

    // The method IS saved — it is stored by the time the link is written, and
    // saying otherwise would be the one thing that is certainly untrue.
    expect(result.structuredContent).toMatchObject({ status: "ok" });
    expect(linkFileOf(result.structuredContent)?.written).toBe(false);
    expect(linkFileOf(result.structuredContent)?.reason).toContain("mt_teammate");
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

  it("refuses to write over a link file nobody can parse", async () => {
    // The pull path refuses this exact state; the save path truncated it after
    // the catalog write, destroying whatever it held.
    await writeBundle("garbled", { "bundle.mthds": 'domain = "demo"' });
    await fs.writeFile(path.join(root, "garbled", LINK_FILE_NAME), "not json at all", "utf8");

    const result = await saveMthdsMethod(
      { files: [{ path: "garbled/bundle.mthds" }], name: "Demo" },
      contextFor(creating(), validationAnswering(validReport)),
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", saved: "created" });
    expect(linkFileOf(result.structuredContent)?.written).toBe(false);
    expect(linkFileOf(result.structuredContent)?.reason).toContain("cannot be read");
    expect(await fs.readFile(path.join(root, "garbled", LINK_FILE_NAME), "utf8")).toBe(
      "not json at all",
    );
  });
});
