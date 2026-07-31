import { PipelexApiClient, methodSourceToContents } from "@pipelex/sdk";
import type { MethodData } from "@pipelex/sdk";
import { z } from "zod";

import { buildApiConfig, classifyError, toolErrorSchema, toolResultContent } from "./shared.js";
import type { AuthErrorTexture, ClassifyErrorOptions, ToolError } from "./shared.js";

export const CATALOG_DEFAULT_LIMIT = 20;
export const CATALOG_MAX_LIMIT = 50;
export const CATALOG_NAME_LIMIT = 200;
export const CATALOG_DESCRIPTION_LIMIT = 500;

export const mthdsListMethodsInputSchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Optional case-insensitive substring over method id, name, and description. Whitespace is trimmed; blank means no filter.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CATALOG_MAX_LIMIT)
    .optional()
    .describe(`Maximum methods to return (1-${CATALOG_MAX_LIMIT}; defaults to 20).`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Zero-based offset into the deterministically sorted matches; defaults to 0."),
};

export const mthdsListMethodsInputObjectSchema = z.object(mthdsListMethodsInputSchema);

const catalogMethodSchema = z.object({
  method_id: z.string(),
  name: z.string(),
  name_truncated: z.boolean(),
  description: z.string().nullable(),
  description_truncated: z.boolean(),
  has_source: z
    .boolean()
    .describe("Whether stored MTHDS source exists; not a valid or runnable verdict."),
  updated_at: z.string(),
});

// Keep this as one Zod object for MCP SDK compatibility. The TypeScript result
// remains a discriminated union and the capability emits only the exact arm's
// fields; optionality here lets the transport validate either arm.
export const mthdsListMethodsOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  total_count: z.number().int().nonnegative().optional(),
  matched_count: z.number().int().nonnegative().optional(),
  returned_count: z.number().int().nonnegative().optional(),
  next_offset: z.number().int().nonnegative().nullable().optional(),
  methods: z.array(catalogMethodSchema).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export interface MthdsListMethodsInput {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface CatalogMethod {
  method_id: string;
  name: string;
  name_truncated: boolean;
  description: string | null;
  description_truncated: boolean;
  has_source: boolean;
  updated_at: string;
}

export interface CatalogSuccess {
  status: "ok";
  total_count: number;
  matched_count: number;
  returned_count: number;
  next_offset: number | null;
  methods: CatalogMethod[];
}

export interface CatalogFailure {
  status: "error";
  errors: ToolError[];
}

export type CatalogStructuredContent = CatalogSuccess | CatalogFailure;

export interface CatalogResult {
  structuredContent: CatalogStructuredContent;
  summary: string;
}

/** The narrow SDK seam catalog tests and alternate shells can supply. */
export interface CatalogClient {
  listMethods(): Promise<MethodData[]>;
}

export interface CatalogContext {
  baseUrl: string;
  apiKey?: string;
  client?: CatalogClient;
  /** Deployment-specific auth-failure texture (hosted BYOK); env-var wording by default. */
  authError?: AuthErrorTexture;
}

export function buildCatalogContext(env = process.env): CatalogContext {
  return buildApiConfig(env);
}

function catalogClient(context: CatalogContext): CatalogClient {
  return (
    context.client ??
    new PipelexApiClient({
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    })
  );
}

export interface NormalizedCatalogInput {
  query: string;
  limit: number;
  offset: number;
}

export async function listMthdsMethods(
  input: MthdsListMethodsInput,
  context: CatalogContext,
): Promise<CatalogResult> {
  const normalized = normalizeInput(input);
  if (!normalized.ok) {
    return errorResult(
      "Method catalog was not listed: request input is invalid.",
      normalized.errors,
    );
  }

  let methods: MethodData[];
  try {
    // Client construction stays inside the caught path: malformed base URLs
    // must become classified tool errors, not rejected MCP handlers.
    methods = await catalogClient(context).listMethods();
  } catch (err) {
    const error = classifyError(err, catalogErrorOptions(context));
    return errorResult(summaryForError(error), [error]);
  }

  try {
    return projectCatalog(methods, normalized.input);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "The Pipelex API returned a malformed methods catalog.";
    return errorResult("Method catalog produced no verdict: the API returned malformed data.", [
      {
        class: "runtime",
        message,
        hint: "The API responded, but its methods payload violated the SDK contract; inspect the hosted API.",
        retryable: false,
      },
    ]);
  }
}

function normalizeInput(
  input: MthdsListMethodsInput,
): { ok: true; input: NormalizedCatalogInput } | { ok: false; errors: ToolError[] } {
  const parsed = mthdsListMethodsInputObjectSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        class: "input_domain",
        ...(issue.path.length === 0 ? {} : { location: issue.path.join(".") }),
        message: issue.message,
        hint: `Use query as text, limit as an integer from 1 to ${CATALOG_MAX_LIMIT}, and offset as a non-negative integer.`,
        retryable: false,
      })),
    };
  }

  return {
    ok: true,
    input: {
      query: parsed.data.query?.trim() ?? "",
      limit: parsed.data.limit ?? CATALOG_DEFAULT_LIMIT,
      offset: parsed.data.offset ?? 0,
    },
  };
}

