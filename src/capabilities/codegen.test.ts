import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type { CodegenRequest, CodegenResponse, CodegenValidReport } from "@pipelex/sdk";

import { recordedTsZodReport } from "./codegen-fixture.js";
import {
  CODEGEN_CONTENT_CAP,
  CODEGEN_TARGETS,
  boundArtifacts,
  codegenResult,
  codegenToolResult,
  fenced,
  generateMthdsCode,
} from "./codegen.js";
import { DEFAULT_API_URL } from "./shared.js";

/**
 * A REAL engine response, recorded from a live `ts-zod` call — the only kind
 * that survives the preflight, which runs the SDK's own hash-verifying check
 * over the response before anything is written or relayed. The synthetic
 * reports below stay for the PURE projection tests (`codegenResult`,
 * `boundArtifacts`), where controlled byte sizes are the point and no
 * preflight runs.
 */
const recordedReport = await recordedTsZodReport();

const TS_TYPES = [
  "// >>> pipelex-codegen-stamp >>>",
  '// crate_fingerprint = "crate-abc"',
  "// <<< pipelex-codegen-stamp <<<",
  'import { z } from "zod";',
  "export const Topic = z.object({ topic_text: z.string() });",
  "",
].join("\n");

const TS_BINDER = [
  "// >>> pipelex-codegen-stamp >>>",
  "// <<< pipelex-codegen-stamp <<<",
  "export function parseTopic(value: unknown) {",
  "  return value;",
  "}",
  "",
].join("\n");

const PY_MODELS = [
  "# >>> pipelex-codegen-stamp >>>",
  "# <<< pipelex-codegen-stamp <<<",
  "from pydantic import BaseModel",
  "",
  "class Topic(BaseModel):",
  "    topic_text: str",
  "",
].join("\n");

const LOCK = [
  "lock_version = 1",
  'crate_fingerprint = "crate-abc"',
  'engine_version = "0.20.0"',
  "",
  "[[artifacts]]",
  'path = "types.ts"',
  "",
].join("\n");

const validTsReport: CodegenValidReport = {
  is_valid: true,
  kind: "types",
  target: "ts-zod",
  crate_fingerprint: "crate-abc",
  engine_version: "0.20.0",
  artifacts: [
    { path: "types.ts", content: TS_TYPES },
    { path: "binder.ts", content: TS_BINDER },
  ],
  lock: LOCK,
  lock_filename: "codegen.lock",
  message: "Generated 2 artifact(s) for ts-zod.",
};

const validPyReport: CodegenValidReport = {
  ...validTsReport,
  target: "python-pydantic",
  artifacts: [{ path: "models.py", content: PY_MODELS }],
  message: "Generated 1 artifact(s) for python-pydantic.",
};

const invalidReport: CodegenResponse = {
  is_valid: false,
  message: "The closure did not resolve.",
  validation_errors: [
    {
      category: "blueprint_validation",
      message: "Unknown pipe type",
      source: "bundle.mthds",
    },
  ],
};

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-codegen-capability-"));
  tempDirs.push(dir);
  return dir;
}

/** A workshop context whose write root is a real temp directory — no writer fake. */
function workshopContext(saveRoot: string, response: CodegenResponse = recordedReport) {
  return {
    baseUrl: DEFAULT_API_URL,
    saveRoot,
    client: {
      async codegen(): Promise<CodegenResponse> {
        return response;
      },
    },
  };
}

/** Fake codegen arm for tests whose request must never reach the route. */
const codegenNotCalled = {
  async codegen(): Promise<CodegenResponse> {
    throw new Error("codegen must not be called in this test");
  },
};

