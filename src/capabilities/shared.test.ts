import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  ArtifactAuthenticationError,
  ArtifactOperationError,
  InputPreparationError,
  InvalidLocalSourceError,
  MethodFileTransferError,
  MissingMainStuffError,
  PagingNotTerminatingError,
  PipelineRequestError,
  RejectedAssetError,
  RequestArgumentError,
  RunLifecycleUnavailableError,
  RunTimeoutError,
  ScopeUnavailableError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "@pipelex/sdk";

import { sha256Hex, treeDigest } from "mthds";

import type { ListingLimits } from "./method-tree.js";
import {
  ALLOW_HTTP_ENV,
  BULK_RESOLVE_ERROR_OPTIONS,
  allowsPlainHttp,
  blueprintMainPipeRefOf,
  buildApiConfig,
  buildArtifactFetchConfig,
  classifyError,
  createPipelexApiClient,
  DEFAULT_API_URL,
  DEFAULT_AUTH_HINT,
  ROLE_REFUSAL_HINT,
  imageCandidatesOf,
  itemToolError,
  looksLikeImageKey,
  methodFilesInputSchema,
  parseAllowHttpOverride,
  resolveMethodSource,
  storageKeyOf,
  summaryForToolError,
  toolResultContent,
  validateMethodSelectorRequest,
  validateRunIdRequest,
  withFilesSent,
  failedBeforeSending,
  markUnsent,
} from "./shared.js";
import type {
  ErrorSummaries,
  FileResolver,
  MethodSourceInput,
  ResolvedMethodSource,
  ToolError,
} from "./shared.js";

describe("buildApiConfig", () => {
  it("defaults to the hosted API with no key", () => {
    const config = buildApiConfig({});

    expect(config.baseUrl).toBe(DEFAULT_API_URL);
    expect(config.apiKey).toBeUndefined();
  });

  it("reads the base URL and key from the environment", () => {
    const config = buildApiConfig({
      PIPELEX_BASE_URL: "http://localhost:8081",
      PIPELEX_API_KEY: "secret",
    });

    expect(config.baseUrl).toBe("http://localhost:8081");
    expect(config.apiKey).toBe("secret");
  });

  it("treats an empty key as absent", () => {
    const config = buildApiConfig({ PIPELEX_API_KEY: "" });

    expect(config.apiKey).toBeUndefined();
  });

  it("falls back to the hosted default when the base URL is blank", () => {
    const config = buildApiConfig({ PIPELEX_BASE_URL: "" });

    expect(config.baseUrl).toBe(DEFAULT_API_URL);
  });
});

describe("methodFilesInputSchema", () => {
  it("accepts the content arm and the path arm, a template path being a path item", () => {
    const parsed = methodFilesInputSchema.parse([
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { path: "methods/bundle.mthds" },
      { path: "methods/templates/invoice.xlsx" },
    ]);

    expect(parsed).toEqual([
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { path: "methods/bundle.mthds" },
      { path: "methods/templates/invoice.xlsx" },
    ]);
  });

  it("parses a pathological both-keys item as the content arm, ignoring path", () => {
    const parsed = methodFilesInputSchema.parse([
      { content: 'domain = "demo"', path: "methods/bundle.mthds" },
    ]);

    expect(parsed).toEqual([{ content: 'domain = "demo"' }]);
  });

  it("rejects an item matching neither arm", () => {
    expect(methodFilesInputSchema.safeParse([{ uri: "bundle.mthds" }]).success).toBe(false);
  });
});

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The limits a deployment announces, the workshop's own standing in for none. */
const LIMITS: ListingLimits = {
  maxFileCount: 1_000,
  maxFileSize: 32 * 1024 * 1024,
  maxTotalSize: 64 * 1024 * 1024,
};

/** A limits reader that counts how often it was asked. */
function limitsReader(limits: ListingLimits = LIMITS): (() => Promise<ListingLimits>) & {
  calls: number;
} {
  const read = Object.assign(
    () => {
      read.calls += 1;
      return Promise.resolve(limits);
    },
    { calls: 0 },
  );
  return read;
}

/**
 * A resolver reading `{ path }` items from `files`, by path as submitted, each
 * at `/w/<path>`: the working directory the fake stands for.
 */
