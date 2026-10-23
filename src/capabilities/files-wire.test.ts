import { afterEach, describe, expect, it, vi } from "vitest";

import type { PipeIOValidReport } from "@pipelex/sdk";

import { listMthdsFiles } from "./org-files.js";
import { prepareMthdsInputs } from "./prepare.js";

/**
 * The wire the files list and a test upload leave on: the real
 * `PipelexApiClient` over a stubbed `fetch`, so these prove what the platform
 * receives, the query `GET /v1/files` reads and the `kind` and `method_id`
 * every `POST /v1/upload` of a test preparation carries. Every other test of
 * these tools fakes the client and sees only what the workshop hands the SDK.
 */

interface SentRequest {
  method: string;
  url: URL;
  body: Record<string, unknown> | undefined;
}

/** A pipe I/O answer for a pipe taking one document, which the SDK's walk uploads. */
const PIPE_IO_REPORT = {
  is_valid: true,
  pipe_ref: "invoice.main",
  pipe_io_contracts: {},
  input_form: {
    "invoice.main": { fields: [{ name: "invoice", kind: "document", required: true }] },
  },
  output_form: {},
  default_pipe_ref: "invoice.main",
  pending_signatures: [],
  is_runnable: true,
} as unknown as PipeIOValidReport;

function stubDeployment(answers: Record<string, unknown>): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    sent.push({ method, url, body });
    if (url.pathname === "/v1/version") {
      return Promise.resolve(Response.json({ version: "1.0.0" }));
    }
    const answer = answers[url.pathname];
    if (typeof answer === "function") return Promise.resolve((answer as () => Response)());
    return Promise.resolve(
      answer === undefined ? new Response("", { status: 404 }) : Response.json(answer),
    );
  });
  return sent;
}

describe("the files list and a test upload on the wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the list's filters under the route's names", async () => {
    const sent = stubDeployment({ "/v1/files": { items: [], next_cursor: null } });

    const result = await listMthdsFiles(
      { query: "invoice", kind: "test", format: [".PDF", "image"], method_id: "mt_abc" },
      { baseUrl: "https://files.example", apiKey: "plx_sk_test" },
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", next_cursor: null });
    const listed = sent.filter((request) => request.url.pathname === "/v1/files");
    expect(listed).toHaveLength(1);
    const params = listed[0]!.url.searchParams;
    expect(params.get("q")).toBe("invoice");
    expect(params.get("kind")).toBe("test");
    expect(params.getAll("format")).toEqual(["pdf", "image"]);
    expect(params.get("method_id")).toBe("mt_abc");
    expect(params.get("limit")).toBe("20");
  });

  it("sends kind test and the method's bare id with every upload of the walk", async () => {
    const sent = stubDeployment({
      "/v1/pipe-io": PIPE_IO_REPORT,
      "/v1/upload": { uri: "pipelex-storage://org/assets/abc.pdf", filename: "invoice.pdf" },
    });

    const result = await prepareMthdsInputs(
      {
        method_id: "mt_abc",
        inputs: { invoice: "data:application/pdf;base64,JVBERi0xLjQK" },
        kind: "test",
      },
      { baseUrl: "https://upload.example", apiKey: "plx_sk_test" },
    );

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      kind: "test",
      test_method_id: "mt_abc",
    });
    const uploads = sent.filter((request) => request.url.pathname === "/v1/upload");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.body).toMatchObject({ kind: "test", method_id: "mt_abc" });
  });

  it("sends no kind with an upload the caller did not mark", async () => {
    const sent = stubDeployment({
      "/v1/pipe-io": PIPE_IO_REPORT,
      "/v1/upload": { uri: "pipelex-storage://org/assets/abc.pdf", filename: "invoice.pdf" },
    });

    await prepareMthdsInputs(
      { method_id: "mt_abc", inputs: { invoice: "data:application/pdf;base64,JVBERi0xLjQK" } },
      { baseUrl: "https://upload.example", apiKey: "plx_sk_test" },
    );

    const uploads = sent.filter((request) => request.url.pathname === "/v1/upload");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.body).not.toHaveProperty("kind");
    expect(uploads[0]?.body).not.toHaveProperty("method_id");
  });

  it("locates the platform's 422 at the argument behind the field it names", async () => {
    stubDeployment({
      "/v1/files": () =>
        Response.json(
          {
            type: "https://pipelex.com/errors/validation_failed",
            title: "Validation failed",
            status: 422,
            detail: "Request body failed validation. See `errors` for the per-field breakdown.",
            code: "validation_failed",
            error_domain: "input",
            retryable: false,
            errors: [
              {
                field: "q",
                code: "string_too_long",
                detail: "String should have at most 200 characters",
              },
            ],
          },
          { status: 422, headers: { "content-type": "application/problem+json" } },
        ),
    });

    const result = await listMthdsFiles(
      { query: "invoice" },
      { baseUrl: "https://files.example", apiKey: "plx_sk_test" },
    );

    expect(result.structuredContent).toMatchObject({
      status: "error",
      errors: [{ class: "input_domain", location: "query", retryable: false }],
    });
  });

  it("uploads nothing for a test preparation whose method is unknown", async () => {
    const sent = stubDeployment({
      "/v1/pipe-io": PIPE_IO_REPORT,
      "/v1/upload": { uri: "pipelex-storage://org/assets/abc.pdf", filename: "invoice.pdf" },
    });

    const result = await prepareMthdsInputs(
      {
        files: [{ content: 'domain = "invoice"' }],
        inputs: { invoice: "data:application/pdf;base64,JVBERi0xLjQK" },
        kind: "test",
      },
      { baseUrl: "https://upload.example", apiKey: "plx_sk_test" },
    );

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "kind",
    });
    expect(sent.filter((request) => request.url.pathname === "/v1/upload")).toHaveLength(0);
  });
});
