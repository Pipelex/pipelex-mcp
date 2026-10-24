import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  RequestArgumentError,
  buildProblem,
} from "@pipelex/sdk";
import type { CodegenRequest, CodegenResponse, CodegenValidReport } from "@pipelex/sdk";

import { resolveWorkshopCredentials } from "../credentials.js";
import { recordedTsZodReport } from "./codegen-fixture.js";
import {
  CODEGEN_CONTENT_CAP,
  boundArtifacts,
  codegenResult,
  codegenToolResult,
  fenced,
  generateMthdsCode,
} from "./codegen.js";
import { comparableRequest, contentsOf, fakeMethodResolver } from "./method-tree-fixtures.js";
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
  errors: [
    {
      code: "method.pipe_type_invalid",
      detail: "Pipe 'summarize' has no usable type (reason: Unknown pipe type).",
      params: { pipe: "summarize", reason: "Unknown pipe type" },
      location: { pipe: "summarize", file: "bundle.mthds" },
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

/** An answer whose body is no problem document: the SDK reads its status alone. */
function responseError(status: number): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/codegen`,
    status,
    "status text",
    "{}",
  );
}

/** A refusal as the hosted API answers it: a problem document, read by the SDK as it came. */
function problemAnswer(status: number, problem: Record<string, unknown>): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/codegen`,
    status,
    "status text",
    JSON.stringify(problem),
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

  it("projects invalid produced verdicts as ok with their problem items", () => {
    const result = codegenResult(invalidReport);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.errors).toEqual(
      (invalidReport as { errors: unknown[] }).errors,
    );
    expect(result.structuredContent).not.toHaveProperty("problem");
    expect(result.structuredContent).not.toHaveProperty("artifacts");
    expect(result.structuredContent).not.toHaveProperty("lock");
    expect(result.structuredContent).not.toHaveProperty("truncated");
    expect(result.summary).toContain("Code not generated");
    expect(result.summary).toContain("method.pipe_type_invalid");
    expect(result.summary).toContain("Unknown pipe type");
    expect(result.summary).toContain("file 'bundle.mthds'");
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
      structuredContent: {
        status: "error",
        is_valid: false,
        problem: buildProblem("runtime.unexpected", {}),
      },
      summary: "failed",
    });

    expect(result.isError).toBe(true);
  });
});

describe("generateMthdsCode request mapping", () => {
  it("sends the files as one tree with kind types, the target, and no pipe_ref key", async () => {
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

    // The first file under its uri's name, the second under the next free
    // one. `pipe_ref` must be ABSENT — the route rejects it on `types`.
    expect(await comparableRequest(captured)).toEqual({
      tree: { "bundle.mthds": 'domain = "demo"', "bundle-2.mthds": 'main_pipe = "main"' },
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

  it("sends @draft as given and says it read the draft", async () => {
    let captured: CodegenRequest | undefined;

    const result = await generateMthdsCode(
      { method_id: "mt_123@draft", target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async codegen(request) {
            captured = request;
            return recordedReport;
          },
          async version() {
            return { version: "1.0.0", extensions: ["runs"] };
          },
        },
      },
    );

    expect(captured).toMatchObject({ method_id: "mt_123@draft" });
    expect(result.structuredContent.method_version).toBe("draft");
    expect(result.summary).toContain("generated code from the draft of `mt_123`");
  });

  it("rejects a request with no selector without calling the route", async () => {
    const result = await generateMthdsCode(
      { target: "ts-zod" },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files", reason: "missing" },
      location: { field: "files" },
    });
    expect(result.summary).toContain("## An argument was refused before sending");
    expect(result.summary).toContain("Provide a method folder");
  });

  it("rejects files beside method_id (one_selector) without calling the route", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_123", target: "ts-zod" },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_id", reason: "mutually_exclusive" },
      location: { field: "method_id" },
    });
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
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_id", reason: "mutually_exclusive" },
      location: { field: "method_id" },
    });
  });
});

