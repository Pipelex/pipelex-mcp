import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type { CodegenRequest, CodegenResponse, CodegenValidReport } from "@pipelex/sdk";

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

  it("withholds whole files in order from the first that does not fit", () => {
    // Enough for types.ts alone: binder.ts does not fit, and once the walk has
    // stopped the lock is withheld too even though it would fit on its own — a
    // lock without its artifacts is no more useful than none.
    const cap = bytesOf(TS_TYPES) + bytesOf(TS_BINDER) - 1;

    const bounded = boundArtifacts(validTsReport, cap);

    expect(bounded.truncated).toBe(true);
    expect(bounded.artifacts).toEqual([
      { path: "types.ts", bytes: bytesOf(TS_TYPES), content: TS_TYPES },
      { path: "binder.ts", bytes: bytesOf(TS_BINDER) },
    ]);
    expect(bounded.lock).toEqual({ filename: "codegen.lock", bytes: bytesOf(LOCK) });
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
    expect(result.summary).toContain("- `codegen.lock` (");
    expect(result.summary).toContain("pipelex codegen types");
    expect(result.summary).not.toContain(huge);
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
            return validTsReport;
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
            return validPyReport;
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
            return { ...validPyReport, target: "python-structures" };
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
            return { ...validTsReport, lock: undefined } as unknown as CodegenResponse;
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
            return validTsReport;
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