/** Validate, filter, sort, page, and bound the full SDK response immediately. */
export function projectCatalog(value: unknown, input: NormalizedCatalogInput): CatalogResult {
  if (!Array.isArray(value)) {
    throw new Error("Methods catalog response must be an array.");
  }

  const rows = value.map(validateRow);
  const query = input.query.toLowerCase();
  const matched = rows
    .filter((row) => query === "" || searchableFields(row).some((field) => field.includes(query)))
    .sort(compareRows);
  const page = matched.slice(input.offset, input.offset + input.limit).map(projectRow);
  const nextOffset =
    input.offset + page.length < matched.length ? input.offset + page.length : null;

  const structuredContent: CatalogSuccess = {
    status: "ok",
    total_count: rows.length,
    matched_count: matched.length,
    returned_count: page.length,
    next_offset: nextOffset,
    methods: page,
  };

  return { structuredContent, summary: catalogSummary(structuredContent, input.query) };
}

interface ValidatedRow {
  method_id: string;
  name: string;
  description: string | null;
  mthds: string;
  updated_at: string;
}

function validateRow(value: unknown, index: number): ValidatedRow {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Methods catalog row ${index} must be an object.`);
  }

  const row = value as Record<string, unknown>;
  for (const field of ["method_id", "name", "updated_at", "mthds"] as const) {
    if (typeof row[field] !== "string") {
      throw new Error(`Methods catalog row ${index} is missing string field ${field}.`);
    }
  }
  if (
    row.description !== undefined &&
    row.description !== null &&
    typeof row.description !== "string"
  ) {
    throw new Error(`Methods catalog row ${index} has a non-string description.`);
  }

  return {
    method_id: row.method_id as string,
    name: row.name as string,
    description: (row.description as string | null | undefined) ?? null,
    mthds: row.mthds as string,
    updated_at: row.updated_at as string,
  };
}

function searchableFields(row: ValidatedRow): string[] {
  return [row.method_id, row.name, row.description ?? ""].map((field) => field.toLowerCase());
}

function compareRows(left: ValidatedRow, right: ValidatedRow): number {
  const byName = compareStrings(left.name.toLowerCase(), right.name.toLowerCase());
  return byName !== 0 ? byName : compareStrings(left.method_id, right.method_id);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function projectRow(row: ValidatedRow): CatalogMethod {
  const name = boundCodePoints(row.name, CATALOG_NAME_LIMIT);
  const description =
    row.description === null ? null : boundCodePoints(row.description, CATALOG_DESCRIPTION_LIMIT);
  return {
    method_id: row.method_id,
    name: name.value,
    name_truncated: name.truncated,
    description: description?.value ?? null,
    description_truncated: description?.truncated ?? false,
    has_source: methodSourceToContents(row.mthds).length > 0,
    updated_at: row.updated_at,
  };
}

function boundCodePoints(value: string, limit: number): { value: string; truncated: boolean } {
  const codePoints = Array.from(value);
  return {
    value: codePoints.slice(0, limit).join(""),
    truncated: codePoints.length > limit,
  };
}

function catalogSummary(result: CatalogSuccess, query: string): string {
  const lines = [
    `Organization method catalog: ${result.total_count} total, ${result.matched_count} matched, ${result.returned_count} returned.`,
  ];

  for (const method of result.methods) {
    const description =
      method.description === null ? "no description" : JSON.stringify(method.description);
    const source = method.has_source
      ? "source present (not a validation/runnable verdict)"
      : "draft: no MTHDS source; do not use by reference";
    lines.push(
      `- ${JSON.stringify(method.name)} — method_id ${JSON.stringify(method.method_id)}; ${description}; ${source}.`,
    );
  }

  if (result.next_offset !== null) {
    const queryHint = query === "" ? "the same query" : `query ${JSON.stringify(query)}`;
    lines.push(
      `More matches are available: call mthds_list_methods with ${queryHint} and offset ${result.next_offset}.`,
    );
  }

  return lines.join("\n");
}

function catalogErrorOptions(context: CatalogContext): ClassifyErrorOptions {
  return {
    route: "/v1/methods",
    badRequest: {
      class: "config",
      location: context.authError?.location ?? "PIPELEX_API_KEY",
      hint: "The methods catalog needs an active organization context. Use a platform key minted for the intended organization, then retry.",
    },
    auth: context.authError,
  };
}

function summaryForError(error: ToolError): string {
  switch (error.class) {
    case "config":
      return "Method catalog could not be listed: the Pipelex API or catalog access is misconfigured.";
    case "input_domain":
      return "Method catalog was not listed: the Pipelex API rejected the request.";
    case "runtime":
      return "Method catalog could not be listed: the Pipelex API returned an error.";
  }
}

function errorResult(summary: string, errors: ToolError[]): CatalogResult {
  return { structuredContent: { status: "error", errors }, summary };
}

export function catalogToolResult(result: CatalogResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(
      result.summary,
      result.structuredContent.status === "error" ? result.structuredContent.errors : undefined,
    ),
    isError: result.structuredContent.status === "error",
  };
}
