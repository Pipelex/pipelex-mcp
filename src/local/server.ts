import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import pkg from "../../package.json" with { type: "json" };

import { mcpAppInfo, workshopHost } from "../capabilities/client-identification.js";
import type { AppInfoSource, McpClientInfo } from "../capabilities/client-identification.js";
import { buildLocalToolContexts, localToolDefinitions, patchLocalApiContexts } from "./tools.js";
import type { LocalToolContexts, LocalToolDefinition } from "./tools.js";

// Version is sourced from package.json so the MCP handshake always reports the
// shipped release — the /release skill bumps package.json alone, and a
// hardcoded copy here would silently drift (it did: 0.1.0 vs a 0.4.0 package).
export const LOCAL_SERVER_INFO = {
  name: "pipelex-mcp",
  version: pkg.version,
} as const;

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
  "to see a picture it produced, or `mthds_download_artifacts` to save its output and files to disk.",
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
  contexts?: LocalToolContexts;
}

export function createLocalServer(options: LocalServerOptions = {}): McpServer {
  const server = new McpServer(LOCAL_SERVER_INFO, {
    capabilities: {},
    instructions: LOCAL_SERVER_INSTRUCTIONS,
  });
  // Every client a tool call builds names the workshop and the AI host driving
  // it: `pipelex-mcp/<v> (workshop; host=<name>/<version>)`. The host is the
  // `clientInfo` of the MCP `initialize` handshake, which is only known once
  // the host has connected — after these contexts exist — so it is read when
  // each client is constructed, never captured here. Applied to supplied
  // contexts too: the identity is the shell's, not the caller's.
  const contexts = patchLocalApiContexts(
    options.contexts ?? buildLocalToolContexts(options.env, options.rootDir ?? process.cwd()),
    { appInfo: workshopAppInfoSource(() => server.server.getClientVersion()) },
  );

  for (const definition of localToolDefinitions) {
    registerLocalTool(server, definition, contexts);
  }

  return server;
}

/**
 * The workshop's identity, read from the handshake each time a client is built.
 * Before `initialize` (no tool call can arrive then) or from a host that sent
 * an unusable name, the `host=` parameter is simply left out.
 */
export function workshopAppInfoSource(clientInfo: () => McpClientInfo | undefined): AppInfoSource {
  return () => mcpAppInfo("workshop", workshopHost(clientInfo()));
}

interface ErasedToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  outputSchema: ZodRawShapeCompat | AnySchema;
  annotations: LocalToolDefinition["annotations"];
  handler: (input: unknown, contexts: LocalToolContexts) => Promise<unknown>;
}

function registerLocalTool(
  server: McpServer,
  definition: LocalToolDefinition,
  contexts: LocalToolContexts,
): void {
  // The table retains each handler's precise input type. Registration through
  // the plain SDK is necessarily homogeneous at this loop boundary; the SDK
  // validates input before this erased dispatch.
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