function fakeFileResolver(files: Record<string, string | Uint8Array>): FileResolver & {
  reads: { path: string; maxBytes: number }[];
} {
  const reads: { path: string; maxBytes: number }[] = [];
  return {
    reads,
    resolve: () => Promise.reject(new Error("a method's files are read as bytes")),
    async readMethodFile(path, { maxBytes }) {
      reads.push({ path, maxBytes });
      const content = files[path.replace(/^\.\//, "")];
      if (content === undefined) {
        return { ok: false, message: `File not found: ${path}`, hint: "Check the path." };
      }
      return {
        ok: true,
        absolute: `/w/${path.replace(/^\.\//, "")}`,
        bytes: typeof content === "string" ? encode(content) : content,
      };
    },
  };
}

/** The tree a resolution sends, file by file: tree path, where the caller finds it, and its text. */
function sentFiles(resolution: ResolvedMethodSource) {
  return resolution.tree?.files.map((file) => ({
    treePath: file.treePath,
    shown: file.shown,
    onDisk: file.onDisk,
    text: decode(file.bytes),
  }));
}

describe("resolveMethodSource on files", () => {
  it("sends inline items at the tree's top, under their uri's file name or bundle.mthds, asking no limits", async () => {
    const limits = limitsReader();
    const resolution = await resolveMethodSource(
      {
        files: [
          { content: 'domain = "a"', uri: "methods/a.mthds" },
          { content: 'domain = "b"' },
          { content: 'domain = "c"', uri: "https://example.com/x/report.html" },
          { content: 'domain = "d"', uri: "C:\\work\\a.mthds" },
        ],
      },
      undefined,
      "one_selector",
      limits,
    );

    expect(resolution.errors).toEqual([]);
    expect(sentFiles(resolution)).toEqual([
      { treePath: "a.mthds", shown: "a.mthds", onDisk: false, text: 'domain = "a"' },
      { treePath: "bundle-2.mthds", shown: "bundle-2.mthds", onDisk: false, text: 'domain = "c"' },
      { treePath: "bundle-3.mthds", shown: "bundle-3.mthds", onDisk: false, text: 'domain = "d"' },
      { treePath: "bundle.mthds", shown: "bundle.mthds", onDisk: false, text: 'domain = "b"' },
    ]);
    expect(resolution.tree?.fromFolder).toBe(false);
    expect(limits.calls).toBe(0);
  });

  it("roots the { path } items at the deepest directory holding them all, each shown as given", async () => {
    const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const resolver = fakeFileResolver({
      "methods/invoice/invoice.mthds": 'domain = "invoice"',
      "methods/invoice/templates/invoice.xlsx": XLSX,
    });
    const limits = limitsReader();

    const resolution = await resolveMethodSource(
      {
        files: [
          { path: "methods/invoice/templates/invoice.xlsx" },
          { path: "methods/invoice/invoice.mthds" },
          { path: "./methods/invoice/invoice.mthds" },
        ],
      },
      resolver,
      "one_selector",
      limits,
    );

    expect(resolution.errors).toEqual([]);
    expect(resolution.tree?.files.map(({ treePath, shown }) => ({ treePath, shown }))).toEqual([
      { treePath: "invoice.mthds", shown: "methods/invoice/invoice.mthds" },
      { treePath: "templates/invoice.xlsx", shown: "methods/invoice/templates/invoice.xlsx" },
    ]);
    // Held to the deployment's limit on one file, asked once.
    expect(limits.calls).toBe(1);
    expect(resolver.reads.map((read) => read.maxBytes)).toEqual([
      LIMITS.maxFileSize,
      LIMITS.maxFileSize,
      LIMITS.maxFileSize,
    ]);

    // The SDK's tree, built from the same bytes.
    const source = resolution.tree!.source;
    const listing = [
      { path: "invoice.mthds", bytes: encode('domain = "invoice"') },
      { path: "templates/invoice.xlsx", bytes: XLSX },
    ].map(({ path, bytes }) => ({ path, size: bytes.byteLength, sha256: sha256Hex(bytes) }));
    expect(source.files).toEqual(listing);
    expect(source.digest).toBe(treeDigest(listing));
    expect(await source.readFile("templates/invoice.xlsx")).toEqual(XLSX);
    await expect(source.readFile("absent.mthds")).rejects.toThrow("not a file");
  });

  it("gives an inline item another name when a { path } item takes its uri's", async () => {
    const resolution = await resolveMethodSource(
      {
        files: [{ path: "m/main.mthds" }, { content: 'domain = "x"', uri: "elsewhere/MAIN.mthds" }],
      },
      fakeFileResolver({ "m/main.mthds": 'domain = "m"' }),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.tree?.files.map((file) => file.treePath)).toEqual([
      "bundle.mthds",
      "main.mthds",
    ]);
  });

  it("refuses path items instructively when no resolver is provided (hosted)", async () => {
    const resolution = await resolveMethodSource(
      { files: [{ content: 'domain = "demo"' }, { path: "methods/bundle.mthds" }] },
      undefined,
      "one_selector",
      limitsReader(),
    );

    expect(resolution.errors).toHaveLength(1);
    const error = resolution.errors[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("files[1].path");
    expect(error?.message).toBe(
      "This deployment cannot read files from disk; submit the file contents instead.",
    );
    expect(error?.hint).toContain("{ content, uri? }");
    expect(error?.hint).toContain("npx @pipelex/mcp");
    expect(error?.retryable).toBe(false);
  });

  it("refuses a blank path, an empty content and a blank uri, before the resolver runs", async () => {
    const resolver = fakeFileResolver({});
    const resolution = await resolveMethodSource(
      { files: [{ path: "  " }, { content: " " }, { content: "x", uri: "" }] },
      resolver,
      "run_source",
      limitsReader(),
    );

    expect(resolution.errors.map((error) => [error.location, error.message])).toEqual([
      ["files[0].path", "File path must not be empty."],
      ["files[1].content", "File content must not be empty."],
      ["files[2].uri", "File uri must not be empty when supplied."],
    ]);
    expect(resolver.reads).toEqual([]);
    expect(resolution.tree).toBeUndefined();
  });

  it("maps resolver failures to input_domain errors at the item's path", async () => {
    const resolution = await resolveMethodSource(
      { files: [{ path: "missing.mthds" }, { path: "also-missing.mthds" }] },
      fakeFileResolver({}),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.errors).toEqual([
      {
        class: "input_domain",
        location: "files[0].path",
        message: "File not found: missing.mthds",
        hint: "Check the path.",
        retryable: false,
      },
      expect.objectContaining({ location: "files[1].path" }),
    ]);
  });

  it("refuses a name no tree holds, and two names that collide, at their items", async () => {
    const hidden = await resolveMethodSource(
      { files: [{ path: "m/main.mthds" }, { path: "m/.drafts/old.mthds" }] },
      fakeFileResolver({ "m/main.mthds": "a", "m/.drafts/old.mthds": "b" }),
      "one_selector",
      limitsReader(),
    );
    expect(hidden.errors).toEqual([
      expect.objectContaining({ location: "files[1].path", class: "input_domain" }),
    ]);
    expect(hidden.errors[0]?.message).toContain(".drafts/old.mthds");

    const colliding = await resolveMethodSource(
      { files: [{ path: "m/Main.mthds" }, { path: "m/main.mthds" }] },
      fakeFileResolver({ "m/Main.mthds": "a", "m/main.mthds": "b" }),
      "one_selector",
      limitsReader(),
    );
    expect(colliding.errors.map((error) => error.location)).toEqual([
      "files[0].path",
      "files[1].path",
    ]);
    expect(colliding.errors[0]?.hint).toContain("case-insensitive");
  });

  it("holds the tree to the deployment's file count and total size", async () => {
    const files = { "a.mthds": "aaaa", "b.mthds": "bbbb" };
    const counted = await resolveMethodSource(
      { files: [{ path: "a.mthds" }, { path: "b.mthds" }] },
      fakeFileResolver(files),
      "one_selector",
      limitsReader({ ...LIMITS, maxFileCount: 1 }),
    );
    expect(counted.errors).toEqual([expect.objectContaining({ location: "files" })]);
    expect(counted.errors[0]?.message).toContain("past the limit of 1");

    const weighed = await resolveMethodSource(
      { files: [{ path: "a.mthds" }, { content: "cccc" }] },
      fakeFileResolver(files),
      "one_selector",
      limitsReader({ ...LIMITS, maxTotalSize: 7 }),
    );
    expect(weighed.errors).toEqual([expect.objectContaining({ location: "files" })]);
    expect(weighed.errors[0]?.message).toContain("8 bytes");
  });

  it("refuses a file holding what looks like a secret at its item, quoting nothing of it", async () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const resolution = await resolveMethodSource(
      {
        files: [
          { path: "m/main.mthds" },
          { path: "m/templates/notes.html" },
          { content: `api_key = "${key}"` },
        ],
      },
      fakeFileResolver({ "m/main.mthds": 'domain = "m"', "m/templates/notes.html": key }),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.errors.map((error) => error.location)).toEqual([
      "files[1].path",
      "files[2].content",
    ]);
    expect(resolution.errors[0]?.message).toContain(
      "m/templates/notes.html (it holds an AWS access key id)",
    );
    expect(resolution.errors[0]?.hint).toContain("call the tool again");
    for (const error of resolution.errors) {
      expect(JSON.stringify(error)).not.toContain(key);
    }
    expect(resolution.tree).toBeUndefined();
  });
});

/** A folder resolver over in-memory files, recording the limits each read was held to. */
function fakeFolderResolver(
  files: Record<string, string | Uint8Array>,
  overrides: Partial<FileResolver> = {},
): FileResolver & { limits: ListingLimits[] } {
  const limits: ListingLimits[] = [];
  return {
    limits,
    resolve: () => Promise.reject(new Error("a folder is not read file by file")),
    locateMethodDir: (methodDir) =>
      Promise.resolve({ ok: true, folder: `/w/${methodDir}`, methodDir }),
    readMethodTree: (_location, options) => {
      limits.push(options.limits);
      const bytes = new Map(
        Object.entries(files).map(([path, content]) => [
          path,
          typeof content === "string" ? encode(content) : content,
        ]),
      );
      const listing = [...bytes].map(([path, read]) => ({
        path,
        size: read.byteLength,
        sha256: sha256Hex(read),
      }));
      return Promise.resolve({ ok: true, files: listing, digest: treeDigest(listing), bytes });
    },
    ...overrides,
  };
}

describe("resolveMethodSource on method_dir", () => {
  const FOLDER = { "main.mthds": 'domain = "demo"', "templates/a.html": "<p>{{ x }}</p>" };

  it("resolves nothing when the method is named by a selector", async () => {
    const limits = limitsReader();
    const resolution = await resolveMethodSource(
      { method_ref: "github.com/acme/methods/invoice" },
      fakeFolderResolver(FOLDER),
      "one_selector",
      limits,
    );

    expect(resolution).toEqual({ errors: [] });
    expect(limits.calls).toBe(0);
  });

  it("sends the folder's whole tree under the deployment's limits, each file shown under method_dir", async () => {
    const resolver = fakeFolderResolver(FOLDER);
    const resolution = await resolveMethodSource(
      { method_dir: "m" },
      resolver,
      "run_source",
      limitsReader(),
    );

    expect(resolution.errors).toEqual([]);
    expect(resolution.tree?.fromFolder).toBe(true);
    expect(resolution.tree?.files.map(({ treePath, shown }) => ({ treePath, shown }))).toEqual([
      { treePath: "main.mthds", shown: "m/main.mthds" },
      { treePath: "templates/a.html", shown: "m/templates/a.html" },
    ]);
    expect(resolution.tree?.source.files.map((file) => file.path)).toEqual([
      "main.mthds",
      "templates/a.html",
    ]);
    expect(resolver.limits).toEqual([LIMITS]);
  });

  it("refuses a blank folder before reading anything", async () => {
    const resolver = fakeFolderResolver(FOLDER);
    const resolution = await resolveMethodSource(
      { method_dir: "  " },
      resolver,
      "one_selector",
      limitsReader(),
    );

    expect(resolution.errors).toEqual([
      expect.objectContaining({
        class: "input_domain",
        location: "method_dir",
        message: "method_dir must not be empty when supplied.",
      }),
    ]);
    expect(resolver.limits).toEqual([]);
  });

  it("refuses a folder beside files or an address on every tool, at the second field", async () => {
    for (const rule of ["one_selector", "run_source"] as const) {
      const resolution = await resolveMethodSource(
        {
          method_dir: "m",
          files: [{ content: 'domain = "demo"' }],
          method_ref: "github.com/acme/methods/invoice",
        },
        fakeFolderResolver(FOLDER),
        rule,
        limitsReader(),
      );

      expect(resolution.errors.map((error) => error.location)).toEqual([
        "method_dir",
        "method_ref",
      ]);
      expect(resolution.errors[0]?.message).toContain(
        "method_dir and files are mutually exclusive",
      );
      expect(resolution.tree).toBeUndefined();
    }
  });

  it("refuses a folder beside a method_id on the tooling tools, and pairs them on a run", async () => {
    const tooling = await resolveMethodSource(
      { method_dir: "m", method_id: "mt_abc123" },
      fakeFolderResolver(FOLDER),
      "one_selector",
      limitsReader(),
    );
    expect(tooling.errors).toEqual([
      expect.objectContaining({ location: "method_id", retryable: false }),
    ]);

    const run = await resolveMethodSource(
      { method_dir: "m", method_id: "mt_abc123" },
      fakeFolderResolver(FOLDER),
      "run_source",
      limitsReader(),
    );
    expect(run.errors).toEqual([]);
    expect(run.tree?.files).toHaveLength(2);
  });

  it("says when a deployment cannot read a folder", async () => {
    const resolution = await resolveMethodSource(
      { method_dir: "m" },
      undefined,
      "one_selector",
      limitsReader(),
    );

    expect(resolution.errors).toEqual([
      expect.objectContaining({
        class: "input_domain",
        location: "method_dir",
        message:
          "This deployment cannot read a folder from disk; submit the method's files instead.",
      }),
    ]);
  });

  it("locates every refusal of the folder at method_dir, the locating and the reading", async () => {
    const unlocated = await resolveMethodSource(
      { method_dir: "m" },
      fakeFolderResolver(FOLDER, {
        locateMethodDir: () =>
          Promise.resolve({ ok: false, refusals: [{ message: "first", hint: "one" }] }),
      }),
      "one_selector",
      limitsReader(),
    );
    const unread = await resolveMethodSource(
      { method_dir: "m" },
      fakeFolderResolver(FOLDER, {
        readMethodTree: () =>
          Promise.resolve({
            ok: false,
            refusals: [
              { message: "second", hint: "two" },
              { message: "third", hint: "three" },
            ],
          }),
      }),
      "one_selector",
      limitsReader(),
    );

    expect([...unlocated.errors, ...unread.errors]).toEqual(
      ["first", "second", "third"].map((message) =>
        expect.objectContaining({
          class: "input_domain",
          location: "method_dir",
          message,
          retryable: false,
        }),
      ),
    );
  });

  it("refuses a folder holding what looks like a secret, naming each file under method_dir", async () => {
    const resolution = await resolveMethodSource(
      { method_dir: "m" },
      fakeFolderResolver({
        ...FOLDER,
        "keys/deploy.key": "not a zip",
        "notes.md": "token ghp_" + "a".repeat(36),
      }),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.errors).toHaveLength(1);
    expect(resolution.errors[0]).toMatchObject({ class: "input_domain", location: "method_dir" });
    expect(resolution.errors[0]?.message).toContain(
      "m/keys/deploy.key (it is named like a key file",
    );
    expect(resolution.errors[0]?.message).toContain("m/notes.md (it holds a GitHub token)");
    expect(resolution.tree).toBeUndefined();
  });
});

describe("withFilesSent", () => {
  const error = (location?: string): ToolError => ({
    class: "input_domain",
    ...(location === undefined ? {} : { location }),
    message: "m",
    hint: "h",
    retryable: false,
  });

  async function treeOf(source: MethodSourceInput, resolver?: FileResolver) {
    const resolution = await resolveMethodSource(source, resolver, "one_selector", limitsReader());
    return resolution.tree!;
  }

  it("returns a result that sent no tree unchanged", () => {
    const result = { structuredContent: { status: "error", errors: [error("files")] } };

    expect(withFilesSent(result, undefined)).toBe(result);
  });

  it("lists a folder's files and relocates the errors that named files to method_dir", async () => {
    const result: {
      structuredContent: { status: string; errors?: ToolError[]; files_sent?: string[] };
    } = {
      structuredContent: {
        status: "error",
        errors: [error("files"), error("files[2].content"), error("method_id"), error()],
      },
    };

    const listed = withFilesSent(
      result,
      await treeOf({ method_dir: "m" }, fakeFolderResolver({ "main.mthds": "x" })),
    );

    expect(listed.structuredContent.files_sent).toEqual(["m/main.mthds"]);
    expect(listed.structuredContent.errors?.map((item) => item.location)).toEqual([
      "method_dir",
      "method_dir",
      "method_id",
      undefined,
    ]);
  });

  it("lists the files given and leaves their errors where they are", async () => {
    const result: {
      structuredContent: { status: string; errors?: ToolError[]; files_sent?: string[] };
    } = { structuredContent: { status: "error", errors: [error("files")] } };

    const listed = withFilesSent(
      result,
      await treeOf(
        { files: [{ path: "m/main.mthds" }, { content: "y" }] },
        fakeFileResolver({ "m/main.mthds": "x" }),
      ),
    );

    expect(listed.structuredContent.files_sent).toEqual(["bundle.mthds", "m/main.mthds"]);
    expect(listed.structuredContent.errors?.[0]?.location).toBe("files");
  });

  it("lists no file on a result marked unsent, and still relocates its errors", async () => {
    const result: {
      structuredContent: { status: string; errors?: ToolError[]; files_sent?: string[] };
    } = markUnsent({ structuredContent: { status: "error", errors: [error("files")] } });

    const bare = withFilesSent(
      result,
      await treeOf({ method_dir: "m" }, fakeFolderResolver({ "main.mthds": "x" })),
    );

    expect(bare.structuredContent).not.toHaveProperty("files_sent");
    expect(bare.structuredContent.errors?.[0]?.location).toBe("method_dir");
  });

  it("reads only the SDK's refusal of an argument as a failure before sending", () => {
    expect(failedBeforeSending(new RequestArgumentError("bad base URL"))).toBe(true);
    expect(
      failedBeforeSending(new ApiUnreachableError("reset", DEFAULT_API_URL, "ECONNRESET")),
    ).toBe(false);
    expect(failedBeforeSending(new Error("anything else"))).toBe(false);
  });

  it("lists the files sent on a produced verdict, which carries no errors", async () => {
    const result: { structuredContent: { status: string; files_sent?: string[] } } = {
      structuredContent: { status: "ok" },
    };

    const listed = withFilesSent(
      result,
      await treeOf({ method_dir: "m" }, fakeFolderResolver({ "main.mthds": "x" })),
    );

    expect(listed.structuredContent).toEqual({ status: "ok", files_sent: ["m/main.mthds"] });
  });
});

describe("toolResultContent", () => {
  it("closes the summary with every file a tree sent, after the errors", () => {
    const [content] = toolResultContent(
      "Validation was not run.",
      [error()],
      ["m/main.mthds", "m/templates/a `b`.html"],
    );

    expect(content.text).toBe(
      [
        "Validation was not run.",
        "",
        "- `method_dir` — m",
        "  *Hint: h*",
        "",
        "## Files sent",
        "",
        "The method's tree, every file this call sent and nothing else:",
        "",
        "- `m/main.mthds`",
        // A backtick in a path cannot close the span it is shown in.
        "- ``m/templates/a `b`.html``",
      ].join("\n"),
    );

    function error(): ToolError {
      return {
        class: "input_domain",
        location: "method_dir",
        message: "m",
        hint: "h",
        retryable: false,
      };
    }
  });

  it("adds no files-sent section when no tree was sent", () => {
    expect(toolResultContent("Done.", [], [])[0].text).toBe("Done.");
    expect(toolResultContent("Done.")[0].text).toBe("Done.");
  });
});

describe("toolResultContent", () => {
  it("returns just the summary when there are no errors (success)", () => {
    expect(toolResultContent("# Validation passed")).toEqual([
      { type: "text", text: "# Validation passed" },
    ]);
  });

  it("returns just the summary for an empty error list", () => {
    expect(toolResultContent("headline", [])).toEqual([{ type: "text", text: "headline" }]);
  });

  it("surfaces each error's locator, message, and hint under the summary", () => {
    const errors: ToolError[] = [
      {
        class: "input_domain",
        location: "files[1].path",
        message: "This deployment cannot read files from disk; submit the file contents instead.",
        hint: "Resubmit this item as { content, uri? }, or use the local workshop server (npx @pipelex/mcp).",
        retryable: false,
      },
    ];

    const [content] = toolResultContent(
      "Validation was not run: request input is invalid.",
      errors,
    );

    // The headline stays first, so hosts that show only the top line still read well.
    expect(content.text.startsWith("Validation was not run: request input is invalid.")).toBe(true);
    // The instructive detail every capability writes into errors[] now reaches
    // the agent-facing content stream, not just structuredContent.errors.
    expect(content.text).toContain("`files[1].path`");
    expect(content.text).toContain(
      "This deployment cannot read files from disk; submit the file contents instead.",
    );
    expect(content.text).toContain("*Hint: Resubmit this item as { content, uri? }");
    expect(content.text).toContain("npx @pipelex/mcp");
  });

  it("omits the locator and hint segments when they are absent", () => {
    const [content] = toolResultContent("headline", [
      { class: "runtime", message: "Server fault.", retryable: true },
    ]);

    expect(content.text).toBe("headline\n\n- Server fault.");
  });

  it("lists every error, one per line", () => {
    const [content] = toolResultContent("headline", [
      { class: "input_domain", location: "files[0].path", message: "First.", retryable: false },
      { class: "input_domain", location: "files[1].path", message: "Second.", retryable: false },
    ]);

    expect(content.text).toBe(
      "headline\n\n- `files[0].path` — First.\n- `files[1].path` — Second.",
    );
  });

  it("collapses embedded newlines so a crafted message stays one Markdown bullet", () => {
    // A path with an embedded blank line still ends in .mthds, so it clears the
    // extension gate and reaches the content stream; without normalization the
    // blank line would terminate the list item early.
    const [content] = toolResultContent("headline", [
      {
        class: "input_domain",
        location: "files[0].path",
        message: "File not found: a\n\nb.mthds",
        hint: "Check\nthe path.",
        retryable: false,
      },
    ]);

    expect(content.text).toBe(
      "headline\n\n- `files[0].path` — File not found: a b.mthds\n  *Hint: Check the path.*",
    );
  });
});

describe("validateMethodSelectorRequest", () => {
  // Whether `method_dir` or `files` resolved into a tree.
  const files = true;
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";

  it("accepts each selector alone, under both rules", () => {
    for (const rule of ["one_selector", "run_source"] as const) {
      expect(validateMethodSelectorRequest(files, {}, { rule })).toEqual([]);
      expect(validateMethodSelectorRequest(false, { method_ref: ADDRESS }, { rule })).toEqual([]);
      expect(validateMethodSelectorRequest(false, { method_id: "mt_abc123" }, { rule })).toEqual(
        [],
      );
    }
  });

  it("rejects a request with no selector at all, naming the accepted forms", () => {
    const errors = validateMethodSelectorRequest(false, {}, { rule: "one_selector" });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("files");
    expect(errors[0]?.message).toBe(
      "Provide a method folder, MTHDS files, a method_ref address, or a method_id.",
    );
    expect(errors[0]?.hint).toContain("github.com/");
  });

  it("rejects a blank method_id at method_id, with or without files", () => {
    for (const presentFiles of [false, files]) {
      const errors = validateMethodSelectorRequest(
        presentFiles,
        { method_id: "  " },
        { rule: "run_source" },
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.class).toBe("input_domain");
      expect(errors[0]?.location).toBe("method_id");
      expect(errors[0]?.retryable).toBe(false);
    }
  });

  it("rejects a blank method_ref at method_ref", () => {
    const errors = validateMethodSelectorRequest(
      false,
      { method_ref: "  " },
      { rule: "one_selector" },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("method_ref");
  });

  it("accepts any non-blank selector — format stays server-owned", () => {
    expect(
      validateMethodSelectorRequest(false, { method_id: "not-an-mt-id" }, { rule: "one_selector" }),
    ).toEqual([]);
    expect(
      validateMethodSelectorRequest(
        false,
        { method_ref: "not-an-address" },
        { rule: "one_selector" },
      ),
    ).toEqual([]);
  });

  it("one_selector: rejects every pairing, each at the extra selector", () => {
    const filesAndId = validateMethodSelectorRequest(
      files,
      { method_id: "mt_abc123" },
      { rule: "one_selector" },
    );
    expect(filesAndId).toHaveLength(1);
    expect(filesAndId[0]?.location).toBe("method_id");
    expect(filesAndId[0]?.message).toContain("mutually exclusive");

    const filesAndRef = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS },
      { rule: "one_selector" },
    );
    expect(filesAndRef).toHaveLength(1);
    expect(filesAndRef[0]?.location).toBe("method_ref");

    const refAndId = validateMethodSelectorRequest(
      false,
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "one_selector" },
    );
    expect(refAndId).toHaveLength(1);
    expect(refAndId[0]?.location).toBe("method_id");
  });

  it("run_source: files + method_id is the legal linkage pair", () => {
    expect(
      validateMethodSelectorRequest(files, { method_id: "mt_abc123" }, { rule: "run_source" }),
    ).toEqual([]);
  });

  it("run_source: method_ref pairs with nothing", () => {
    const filesAndRef = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS },
      { rule: "run_source" },
    );
    expect(filesAndRef).toHaveLength(1);
    expect(filesAndRef[0]?.location).toBe("method_ref");

    const refAndId = validateMethodSelectorRequest(
      false,
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "run_source" },
    );
    expect(refAndId).toHaveLength(1);
    expect(refAndId[0]?.location).toBe("method_id");
    expect(refAndId[0]?.message).toContain("provenance");
  });

  it("all three selectors report each illegal pairing", () => {
    const errors = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "one_selector" },
    );

    expect(errors.map((error) => error.location).sort()).toEqual([
      "method_id",
      "method_id",
      "method_ref",
    ]);
  });

  it("a blank selector earns its own error, not a pairing error", () => {
    // The blank method_ref is invalid on its own; it must not also produce
    // an exclusivity error against the files.
    const errors = validateMethodSelectorRequest(
      files,
      { method_ref: "  " },
      { rule: "run_source" },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("must not be empty");
  });
});

