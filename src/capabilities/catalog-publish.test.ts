import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type {
  MethodDetail,
  MethodPublishInput,
  MethodPublishResult,
  MethodVersionSummary,
  Problem,
} from "@pipelex/sdk";
import { describe, expect, it, vi } from "vitest";

import { publishMethodToolResult, publishMthdsMethod } from "./catalog-publish.js";
import type { PublishMethodSuccess } from "./catalog-publish.js";
import type { CatalogWriteClient, CatalogWriteContext } from "./catalog-write.js";

const TOKEN = "2026-09-20T12:00:00Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

function versionSummary(overrides: Partial<MethodVersionSummary> = {}): MethodVersionSummary {
  return {
    version: 3,
    tree_digest: DIGEST,
    crate_fingerprint: "crate-fp",
    runner_version: "0.78.0",
    description: null,
    published_at: "2026-09-20T12:05:00Z",
    published_by: "user_1",
    ...overrides,
  };
}

function method(overrides: Partial<MethodDetail> = {}): MethodDetail {
  return {
    method_id: "mt_one",
    org_id: "org_1",
    created_by_user_id: "user_1",
    name: "Summarize PDF",
    files: [],
    created_at: "2026-09-01T00:00:00Z",
    updated_at: TOKEN,
    draft_digest: DIGEST,
    latest_version: 3,
    latest_published: versionSummary(),
    ...overrides,
  };
}

/** A client answering `publish` to every publish, and failing every other arm. */
function publishing(
  publish: (id: string, input: MethodPublishInput) => Promise<MethodPublishResult>,
  extra: Partial<CatalogWriteClient> = {},
): CatalogWriteClient {
  const notCalled = async (): Promise<never> => {
    throw new Error("must not be called in this test");
  };
  return {
    getMethod: notCalled,
    createMethod: notCalled,
    writeDraft: notCalled,
    renameMethod: notCalled,
    getMethodVersion: notCalled,
    publishMethod: publish,
    writeMethodTree: notCalled,
    ...extra,
  };
}

function contextFor(client: CatalogWriteClient): CatalogWriteContext {
  return {
    baseUrl: "https://api-dev.pipelex.com",
    client,
    validation: { baseUrl: "https://api-dev.pipelex.com" },
  } as CatalogWriteContext;
}

function success(result: { structuredContent: unknown }): PublishMethodSuccess {
  const sc = result.structuredContent as PublishMethodSuccess | { status: "error" };
  if (sc.status !== "ok") throw new Error(`expected a verdict: ${JSON.stringify(sc)}`);
  return sc;
}

function problemOf(result: { structuredContent: unknown }): Problem | undefined {
  const sc = result.structuredContent as { status: string; problem?: Problem };
  return sc.status === "error" ? sc.problem : undefined;
}

const PUBLISH_URL = "https://api-dev.pipelex.com/v1/methods/mt_one/publish";

/** A platform refusal carrying its problem document, its request id on the header. */
function platformError(
  status: number,
  problem: { code: string; title: string; detail: string; domain: string } & Record<
    string,
    unknown
  >,
): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    PUBLISH_URL,
    status,
    "Refused",
    JSON.stringify({
      type: `https://docs.pipelex.com/errors/${problem.code}`,
      status,
      retry: "no",
      next_step: { kind: "report", detail: "Report it." },
      ...problem,
    }),
    { headers: { "x-request-id": `req_${status}` } },
  );
}

/** The platform's refusal of a draft that moved since the token the publish sent. */
function staleTokenRefusal(): ApiResponseError {
  return platformError(409, {
    code: "pipelex.catalog.update_conflict",
    title: "The method changed since your token",
    detail: "The draft changed since the expected_draft_updated_at you sent.",
    domain: "input",
    next_step: { kind: "reread", detail: "Read the method again, then decide what to send." },
    location: { field: "expected_draft_updated_at" },
  });
}