function responseError(status: number, errorType = "error"): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/codegen`,
    status,
    "status text",
    "{}",
    errorType,
    `Server said ${status}`,
    undefined,
    undefined,
  );
}

describe("codegenResult", () => {
  it("projects a ts-zod report with both artifacts, the lock, and verbatim content", () => {
    const result = codegenResult(validTsReport);

    expect(result.structuredContent).toEqual({
      status: "ok",
      is_valid: true,
      target: "ts-zod",
      kind: "types",
      crate_fingerprint: "crate-abc",
      engine_version: "0.20.0",
      artifacts: [
        { path: "types.ts", bytes: bytesOf(TS_TYPES), content: TS_TYPES },
        { path: "binder.ts", bytes: bytesOf(TS_BINDER), content: TS_BINDER },
      ],
      lock: { filename: "codegen.lock", bytes: bytesOf(LOCK), content: LOCK },
      truncated: false,
    });

    // The summary deliberately duplicates the artifacts: they are the payload
    // the model must write out, and it tags each block for its language.
    expect(result.summary).toContain("# Generated code — ts-zod");
    expect(result.summary).toContain("Generated 2 artifact(s) for ts-zod.");
    expect(result.summary).toContain("crate fingerprint `crate-abc`");
    expect(result.summary).toContain("## `types.ts` (");
    expect(result.summary).toContain("## `binder.ts` (");
    expect(result.summary).toContain("## `codegen.lock` (");
    expect(result.summary).toContain("```ts\n" + TS_TYPES + "```");
    expect(result.summary).toContain("```toml\n" + LOCK + "```");
    expect(result.summary).toContain("VERBATIM");
    expect(result.summary).not.toContain("Withheld for size");
  });

  it("tags a Python artifact's block as python", () => {
    const result = codegenResult(validPyReport);

    expect(result.structuredContent.target).toBe("python-pydantic");
    expect(result.structuredContent.artifacts).toHaveLength(1);
    expect(result.summary).toContain("```python\n" + PY_MODELS + "```");
  });

  it("counts bytes in UTF-8, not code units", () => {
    const report: CodegenValidReport = {
      ...validPyReport,
      artifacts: [{ path: "models.py", content: "# é\n" }],
    };

    const result = codegenResult(report);

    expect(result.structuredContent.artifacts?.[0]?.bytes).toBe(5);
  });

  it("projects invalid produced verdicts as ok with validation errors", () => {
    const result = codegenResult(invalidReport);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.validation_errors).toEqual(
      (invalidReport as { validation_errors: unknown[] }).validation_errors,
    );
    expect(result.structuredContent).not.toHaveProperty("artifacts");
    expect(result.structuredContent).not.toHaveProperty("lock");
    expect(result.structuredContent).not.toHaveProperty("truncated");
    expect(result.summary).toContain("Code not generated");
    expect(result.summary).toContain("Unknown pipe type");
    expect(result.summary).toContain("bundle.mthds");
  });

  it("throws when the valid arm is missing its artifacts", () => {
    const malformed = { ...validTsReport, artifacts: undefined } as unknown as CodegenResponse;

    expect(() => codegenResult(malformed)).toThrow(/well-formed artifacts list/);
  });

  it("throws when the valid arm is missing its lock", () => {
    const malformed = { ...validTsReport, lock: undefined } as unknown as CodegenResponse;

    expect(() => codegenResult(malformed)).toThrow(/lock content/);
  });

  it("throws when an artifact has no content", () => {
    const malformed = {
      ...validTsReport,
      artifacts: [{ path: "types.ts" }],
    } as unknown as CodegenResponse;

    expect(() => codegenResult(malformed)).toThrow(/well-formed artifacts list/);
  });
});

describe("boundArtifacts", () => {
  it("includes everything when the set fits the cap exactly", () => {
    const total = bytesOf(TS_TYPES) + bytesOf(TS_BINDER) + bytesOf(LOCK);

    const bounded = boundArtifacts(validTsReport, total);

    expect(bounded.truncated).toBe(false);
    expect(bounded.artifacts.every((artifact) => artifact.content !== undefined)).toBe(true);
    expect(bounded.lock.content).toBe(LOCK);
  });

  it("withholds whole files in order from the first that does not fit, keeping the lock", () => {
    // The lock's bytes are reserved off the top, so what remains fits types.ts
    // and not binder.ts. The trust anchor rides even though the code it
    // anchors does not: code the model cannot check is the wrong casualty.
    const cap = bytesOf(LOCK) + bytesOf(TS_TYPES) + bytesOf(TS_BINDER) - 1;

    const bounded = boundArtifacts(validTsReport, cap);

    expect(bounded.truncated).toBe(true);
    expect(bounded.artifacts).toEqual([
      { path: "types.ts", bytes: bytesOf(TS_TYPES), content: TS_TYPES },
      { path: "binder.ts", bytes: bytesOf(TS_BINDER) },
    ]);
    expect(bounded.lock).toEqual({
      filename: "codegen.lock",
      bytes: bytesOf(LOCK),
      content: LOCK,
    });
  });

  it("keeps the lock's content when the artifacts alone exceed the cap", () => {
    const bounded = boundArtifacts(validTsReport, bytesOf(LOCK) + 1);

    expect(bounded.truncated).toBe(true);
    expect(bounded.artifacts.every((artifact) => artifact.content === undefined)).toBe(true);
    expect(bounded.lock.content).toBe(LOCK);
  });

  it("reports truncated, and withholds everything, when the lock alone exceeds the cap", () => {
    const bounded = boundArtifacts(validTsReport, bytesOf(LOCK) - 1);

    expect(bounded.truncated).toBe(true);
    expect(bounded.lock.content).toBeUndefined();
    expect(bounded.artifacts.every((artifact) => artifact.content === undefined)).toBe(true);
  });

  it("never cuts a file: an artifact larger than the cap is withheld entirely", () => {
    const bounded = boundArtifacts(validTsReport, 10);

    expect(bounded.truncated).toBe(true);
    expect(bounded.artifacts.every((artifact) => artifact.content === undefined)).toBe(true);
    expect(bounded.lock.content).toBeUndefined();
  });

  it("defaults to the documented cap, which the ordinary case never reaches", () => {
    expect(CODEGEN_CONTENT_CAP).toBe(64 * 1024);
    expect(boundArtifacts(validTsReport).truncated).toBe(false);
  });
});

describe("a truncated result's summary", () => {
  it("names the withheld files with their sizes and points at the CLI, without their content", () => {
    const huge = "x".repeat(CODEGEN_CONTENT_CAP);
    const report: CodegenValidReport = {
      ...validTsReport,
      artifacts: [
        { path: "types.ts", content: TS_TYPES },
        { path: "binder.ts", content: huge },
      ],
    };

    const result = codegenResult(report);

    expect(result.structuredContent.truncated).toBe(true);
    expect(result.structuredContent.artifacts?.[0]?.content).toBe(TS_TYPES);
    expect(result.structuredContent.artifacts?.[1]).toEqual({
      path: "binder.ts",
      bytes: CODEGEN_CONTENT_CAP,
    });
    expect(result.summary).toContain("## Withheld for size");
    expect(result.summary).toContain(`- \`binder.ts\` (${CODEGEN_CONTENT_CAP} bytes)`);
    // The lock rides: it is reserved off the top, so it is never the casualty.
    expect(result.structuredContent.lock?.content).toBe(LOCK);
    expect(result.summary).not.toContain("- `codegen.lock` (");
    expect(result.summary).toContain("pipelex codegen types");
    expect(result.summary).not.toContain(huge);
  });

  it("offers the write arm only on a shell that can write", () => {
    const huge = "x".repeat(CODEGEN_CONTENT_CAP);
    const report: CodegenValidReport = {
      ...validTsReport,
      artifacts: [{ path: "types.ts", content: huge }],
    };

    expect(codegenResult(report, undefined, true).summary).toContain(
      "Pass `output_dir` to write the tree to disk instead",
    );
    expect(codegenResult(report, undefined, false).summary).not.toContain("output_dir");
  });
});