describe("validateRunIdRequest", () => {
  it("rejects an empty or whitespace-only run id", () => {
    for (const runId of ["", "   ", "\n\t"]) {
      const errors = validateRunIdRequest(runId);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.class).toBe("input_domain");
      expect(errors[0]?.location).toBe("run_id");
    }
  });

  it("accepts a normal run id", () => {
    expect(validateRunIdRequest("01JRUN0000000000000000TEST")).toEqual([]);
  });
});

/**
 * What the SDK throws when the API refuses a request: the real client, reading
 * a stubbed answer, so the verdict on the error is the one the SDK decides from
 * the problem document it parsed. `problem` is the document's members; a
 * string is sent as the raw body, as a bare runner or a gateway answers.
 */
async function refused(
  status: number,
  problem: Record<string, unknown> | string = {},
): Promise<ApiResponseError> {
  const body = typeof problem === "string" ? problem : JSON.stringify({ status, ...problem });
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(body, {
        status,
        headers: { "content-type": "application/problem+json" },
      }),
    ),
  );
  try {
    await createPipelexApiClient({ baseUrl: DEFAULT_API_URL }).getMethod("mt_test");
  } catch (err) {
    if (err instanceof ApiResponseError) return err;
    throw err;
  }
  throw new Error("the client did not refuse");
}

