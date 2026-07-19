import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import {
  buildInputsContext,
  buildMthdsInputs,
  inputsToolResult,
  mthdsInputsInputSchema,
  mthdsInputsOutputSchema,
} from "./capabilities/inputs.js";
import type { InputsContext, MthdsInputsInput } from "./capabilities/inputs.js";
import {
  buildRunContext,
  getMthdsRunResults,
  getMthdsRunStatus,
  mthdsRunInputSchema,
  mthdsRunOutputSchema,
  mthdsRunResultsInputSchema,
  mthdsRunResultsOutputSchema,
  mthdsRunStatusInputSchema,
  mthdsRunStatusOutputSchema,
  runResultsToolResult,
  runStatusToolResult,
  runToolResult,
  startMthdsRun,
} from "./capabilities/run.js";
import type { MthdsRunInput, RunContext, RunIdInput } from "./capabilities/run.js";
import type { FileResolver } from "./capabilities/shared.js";
import {
  buildValidationContext,
  mthdsValidateInputSchema,
  mthdsValidateOutputSchema,
  toolResult,
  validateMthds,
} from "./capabilities/validate.js";
import type { MthdsValidateInput, ValidationContext } from "./capabilities/validate.js";

export const PIPELEX_MCP_SERVER_INFO = {
  name: "pipelex-mcp",
  version: "0.1.0",
} as const;

export interface ToolContexts {
  validation: ValidationContext;
  inputs: InputsContext;
  run: RunContext;
}

interface ToolContextOptions {
  env?: NodeJS.ProcessEnv;
  resolver?: FileResolver;
  viewsAvailable?: boolean;
}

/** Build one capability-context set for either deployment shell. */
export function buildToolContexts(options: ToolContextOptions = {}): ToolContexts {
  const env = options.env ?? process.env;
  const resolver = options.resolver;
  const viewsAvailable = options.viewsAvailable ?? true;

  return {
    validation: {
      ...buildValidationContext(env),
      resolver,
      viewsAvailable,
    },
    inputs: {
      ...buildInputsContext(env),
      resolver,
    },
    run: {
      ...buildRunContext(env),
      resolver,
      viewsAvailable,
    },
  };
}

interface ToolDefinition<
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
  handler: (input: TInput, contexts: ToolContexts) => Promise<TResult>;
}

function defineTool<
  const TName extends string,
  TInputSchema extends ZodRawShapeCompat,
  TOutputSchema extends ZodRawShapeCompat | AnySchema,
  TInput,
  TResult,
>(
  definition: ToolDefinition<TName, TInputSchema, TOutputSchema, TInput, TResult>,
): ToolDefinition<TName, TInputSchema, TOutputSchema, TInput, TResult> {
  return definition;
}

export const mthdsValidateTool = defineTool({
  name: "mthds_validate",
  description: "Validate submitted MTHDS file contents with the local Pipelex API.",
  inputSchema: mthdsValidateInputSchema,
  outputSchema: mthdsValidateOutputSchema,
  annotations: {
    title: "Validate MTHDS files",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input: MthdsValidateInput, contexts: ToolContexts) {
    return toolResult(await validateMthds(input, contexts.validation));
  },
});

export const mthdsInputsTemplateTool = defineTool({
  name: "mthds_inputs_template",
  description:
    "Project a pipe's declared inputs as a fill-in template from submitted MTHDS file contents.",
  inputSchema: mthdsInputsInputSchema,
  outputSchema: mthdsInputsOutputSchema,
  annotations: {
    title: "Build MTHDS inputs template",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input: MthdsInputsInput, contexts: ToolContexts) {
    return inputsToolResult(await buildMthdsInputs(input, contexts.inputs));
  },
});

export const mthdsRunTool = defineTool({
  name: "mthds_run",
  description:
    "Start a durable run of a MTHDS method from submitted file contents, a pipe to run, and filled inputs. " +
    "Executes the method on the hosted Pipelex API and spends inference credit. " +
    "Validate the bundle with mthds_validate and fill the inputs template from mthds_inputs_template first — " +
    "the hosted API rejects a bad bundle at start with an opaque server error. " +
    "Returns the durable run id immediately (never blocks); follow up with mthds_run_status and mthds_run_results.",
  inputSchema: mthdsRunInputSchema,
  outputSchema: mthdsRunOutputSchema,
  annotations: {
    title: "Run MTHDS method",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input: MthdsRunInput, contexts: ToolContexts) {
    return runToolResult(await startMthdsRun(input, contexts.run));
  },
});

export const mthdsRunStatusTool = defineTool({
  name: "mthds_run_status",
  description:
    "Check on a durable MTHDS run by its run id — one cheap status read. " +
    "Honor the retry hint in the response instead of polling in a tight loop.",
  inputSchema: mthdsRunStatusInputSchema,
  outputSchema: mthdsRunStatusOutputSchema,
  annotations: {
    title: "Check MTHDS run status",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input: RunIdInput, contexts: ToolContexts) {
    return runStatusToolResult(await getMthdsRunStatus(input, contexts.run));
  },
});

export const mthdsRunResultsTool = defineTool({
  name: "mthds_run_results",
  description:
    "Fetch the results of a durable MTHDS run by its run id: the main output when completed, " +
    "the failure details when failed, or a retry hint while still running.",
  inputSchema: mthdsRunResultsInputSchema,
  outputSchema: mthdsRunResultsOutputSchema,
  annotations: {
    title: "Fetch MTHDS run results",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input: RunIdInput, contexts: ToolContexts) {
    return runResultsToolResult(await getMthdsRunResults(input, contexts.run));
  },
});

/** The cross-shell MCP contract, in registration order. */
export const toolDefinitions = [
  mthdsValidateTool,
  mthdsInputsTemplateTool,
  mthdsRunTool,
  mthdsRunStatusTool,
  mthdsRunResultsTool,
] as const;

export type AnyToolDefinition = (typeof toolDefinitions)[number];