describe("generateMthdsCode problems", () => {
  const files = [{ content: 'domain = "demo"' }];

  async function failWith(
    input: Parameters<typeof generateMthdsCode>[0],
    err: unknown,
    extra: { apiNotes?: { apiKey?: string; baseUrl?: string } } = {},
  ) {
    const result = await generateMthdsCode(input, {
      baseUrl: DEFAULT_API_URL,
      ...extra,
      client: {
        async codegen() {
          throw err;
        },
      },
    });
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent).not.toHaveProperty("errors");
    return { problem: result.structuredContent.problem, summary: result.summary };
  }

  it("relays the API's problem for a refused request, and renders it whole", async () => {
    const answered = {
      type: "https://mthds.ai/errors/request.invalid",
      title: "The request does not match the route's schema",
      status: 422,
      detail: "The request's field 'target' does not match the route's schema.",
      code: "request.invalid",
      domain: "input",
      retry: "no",
      next_step: { kind: "change_input", detail: "Correct the field 'target', then try again." },
      params: { field: "target" },
      location: { field: "target" },
      request_id: "req_codegen_422",
    };

    const { problem, summary } = await failWith(
      { files, target: "ts-zod" },
      problemAnswer(422, answered),
    );

    // Whatever named the method, the API's problem is the caller's, as it came.
    expect(problem).toEqual(answered);
    expect(summary).toContain(`## ${answered.title}`);
    expect(summary).toContain(answered.detail);
    expect(summary).toContain(`**Next step** (\`change_input\`): ${answered.next_step.detail}`);
    expect(summary).toContain("`request.invalid`");
    expect(summary).toContain("Request id: `req_codegen_422`");
    expect(summary).toContain("field 'target'");
  });

  it("relays a by-ref and a by-id refusal unchanged, whatever selector named the method", async () => {
    const ref = "github.com/Pipelex/methods/documents@v0.1.0";
    const notFound = {
      type: "https://mthds.ai/errors/method.not_found",
      title: "No method is found",
      status: 404,
      detail: `No method is found at '${ref}'.`,
      code: "method.not_found",
      domain: "input",
      retry: "no",
      next_step: { kind: "change_input", detail: "Check the address." },
      params: { method_ref: ref },
    };
    const byRef = await failWith(
      { method_ref: ref, target: "ts-zod" },
      problemAnswer(404, notFound),
    );
    expect(byRef.problem).toEqual(notFound);

    const catalogMiss = {
      type: "https://docs.pipelex.com/errors/pipelex.catalog.not_found",
      title: "The method is not in the catalog",
      status: 404,
      detail:
        "The organization's catalog holds no method matching the request for the method 'mt_123'.",
      code: "pipelex.catalog.not_found",
      domain: "input",
      retry: "no",
      next_step: { kind: "change_input", detail: "Pick a method listMethods lists." },
      params: { resource: "method", method_id: "mt_123" },
    };
    const byId = await failWith(
      { method_id: "mt_123", target: "ts-zod" },
      problemAnswer(404, catalogMiss),
    );
    expect(byId.problem).toMatchObject(catalogMiss);
  });

  it("reads a bare 404 as a route the deployment does not serve, naming the API in use", async () => {
    const { problem, summary } = await failWith({ files, target: "ts-zod" }, responseError(404));

    expect(problem).toMatchObject({ code: "request.not_found", status: 404 });
    expect(summary).toContain("PIPELEX_BASE_URL");
  });

  it("relays the platform's refusal of the route's gate, with no note on the key", async () => {
    const gate = {
      type: "https://mthds.ai/errors/auth.forbidden",
      title: "The identity lacks a requirement",
      status: 403,
      detail: "The request's identity lacks 'codegen', which this operation needs.",
      code: "auth.forbidden",
      domain: "account",
      retry: "no",
      next_step: { kind: "contact_owner", detail: "Ask the account's owner for 'codegen'." },
      params: { requirement: "codegen" },
    };

    const { problem, summary } = await failWith(
      { files, target: "ts-zod" },
      problemAnswer(403, gate),
    );

    expect(problem).toEqual(gate);
    expect(summary).toContain(gate.detail);
    // A gate is no refused key: nothing sends the caller to replace it.
    expect(summary).not.toContain("PIPELEX_API_KEY");
  });

  it("closes a refused key's summary with where each of the workshop's keys came from", async () => {
    const home = await makeTempDir();
    const noKey = await resolveWorkshopCredentials({ PIPELEX_HOME: home });
    const hostKey = await resolveWorkshopCredentials({ PIPELEX_API_KEY: "plx_sk_host" });
    await fs.writeFile(path.join(home, ".env"), "PIPELEX_API_KEY=plx_sk_saved\n");
    const fileKey = await resolveWorkshopCredentials({ PIPELEX_HOME: home });
    expect([noKey.source, hostKey.source, fileKey.source]).toEqual(["none", "host", "file"]);

    for (const credentials of [noKey, hostKey, fileKey]) {
      const result = await generateMthdsCode(
        { files, target: "ts-zod" },
        {
          baseUrl: credentials.baseUrl,
          apiNotes: credentials.notes,
          client: {
            async codegen() {
              throw responseError(403);
            },
          },
        },
      );

      expect(result.structuredContent.problem?.code, credentials.source).toBe(
        "auth.invalid_credential",
      );
      expect(result.summary, credentials.source).toContain(credentials.notes.apiKey);
      expect(result.summary, credentials.source).toContain(credentials.notes.baseUrl);
      expect(result.summary, credentials.source).toContain("`npx -y @pipelex/mcp@latest login`");
    }
  });

  it("closes a refused key's summary with the context's own note on the key", async () => {
    const { summary } = await failWith({ files, target: "ts-zod" }, responseError(401), {
      apiNotes: { apiKey: "Reconnect and sign in again." },
    });

    expect(summary).toContain("Reconnect and sign in again.");
  });

  it("reads a bare 401 as a missing credential, naming the key's variable by default", async () => {
    const { problem, summary } = await failWith({ files, target: "ts-zod" }, responseError(401));

    expect(problem).toMatchObject({ code: "auth.missing_credential", domain: "account" });
    expect(summary).toContain("PIPELEX_API_KEY");
  });

  it("relays a plan refusal as the platform states it, never as an unreachable API", async () => {
    const plan = {
      type: "https://docs.pipelex.com/errors/pipelex.billing.credit_exhausted",
      title: "No credit left",
      status: 402,
      detail: "The organization has no credit left, so the operation was refused.",
      code: "pipelex.billing.credit_exhausted",
      domain: "account",
      retry: "no",
      next_step: { kind: "contact_owner", detail: "Ask the organization's owner to add credit." },
    };

    const { problem, summary } = await failWith(
      { files, target: "ts-zod" },
      problemAnswer(402, plan),
    );

    expect(problem).toEqual(plan);
    expect(summary).toContain("no credit left");
    expect(summary).not.toContain("PIPELEX_BASE_URL");
  });

  it("reads an unreachable API as retryable, naming the API in use", async () => {
    const { problem, summary } = await failWith(
      { files, target: "ts-zod" },
      new ApiUnreachableError("connection refused", "http://localhost:8081", "ECONNREFUSED"),
    );

    expect(problem).toMatchObject({
      code: "client.unreachable",
      retry: "yes",
      params: { base_url: "http://localhost:8081" },
    });
    expect(summary).toContain("PIPELEX_BASE_URL");
  });

  it("reads a bare 503 as a retryable unavailable runtime", async () => {
    const { problem } = await failWith({ files, target: "ts-zod" }, responseError(503));

    expect(problem).toMatchObject({ code: "runtime.unavailable", retry: "yes" });
  });

  it("turns a malformed base URL into a problem instead of rejecting the handler", async () => {
    const result = await generateMthdsCode({ files, target: "ts-zod" }, { baseUrl: "not a url" });

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.not_configured",
      params: { setting: "base_url" },
    });
  });

  it("reads a reachable but malformed report as an unreadable answer, not an unreachable API", async () => {
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
    const problem = result.structuredContent.problem;
    expect(problem).toMatchObject({
      code: "client.response_unreadable",
      domain: "runtime",
      retry: "no",
    });
    expect(problem?.message).toContain("lock content");
    expect(result.summary).toContain("did not hold together");
  });
});