/** What the SDK throws when nothing answers: an `ApiUnreachableError` carrying the network code. */
async function unreachable(code: string): Promise<unknown> {
  vi.stubGlobal("fetch", () =>
    Promise.reject(
      new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }),
    ),
  );
  return createPipelexApiClient({ baseUrl: DEFAULT_API_URL })
    .getMethod("mt_test")
    .then(
      () => undefined,
      (err: unknown) => err,
    );
}

/**
 * What input preparation throws once the client's `upload()` met `answer`: the
 * SDK's `prepareInputs` on the real client, asked for one image whose value is
 * bytes to upload, so the `UploadTransportError` wrapping the refusal is the
 * SDK's own.
 */
async function uploadFailure(answer: () => Promise<Response>): Promise<unknown> {
  vi.stubGlobal("fetch", (url: string) =>
    String(url).endsWith("/v1/pipe-io")
      ? Promise.resolve(
          Response.json({
            is_valid: true,
            pipe_ref: "demo.main",
            pipe_io_contracts: {},
            input_form: {
              "demo.main": {
                fields: [
                  { kind: "image", required: true, name: "photo", presence: "plain", gating: true },
                ],
              },
            },
            output_form: {},
            default_pipe_ref: "demo.main",
            pending_signatures: [],
            is_runnable: true,
          }),
        )
      : answer(),
  );
  return createPipelexApiClient({ baseUrl: DEFAULT_API_URL })
    .prepareInputs({
      // The protocol's map, sent as given: no handshake, no blob route.
      files: { "main.mthds": 'domain = "demo"' },
      inputs: { photo: "data:image/png;base64,AQ==" },
    })
    .then(
      () => undefined,
      (err: unknown) => err,
    );
}

/** The runner's own rendering of a refusal: `error_type`, `detail` and `error_domain`. */
function runnerProblem(errorType: string, detail: string, errorDomain?: string) {
  return {
    error_type: errorType,
    detail,
    ...(errorDomain === undefined ? {} : { error_domain: errorDomain }),
  };
}