describe("fenced", () => {
  it("opens a three-backtick block tagged with the language and closes after one newline", () => {
    expect(fenced("a\n", "ts")).toBe("```ts\na\n```");
    expect(fenced("a", "ts")).toBe("```ts\na\n```");
  });

  it("grows the fence past the longest backtick run inside the content", () => {
    const content = "const s = ```;\n";

    expect(fenced(content, "ts")).toBe("````ts\n" + content + "````");
  });
});

describe("codegenToolResult", () => {
  it("carries the summary as content with no _meta channel", () => {
    const result = codegenToolResult(codegenResult(validTsReport));

    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: codegenResult(validTsReport).summary }]);
    expect(result.isError).toBe(false);
    expect(result).not.toHaveProperty("_meta");
  });

  it("flags no-verdict results as errors", () => {
    const result = codegenToolResult({
      structuredContent: { status: "error", is_valid: false, errors: [] },
      summary: "failed",
    });

    expect(result.isError).toBe(true);
  });
});

describe("generateMthdsCode request mapping", () => {
  it("sends the files selector with kind types, the target, and no pipe_ref key", async () => {
    let captured: CodegenRequest | undefined;

    const result = await generateMthdsCode(
      {
        files: [
          { content: 'domain = "demo"', uri: "bundle.mthds" },
          { content: 'main_pipe = "main"', uri: null },
        ],
        target: "ts-zod",
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async codegen(request) {
            captured = request;
            return recordedReport;
          },
        },
      },
    );

    // The MCP surface spells provenance `uri`; the crate envelope spells it
    // `source`. `pipe_ref` must be ABSENT — the route rejects it on `types`.
    expect(captured).toEqual({
      files: [
        { content: 'domain = "demo"', source: "bundle.mthds" },
        { content: 'main_pipe = "main"' },
      ],
      kind: "types",
      target: "ts-zod",
    });
    expect(captured).not.toHaveProperty("pipe_ref");
    expect(captured).not.toHaveProperty("method_ref");
    expect(captured).not.toHaveProperty("method_id");
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
  });

  it("forwards method_ref as a server pass-through with no files key", async () => {
    let captured: CodegenRequest | undefined;

    await generateMthdsCode(
      { method_ref: "github.com/Pipelex/methods/documents@v0.1.0", target: "python-pydantic" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async codegen(request) {
            captured = request;
            return recordedReport;
          },
        },
      },
    );

    expect(captured).toEqual({
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      kind: "types",
      target: "python-pydantic",
    });
    expect(captured).not.toHaveProperty("files");
  });

  it("forwards method_id as a server pass-through with no files key", async () => {
    let captured: CodegenRequest | undefined;

    await generateMthdsCode(
      { method_id: "mt_123", target: "python-structures" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async codegen(request) {
            captured = request;
            return recordedReport;
          },
        },
      },
    );

    expect(captured).toEqual({ method_id: "mt_123", kind: "types", target: "python-structures" });
    expect(captured).not.toHaveProperty("files");
  });

  it("rejects a request with no selector without calling the route", async () => {
    const result = await generateMthdsCode(
      { target: "ts-zod" },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.map((error) => error.location)).toEqual(["files"]);
    expect(result.summary).toContain("request input is invalid");
  });

  it("rejects files beside method_id (one_selector) without calling the route", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_123", target: "ts-zod" },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.map((error) => error.location)).toEqual(["method_id"]);
  });

  it("rejects method_ref beside method_id without calling the route", async () => {
    const result = await generateMthdsCode(
      {
        method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
        method_id: "mt_123",
        target: "ts-zod",
      },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.map((error) => error.location)).toEqual(["method_id"]);
  });
});

