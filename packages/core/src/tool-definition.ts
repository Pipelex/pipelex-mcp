import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

/**
 * One MCP tool as a shell registers it: the contract a host is shown (name,
 * description, schemas, annotations) and the handler that answers a call over
 * that shell's own capability contexts.
 *
 * This is the shape both tool tables are written in, not a table: each shell
 * owns its table (`src/tools.ts` in the workshop's package, `src/hosted/tools.ts`
 * in the console's), and what the two share is the capability core in `capabilities/`,
 * never a definition. A tool that should behave differently on one shell is an
 * edit to that shell's table, not a flag on a shared one.
 *
 * Kept free of any Skybridge import: the workshop's bundle reaches this module.
 */
export interface ToolDefinition<
  TContexts,
  TName extends string,
  TInputSchema extends ZodRawShapeCompat,
  TOutputSchema extends ZodRawShapeCompat | AnySchema,
  TInput,
  TResult,
> {
  name: TName;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  annotations: ToolAnnotations;
  handler: (input: TInput, contexts: TContexts) => Promise<TResult>;
}

/**
 * Identity at runtime; it exists so a definition keeps its literal `name` and
 * its handler's precise input type, which the console's typed registration
 * chain needs.
 */
export function defineTool<
  TContexts,
  const TName extends string,
  TInputSchema extends ZodRawShapeCompat,
  TOutputSchema extends ZodRawShapeCompat | AnySchema,
  TInput,
  TResult,
>(
  definition: ToolDefinition<TContexts, TName, TInputSchema, TOutputSchema, TInput, TResult>,
): ToolDefinition<TContexts, TName, TInputSchema, TOutputSchema, TInput, TResult> {
  return definition;
}