describe("classifyError", () => {
  describe("takes the verdict from the SDK's error", () => {
    it("reads a refused request's class and retryable flag as the SDK decided them", async () => {
      const error = classifyError(
        await refused(422, runnerProblem("ValidationError", "Bad request body", "input")),
      );

      expect(error).toEqual({
        class: "input_domain",
        location: "files",
        message: "Bad request body",
        hint: "Check the submitted file contents and provenance fields.",
        retryable: false,
      });
    });

    it("follows the server's own members over the status", async () => {
      // A runner's engine configuration error is a 500 that names its domain
      // and says nothing of a retry: the SDK reads it as config, not retryable,
      // where the status alone would have called it a passing fault.
      const configFault = classifyError(
        await refused(500, runnerProblem("ConfigError", "Missing secret", "config")),
      );
      expect(configFault).toMatchObject({ class: "config", retryable: false });

      const finalFault = classifyError(
        await refused(503, { detail: "Gone for good", error_domain: "runtime", retryable: false }),
      );
      expect(finalFault).toMatchObject({ class: "runtime", retryable: false });
    });

    it("reads the SDK's fallback when the server sent no verdict", async () => {
      const server = classifyError(await refused(500, { detail: "Server fault" }));
      expect(server).toMatchObject({ class: "runtime", message: "Server fault", retryable: true });

      // A conflict is the caller's request meeting the stored state.
      expect(classifyError(await refused(409, { code: "conflict" }))).toMatchObject({
        class: "input_domain",
        hint: "The Pipelex API returned HTTP 409.",
        retryable: false,
      });

      // Refused for its timing, not its content: a poll loop must keep going.
      for (const status of [429, 408]) {
        expect(classifyError(await refused(status))).toMatchObject({
          class: "runtime",
          retryable: true,
        });
      }
    });

    it("reads an unreachable API as retryable config at the base URL", async () => {
      const error = classifyError(await unreachable("ECONNREFUSED"));

      expect(error.class).toBe("config");
      expect(error.location).toBe("PIPELEX_BASE_URL");
      expect(error.retryable).toBe(true);
    });

    it("reads the SDK's own request timeout as a retryable runtime fault, not the base URL", () => {
      const error = classifyError(
        new ApiUnreachableError("no answer in time", DEFAULT_API_URL, "ABORT_TIMEOUT"),
      );

      expect(error.class).toBe("runtime");
      expect(error.location).toBeUndefined();
      expect(error.hint).toMatch(/did not answer in time/);
      expect(error.retryable).toBe(true);
    });

    it("reads the client's refusal of its own arguments by their verdict", () => {
      // A base URL carrying a path is refused at construction, as `config`.
      let construction: unknown;
      try {
        createPipelexApiClient({ baseUrl: `${DEFAULT_API_URL}/v1` });
      } catch (err) {
        construction = err;
      }
      expect(construction).toBeInstanceOf(RequestArgumentError);
      expect(classifyError(construction)).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: false,
      });

      const argument = classifyError(new RequestArgumentError("No run source given."));
      expect(argument).toMatchObject({ class: "input_domain", retryable: false });
      expect(argument.location).toBeUndefined();
    });

    it("reads the run family and the paging guard by their verdict", () => {
      expect(classifyError(new RunTimeoutError("still going", "run_1", 1_000))).toMatchObject({
        class: "runtime",
        retryable: true,
      });
      expect(classifyError(new PagingNotTerminatingError("cursors never end", 100))).toMatchObject({
        class: "runtime",
        retryable: false,
      });
      expect(
        classifyError(new MissingMainStuffError("Completed run 'x' returned no main stuff.", "x")),
      ).toMatchObject({
        class: "runtime",
        message: expect.stringMatching(/main stuff/i),
        retryable: false,
      });
    });

    it("reads a missing run lifecycle as config, pointing at the hosted API", async () => {
      vi.stubGlobal("fetch", () =>
        Promise.resolve(Response.json({ detail: "Not Found" }, { status: 404 })),
      );
      const err = await createPipelexApiClient({ baseUrl: DEFAULT_API_URL })
        .getRunStatus("run_1")
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(RunLifecycleUnavailableError);

      const error = classifyError(err);
      expect(error.class).toBe("config");
      expect(error.location).toBe("PIPELEX_BASE_URL");
      expect(error.hint).toMatch(/hosted/i);
      expect(error.retryable).toBe(false);
    });

    it("reads a verdict carried by an error that is not this copy's class", () => {
      const foreign = Object.assign(new Error("refused elsewhere"), {
        retryable: false,
        errorDomain: "input",
      });

      expect(classifyError(foreign)).toMatchObject({ class: "input_domain", retryable: false });
    });

    it("keeps its own reading of a failure that carries no verdict", () => {
      const bare = classifyError(new PipelineRequestError("Invalid API base URL"));
      expect(bare).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: false,
      });

      // A fault nothing names stays retryable: for the poll loops, wrongly
      // stopping a live follow is worse than one more read.
      expect(classifyError(new Error("boom"))).toMatchObject({ class: "runtime", retryable: true });
      expect(classifyError("boom")).toMatchObject({
        class: "runtime",
        message: "Unknown failure.",
        retryable: true,
      });
    });
  });

  describe("overrides the SDK's class where this server knows better, and says why", () => {
    it("reads every rejected credential as config, whatever the server tagged it", async () => {
      // The runner tags its own 401 `input`; the platform sends no domain.
      const fromRunner = await refused(
        401,
        runnerProblem("Unauthenticated", "Missing key", "input"),
      );
      expect(fromRunner.errorDomain).toBe("input");
      for (const err of [fromRunner, await refused(401, { code: "unauthorized" })]) {
        expect(classifyError(err)).toMatchObject({
          class: "config",
          location: "PIPELEX_API_KEY",
          hint: "Check PIPELEX_API_KEY for the configured API.",
          retryable: false,
        });
      }
    });

    it("takes a route's declared class for a 400 no argument fixes", async () => {
      const orgless = await refused(400, { code: "bad_request", detail: "No active organization" });
      expect(orgless.errorDomain).toBe("input");

      expect(classifyError(orgless, BULK_RESOLVE_ERROR_OPTIONS)).toMatchObject({
        class: "config",
        retryable: false,
      });
    });

    it("reads the registry form of method_ref as the caller's, on a route that declared it", async () => {
      const registry = await refused(
        501,
        runnerProblem("MethodRefNotImplemented", "Registry refs are reserved.", "config"),
      );
      const texture = { location: "method_ref", hint: "Use an address." };

      expect(classifyError(registry, { notImplemented: texture })).toEqual({
        class: "input_domain",
        location: "method_ref",
        message: "Registry refs are reserved.",
        hint: "Use an address.",
        retryable: false,
      });
      // Elsewhere the deployment does not implement the route.
      expect(classifyError(registry, { route: "/v1/codegen" })).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        hint: expect.stringContaining("/v1/codegen"),
        retryable: false,
      });
    });

    it("reads a 404 as the caller's miss only where the route takes a name and the SDK reads it so", async () => {
      const texture = { location: "method_ref", hint: "No such package." };
      const options = { route: "/v1/pipe-io", notFound: texture };

      // A runner's typed refusal and the platform's coded one both name the miss.
      const typed = await refused(
        404,
        runnerProblem("MethodPackageNotFoundError", "No package matches.", "input"),
      );
      expect(classifyError(typed, options)).toMatchObject({
        class: "input_domain",
        location: "method_ref",
        retryable: false,
      });
      const coded = await refused(404, { code: "not_found", detail: "Method not found" });
      expect(classifyError(coded, options).location).toBe("method_ref");

      // A bare 404 is the deployment not serving the route.
      const bare = classifyError(await refused(404, '{"detail":"Not Found"}'), options);
      expect(bare).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: false,
      });
      expect(bare.hint).toContain("/v1/pipe-io");

      // On a route that names no resource, even a coded 404 is the route
      // missing: the platform renders a path it does not serve that way.
      expect(classifyError(coded, { route: "/v1/methods" })).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        hint: expect.stringContaining("/v1/methods"),
      });
    });
  });

  describe("words each refusal for this server's caller", () => {
    it("applies route-specific bad-request texture when provided", async () => {
      const error = classifyError(
        await refused(422, runnerProblem("ValidationError", "Unknown pipe: demo.missing", "input")),
        {
          route: "/v1/pipe-io",
          badRequest: { location: "pipe_ref", hint: "Pass a qualified domain.pipe_code." },
        },
      );

      expect(error).toMatchObject({
        class: "input_domain",
        location: "pipe_ref",
        hint: "Pass a qualified domain.pipe_code.",
      });
    });

    it("locates a refused pipe selection at the selection texture, ahead of the selector's", async () => {
      const refusal = (errorType: string) =>
        refused(
          422,
          runnerProblem(errorType, "Several domains declare a main_pipe: a.main, b.main.", "input"),
        );
      const withoutSelection = {
        route: "/v1/pipe-io",
        badRequest: { location: "method_ref", hint: "Check the address." },
      };
      const options = {
        ...withoutSelection,
        selection: { location: "pipe_ref", hint: "Name the pipe." },
      };

      for (const errorType of ["EntryPipeNotFoundError", "EntryPipeAmbiguousError"]) {
        expect(classifyError(await refusal(errorType), options)).toEqual({
          class: "input_domain",
          location: "pipe_ref",
          message: "Several domains declare a main_pipe: a.main, b.main.",
          hint: "Name the pipe.",
          retryable: false,
        });
      }

      // Any other 422 keeps the selector's texture, and a route that declared no
      // selection texture keeps the generic arm for the typed refusal too.
      expect(classifyError(await refusal("ValidationError"), options).location).toBe("method_ref");
      expect(
        classifyError(await refusal("EntryPipeNotFoundError"), withoutSelection).location,
      ).toBe("method_ref");
    });

    it("locates a 413 at the declared size only on a route that declared the texture", async () => {
      const tooLarge = () =>
        refused(413, {
          code: "payload_too_large",
          detail: "Declared file size exceeds the 50 MiB limit.",
        });

      expect(
        classifyError(await tooLarge(), {
          route: "/v1/upload/grant",
          tooLarge: { location: "size", hint: "Pick a smaller file." },
        }),
      ).toEqual({
        class: "input_domain",
        location: "size",
        message: "Declared file size exceeds the 50 MiB limit.",
        hint: "Pick a smaller file.",
        retryable: false,
      });

      // Elsewhere a 413 keeps the SDK's verdict and names its status.
      const undeclared = classifyError(await tooLarge(), { route: "/v1/validate" });
      expect(undeclared).toMatchObject({ class: "input_domain", retryable: false });
      expect(undeclared.location).toBeUndefined();
      expect(undeclared.hint).toBe("The Pipelex API returned HTTP 413.");
    });

    it("applies deployment auth texture to a 401 response", async () => {
      const error = classifyError(await refused(401, { code: "unauthorized" }), {
        auth: { location: "api_key", hint: "Bring your own key." },
      });

      expect(error).toMatchObject({
        class: "config",
        location: "api_key",
        hint: "Bring your own key.",
        retryable: false,
      });
    });

    it("uses the route's forbidden texture on a 403, keeping the auth locator", async () => {
      const error = classifyError(await refused(403, { code: "forbidden" }), {
        auth: { location: "authorization", hint: "Sign in again." },
        forbidden: { hint: "Sign in again. If that is fine, the feature is gated." },
      });

      expect(error).toMatchObject({
        class: "config",
        location: "authorization",
        hint: "Sign in again. If that is fine, the feature is gated.",
        retryable: false,
      });
    });

    it("never applies the forbidden texture to a 401 — a rejected credential is not a gate", async () => {
      const error = classifyError(await refused(401, { code: "unauthorized" }), {
        auth: { location: "authorization", hint: "Sign in again." },
        forbidden: { hint: "The feature is gated." },
      });

      expect(error.location).toBe("authorization");
      expect(error.hint).toBe("Sign in again.");
    });

    it("classifies the sandbox refusal (403 CustomCodeRequiresSandbox) at the method, not the key", async () => {
      const error = classifyError(
        await refused(
          403,
          runnerProblem(
            "CustomCodeRequiresSandbox",
            "This bundle ships custom Python (.py); running it requires a sandbox-hosted deployment.",
            "input",
          ),
        ),
        {
          methodLocation: "method_ref",
          // The textures that would otherwise win: a deployment auth wording and
          // a route gate. Neither may reach a refusal about the method itself.
          auth: { location: "authorization", hint: "Sign in again." },
          forbidden: { hint: "The feature is gated." },
        },
      );

      expect(error.class).toBe("input_domain");
      expect(error.location).toBe("method_ref");
      expect(error.hint).toMatch(/sandbox-hosted/);
      expect(error.hint).not.toMatch(/sign in/i);
      expect(error.retryable).toBe(false);
    });

    it("locates the sandbox refusal wherever the request named the method, or nowhere", async () => {
      const sandbox = await refused(
        403,
        runnerProblem(
          "CustomCodeRequiresSandbox",
          "This bundle ships custom Python (.py).",
          "input",
        ),
      );

      // `/v1/start` applies the gate to a submitted bundle and to a stored
      // method's injected source as well as to a fetched package, so the locator
      // follows the request shape rather than being hardcoded to method_ref.
      expect(classifyError(sandbox, { methodLocation: "files" }).location).toBe("files");
      expect(classifyError(sandbox, { methodLocation: "method_id" }).location).toBe("method_id");
      // A missing locator is the honest answer — better than pointing the caller
      // at a field this route never had.
      const unlocated = classifyError(sandbox, {});
      expect(unlocated.class).toBe("input_domain");
      expect(unlocated.location).toBeUndefined();
    });

    it("classifies the structures refusal (403 MethodStructuresRefusedError) at method_ref", async () => {
      // The runner sends this refusal with no `error_domain` (L-261007-31dea6),
      // and the SDK reads a bare 403 as `config`: the arm overrides it.
      const refusal = await refused(
        403,
        runnerProblem("MethodStructuresRefusedError", "Structure classes refused."),
      );
      expect(refusal.errorDomain).toBe("config");

      const error = classifyError(refusal);

      expect(error).toMatchObject({
        class: "input_domain",
        location: "method_ref",
        retryable: false,
      });
    });

    it("never applies the sandbox arm to a 401 carrying the same error_type", async () => {
      const error = classifyError(
        await refused(401, runnerProblem("CustomCodeRequiresSandbox", "Missing key", "input")),
        { methodLocation: "method_ref" },
      );

      expect(error.class).toBe("config");
      expect(error.location).toBe("PIPELEX_API_KEY");
    });

    it("classifies a paywall 402 as config with the billing hint", async () => {
      // The platform's problem code for 402 is "forbidden" — the arm branches
      // on the status, never on this.
      const error = classifyError(
        await refused(402, { code: "forbidden", detail: "Subscription required to run methods" }),
      );

      // The class stays `config`; `kind` is what tells a billing refusal from
      // an unreachable API, for the headline and for a machine consumer that
      // would otherwise have to sniff the message.
      expect(error).toEqual({
        class: "config",
        kind: "paywall",
        message: "Subscription required to run methods",
        hint: expect.stringContaining("app.pipelex.com"),
        retryable: false,
      });
    });

    it("falls back to the transport message on a 402 without a server message", async () => {
      const error = classifyError(await refused(402, ""));

      expect(error).toMatchObject({ class: "config", kind: "paywall", retryable: false });
      expect(error.message).toMatch(/402/);
    });
  });

  // A missing or refused key is `config`, like an unreachable API, so without
  // the kind every capability's headline blamed connectivity for it
  // (L-260924-a58ae1). Every credential arm tags it, and only those.
  describe("tags a missing or refused key as kind auth", () => {
    const texture = { location: "PIPELEX_API_KEY", hint: "No Pipelex API key is set." };

    it("tags a 401 and a 403 through the generic arm, keeping the key's texture", async () => {
      for (const status of [401, 403]) {
        const error = classifyError(await refused(status, { detail: "Missing API key" }), {
          auth: texture,
        });

        expect(error, String(status)).toEqual({
          class: "config",
          kind: "auth",
          location: "PIPELEX_API_KEY",
          message: "Missing API key",
          hint: "No Pipelex API key is set.",
          retryable: false,
        });
      }
    });

    it("tags a route's gated 403 too, whose hint composes the key's with the gate's", async () => {
      const error = classifyError(await refused(403, { code: "forbidden" }), {
        auth: texture,
        forbidden: { hint: "No Pipelex API key is set. Or the route is gated." },
      });

      expect(error).toMatchObject({
        class: "config",
        kind: "auth",
        location: "PIPELEX_API_KEY",
        hint: "No Pipelex API key is set. Or the route is gated.",
      });
    });

    it("tags the upload leg's refused credential, as the SDK raises it", async () => {
      const err = await uploadFailure(() =>
        Promise.resolve(
          Response.json(
            { status: 401, title: "Unauthorized", detail: "Missing API key" },
            { status: 401, headers: { "content-type": "application/problem+json" } },
          ),
        ),
      );
      expect(err).toBeInstanceOf(UploadAuthenticationError);

      expect(classifyError(err, { auth: texture })).toMatchObject({
        class: "config",
        kind: "auth",
        location: "PIPELEX_API_KEY",
        hint: "No Pipelex API key is set.",
        retryable: false,
      });
    });

    it("tags the artifact family's refused credential", () => {
      const verdict = {
        scope: "main_stuff" as const,
        artifacts: [],
        saved_paths: [],
        all_saved: true,
      };
      for (const status of [401, 403]) {
        const error = classifyError(
          new ArtifactAuthenticationError(
            "The resolve route refused the credential.",
            status,
            verdict,
          ),
          { auth: texture },
        );

        expect(error, String(status)).toMatchObject({
          class: "config",
          kind: "auth",
          location: "PIPELEX_API_KEY",
          hint: "No Pipelex API key is set.",
        });
      }
    });

    it("gives every credential arm the same default hint when no texture is set", async () => {
      const verdict = {
        scope: "main_stuff" as const,
        artifacts: [],
        saved_paths: [],
        all_saved: true,
      };
      const errors = {
        generic: await refused(401, { detail: "Missing API key" }),
        upload: new UploadAuthenticationError("refused", 401),
        artifact: new ArtifactAuthenticationError("refused", 403, verdict),
      };
      for (const [arm, err] of Object.entries(errors)) {
        expect(classifyError(err), arm).toMatchObject({
          class: "config",
          kind: "auth",
          location: "PIPELEX_API_KEY",
          hint: DEFAULT_AUTH_HINT,
        });
      }
    });

    it("leaves the execution-locus refusals untagged, at the method and not the key", async () => {
      for (const errorType of ["MethodStructuresRefusedError", "CustomCodeRequiresSandbox"]) {
        const error = classifyError(
          await refused(403, runnerProblem(errorType, "Refused by the execution locus.", "input")),
          { auth: texture, methodLocation: "method_ref" },
        );

        expect(error, errorType).toMatchObject({ class: "input_domain", location: "method_ref" });
        expect(error.kind, errorType).toBeUndefined();
      }
    });

    it("tags nothing else: an unreachable API, a paywall and a route's 404 keep their own", async () => {
      expect(classifyError(await unreachable("ECONNREFUSED")).kind).toBeUndefined();
      expect(classifyError(await refused(402, { detail: "Plan limit" })).kind).toBe("paywall");
      expect(classifyError(await refused(404, { code: "not_found" })).kind).toBeUndefined();
    });
  });

  // The platform's refusal by role answers a runner changing a method, a member
  // taking an admin action and a caller with no recognised role alike, so the
  // arm names no role: the server's `detail` says which, and the key, which was
  // accepted, is never blamed (L-261015-bfe8ec).
  describe("reads a role refusal as the role, not the key", () => {
    /** The platform's `RoleNotPermittedError`, as its problem document carries it. */
    const roleRefusal = (detail?: string) =>
      refused(403, {
        type: "https://pipelex.com/errors/role_not_permitted",
        title: "Forbidden",
        code: "role_not_permitted",
        error_domain: "config",
        retryable: false,
        ...(detail === undefined ? {} : { detail }),
      });
    const runnerDetail =
      "Your role in this organization is runner: it runs the organization's published versions and changes no method.";
    const loginTexture = {
      location: "PIPELEX_API_KEY",
      hint: "The key saved in `~/.pipelex/.env` was refused. Run `npx -y @pipelex/mcp@latest login` again.",
    };

    it("tags it kind role, with the server's detail as its message and no locator", async () => {
      const error = classifyError(await roleRefusal(runnerDetail), { auth: loginTexture });

      expect(error).toEqual({
        class: "config",
        kind: "role",
        message: runnerDetail,
        hint: ROLE_REFUSAL_HINT,
        retryable: false,
      });
    });

    it("never sends the caller to the key or a login, whatever texture the call carries", async () => {
      const error = classifyError(await roleRefusal(runnerDetail), {
        auth: loginTexture,
        // A route's gate on a 403 (`mthds_codegen`'s) loses to the role too.
        forbidden: { hint: "Check the key. Or the route is gated." },
      });

      expect(error.kind).toBe("role");
      expect(error.location).toBeUndefined();
      expect(error.hint).toBe(ROLE_REFUSAL_HINT);
      expect(error.hint).not.toMatch(/PIPELEX_API_KEY|log ?in|replace|check/i);
    });

    it("assumes no role: a member refused an admin action reads the server's own sentence", async () => {
      const memberDetail =
        "Your role in this organization is member: this action needs the admin role.";
      const error = classifyError(await roleRefusal(memberDetail));

      expect(error).toMatchObject({ class: "config", kind: "role", message: memberDetail });
      expect(`${error.message} ${error.hint}`).not.toMatch(/runner/i);
      expect(ROLE_REFUSAL_HINT).not.toMatch(/runner|member|admin role/i);
    });

    it("falls back to the transport message when the refusal carries no detail", async () => {
      const error = classifyError(await roleRefusal());

      expect(error).toMatchObject({ class: "config", kind: "role", retryable: false });
      expect(error.message).toMatch(/403/);
    });

    it("leaves every other 403 to the key's arm", async () => {
      const error = classifyError(await refused(403, { code: "forbidden", detail: "Forbidden" }), {
        auth: loginTexture,
      });

      expect(error).toMatchObject({ kind: "auth", location: "PIPELEX_API_KEY" });
    });
  });

  describe("the upload leg", () => {
    it("reads a wrapped plan refusal as the paywall it is, not a passing fault", async () => {
      const err = await uploadFailure(() =>
        Promise.resolve(
          Response.json({ status: 402, code: "forbidden", detail: "Plan limit" }, { status: 402 }),
        ),
      );
      expect(err).toBeInstanceOf(UploadTransportError);

      expect(classifyError(err)).toMatchObject({
        class: "config",
        kind: "paywall",
        message: "Plan limit",
        retryable: false,
      });
    });

    it("reads a wrapped unreachable API as retryable config at the base URL", async () => {
      const err = await uploadFailure(() =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
          }),
        ),
      );
      expect(err).toBeInstanceOf(UploadTransportError);

      expect(classifyError(err)).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: true,
      });
    });

    it("reads a wrapped server fault by its verdict, with the upload's own hint", async () => {
      const err = await uploadFailure(() =>
        Promise.resolve(Response.json({ status: 503, detail: "Busy" }, { status: 503 })),
      );

      expect(classifyError(err)).toMatchObject({
        class: "runtime",
        hint: expect.stringMatching(/could not reach Pipelex storage/),
        retryable: true,
      });

      const refusal = await uploadFailure(() =>
        Promise.resolve(Response.json({ status: 400, detail: "Bad file" }, { status: 400 })),
      );
      expect(classifyError(refusal, { asset: { location: "inputs.photo" } })).toMatchObject({
        class: "input_domain",
        location: "inputs.photo",
        retryable: false,
      });
    });

    it("reads the rest of the preparation family by its verdict, located at the asset", () => {
      const options = { asset: { location: "inputs.photo", hint: "Shrink it." } };

      expect(
        classifyError(new RejectedAssetError("too large", "photo.png", 413), options),
      ).toMatchObject({
        class: "input_domain",
        location: "inputs.photo",
        hint: "Shrink it.",
        retryable: false,
      });
      expect(
        classifyError(new InvalidLocalSourceError("unreadable", "./photo.png"), options),
      ).toMatchObject({ class: "input_domain", location: "inputs.photo", retryable: false });
      expect(classifyError(new UnsupportedUploadCapabilityError("no upload route"))).toMatchObject({
        class: "config",
        location: "PIPELEX_BASE_URL",
        retryable: false,
      });
      expect(
        classifyError(new UploadAuthenticationError("refused", 401), {
          auth: { location: "api_key", hint: "Bring your own key." },
        }),
      ).toMatchObject({ class: "config", location: "api_key", retryable: false });
    });

    it("locates the preparation base error at the pipe, unless the SDK reads it as no fault of the caller's", () => {
      const options = { preparation: { location: "pipe_ref", hint: "Name the pipe." } };

      expect(classifyError(new InputPreparationError("Unknown pipe."), options)).toMatchObject({
        class: "input_domain",
        location: "pipe_ref",
        retryable: false,
      });

      const unreadable = classifyError(
        new InputPreparationError("is_valid is not a boolean", {
          verdict: { errorDomain: "runtime", retryable: false },
        }),
        options,
      );
      expect(unreadable).toMatchObject({ class: "runtime", retryable: false });
      expect(unreadable.location).toBeUndefined();
    });
  });

  it("classifies the artifact family by its verdict, with its own texture", () => {
    const verdict = {
      scope: "main_stuff" as const,
      artifacts: [],
      saved_paths: [],
      all_saved: true,
    };
    const auth = classifyError(
      new ArtifactAuthenticationError(
        "The resolve route refused the credential (401).",
        401,
        verdict,
      ),
      { auth: { location: "connector", hint: "Reconnect." } },
    );
    expect(auth).toMatchObject({
      class: "config",
      location: "connector",
      hint: "Reconnect.",
      retryable: false,
    });
    expect(classifyError(new ArtifactAuthenticationError("refused", 403, verdict))).toMatchObject({
      class: "config",
      location: "PIPELEX_API_KEY",
    });

    // A scope with no artifact on a completed run reads like a missing main output.
    expect(classifyError(new ScopeUnavailableError("main_stuff", "run-1"))).toMatchObject({
      class: "runtime",
      retryable: false,
    });

    // The base class is never the caller's input, and never the base-URL config arm.
    const operation = classifyError(new ArtifactOperationError("malformed bulk answer"));
    expect(operation).toMatchObject({ class: "runtime", retryable: false });
    expect(operation.location).toBeUndefined();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyError on the method-version codes", () => {
  it("reads a never-published method's bare id as the caller's, naming the draft and the publish", async () => {
    const error = classifyError(
      await refused(409, { code: "method_not_published", detail: "mt_test is not published." }),
      { route: "/v1/validate", methodLocation: "files" },
    );

    expect(error).toMatchObject({
      class: "input_domain",
      location: "method_id",
      message: "mt_test is not published.",
      retryable: false,
    });
    expect(error.hint).toContain("mt_…@draft");
    expect(error.hint).toContain("mthds_publish_method");
    expect(error.hint).toContain("only when the user asks");
  });

  it("locates a stale draft token where the route says, with its hint", async () => {
    const conflict = await refused(409, { code: "method_update_conflict", detail: "Moved." });

    expect(classifyError(conflict)).toMatchObject({
      class: "input_domain",
      location: "expected_updated_at",
    });
    expect(
      classifyError(conflict, {
        conflict: { location: "expected_draft_updated_at", hint: "Read it again." },
      }),
    ).toMatchObject({ location: "expected_draft_updated_at", hint: "Read it again." });
  });

  it("says a method being deleted is going away", async () => {
    const error = classifyError(
      await refused(409, { code: "method_being_deleted", detail: "Deleting." }),
    );
    expect(error).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(error.hint).toContain("being deleted");
  });

  it("reads an unknown version as the caller's, ahead of the route's unknown-method hint", async () => {
    const error = classifyError(
      await refused(404, { code: "method_version_not_found", detail: "No version 9." }),
      { notFound: { location: "method_id", hint: "No registered method with this id." } },
    );

    expect(error).toMatchObject({
      class: "input_domain",
      location: "method_id",
      message: "No version 9.",
      retryable: false,
    });
    expect(error.hint).not.toContain("No registered method");
    expect(error.hint).toContain("no published version with this number");
  });
});

