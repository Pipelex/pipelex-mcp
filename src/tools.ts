import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import pkg from "../package.json" with { type: "json" };

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

// Version is sourced from package.json so the MCP handshake always reports the
// shipped release — the /release skill bumps package.json alone, and a
// hardcoded copy here would silently drift (it did: 0.1.0 vs a 0.4.0 package).
export const PIPELEX_MCP_SERVER_INFO = {
  name: "pipelex-mcp",
  version: pkg.version,
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
  description:
    "Validate MTHDS file contents with the Pipelex API — from submitted file contents, or from a registered method's catalog id (mt_…) passed as method_id. " +
    "A by-id call validates the method's CURRENT stored content and requires an API key, since the catalog is org-scoped. " +
    "With both files and method_id supplied, the files win and method_id is ignored.",
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
    "Project a pipe's declared inputs as a fill-in template — from submitted MTHDS file contents, or from a registered method's catalog id (mt_…) passed as method_id. " +
    "A by-id call projects from the method's CURRENT stored content and requires an API key, since the catalog is org-scoped. " +
    "With both files and method_id supplied, the files win and method_id is ignored.",
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
    "Start a durable run of a MTHDS method — from submitted file contents, or from a registered method's catalog id (mt_…) passed as method_id. " +
    "A by-id run executes the method's CURRENT stored content (methods are not versioned — it does not pin what you previously validated) and requires an API key, since the catalog is org-scoped. " +
    "With both files and method_id supplied, the files run and method_id is recorded as run-history linkage. " +
    "Executes the method on the hosted Pipelex API and spends inference credit. " +
    "When running from files, validate the bundle with mthds_validate and fill the inputs template from mthds_inputs_template first — " +
    "validation gives a structured, repairable verdict, where a start-time rejection only reports the failure. " +
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
