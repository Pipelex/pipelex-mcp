import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError, ClientAuthenticationError } from "@pipelex/sdk";
import type { MethodData } from "@pipelex/sdk";

import {
  CATALOG_DESCRIPTION_LIMIT,
  CATALOG_MAX_LIMIT,
  CATALOG_NAME_LIMIT,
  catalogToolResult,
  listMthdsMethods,
  mthdsListMethodsInputObjectSchema,
} from "./catalog.js";
import type { CatalogClient, CatalogContext, CatalogSuccess } from "./catalog.js";
import { DEFAULT_API_URL } from "./shared.js";

const baseMethod: MethodData = {
  method_id: "mt_base",
  org_id: "org_secret",
  created_by_user_id: "usr_secret",
  name: "Invoice extractor",
  mthds: 'domain = "invoice"',
  python: [{ name: "secret.py", content: "PYTHON_SENTINEL" }],
  input_data: { private_default: "INPUT_SENTINEL" },
  pipe_output: { private_output: "OUTPUT_SENTINEL" },
  description: "Extract invoices",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

function method(overrides: Partial<MethodData> = {}): MethodData {
  return { ...baseMethod, ...overrides };
}

function context(client: CatalogClient): CatalogContext {
  return { baseUrl: DEFAULT_API_URL, client };
}

async function success(methods: MethodData[], input = {}) {
  const result = await listMthdsMethods(
    input,
    context({
      async listMethods() {
        return methods;
      },
    }),
  );
  expect(result.structuredContent.status).toBe("ok");
  return result as { structuredContent: CatalogSuccess; summary: string };
}

describe("mthds_list_methods schemas", () => {
  it("accepts defaults and valid bounds", () => {
    expect(mthdsListMethodsInputObjectSchema.safeParse({}).success).toBe(true);
    expect(
      mthdsListMethodsInputObjectSchema.safeParse({ query: " invoice ", limit: 1, offset: 0 })
        .success,
    ).toBe(true);
    expect(
      mthdsListMethodsInputObjectSchema.safeParse({ limit: CATALOG_MAX_LIMIT, offset: 999 })
        .success,
    ).toBe(true);
  });

  it("rejects invalid limit and offset bounds", () => {
    for (const input of [
      { limit: 0 },
      { limit: CATALOG_MAX_LIMIT + 1 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 1.5 },
    ]) {
      expect(mthdsListMethodsInputObjectSchema.safeParse(input).success).toBe(false);
    }
  });

  it("does not call the client when direct capability input fails schema validation", async () => {
    let calls = 0;
    const result = await listMthdsMethods(
      { limit: 0 },
      context({
        async listMethods() {
          calls += 1;
          return [];
        },
      }),
    );

    expect(calls).toBe(0);
    expect(result.structuredContent).toMatchObject({
      status: "error",
      errors: [{ class: "input_domain", location: "limit", retryable: false }],
    });
  });
});

describe("listMthdsMethods projection", () => {
  it("returns an empty catalog as a successful result", async () => {
    const result = await success([]);

    expect(result.structuredContent).toEqual({
      status: "ok",
      total_count: 0,
      matched_count: 0,
      returned_count: 0,
      next_offset: null,
      methods: [],
    });
    expect(result.summary).toContain("0 total, 0 matched, 0 returned");
  });

  it("projects only allowlisted fields and never serializes sensitive catalog fields", async () => {
    const result = await success([
      method({
        mthds: "MTHDS_SOURCE_SENTINEL",
        org_id: "ORG_SENTINEL",
        created_by_user_id: "CREATOR_SENTINEL",
      }),
    ]);
    const projected = result.structuredContent.methods[0];

    expect(Object.keys(projected ?? {}).sort()).toEqual([
      "description",
      "description_truncated",
      "has_source",
      "method_id",
      "name",
      "name_truncated",
      "updated_at",
    ]);
    expect(projected).toEqual({
      method_id: "mt_base",
      name: "Invoice extractor",
      name_truncated: false,
      description: "Extract invoices",
      description_truncated: false,
      has_source: true,
      updated_at: "2026-07-31T00:00:00Z",
    });

    const serialized = JSON.stringify(catalogToolResult(result));
    for (const sentinel of [
      "MTHDS_SOURCE_SENTINEL",
      "PYTHON_SENTINEL",
      "INPUT_SENTINEL",
      "OUTPUT_SENTINEL",
      "ORG_SENTINEL",
      "CREATOR_SENTINEL",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("normalizes missing and null descriptions to null", async () => {
    const missing = method({ method_id: "mt_missing" });
    delete missing.description;
    const result = await success([missing, method({ method_id: "mt_null", description: null })]);

    expect(result.structuredContent.methods.map((row) => row.description)).toEqual([null, null]);
    expect(result.structuredContent.methods.every((row) => !row.description_truncated)).toBe(true);
  });

  it("derives has_source through the SDK parser for every stored source form", async () => {
    const result = await success([
      method({ method_id: "mt_raw", name: "A raw", mthds: 'domain = "raw"' }),
      method({
        method_id: "mt_files",
        name: "B files",
        mthds: JSON.stringify([{ name: "bundle.mthds", content: 'domain = "files"' }]),
      }),
      method({ method_id: "mt_blank", name: "C blank", mthds: "   " }),
      method({ method_id: "mt_empty_array", name: "D empty", mthds: "[]" }),
    ]);

    expect(
      Object.fromEntries(
        result.structuredContent.methods.map((row) => [row.method_id, row.has_source]),
      ),
    ).toEqual({ mt_raw: true, mt_files: true, mt_blank: false, mt_empty_array: false });
  });

  it("trims query and filters case-insensitively across id, name, and description", async () => {
    const rows = [
      method({ method_id: "mt_needle_id", name: "Alpha", description: "first" }),
      method({ method_id: "mt_two", name: "Name Needle", description: "second" }),
      method({ method_id: "mt_three", name: "Gamma", description: "Description NEEDLE" }),
      method({ method_id: "mt_four", name: "Other", description: null }),
    ];
    const result = await success(rows, { query: "  NeEdLe  " });

    expect(result.structuredContent.total_count).toBe(4);
    expect(result.structuredContent.matched_count).toBe(3);
    expect(result.structuredContent.methods.map((row) => row.method_id)).toEqual([
      "mt_needle_id",
      "mt_three",
      "mt_two",
    ]);

    const blank = await success(rows, { query: "   " });
    expect(blank.structuredContent.matched_count).toBe(4);
  });

  it("sorts stably, pages after sorting, and computes exact counts and next_offset", async () => {
    const rows = [
      method({ method_id: "mt_z", name: "beta" }),
      method({ method_id: "mt_b", name: "Alpha" }),
      method({ method_id: "mt_a", name: "alpha" }),
      method({ method_id: "mt_c", name: "Charlie" }),
    ];
    const result = await success(rows, { limit: 2, offset: 1 });

    expect(result.structuredContent).toMatchObject({
      total_count: 4,
      matched_count: 4,
      returned_count: 2,
      next_offset: 3,
    });
    expect(result.structuredContent.methods.map((row) => row.method_id)).toEqual(["mt_b", "mt_z"]);
    expect(result.summary).toContain("offset 3");

    const beyond = await success(rows, { offset: 50 });
    expect(beyond.structuredContent.returned_count).toBe(0);
    expect(beyond.structuredContent.next_offset).toBeNull();
  });

  it("bounds names and descriptions by Unicode code point without splitting surrogate pairs", async () => {
    const longName = "😀".repeat(CATALOG_NAME_LIMIT) + "X";
    const longDescription = "𝌆".repeat(CATALOG_DESCRIPTION_LIMIT) + "Y";
    const result = await success([method({ name: longName, description: longDescription })]);
    const projected = result.structuredContent.methods[0];

    expect(Array.from(projected?.name ?? "")).toHaveLength(CATALOG_NAME_LIMIT);
    expect(projected?.name).toBe("😀".repeat(CATALOG_NAME_LIMIT));
    expect(projected?.name_truncated).toBe(true);
    expect(Array.from(projected?.description ?? "")).toHaveLength(CATALOG_DESCRIPTION_LIMIT);
    expect(projected?.description).toBe("𝌆".repeat(CATALOG_DESCRIPTION_LIMIT));
    expect(projected?.description_truncated).toBe(true);
  });

  it("calls the SDK client exactly once", async () => {
    let calls = 0;
    await listMthdsMethods(
      {},
      context({
        async listMethods() {
          calls += 1;
          return [baseMethod];
        },
      }),
    );

    expect(calls).toBe(1);
  });

  it("puts bounded names, descriptions, ids, draft labels, and paging guidance in content", async () => {
    const result = await success(
      [
        method({ method_id: "mt_draft", name: "Draft", description: "Needs source", mthds: "" }),
        method({ method_id: "mt_ready", name: "Ready", description: "Can inspect", mthds: "x" }),
      ],
      { limit: 1 },
    );
    const toolResult = catalogToolResult(result);
    const text = toolResult.content[0].text;

    expect(text).toContain("Draft");
    expect(text).toContain("Needs source");
    expect(text).toContain("mt_draft");
    expect(text).toContain("draft: no MTHDS source");
    expect(text).toContain("offset 1");
    expect(toolResult.isError).toBe(false);
  });
});

describe("listMthdsMethods failures", () => {
  it("maps unreachable API failures to retryable config", async () => {
    const result = await failure(
      new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
    );
    expect(firstError(result)).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      retryable: true,
    });
  });

  it("maps SDK and HTTP auth failures through deployment auth texture", async () => {
    for (const error of [
      new ClientAuthenticationError("Unauthorized"),
      apiError(401, "Unauthorized"),
      apiError(403, "Forbidden"),
    ]) {
      const result = await failure(error, {
        authError: { location: "api_key", hint: "Bring your own key." },
      });
      expect(firstError(result)).toMatchObject({
        class: "config",
        location: "api_key",
        hint: "Bring your own key.",
        retryable: false,
      });
    }
  });

  it("maps missing active-org context (400) to config at the deployment key location", async () => {
    const result = await failure(apiError(400, "No active organization"), {
      authError: { location: "api_key", hint: "Bring your own key." },
    });

    expect(firstError(result)).toMatchObject({
      class: "config",
      location: "api_key",
      retryable: false,
    });
    expect(firstError(result)?.hint).toContain("active organization");
  });

  it("maps paywall, missing route, and server faults with catalog-specific semantics", async () => {
    expect(firstError(await failure(apiError(402, "Subscription required")))).toMatchObject({
      class: "config",
      retryable: false,
    });

    const missingRoute = firstError(await failure(apiError(404, "Not found")));
    expect(missingRoute).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      retryable: false,
    });
    expect(missingRoute?.hint).toContain("/v1/methods");

    expect(firstError(await failure(apiError(503, "Unavailable")))).toMatchObject({
      class: "runtime",
      retryable: true,
    });
  });

  it("maps unknown errors to retryable runtime", async () => {
    expect(firstError(await failure(new Error("boom")))).toMatchObject({
      class: "runtime",
      message: "boom",
      retryable: true,
    });
  });

  it("classifies malformed base URLs instead of rejecting the handler", async () => {
    const result = await listMthdsMethods({}, { baseUrl: "not a url" });

    expect(firstError(result)).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      retryable: false,
    });
  });

  it("maps non-array and malformed rows to non-retryable runtime contract errors", async () => {
    const nonArray = await listMthdsMethods(
      {},
      context({
        async listMethods() {
          return {} as unknown as MethodData[];
        },
      }),
    );
    expect(firstError(nonArray)).toMatchObject({ class: "runtime", retryable: false });

    const malformed = await listMthdsMethods(
      {},
      context({
        async listMethods() {
          return [{ ...baseMethod, name: undefined }] as unknown as MethodData[];
        },
      }),
    );
    expect(firstError(malformed)).toMatchObject({ class: "runtime", retryable: false });
    expect(firstError(malformed)?.message).toContain("name");
  });

  it("marks MCP tool results as errors and surfaces classified detail in content", async () => {
    const result = catalogToolResult(await failure(apiError(404, "Not found")));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("PIPELEX_BASE_URL");
    expect(result.content[0].text).toContain("/v1/methods");
  });
});

async function failure(error: unknown, overrides: Partial<CatalogContext> = {}) {
  return listMthdsMethods(
    {},
    {
      baseUrl: DEFAULT_API_URL,
      ...overrides,
      client: {
        async listMethods() {
          throw error;
        },
      },
    },
  );
}

function firstError(result: Awaited<ReturnType<typeof listMthdsMethods>>) {
  return result.structuredContent.status === "error"
    ? result.structuredContent.errors[0]
    : undefined;
}

function apiError(status: number, message: string): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/methods`,
    status,
    message,
    "{}",
    status === 402 ? "subscription_required" : "request_error",
    message,
    undefined,
    undefined,
  );
}
