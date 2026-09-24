import { McpServer } from "skybridge/server";
import type { OAuthConfig } from "skybridge/server";

import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import pkg from "../../package.json" with { type: "json" };

import { contextsForRequest } from "./contexts.js";
import {
  buildHostedToolContexts,
  mthdsCodegenTool,
  mthdsInputsTemplateTool,
  mthdsListMethodsTool,
  mthdsPrepareInputsTool,
  mthdsRunResultsTool,
  mthdsRunStatusTool,
  mthdsRunTool,
  mthdsShowImagesTool,
  mthdsUploadAttachmentsTool,
  mthdsValidateTool,
  pipelexRequestUploadTool,
} from "./tools.js";
import type { HostedToolContexts, HostedToolDefinition } from "./tools.js";

/**
 * Sourced from package.json, like the workshop's `LOCAL_SERVER_INFO`, so the
 * handshake reports the shipped release.
 */
export const HOSTED_SERVER_INFO = {
  name: "pipelex-mcp",
  version: pkg.version,
} as const;

/**
 * The map, not the manual — the same layering as the workshop's
 * `LOCAL_SERVER_INSTRUCTIONS`, which says why: per-tool detail lives in each
 * tool's description, and `npm run check:tool-texts` holds this string under
 * the length a host shows.
 */
export const HOSTED_SERVER_INSTRUCTIONS = [
  "pipelex-mcp helps you work with executable AI methods written in MTHDS (.mthds).",
  "The usual flow: `mthds_list_methods` to find a saved method, `mthds_validate`,",
  "`mthds_inputs_template` and fill it, `mthds_prepare_inputs`, `mthds_run`, then",
  "`mthds_run_status` and `mthds_run_results` with the run id, and `mthds_show_images` to see a",
  "picture the run produced.",
  "`mthds_codegen` turns a method into typed code for the user's project.",
  "Every method-taking tool (`mthds_validate`, `mthds_inputs_template`, `mthds_codegen`,",
  "`mthds_prepare_inputs`, `mthds_run`) takes its method one of three ways: the file contents you",
  "hold, a published method's address as method_ref, or a catalog id (mt_…) as method_id.",
  "An address or an id is resolved server-side, so no bundle enters the conversation.",
  "Call `mthds_list_methods` when the user asks what saved methods exist, names one without its",
  "mt_ id, or a saved method may fit the task; choose by name and description, then pass the id on.",
  "When the user attaches a file to the conversation, `mthds_upload_attachments` turns it into a",
  "run-ready pipelex-storage:// reference to fill into the inputs.",
  "`mthds_prepare_inputs` passes http(s) URLs and pipelex-storage:// references through and",
  "refuses a value that would need an upload.",
  "A valid `mthds_validate` verdict also shows the user an interactive graph of the method, and a",
  "runnable one a run form whose file inputs take a file picked from the user's device: point a",
  "user who holds a file but no URL there.",
  "`mthds_run` executes on the hosted Pipelex API and spends inference credit.",
  "A picture from `mthds_show_images` stays in the conversation for every turn that follows,",
  "so show one when it is asked for, not by reflex.",
].join(" ");

/**
 * Build the hosted console.
 *
 * `oauth` is **required**: per-user OAuth is the console's only auth posture,
 * so a console that cannot authenticate a caller is not a thing this function
 * can produce. Making it a parameter rather than resolving it here keeps the
 * builder synchronous — the shell tests construct the server directly and have
 * no business awaiting an OAuth discovery fetch. The entrypoint (`../server.ts`)
 * resolves it from env and refuses to boot without it.
 */
export function createHostedServer(
  oauth: OAuthConfig,
  contexts: HostedToolContexts = buildHostedToolContexts(),
) {
  return (
    new McpServer(
      HOSTED_SERVER_INFO,
      {
        capabilities: {},
        instructions: HOSTED_SERVER_INSTRUCTIONS,
      },
      // `oauth` belongs to SkybridgeServerOptions — the THIRD constructor
      // argument. Putting it in the second (the MCP SDK's ServerOptions) is
      // silently accepted and simply never read, so the well-known metadata and
      // bearer middleware are never mounted and clients fall back to DCR against
      // our own origin ("Cannot POST /register").
      //
      // Nothing of ours is mounted on `/mcp`: Skybridge's own bearer middleware
      // owns `req.auth` and, since no console tool allows anonymous, it mounts
      // `requireBearerAuth` across the endpoint. Writing that field ourselves is
      // exactly the race that made the old bring-your-own-key posture
      // incompatible with OAuth.
      { oauth },
    )
      // The console's table, in the order a host lists it. One chained call
      // per tool rather than a loop, because the chain is what types
      // `AppType`, which the views' `useToolInfo` / `useCallTool` read.
      .registerTool(hostedToolConfig(mthdsListMethodsTool), (input, extra) =>
        mthdsListMethodsTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsValidateTool), (input, extra) =>
        mthdsValidateTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsInputsTemplateTool), (input, extra) =>
        mthdsInputsTemplateTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsCodegenTool), (input, extra) =>
        mthdsCodegenTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsPrepareInputsTool), (input, extra) =>
        mthdsPrepareInputsTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsUploadAttachmentsTool), (input, extra) =>
        mthdsUploadAttachmentsTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsRunTool), (input, extra) =>
        mthdsRunTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsRunStatusTool), (input, extra) =>
        mthdsRunStatusTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsRunResultsTool), (input, extra) =>
        mthdsRunResultsTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(mthdsShowImagesTool), (input, extra) =>
        mthdsShowImagesTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      // App-only: the run-graph view calls it, the model never does.
      .registerTool(hostedToolConfig(pipelexRequestUploadTool), (input, extra) =>
        pipelexRequestUploadTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
  );
}

/**
 * The registration config Skybridge takes, read off one of the console's
 * definitions: everything but the handler, with `view` passed only where the
 * tool has one. The casts are not redundant: without them the object literal
 * widens each field to its constraint, the chain infers a schema of `any`, and
 * every handler below stops typechecking against its capability's input.
 */
function hostedToolConfig<
  TTool extends HostedToolDefinition<
    string,
    ZodRawShapeCompat,
    ZodRawShapeCompat | AnySchema,
    never,
    unknown
  >,
>(tool: TTool) {
  return {
    name: tool.name as TTool["name"],
    description: tool.description,
    inputSchema: tool.inputSchema as TTool["inputSchema"],
    outputSchema: tool.outputSchema as TTool["outputSchema"],
    annotations: tool.annotations,
    ...(tool.view === undefined ? {} : { view: tool.view }),
    _meta: tool._meta,
  };
}
