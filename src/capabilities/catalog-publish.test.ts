import { ApiResponseError } from "@pipelex/sdk";
import type {
  MethodData,
  MethodPublishInput,
  MethodPublishResult,
  MethodVersionSummary,
} from "@pipelex/sdk";
import { describe, expect, it, vi } from "vitest";

import { publishMethodToolResult, publishMthdsMethod } from "./catalog-publish.js";
import type { PublishMethodSuccess } from "./catalog-publish.js";
import type { CatalogWriteClient, CatalogWriteContext } from "./catalog-write.js";
import type { ToolError } from "./shared.js";

const TOKEN = "2026-09-20T12:00:00Z";

function versionSummary(overrides: Partial<MethodVersionSummary> = {}): MethodVersionSummary {
  return {
    version: 3,
    source_digest: "a".repeat(64),
    crate_fingerprint: "crate-fp",
    runner_version: "0.78.0",
    description: null,
    published_at: "2026-09-20T12:05:00Z",
    published_by: "user_1",
    ...overrides,
  };
}

function method(overrides: Partial<MethodData> = {}): MethodData {
  return {
    method_id: "mt_one",
    org_id: "org_1",
    created_by_user_id: "user_1",
    name: "Summarize PDF",
    mthds: "[]",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: TOKEN,
    draft_digest: "a".repeat(64),
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

function errorsOf(result: { structuredContent: unknown }): ToolError[] {
  return (result.structuredContent as { errors?: ToolError[] }).errors ?? [];
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
    expect(errorsOf(refused)[0]).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(errorsOf(refused)[0]?.hint).toContain('"mt_one"');
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

    expect(errorsOf(result)[0]).toMatchObject({
      class: "input_domain",
      location: "expected_draft_updated_at",
    });
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
            validation_errors: [
              { category: "blueprint_validation", message: "Unknown pipe type", source: "a.mthds" },
            ],
          } as never,
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
    });
    expect(success(result)).not.toHaveProperty("version");
    expect(result.summary).toContain("was NOT published");
    expect(result.summary).toContain("**blueprint_validation** — Unknown pipe type (a.mthds)");
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
            throw new ApiResponseError(
              "conflict",
              "https://api-dev.pipelex.com/v1/methods/mt_one/publish",
              409,
              "Conflict",
              "{}",
              undefined,
              "The draft changed.",
              undefined,
              "method_update_conflict",
            );
          },
          {
            async getMethod() {
              return method({ updated_at: "2026-09-21T09:00:00Z" });
            },
          },
        ),
      ),
    );

    const [error] = errorsOf(result);
    expect(error).toMatchObject({
      class: "input_domain",
      location: "expected_draft_updated_at",
      retryable: false,
    });
    expect(error?.message).toContain("2026-09-21T09:00:00Z");
    expect(error?.message).toContain("nothing was published");
    expect(publishMethodToolResult(result).isError).toBe(true);
  });
});