describe("generateMthdsCode path submissions", () => {
  it("reads { path } items through the context resolver and sends them as one tree", async () => {
    const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    let captured: CodegenRequest | undefined;

    const result = await generateMthdsCode(
      {
        files: [{ path: "methods/invoice.mthds" }, { path: "methods/templates/invoice.xlsx" }],
        target: "ts-zod",
      },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: fakeMethodResolver({
          files: {
            "methods/invoice.mthds": 'domain = "invoice"',
            "methods/templates/invoice.xlsx": XLSX,
          },
        }),
        client: {
          async codegen(request) {
            captured = request;
            return recordedReport;
          },
        },
      },
    );

    expect(captured?.tree?.files.map((file) => file.path)).toEqual([
      "invoice.mthds",
      "templates/invoice.xlsx",
    ]);
    expect(await captured?.tree?.readFile("templates/invoice.xlsx")).toEqual(XLSX);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      files_sent: ["methods/invoice.mthds", "methods/templates/invoice.xlsx"],
    });
  });

  it("reads a method folder through the resolver and lists every file it sent", async () => {
    let captured: CodegenRequest | undefined;

    const result = await generateMthdsCode(
      { method_dir: "methods", target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: methodFolderResolver(),
        client: {
          async codegen(request) {
            captured = request;
            return recordedReport;
          },
        },
      },
    );

    expect(await contentsOf(captured?.tree)).toEqual({
      "invoice.mthds": 'domain = "invoice"',
      "templates/invoice.xlsx": "PK",
    });
    expect(result.structuredContent.files_sent).toEqual([
      "methods/invoice.mthds",
      "methods/templates/invoice.xlsx",
    ]);
    expect(codegenToolResult(result).content[0].text).toContain("## Files sent");
  });

  it("refuses a folder holding a key before anything is sent", async () => {
    const fakeKey = ["plx_sk_", "f".repeat(32)].join("");

    const result = await generateMthdsCode(
      { method_dir: "methods", target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: fakeMethodResolver({
          folder: {
            "invoice.mthds": 'domain = "invoice"',
            "funcs/client.py": `KEY = "${fakeKey}"`,
          },
        }),
        client: codegenNotCalled,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_dir", reason: "secret_suspected" },
      location: { field: "method_dir" },
    });
    expect(result.structuredContent.problem?.message).toContain("nothing was sent");
    expect(result.structuredContent).not.toHaveProperty("files_sent");
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  it("lists no file of a folder when the request never left the machine", async () => {
    const unbuilt = await generateMthdsCode(
      { method_dir: "methods", target: "ts-zod" },
      { baseUrl: "invalid-no-scheme", resolver: methodFolderResolver() },
    );
    expect(unbuilt.structuredContent.status).toBe("error");
    expect(unbuilt.structuredContent).not.toHaveProperty("files_sent");
    expect(codegenToolResult(unbuilt).content[0].text).not.toContain("Files sent");

    const refused = await generateMthdsCode(
      { method_dir: "methods", target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: methodFolderResolver(),
        client: {
          codegen: () => Promise.reject(new RequestArgumentError("refused before sending")),
        },
      },
    );
    expect(refused.structuredContent.status).toBe("error");
    expect(refused.structuredContent).not.toHaveProperty("files_sent");
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    const result = await generateMthdsCode(
      { files: [{ path: "bundle.mthds" }], target: "ts-zod" },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files[0].path", reason: "not_readable_here" },
      location: { field: "files[0].path" },
    });
    expect(result.structuredContent.problem?.message).toContain("npx @pipelex/mcp");
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
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "output_dir", reason: "empty" },
      location: { field: "output_dir" },
    });
  });

  it("refuses output_dir on a shell with no write root, naming the workshop", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      { baseUrl: DEFAULT_API_URL, client: codegenNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "output_dir", reason: "not_writable_here" },
      location: { field: "output_dir" },
    });
    expect(result.structuredContent.problem?.message).toContain("npx @pipelex/mcp");
  });

  it("refuses an absolute output_dir without calling the route", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "/etc/pipelex" },
      { baseUrl: DEFAULT_API_URL, saveRoot: "/tmp", client: codegenNotCalled },
    );

    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "output_dir", reason: "absolute" },
      location: { field: "output_dir" },
    });
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
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.target_exists",
      location: { field: "output_dir" },
    });
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
    expect(result.structuredContent.problem?.code).toBe("client.response_unreadable");
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
    // The verdict line follows `isCurrent`, not the orphan list: a drifting
    // tree with no orphans must never be announced as current two paragraphs
    // above the section saying it disagrees with its own lock.
    expect(result.summary).not.toContain("**current**");
    expect(result.summary).toContain("**not current**");
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
  it("refuses any lock filename but codegen.lock, on the riding arm too", async () => {
    for (const lockFilename of [
      "../codegen.lock",
      "nested/codegen.lock",
      ".codegen.lock",
      "pipelex.lock",
    ]) {
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
      expect(result.structuredContent.problem?.code).toBe("client.response_unreadable");
      expect(result.structuredContent.problem?.message).toContain("codegen.lock");
    }
  });

  it("refuses a lock filename that aliases an artifact path, before anything is written", async () => {
    const root = await makeTempDir();
    // The preflight structurally cannot see this: `runCodegenCheck` takes the
    // lock content separately and never learns its filename, so an aliasing
    // report is internally current. Without the exact-name rule the writer
    // would write types.ts and then overwrite it with the lock (written last),
    // read the lock text back as the locked artifact, and report the result as
    // drift on a tree where the real lock never existed.
    const aliasing: CodegenResponse = { ...recordedReport, lock_filename: "types.ts" };

    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      workshopContext(root, aliasing),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem?.code).toBe("client.response_unreadable");
    expect(result.structuredContent.problem?.message).toContain("codegen.lock");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a response that answers for another target, before anything is written", async () => {
    const root = await makeTempDir();
    // Internally consistent — it passes the SDK's own check against its own
    // lock — but it answers a question nobody asked. Only comparing the echo
    // against the request catches it, and it must catch it before the write:
    // otherwise output_dir fills with another language's files, reported current.
    const wrongTarget: CodegenResponse = { ...recordedReport, target: "python-pydantic" };

    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod", output_dir: "generated" },
      workshopContext(root, wrongTarget),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem?.code).toBe("client.response_unreadable");
    expect(result.structuredContent.problem?.message).toContain("python-pydantic");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a response that answers for another kind, on the riding arm too", async () => {
    const result = await generateMthdsCode(
      { files: [{ content: 'domain = "demo"' }], target: "ts-zod" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async codegen(): Promise<CodegenResponse> {
            return { ...recordedReport, kind: "pipe" as CodegenValidReport["kind"] };
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem?.code).toBe("client.response_unreadable");
    expect(result.structuredContent.problem?.message).toContain("kind");
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
    expect(result.structuredContent.problem?.code).toBe("client.response_unreadable");
    expect(result.structuredContent.problem?.message).toContain("offline check");
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
    expect(result.structuredContent.problem?.message).toContain("types.rb");
  });
});

/** A resolver reading every method folder as a bundle and one template file. */
function methodFolderResolver() {
  return fakeMethodResolver({
    folder: { "invoice.mthds": 'domain = "invoice"', "templates/invoice.xlsx": "PK" },
  });
}
