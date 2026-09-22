import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import {
  PIPELEX_MCP_SERVER_INFO,
  buildToolContexts,
  toolDefinitions,
  workshopOnlyToolDefinitions,
} from "../tools.js";
import type { AnyToolDefinition, ToolContexts } from "../tools.js";
import { localFileResolver } from "./files.js";

/**
 * The map, not the manual: what the workshop is for, the order of the steps,
 * the three ways to name a method (stated once), and the rules that hold for
 * every tool. Per-tool detail belongs to the tool's own description, parameter
 * detail to its field descriptions, and what matters only after a call to the
 * result summary — `npm run check:tool-texts` holds this string under the
 * length a host shows, and a host that cuts keeps the head, so the order of
 * the steps comes first.
 */
export const LOCAL_SERVER_INSTRUCTIONS = [
  "pipelex-mcp is the local workshop for executable AI methods written in MTHDS (.mthds).",
  "The usual flow: `mthds_list_methods` to find a saved method, `mthds_validate`,",
  "`mthds_inputs_template` and fill it, `mthds_prepare_inputs`, `mthds_run`, then",
  "`mthds_run_status` and `mthds_run_results` with the run id, and finally `mthds_show_images`",
  "or `mthds_download_artifacts` for the files the run produced.",
  "`mthds_codegen` turns a method into typed code for the project you are in, and",
  "`mthds_save_method` and `mthds_get_method` push a bundle to the catalog and pull one back.",
  "Every method-taking tool (`mthds_validate`, `mthds_inputs_template`, `mthds_codegen`,",
  "`mthds_prepare_inputs`, `mthds_run`) takes its method one of three ways: files, a published",
  "method's address as method_ref, or a catalog id (mt_…) as method_id.",
  "An address or an id is resolved server-side, so no bundle enters the conversation.",
  "Prefer the `{ path: string }` file form for workspace .mthds files: a path is resolved against",
  "the directory this server was started in, and diagnostics name it.",
  "Inline `{ content: string, uri?: string }` files are accepted too.",
  "Call `mthds_list_methods` when the user asks what saved methods exist or names one without its",
  "mt_ id; choose by name and description, then pass the id on.",
  "`mthds_run` executes on the hosted Pipelex API and spends inference credit.",
  "A picture from `mthds_show_images` stays in the conversation for every turn that follows,",
  "so show one when it is asked for, not by reflex.",
  "This workshop has no views: report the structured result and the text summary to the user.",
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
    // A second resolver, gated on `.py`, for mthds_save_method's `python`. The
    // extension IS the read boundary, so one resolver serving both arguments
    // would let each read the other's files.
    pythonResolver: localFileResolver(rootDir, ".py"),
    viewsAvailable: false,
    // The workshop is co-located with the user's files, so it uploads
    // file-bearing inputs (local paths, data: URLs, bytes) for mthds_prepare_inputs.
    allowUpload: true,
    // ...and, in the other direction, writes under that same working
    // directory: run artifacts for mthds_download_artifacts, generated trees
    // for mthds_codegen's output_dir.
    workspaceRoot: rootDir,
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
  // The workshop-only table — the mirror of the console's `consoleOnlyToolDefinitions`.
  for (const definition of workshopOnlyToolDefinitions) {
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