describe("generateMthdsCode error classification", () => {
  const files = [{ content: 'domain = "demo"' }];

  async function classify(input: Parameters<typeof generateMthdsCode>[0], err: unknown) {
    const result = await generateMthdsCode(input, {
      baseUrl: DEFAULT_API_URL,
      client: {
        async codegen() {
          throw err;
        },
      },
    });
    expect(result.structuredContent.status).toBe("error");
    return { error: result.structuredContent.errors?.[0], summary: result.summary };
  }

  it("locates a 422 on a files request at target, naming the targets", async () => {
    const { error, summary } = await classify({ files, target: "ts-zod" }, responseError(422));

    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("target");
    for (const target of CODEGEN_TARGETS) {
      expect(error?.hint).toContain(target);
    }
    expect(error?.retryable).toBe(false);
    expect(summary).toContain("the Pipelex API rejected the request");
  });

  it("locates a 422, a 404 and a 501 on a by-ref request at method_ref", async () => {
    const ref = "github.com/Pipelex/methods/documents@v0.1.0";

    const rejected = await classify({ method_ref: ref, target: "ts-zod" }, responseError(422));
    expect(rejected.error?.class).toBe("input_domain");
    expect(rejected.error?.location).toBe("method_ref");

    const missing = await classify({ method_ref: ref, target: "ts-zod" }, responseError(404));
    expect(missing.error?.class).toBe("input_domain");
    expect(missing.error?.location).toBe("method_ref");
    expect(missing.error?.hint).toContain("METHODS.toml");

    const reserved = await classify({ method_ref: ref, target: "ts-zod" }, responseError(501));
    expect(reserved.error?.class).toBe("input_domain");
    expect(reserved.error?.location).toBe("method_ref");
    expect(reserved.error?.hint).toContain("registry references are reserved");
  });

  it("locates a 422 and a 404 on a by-id request at method_id", async () => {
    const rejected = await classify({ method_id: "mt_123", target: "ts-zod" }, responseError(422));
    expect(rejected.error?.class).toBe("input_domain");
    expect(rejected.error?.location).toBe("method_id");
    expect(rejected.error?.hint).toContain("/v1/codegen");

    const missing = await classify({ method_id: "mt_123", target: "ts-zod" }, responseError(404));
    expect(missing.error?.class).toBe("input_domain");
    expect(missing.error?.location).toBe("method_id");
    expect(missing.error?.hint).toContain("org-scoped");
  });

  it("keeps a 404 on a files request as config at PIPELEX_BASE_URL (the route is missing)", async () => {
    const { error } = await classify({ files, target: "ts-zod" }, responseError(404));

    expect(error?.class).toBe("config");
    expect(error?.location).toBe("PIPELEX_BASE_URL");
    expect(error?.hint).toContain("/v1/codegen");
  });

  it("tells a 403 caller about the feature-flag gate, on top of the deployment's auth wording", async () => {
    const { error } = await classify({ files, target: "ts-zod" }, responseError(403));

    expect(error?.class).toBe("config");
    expect(error?.location).toBe("PIPELEX_API_KEY");
    expect(error?.hint).toContain("Check PIPELEX_API_KEY");
    expect(error?.hint).toContain("feature flags");
    expect(error?.retryable).toBe(false);
  });

  it("composes the console's sign-in-again wording with the gate on a 403", async () => {
    const result = await generateMthdsCode(
      { files, target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        authError: { location: "authorization", hint: "Reconnect and sign in again." },
        client: {
          async codegen() {
            throw responseError(403);
          },
        },
      },
    );

    const error = result.structuredContent.errors?.[0];
    expect(error?.location).toBe("authorization");
    expect(error?.hint).toContain("Reconnect and sign in again.");
    expect(error?.hint).toContain("feature flags");
  });

  it("keeps a 401 on the plain auth wording — a rejected credential is not a gate", async () => {
    const { error } = await classify({ files, target: "ts-zod" }, responseError(401));

    expect(error?.class).toBe("config");
    expect(error?.location).toBe("PIPELEX_API_KEY");
    expect(error?.hint).not.toContain("feature flags");
  });

  it("classifies a 402 as a paywall with its own headline", async () => {
    const { error, summary } = await classify({ files, target: "ts-zod" }, responseError(402));

    expect(error?.class).toBe("config");
    expect(error?.kind).toBe("paywall");
    expect(summary).toContain("plan does not cover this call");
    expect(summary).not.toContain("unreachable");
  });

  it("classifies an unreachable API as retryable config", async () => {
    const { error, summary } = await classify(
      { files, target: "ts-zod" },
      new ApiUnreachableError("connection refused", "http://localhost:8081", "ECONNREFUSED"),
    );

    expect(error?.class).toBe("config");
    expect(error?.location).toBe("PIPELEX_BASE_URL");
    expect(error?.retryable).toBe(true);
    expect(summary).toContain("unreachable or misconfigured");
  });

  it("classifies a 5xx as retryable runtime", async () => {
    const { error, summary } = await classify({ files, target: "ts-zod" }, responseError(503));

    expect(error?.class).toBe("runtime");
    expect(error?.retryable).toBe(true);
    expect(summary).toContain("returned an error");
  });

  it("classifies a malformed base URL as config instead of rejecting the handler", async () => {
    const result = await generateMthdsCode({ files, target: "ts-zod" }, { baseUrl: "not a url" });

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
  });

  it("treats a reachable but malformed report as runtime, not unreachable", async () => {
    const result = await generateMthdsCode(
      { files, target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async codegen() {
            return { ...recordedReport, lock: undefined } as unknown as CodegenResponse;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("runtime");
    expect(error?.retryable).toBe(false);
    expect(error?.message).toContain("lock content");
    expect(result.summary).toContain("malformed report");
  });
});

describe("generateMthdsCode path submissions", () => {
  it("resolves { path } items through the context resolver, with the path as source", async () => {
    let captured: CodegenRequest | undefined;

    const result = await generateMthdsCode(
      { files: [{ path: "bundle.mthds" }], target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: {
          async resolve(path) {
            return { ok: true, content: `# from ${path}\ndomain = "demo"` };
          },
        },
        client: {
          async codegen(request) {
            captured = request;
            return recordedReport;
          },
        },
      },
    );

    expect(captured?.files).toEqual([
      { content: '# from bundle.mthds\ndomain = "demo"', source: "bundle.mthds" },
    ]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    const result = await generateMthdsCode(
      { files: [{ path: "bundle.mthds" }], target: "ts-zod" },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("files[0].path");
    expect(error?.hint).toContain("npx @pipelex/mcp");
  });
});

describe("generateMthdsCode write arm", () => {
  it("writes the tree and withholds every byte from both streams", async () => {
    const root = await makeTempDir();

    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "src/generated" },
      workshopContext(root),
    );

    const content = result.structuredContent;
    expect(content.status).toBe("ok");
    expect(content.is_valid).toBe(true);
    expect(content.output_dir).toBe(path.join("src", "generated"));
    expect(content.is_current).toBe(true);
    expect(content.orphans).toEqual([]);
    expect(content.orphans_truncated).toBeUndefined();
    expect(content.drifts).toBeUndefined();
    // `output_dir`'s presence is the arm discriminator, and `truncated` is
    // always false there — nothing rode, so nothing was withheld for size.
    expect(content.truncated).toBe(false);
    expect(content.artifacts?.every((artifact) => artifact.content === undefined)).toBe(true);
    expect(content.artifacts?.every((artifact) => artifact.written_to !== undefined)).toBe(true);
    expect(content.lock?.content).toBeUndefined();
    expect(content.lock?.written_to).toBe(path.join("src", "generated", "codegen.lock"));

    // The summary carries no fenced block and no content either.
    expect(result.summary).not.toContain("```");
    expect(result.summary).toContain("Written under");
    expect(result.summary).toContain("**current**");
    expect(result.summary).not.toContain(recordedReport.artifacts[0]!.content);

    // The bytes are on disk, verbatim.
    for (const artifact of recordedReport.artifacts) {
      expect(await fs.readFile(path.join(root, "src/generated", artifact.path), "utf8")).toBe(
        artifact.content,
      );
    }
  });

  it("reports orphans in the summary and never deletes them", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    const stale = path.join(dir, "structures.py");
    await fs.writeFile(
      stale,
      ["# >>> pipelex-codegen-stamp >>>", "# <<< pipelex-codegen-stamp <<<", ""].join("\n"),
      "utf8",
    );

    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      workshopContext(root),
    );

    expect(result.structuredContent.is_current).toBe(false);
    expect(result.structuredContent.orphans).toEqual(["structures.py"]);
    expect(result.summary).toContain("not current");
    expect(result.summary).toContain("never deletes");
    expect(await fs.stat(stale)).toBeDefined();
  });

  it("refuses a blank output_dir without calling the route", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "  " },
      { baseUrl: DEFAULT_API_URL, saveRoot: "/tmp", client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "output_dir",
    });
  });

  it("refuses output_dir on a shell with no write root, naming the workshop", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.location).toBe("output_dir");
    expect(error?.hint).toContain("npx @pipelex/mcp");
  });

  it("refuses an absolute output_dir without calling the route", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "/etc/pipelex" },
      { baseUrl: DEFAULT_API_URL, saveRoot: "/tmp", client: codegenNotCalled },
    );

    expect(result.structuredContent.errors?.[0]?.location).toBe("output_dir");
  });

  it("returns a no-verdict error on a refused write, never a fallback to riding the content", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "generated");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, recordedReport.artifacts[0]!.path),
      "export const mine = 1;\n",
      "utf8",
    );

    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      workshopContext(root),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("output_dir");
    // The caller asked for a write and none happened; inlining tens of
    // kilobytes they did not ask for would change the shape they expected.
    expect(result.structuredContent.artifacts).toBeUndefined();
  });

  it("touches no disk at all on a produced-invalid verdict, even with output_dir", async () => {
    const root = await makeTempDir();

    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      workshopContext(root, invalidReport),
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.output_dir).toBeUndefined();
    // Not even the directory: an invalid verdict returns before the write arm.
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a lock that tracks a file the response does not carry, before anything is written", async () => {
    const root = await makeTempDir();
    // A lock that tracks a file the response does not carry: the check reports
    // it `missing`, which is a writer defect and must never vanish behind a
    // bare `is_current: false`.
    const drifting: CodegenResponse = {
      ...recordedReport,
      lock:
        recordedReport.lock +
        '\n[[artifacts]]\npath = "extra.ts"\ncontent_hash = "' +
        "0".repeat(64) +
        '"\n',
    };

    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      workshopContext(root, drifting),
    );

    // The preflight catches it first: a lock that disagrees with its artifacts
    // is a contract violation, and nothing reaches disk.
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("the written arm's drift projection", () => {
  // A non-orphan drift after a successful write can only mean the writer
  // itself is broken, so it cannot be produced through the capability — the
  // preflight refuses a disagreeing response before the write. What must not
  // regress is the PROJECTION: an earlier draft computed drifts and dropped
  // them, leaving `is_current: false` with nothing anywhere saying why.
  const written = {
    ok: true as const,
    dir: "generated",
    written: [{ path: "types.ts", bytes: 10, writtenTo: "generated/types.ts" }],
    lock: { filename: "codegen.lock", bytes: 5, writtenTo: "generated/codegen.lock" },
    isCurrent: false,
    orphans: [],
    orphansTruncated: false,
    drifts: [{ path: "types.ts", category: "modified" as const, detail: "content hash mismatch" }],
  };

  it("carries a non-orphan drift into structuredContent and the summary", () => {
    const result = codegenResult(validTsReport, written);

    expect(result.structuredContent.drifts).toEqual(written.drifts);
    expect(result.summary).toContain("Unexpected drift");
    expect(result.summary).toContain("content hash mismatch");
  });

  it("says orphan detection was partial when a walk bound tripped", () => {
    const result = codegenResult(validTsReport, {
      ...written,
      isCurrent: true,
      drifts: [],
      orphansTruncated: true,
    });

    expect(result.structuredContent.orphans_truncated).toBe(true);
    expect(result.summary).toContain("partial");
  });
});

