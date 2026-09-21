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
    expect(error).toMatchObject({ class: "input_domain", location: "files" });
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
