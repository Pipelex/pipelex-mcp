import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

/**
 * One MCP tool as the workshop registers it: the contract a host is shown
 * (name, description, schemas, annotations) and the handler that answers a
 * call over the workshop's capability contexts.
 *
 * This is the shape the workshop's tool table is written in, not the table:
 * the table is `src/tools.ts` in the workshop's package, and what it is built
 * from is the capability core in `capabilities/`.
 *
 * Type imports only: the workshop's bundle reaches this module.
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
 * its handler's precise input type in the workshop's table, which erases them
 * only at the one registration loop in its `src/server.ts`.
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