describe("classifyError on the refusals of a method's tree", () => {
  // Codegen's tree shape points a bare 400/422 at `target`: a refusal of the
  // tree must not follow it there.
  const TREE_SHAPE = {
    route: "/v1/codegen",
    badRequest: { location: "target", hint: "Pass a known target." },
    methodTree: true,
  };
  // The same route on a request that sent no tree.
  const NO_TREE = { ...TREE_SHAPE, methodTree: false };

  it("locates a tree the standard's rules or the deployment's limits refuse at files", async () => {
    for (const problem of [
      { code: "invalid_method_files", detail: "'a//b.mthds' is not a tree path" },
      runnerProblem("InvalidMethodFiles", "'a//b.mthds' is not a tree path", "input"),
      { code: "method_tree_too_large", detail: "The tree holds more than 1000 files" },
      runnerProblem("MethodTreeTooLarge", "The tree holds more than 1000 files", "input"),
    ]) {
      const error = classifyError(await refused(422, problem), TREE_SHAPE);

      expect(error).toMatchObject({ class: "input_domain", location: "files", retryable: false });
      expect(error.message).toBe(problem.detail);
      expect(error.hint).not.toBe("Pass a known target.");
    }
  });

  it("reads a blob the platform holds otherwise, or lost, as no argument's fault", async () => {
    const mismatch = classifyError(
      await refused(422, { code: "blob_mismatch", detail: "Size mismatch" }),
      TREE_SHAPE,
    );
    expect(mismatch).toMatchObject({ class: "runtime", location: "files", retryable: false });

    const missing = classifyError(
      await refused(422, { code: "missing_blobs", detail: "Missing blobs" }),
      TREE_SHAPE,
    );
    // Sending the same call again uploads what is missing.
    expect(missing).toMatchObject({ class: "runtime", location: "files", retryable: true });
  });

  it("reads a request too large for the deployment as the tree's, at files", async () => {
    const error = classifyError(await refused(413, { detail: "Request Entity Too Large" }), {
      ...TREE_SHAPE,
      route: "/v1/start",
    });

    expect(error).toMatchObject({ class: "input_domain", location: "files", retryable: false });
    expect(error.hint).toContain("without a blob store");
    expect(error.hint).toContain(".gitignore");
  });

  it("leaves the tree refusals to the route on a request that sent no tree", async () => {
    const error = classifyError(
      await refused(422, { code: "invalid_method_files", detail: "Bad map" }),
      NO_TREE,
    );

    expect(error).toMatchObject({ class: "input_domain", location: "target" });
    expect(error.hint).toBe("Pass a known target.");
  });

  it("locates a file that did not upload at files on a tool, and at method_dir on a save", () => {
    const failure = new MethodFileTransferError("The upload of main.mthds failed.", {
      operation: "upload",
      code: "unreachable",
      path: "main.mthds",
    });

    const onTool = classifyError(failure, TREE_SHAPE);
    expect(onTool.location).toBe("files");
    expect(onTool.hint).toContain("the request was not sent");

    expect(classifyError(failure, {}).location).toBe("method_dir");
  });
});