describe("generateMthdsCode report-shape rules", () => {
  it("refuses a lock filename that is not bare, on the riding arm too", async () => {
    for (const lockFilename of ["../codegen.lock", "nested/codegen.lock", ".codegen.lock"]) {
      const result = await generateMthdsCode(
        { files: [{ content: 'domain = "demo"' }], target: "ts-zod" },
        {
          baseUrl: DEFAULT_API_URL,
          client: {
            async codegen(): Promise<CodegenResponse> {
              return { ...recordedReport, lock_filename: lockFilename };
            },
          },
        },
      );

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
      expect(result.structuredContent.errors?.[0]?.message).toContain("bare filename");
    }
  });

  it("refuses a response whose lock and artifacts disagree, before anything is written", async () => {
    const root = await makeTempDir();
    const tampered: CodegenResponse = {
      ...recordedReport,
      artifacts: recordedReport.artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, content: artifact.content + "// tampered\n" } : artifact,
      ),
    };

    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      workshopContext(root, tampered),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.structuredContent.errors?.[0]?.message).toContain("offline check");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses an artifact path the offline check cannot verify", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async codegen(): Promise<CodegenResponse> {
            return {
              ...recordedReport,
              artifacts: [{ path: "types.rb", content: "# nope\n" }],
            };
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.message).toContain("types.rb");
  });
});
