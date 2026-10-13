import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import pkg from "../package.json" with { type: "json" };

import { mcpAppInfo, workshopHost } from "./capabilities/client-identification.js";
import type {
  AppInfoSource,
  McpClientInfo,
  McpShell,
} from "./capabilities/client-identification.js";
import { credentialsResolver } from "./credentials.js";
import type { CredentialsResolver } from "./credentials.js";
import { buildLocalToolContexts, localToolDefinitions, patchLocalApiContexts } from "./tools.js";
import type { LocalToolContexts, LocalToolDefinition } from "./tools.js";

// Version is sourced from the workshop's own package.json so the MCP handshake
// always reports the shipped release — the /release skill bumps package.json
// alone, and a hardcoded copy here would silently drift (it did: 0.1.0 vs a
// 0.4.0 package). The workshop is the Pipelex plugin's server, so it is named
// `pipelex-plugin`; the Pipelex connector, a separate product, is `pipelex`.
export const LOCAL_SERVER_INFO = {
  name: "pipelex-plugin",
  version: pkg.version,
} as const;

/**
 * The map, not the manual: what the workshop is for, the order of the steps,
 * the ways to name a method (stated once, a folder first for a method on
 * disk), and the rules that hold for every tool. Per-tool detail belongs to
 * the tool's own description, parameter detail to its field descriptions, and
 * what matters only after a call to the result summary — `npm run
 * check:tool-texts` holds this string under the length a host shows, and a
 * host that cuts keeps the head, so the order of the steps comes first.
 */
export const LOCAL_SERVER_INSTRUCTIONS = [
  "This is the Pipelex plugin's local workshop for executable AI methods written in MTHDS (.mthds).",
  "The usual flow: `mthds_list_methods` to find a saved method, `mthds_validate`,",
  "`mthds_inputs_template` and fill it, `mthds_prepare_inputs`, `mthds_run`, then",
  "`mthds_run_status` and `mthds_run_results` with the run id, and `mthds_show_images` to see",
  "a picture it produced or `mthds_download_artifacts` to save its output and files.",
  "A method only turns the inputs it is given into results; fetching from mail, drives or business",
  "systems, running on a schedule and writing back are up to whatever calls it.",
  "When the Pipelex connector's `pipelex_*` tools are also present, use these `mthds_*` tools for all",
  "method work and never mix the two, which can be signed in to different organizations.",
  "`mthds_codegen` turns a method into typed code, `mthds_models` checks model references,",
  "`mthds_save_method` saves a bundle as a draft, `mthds_get_method` pulls one back,",
  "and `mthds_publish_method` publishes it, only when the user asks.",
  "Every method-taking tool (`mthds_validate`, `mthds_inputs_template`, `mthds_codegen`,",
  "`mthds_prepare_inputs`, `mthds_run`) takes its method as its folder on disk (method_dir,",
  "preferred), files (`{ path }` over inline), a published address (method_ref) or a catalog id",
  "(mt_…, method_id); a bare id names the latest published version, mt_…@draft the draft, and a",
  "path resolves against the working directory.",
  "Call `mthds_list_methods` when the user asks what saved methods exist or names one without its",
  "mt_ id; choose by name and description and pass its id.",
  "`mthds_run` spends inference credit.",
  "A picture from `mthds_show_images` stays in the conversation,",
  "so show one when asked, never by reflex.",
  "This workshop has no views; report each result to the user yourself.",
].join(" ");

export interface LocalServerOptions {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  contexts?: LocalToolContexts;
  /**
   * Decides each tool call's key, base URL and auth-failure texture. When the
   * server builds its own contexts it defaults to `env` and the home `.env`
   * (`credentials.ts`); supplied `contexts` keep the values they carry unless
   * a resolver is supplied with them.
   */
  credentials?: CredentialsResolver;
}

export function createLocalServer(options: LocalServerOptions = {}): McpServer {
  const server = new McpServer(LOCAL_SERVER_INFO, {
    capabilities: {},
    instructions: LOCAL_SERVER_INSTRUCTIONS,
  });
  const env = options.env ?? process.env;
  // Every client a tool call builds names the workshop and the AI host driving
  // it: `pipelex-mcp/<v> (workshop; host=<name>/<version>)`. The host is the
  // `clientInfo` of the MCP `initialize` handshake, which is only known once
  // the host has connected — after these contexts exist — so it is read when
  // each client is constructed, never captured here. Applied to supplied
  // contexts too: the identity is the server's, not the caller's.
  const contexts = patchLocalApiContexts(
    options.contexts ?? buildLocalToolContexts(env, options.rootDir ?? process.cwd()),
    { appInfo: workshopAppInfoSource(() => server.server.getClientVersion()) },
  );
  const credentials =
    options.credentials ?? (options.contexts === undefined ? credentialsResolver(env) : undefined);

  for (const definition of localToolDefinitions) {
    registerLocalTool(server, definition, contexts, credentials);
  }

  return server;
}

/** The workshop as its `User-Agent` names it: its mode and the version it shipped as. */
const WORKSHOP_SHELL: McpShell = { mode: "workshop", version: LOCAL_SERVER_INFO.version };

/**
 * The workshop's identity, read from the handshake each time a client is built.
 * Before `initialize` (no tool call can arrive then) or from a host that sent
 * an unusable name, the `host=` parameter is simply left out.
 */
export function workshopAppInfoSource(clientInfo: () => McpClientInfo | undefined): AppInfoSource {
  return () => mcpAppInfo(WORKSHOP_SHELL, workshopHost(clientInfo()));
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
  credentials: CredentialsResolver | undefined,
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
    async (input) =>
      (await tool.handler(input, await callContexts(contexts, credentials))) as CallToolResult,
  );
}

/**
 * The contexts one tool call runs over. The key and its base URL are decided
 * afresh for every call, so a key saved in the home `.env` while the session
 * runs is used from the next call, and every capability keeps reading plain
 * `baseUrl` and `apiKey` fields. Every field is written on every call, `apiKey`
 * and `baseUrlSource` included when they are `undefined`, so no call inherits
 * another's.
 */
async function callContexts(
  contexts: LocalToolContexts,
  credentials: CredentialsResolver | undefined,
): Promise<LocalToolContexts> {
  if (credentials === undefined) return contexts;
  const { baseUrl, apiKey, authError, baseUrlSource } = await credentials();
  return patchLocalApiContexts(contexts, { baseUrl, apiKey, authError, baseUrlSource });
}