describe("summaryForToolError", () => {
  const summaries: ErrorSummaries = {
    config: "connectivity headline",
    input_domain: "request headline",
    runtime: "server headline",
    paywall: "billing headline",
    auth: "key headline",
    role: "role headline",
  };

  it("maps an untagged error by its class", () => {
    expect(
      summaryForToolError(
        { class: "config", message: "Connection refused", retryable: true },
        summaries,
      ),
    ).toBe("connectivity headline");
  });

  it("prefers the kind headline over the class it refines", () => {
    // The whole point: a 402 is `config` by contract, so a class-first lookup
    // would blame connectivity for a plan limit.
    expect(
      summaryForToolError(
        { class: "config", kind: "paywall", message: "Subscription required", retryable: false },
        summaries,
      ),
    ).toBe("billing headline");
  });

  it("names the key, not connectivity, for a missing or refused key", () => {
    expect(
      summaryForToolError(
        { class: "config", kind: "auth", message: "Missing API key", retryable: false },
        summaries,
      ),
    ).toBe("key headline");
  });

  it("names the role, not the key, for a role refusal", () => {
    expect(
      summaryForToolError(
        {
          class: "config",
          kind: "role",
          message: "Your role in this organization is runner.",
          retryable: false,
        },
        summaries,
      ),
    ).toBe("role headline");
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

    expect(buildArtifactFetchConfig({ [ALLOW_HTTP_ENV]: "true" }).allowHttp).toBe(true);
    expect(buildArtifactFetchConfig({})).not.toHaveProperty("allowHttp");
    expect(buildArtifactFetchConfig({}).baseUrl).toBe(DEFAULT_API_URL);
  });
});

describe("itemToolError", () => {
  it("classifies the SDK's per-item codes and locates each where its caller says", () => {
    expect(
      itemToolError({ code: "not_found", detail: "gone (HTTP 404)." }, "artifacts[1].uri"),
    ).toMatchObject({
      class: "input_domain",
      location: "artifacts[1].uri",
      message: "gone (HTTP 404).",
      retryable: false,
    });
    expect(
      itemToolError({ code: "too_large", detail: "over the cap" }, "artifacts[0].uri"),
    ).toMatchObject({
      class: "input_domain",
      retryable: false,
    });
    expect(
      itemToolError({ code: "forbidden", detail: "another org" }, "artifacts[0].uri"),
    ).toMatchObject({
      class: "input_domain",
      retryable: false,
    });
    for (const code of ["store_refused", "store_error", "timeout", "network", "resolve_failed"]) {
      expect(itemToolError({ code, detail: "x" }, "artifacts[0].uri")).toMatchObject({
        class: "runtime",
        retryable: true,
      });
    }
    expect(
      itemToolError({ code: "write_failed", detail: "EACCES" }, "artifacts[0].uri"),
    ).toMatchObject({
      class: "runtime",
      retryable: false,
    });
  });

  // The locator is a parameter precisely because the table now serves two
  // tools: the download tool locates at `artifacts[i].uri`, mthds_show_images
  // at `images[i].uri`, and everything else about the classification is shared.
  it("carries whichever locator the calling tool names", () => {
    expect(
      itemToolError({ code: "not_found", detail: "gone (HTTP 404)." }, "images[2].uri"),
    ).toMatchObject({
      class: "input_domain",
      location: "images[2].uri",
      message: "gone (HTTP 404).",
    });
  });

  it("points a plain-http refusal at the override instead of the SDK option", () => {
    const error = itemToolError(
      { code: "plain_http_refused", detail: "pass allowHttp: true to accept it" },
      "artifacts[0].uri",
    );

    expect(error.class).toBe("config");
    expect(error.message).not.toContain("allowHttp");
    expect(error.hint).toContain(`${ALLOW_HTTP_ENV}=true`);
  });

  it("reads a code it does not know as a retryable runtime fault", () => {
    expect(
      itemToolError({ code: "something_new", detail: "new failure" }, "artifacts[2].uri"),
    ).toMatchObject({
      class: "runtime",
      location: "artifacts[2].uri",
      message: "new failure",
      retryable: true,
    });
  });

  it("still names a failure when the route sent no detail with it", () => {
    // `detail` is typed but arrives verbatim off the wire, like the code, and
    // `message` is required on both tools' error schemas.
    const missing = itemToolError(
      { code: "not_found", detail: undefined as unknown as string },
      "artifacts[0].uri",
    );
    expect(missing.message).toContain("gave no reason");
    expect(missing.message).toContain("not_found");
    expect(missing.class).toBe("input_domain");

    const blank = itemToolError({ code: "store_refused", detail: "   " }, "artifacts[1].uri");
    expect(blank.message).toContain("gave no reason");
  });

  it("reads a code naming an Object.prototype member as an unknown code, not as its member", () => {
    for (const code of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(itemToolError({ code, detail: "off the wire" }, "artifacts[0].uri")).toMatchObject({
        class: "runtime",
        location: "artifacts[0].uri",
        message: "off the wire",
        retryable: true,
      });
    }
  });
});

