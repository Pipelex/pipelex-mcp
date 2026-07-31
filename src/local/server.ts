import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import { PIPELEX_MCP_SERVER_INFO, buildToolContexts, toolDefinitions } from "../tools.js";
import type { AnyToolDefinition, ToolContexts } from "../tools.js";
import { localFileResolver } from "./files.js";

export const LOCAL_SERVER_INSTRUCTIONS = [
  "pipelex-mcp is the local workshop for executable AI Methods written in the MTHDS language (.mthds).",
  "Prefer the `{ path: string }` file form for workspace .mthds files: paths are resolved relative to",
  "the directory where the host starts this server, and diagnostics keep that path as provenance.",
  "Inline `{ content: string, uri?: string }` files remain accepted for parity with the hosted console.",
  "Call `mthds_list_methods` when the user asks what saved methods exist, names one without its",
  "mt_ id, or a saved method may fit the task; choose or disambiguate by name and description,",
  "then pass the returned id into the current-content validate, inputs-template, and run flow.",
  "Use `mthds_validate` for a structured validation verdict and `mthds_inputs_template` for a pipe's",
  "fill-in input template — both accept files, or a registered method's catalog id via method_id.",
  "Once the template is filled, call `mthds_prepare_inputs` to make file-bearing inputs run-ready:",
  "this workshop uploads local file paths, data: URLs, and bytes to Pipelex storage with your API key",
  "and rewrites them to pipelex-storage:// references (http(s) URLs pass through unchanged).",
  "Start durable execution with `mthds_run` (from files, or from a registered",
  "method's catalog id via method_id), then use `mthds_run_status` and",
  "`mthds_run_results` with the returned run id. This tools-first workshop has no views at launch,",
  "so report the structured result and text summary directly to the user.",
].join(" ");

export interface LocalServerOptions {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  contexts?: ToolContexts;
}

export function buildLocalToolContexts(
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = process.cwd(),
): ToolContexts {
  return buildToolContexts({
    env,
    resolver: localFileResolver(rootDir),
    viewsAvailable: false,
    // The workshop is co-located with the user's files, so it uploads
    // file-bearing inputs (local paths, data: URLs, bytes) for mthds_prepare_inputs.
    allowUpload: true,
  });
}

export function createLocalServer(options: LocalServerOptions = {}): McpServer {
  const contexts =
    options.contexts ?? buildLocalToolContexts(options.env, options.rootDir ?? process.cwd());
  const server = new McpServer(PIPELEX_MCP_SERVER_INFO, {
    capabilities: {},
    instructions: LOCAL_SERVER_INSTRUCTIONS,
  });

  for (const definition of toolDefinitions) {
    registerLocalTool(server, definition, contexts);
  }

  return server;
}

interface ErasedToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  outputSchema: ZodRawShapeCompat | AnySchema;
  annotations: AnyToolDefinition["annotations"];
  handler: (input: unknown, contexts: ToolContexts) => Promise<unknown>;
}

function registerLocalTool(
  server: McpServer,
  definition: AnyToolDefinition,
  contexts: ToolContexts,
): void {
  // The table retains each handler's precise input type for the hosted typed
  // chain. Registration through the plain SDK is necessarily homogeneous at
  // this loop boundary; the SDK validates input before this erased dispatch.
  const tool = definition as ErasedToolDefinition;
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    },
    async (input) => (await tool.handler(input, contexts)) as CallToolResult,
  );
}