describe("publishMthdsMethod", () => {
  it("publishes the draft under the token it was given, and says the version is for good", async () => {
    let sent: [string, MethodPublishInput] | undefined;
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      contextFor(
        publishing(
          async (id, input) => {
            sent = [id, input];
            return { outcome: "published", version: versionSummary(), method: method() };
          },
          {
            async version() {
              return { extensions: ["runs", "method_versions"] };
            },
          } as Partial<CatalogWriteClient>,
        ),
      ),
    );

    expect(sent).toEqual(["mt_one", { expected_draft_updated_at: TOKEN }]);
    expect(success(result)).toMatchObject({
      outcome: "published",
      method_id: "mt_one",
      version: 3,
      published_at: "2026-09-20T12:05:00Z",
      crate_fingerprint: "crate-fp",
      latest_version: 3,
      publish_state: "draft_unchanged",
      api_host: "api-dev.pipelex.com",
    });
    expect(result.summary).toContain("as version 3");
    expect(result.summary).toContain("`mt_one@3` names this version for good");
    expect(result.summary).toContain("Every caller of the bare `mt_one` runs version 3");
    expect(publishMethodToolResult(result).isError).toBe(false);
  });

  it("says a bare id still reads the draft on a platform that does not resolve versions", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      contextFor(
        publishing(
          async () => ({ outcome: "published", version: versionSummary(), method: method() }),
          {
            async version() {
              return { extensions: ["runs"] };
            },
          } as Partial<CatalogWriteClient>,
        ),
      ),
    );

    expect(result.summary).toContain("still reads the draft; once it does, it reads version 3");
  });

  it("asks whether versions resolve beside the publish, not after it", async () => {
    // Only the published result's sentence about callers waits on the answer,
    // so the publish does not wait a handshake after it has finished.
    const order: string[] = [];
    let finish: () => void = () => undefined;
    const result = publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      contextFor(
        publishing(
          async () => {
            order.push("publish sent");
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            order.push("publish answered");
            return { outcome: "published", version: versionSummary(), method: method() };
          },
          {
            async version() {
              order.push("handshake sent");
              return { extensions: ["runs", "method_versions"] };
            },
          } as Partial<CatalogWriteClient>,
        ),
      ),
    );
    await vi.waitFor(() => expect(order).toContain("publish sent"));
    expect(order).toContain("handshake sent");
    finish();

    expect((await result).summary).toContain("Every caller of the bare `mt_one` runs version 3");
    expect(order.indexOf("handshake sent")).toBeLessThan(order.indexOf("publish answered"));
  });

  it("reads @draft as the bare id, and refuses a version, which never changes", async () => {
    let sentId: string | undefined;
    const client = publishing(async (id) => {
      sentId = id;
      return { outcome: "unchanged", version: versionSummary(), method: method() };
    });

    await publishMthdsMethod(
      { method_id: "mt_one@draft", expected_draft_updated_at: TOKEN },
      contextFor(client),
    );
    expect(sentId).toBe("mt_one");

    const refused = await publishMthdsMethod(
      { method_id: "mt_one@2", expected_draft_updated_at: TOKEN },
      contextFor(client),
    );
    const problem = problemOf(refused);
    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "method_id", reason: "version_suffix" },
      location: { field: "method_id" },
    });
    expect(problem?.message).toContain("names version 2");
    expect(problem?.message).toContain('Pass method_id "mt_one"');
    expect(refused.summary).toContain('Pass method_id "mt_one"');
    expect(refused.summary).toContain("`client.argument_invalid`");
  });

  it("requires the draft token", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one" } as never,
      contextFor(
        publishing(async () => {
          throw new Error("must not be sent");
        }),
      ),
    );

    expect(problemOf(result)).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "expected_draft_updated_at", reason: "invalid_type" },
      location: { field: "expected_draft_updated_at" },
    });
    expect(problemOf(result)?.message).toContain("the draft token you last saw");
  });

  it("refuses every missing argument at once, as one problem listing each", async () => {
    const result = await publishMthdsMethod(
      {} as never,
      contextFor(
        publishing(async () => {
          throw new Error("must not be sent");
        }),
      ),
    );

    const problem = problemOf(result);
    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_id", reason: "several_faults" },
    });
    expect(problem?.errors?.map((item) => item.location?.field)).toEqual([
      "method_id",
      "expected_draft_updated_at",
    ]);
  });

  it("reports an unchanged draft as nothing new, with the existing version", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      contextFor(
        publishing(async () => ({
          outcome: "unchanged",
          version: versionSummary(),
          method: method(),
        })),
      ),
    );

    expect(success(result)).toMatchObject({ outcome: "unchanged", version: 3 });
    expect(result.summary).toContain("Nothing new to publish");
  });

  it("reports a refused draft as a verdict, listing why", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      contextFor(
        publishing(async () => ({
          outcome: "refused",
          reason: "invalid",
          message: "The draft is not valid.",
          validation: {
            is_valid: false,
            is_runnable: false,
            pending_signatures: [],
            message: "The bundle is not valid.",
            errors: [
              {
                code: "method.pipe_type_invalid",
                detail: "Unknown pipe type\nPipeMagic",
                location: { pipe: "summarize", file: "a.mthds" },
              },
            ],
          },
          method: method({ latest_version: null, latest_published: null }),
        })),
      ),
    );

    expect(success(result)).toMatchObject({
      outcome: "refused",
      reason: "invalid",
      is_valid: false,
      publish_state: "never_published",
      latest_version: null,
      validation_errors: [
        {
          code: "method.pipe_type_invalid",
          detail: "Unknown pipe type\nPipeMagic",
          location: { pipe: "summarize", file: "a.mthds" },
        },
      ],
    });
    expect(success(result)).not.toHaveProperty("version");
    expect(result.summary).toContain("was NOT published");
    expect(result.summary).toContain(
      "- method.pipe_type_invalid: Unknown pipe type PipeMagic (pipe 'summarize', file 'a.mthds')",
    );
    expect(publishMethodToolResult(result).isError).toBe(false);
  });

  it("names the pending signatures of a draft that validates but does not run", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      contextFor(
        publishing(async () => ({
          outcome: "refused",
          reason: "not_runnable",
          message: "The draft is valid but does not run yet.",
          validation: {
            is_valid: true,
            is_runnable: false,
            pending_signatures: ["demo.summarize"],
          } as never,
          method: method(),
        })),
      ),
    );

    expect(success(result)).toMatchObject({
      reason: "not_runnable",
      is_valid: true,
      is_runnable: false,
      pending_signatures: ["demo.summarize"],
    });
    expect(result.summary).toContain("`demo.summarize`");
  });

  it("refuses a stale token, naming the draft's current one", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: "2026-09-19T00:00:00Z" },
      contextFor(
        publishing(
          async () => {
            throw staleTokenRefusal();
          },
          {
            async getMethod() {
              return method({ updated_at: "2026-09-21T09:00:00Z" });
            },
          },
        ),
      ),
    );

    const problem = problemOf(result);
    // The platform's problem stands, code, domain, retry and location; the
    // workshop adds only its sentence carrying both tokens.
    expect(problem).toMatchObject({
      code: "pipelex.catalog.update_conflict",
      domain: "input",
      retry: "no",
      location: { field: "expected_draft_updated_at" },
      detail: "The draft changed since the expected_draft_updated_at you sent.",
      request_id: "req_409",
    });
    expect(problem?.message).toContain("2026-09-21T09:00:00Z");
    expect(problem?.message).toContain("not 2026-09-19T00:00:00Z");
    expect(problem?.message).toContain("nothing was published");
    expect(problem?.message).toContain("only if they still want to");
    const tool = publishMethodToolResult(result);
    expect(tool.isError).toBe(true);
    expect(tool.content[0].text).toContain("The method changed since your token");
    expect(tool.content[0].text).toContain("2026-09-21T09:00:00Z");
    expect(tool.content[0].text).toContain("**Next step**");
    expect(tool.content[0].text).toContain("`pipelex.catalog.update_conflict`");
    expect(tool.content[0].text).toContain("`req_409`");
  });

  it("relays the stale-token refusal as the platform worded it when the draft cannot be read", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: "2026-09-19T00:00:00Z" },
      contextFor(
        publishing(async () => {
          throw staleTokenRefusal();
        }),
      ),
    );

    const problem = problemOf(result);
    expect(problem).toMatchObject({
      code: "pipelex.catalog.update_conflict",
      detail: "The draft changed since the expected_draft_updated_at you sent.",
    });
    expect(problem).not.toHaveProperty("message");
  });

  it("relays a publish refused by role as the platform's problem, with its sentence", async () => {
    const detail =
      "Your role in this organization is runner: it runs the organization's published versions and changes no method.";
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      contextFor(
        publishing(async () => {
          throw platformError(403, {
            code: "auth.forbidden",
            title: "The credential does not permit this",
            detail,
            domain: "account",
            params: { requirement: "method_write" },
            next_step: { kind: "contact_owner", detail: "Ask the account's owner for a role." },
          });
        }),
      ),
    );

    expect(problemOf(result)).toMatchObject({
      code: "auth.forbidden",
      domain: "account",
      retry: "no",
      detail,
      params: { requirement: "method_write" },
      request_id: "req_403",
    });
    expect(problemOf(result)?.location).toBeUndefined();
    const tool = publishMethodToolResult(result);
    expect(tool.isError).toBe(true);
    expect(tool.content[0].text).toContain("The credential does not permit this");
    expect(tool.content[0].text).toContain(detail);
    expect(tool.content[0].text).toContain("Ask the account's owner for a role.");
    // A role refusal is not the key's fault: no sentence about the key or a login.
    expect(tool.content[0].text).not.toMatch(/PIPELEX_API_KEY|log ?in/i);
  });

  it("reports a refused key as the key, with where it came from, not as connectivity", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      {
        ...contextFor(
          publishing(async () => {
            throw new ApiResponseError("HTTP 401", PUBLISH_URL, 401, "Unauthorized", "{}", {
              headers: { "x-request-id": "req_401" },
            });
          }),
        ),
        apiNotes: {
          apiKey: "The API key was read from the login file; log in again to change it.",
        },
      },
    );

    expect(problemOf(result)).toMatchObject({
      code: "auth.missing_credential",
      domain: "account",
      request_id: "req_401",
    });
    expect(result.summary).toContain(
      "The API key was read from the login file; log in again to change it.",
    );
    expect(result.summary).toContain("`auth.missing_credential`");
  });

  it("reports an API it could not reach as unreachable, naming where the base URL came from", async () => {
    const result = await publishMthdsMethod(
      { method_id: "mt_one", expected_draft_updated_at: TOKEN },
      contextFor(
        publishing(async () => {
          throw new ApiUnreachableError("fetch failed", PUBLISH_URL, "ECONNREFUSED");
        }),
      ),
    );

    expect(problemOf(result)).toMatchObject({ code: "client.unreachable" });
    expect(result.summary).toContain("PIPELEX_BASE_URL");
  });
});