describe("the image-candidate prefilter", () => {
  const PICTURE = "pipelex-storage://runs/01JRUN/outputs/illustration.png";
  const REPORT = "pipelex-storage://runs/01JRUN/outputs/report.pdf";
  const UNTYPED = "pipelex-storage://runs/01JRUN/outputs/blob";

  it("reads a reference's storage key as everything after the scheme", () => {
    expect(storageKeyOf(PICTURE)).toBe("runs/01JRUN/outputs/illustration.png");
    // Not a reference at all: answered as-is rather than silently truncated.
    expect(storageKeyOf("illustration.png")).toBe("illustration.png");
  });

  it("takes every known image extension, in any case", () => {
    for (const extension of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".PNG", ".JPeG"]) {
      expect(looksLikeImageKey(`runs/01JRUN/outputs/picture${extension}`)).toBe(true);
    }
  });

  it("takes a key with no extension, because only the fetched type can settle it", () => {
    expect(looksLikeImageKey("runs/01JRUN/outputs/blob")).toBe(true);
    // A leading dot is not an extension.
    expect(looksLikeImageKey("runs/01JRUN/outputs/.hidden")).toBe(true);
  });

  it("refuses an extension that is plainly not an image", () => {
    for (const key of ["out/report.pdf", "out/data.json", "out/notes.txt", "out/logo.svg"]) {
      expect(looksLikeImageKey(key)).toBe(false);
    }
  });

  it("ignores a query- or fragment-looking tail on the key", () => {
    expect(looksLikeImageKey("out/picture.png?v=2")).toBe(true);
    expect(looksLikeImageKey("out/report.pdf?v=2")).toBe(false);
  });

  it("walks a whole output and keeps only the candidates, in discovery order", () => {
    const mainStuff = {
      cover: { url: PICTURE, public_url: "https://store.example/x" },
      attachments: [{ url: REPORT }, { url: UNTYPED }],
    };

    expect(imageCandidatesOf(mainStuff)).toEqual([
      { uri: PICTURE, key: "runs/01JRUN/outputs/illustration.png" },
      { uri: UNTYPED, key: "runs/01JRUN/outputs/blob" },
    ]);
  });

  it("answers nothing for an output that references no stored file", () => {
    expect(imageCandidatesOf({ text: "no files here" })).toEqual([]);
  });
});

describe("blueprintMainPipeRefOf", () => {
  it("qualifies a bare main_pipe with the blueprint's domain", () => {
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "main" })).toBe("demo.main");
  });

  it("leaves an already-qualified main_pipe alone", () => {
    // The regression this function exists to hold: prefixing unconditionally
    // turned a cross-domain main_pipe into `demo.other.shout`, a ref that keys
    // neither pipe_io_contracts nor input_form, so the signature went missing
    // rather than being found.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "other.shout" })).toBe(
      "other.shout",
    );
  });

  it("answers nothing for a blueprint that declares no usable main pipe", () => {
    expect(blueprintMainPipeRefOf({ domain: "demo" })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "" })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: 7 })).toBeUndefined();
    // A bare main_pipe with no domain to qualify it cannot key either map.
    expect(blueprintMainPipeRefOf({ main_pipe: "main" })).toBeUndefined();
  });

  it("trims both members, as the SDK does", () => {
    // Load-bearing, not cosmetic: the SDK reads both through its own
    // `nonEmptyString`, and `mthds_prepare_inputs` delegates to the SDK.
    // Untrimmed, a padded `main_pipe` keyed nothing here and `demo.main` there.
    // Nothing upstream strips it: `DomainBlueprint.main_pipe` is a bare `str`
    // with no validator.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "  main  " })).toBe("demo.main");
    expect(blueprintMainPipeRefOf({ domain: "  demo  ", main_pipe: "main" })).toBe("demo.main");
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "  other.shout  " })).toBe(
      "other.shout",
    );
    // Whitespace-only is still empty, on both members.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "   " })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "   ", main_pipe: "main" })).toBeUndefined();
  });

  it("treats a blueprint that is not an object as declaring nothing", () => {
    for (const blueprint of [undefined, null, "demo.main", 7, ["demo.main"]]) {
      expect(blueprintMainPipeRefOf(blueprint)).toBeUndefined();
    }
  });
});

describe("createPipelexApiClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The `Authorization` header a client built by the factory sends. */
  async function sentAuthorization(apiKey: string | undefined): Promise<string | null> {
    let seen: string | null = null;
    vi.stubGlobal("fetch", (_url: string, init?: { headers?: HeadersInit }) => {
      seen = new Headers(init?.headers).get("authorization");
      return Promise.resolve(Response.json({}));
    });
    await createPipelexApiClient({ baseUrl: "https://api.test", apiKey }).health();
    return seen;
  }

  it("sends the config's key, and no key at all when the config has none", async () => {
    // The SDK falls back to the process's own PIPELEX_API_KEY when it is handed
    // no key, which would put an ambient key on a call the workshop resolved as
    // keyless; the config's key is the whole decision.
    vi.stubEnv("PIPELEX_API_KEY", "plx_sk_ambient");

    expect(await sentAuthorization("plx_sk_config")).toBe("Bearer plx_sk_config");
    expect(await sentAuthorization(undefined)).toBeNull();
  });
});

describe("classifyError with the base URL's source", () => {
  const baseUrlSource = {
    hint: "The PIPELEX_BASE_URL in use was read from `~/.pipelex/.env` beside the saved key.",
  };

  /** What the SDK throws building a client on a base URL carrying a path: the generic `config` arm. */
  function refusedBaseUrl(): unknown {
    try {
      createPipelexApiClient({ baseUrl: `${DEFAULT_API_URL}/v1` });
    } catch (err) {
      return err;
    }
    throw new Error("the client took a base URL carrying a path");
  }

  it("adds the source to the unreachable API's hint, and only when the call carries one", async () => {
    const unreachableHint =
      "Start pipelex-api locally or set PIPELEX_BASE_URL to a reachable host-only API base URL.";
    const err = await unreachable("ECONNREFUSED");

    expect(classifyError(err)).toMatchObject({
      location: "PIPELEX_BASE_URL",
      hint: unreachableHint,
    });
    expect(classifyError(err, { baseUrlSource })).toEqual({
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: expect.any(String),
      hint: `${unreachableHint} ${baseUrlSource.hint}`,
      retryable: true,
    });
  });

  it("adds the source to the generic config arm a refused base URL falls to", () => {
    const err = refusedBaseUrl();
    expect(err).toBeInstanceOf(RequestArgumentError);

    expect(classifyError(err)).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      hint: "Check PIPELEX_BASE_URL and the submitted request.",
    });
    expect(classifyError(err, { baseUrlSource })).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      hint: `Check PIPELEX_BASE_URL and the submitted request. ${baseUrlSource.hint}`,
    });
  });

  it("adds the source to a missing or unimplemented route", async () => {
    const missing = classifyError(await refused(404, { detail: "Not Found" }), {
      route: "/v1/methods/{id}",
      baseUrlSource,
    });
    expect(missing).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      hint: `Check that PIPELEX_BASE_URL points to a host serving /v1/methods/{id}. ${baseUrlSource.hint}`,
    });

    const unimplemented = classifyError(await refused(501, { detail: "Not Implemented" }), {
      route: "/v1/methods/{id}",
      baseUrlSource,
    });
    expect(unimplemented).toMatchObject({
      location: "PIPELEX_BASE_URL",
      hint: `The deployment PIPELEX_BASE_URL points at does not implement /v1/methods/{id}. ${baseUrlSource.hint}`,
    });
  });

  it("adds the source once to a wrapped unreachable API on the upload leg", async () => {
    const err = await uploadFailure(() =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
        }),
      ),
    );
    expect(err).toBeInstanceOf(UploadTransportError);

    const hint = classifyError(err, { baseUrlSource }).hint ?? "";
    expect(hint.split(baseUrlSource.hint)).toHaveLength(2);
    expect(hint.endsWith(baseUrlSource.hint)).toBe(true);
  });

  it("leaves every failure the base URL cannot fix as it is", async () => {
    const failures = [
      await refused(401, { detail: "Missing API key" }),
      await refused(500, { detail: "Server fault" }),
      new ApiUnreachableError("no answer in time", DEFAULT_API_URL, "ABORT_TIMEOUT"),
      new RequestArgumentError("No run source given."),
    ];

    for (const err of failures) {
      expect(classifyError(err, { baseUrlSource })).toEqual(classifyError(err));
    }
  });
});
