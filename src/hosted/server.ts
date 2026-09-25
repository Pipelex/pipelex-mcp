import { McpServer } from "skybridge/server";
import type { OAuthConfig } from "skybridge/server";

import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import pkg from "../../package.json" with { type: "json" };

import { consoleHost, userAgentOf } from "../capabilities/client-identification.js";
import type { RequestHeaders } from "../capabilities/client-identification.js";
import { CONSOLE_TOOL_NAMES } from "../capabilities/tool-names.js";
import { contextsForRequest } from "./contexts.js";
import {
  buildHostedToolContexts,
  pipelexListMethodsTool,
  pipelexRequestUploadTool,
  pipelexRunResultsTool,
  pipelexRunStatusTool,
  pipelexRunTool,
  pipelexShowImagesTool,
  pipelexShowMethodTool,
  pipelexUploadAttachmentsTool,
} from "./tools.js";
import type { HostedToolContexts, HostedToolDefinition } from "./tools.js";

const NAMES = CONSOLE_TOOL_NAMES;

/**
 * Sourced from package.json, like the workshop's `LOCAL_SERVER_INFO`, so the
 * handshake reports the shipped release. The console is the Pipelex MCP, so it
 * is named `pipelex`; the workshop, the Pipelex plugin's server, is
 * `pipelex-plugin`.
 */
export const HOSTED_SERVER_INFO = {
  name: "pipelex",
  version: pkg.version,
} as const;

/**
 * The map, not the manual — the same layering as the workshop's
 * `LOCAL_SERVER_INSTRUCTIONS`, which says why: per-tool detail lives in each
 * tool's description, and `npm run check:tool-texts` holds every variant under
 * the length a host shows. A host that cuts keeps the head, so the flow comes
 * first and the per-host sentence last.
 */
const HOSTED_INSTRUCTIONS_BODY = [
  "The Pipelex connector runs executable AI methods on the hosted Pipelex API: methods saved in your Pipelex organization, or published by address.",
  `The usual flow: \`${NAMES.listMethods}\` to find a saved method, \`${NAMES.showMethod}\` for its signature and inputs template,`,
  `\`${NAMES.uploadAttachments}\` if the user attached files, \`${NAMES.run}\`, then \`${NAMES.runStatus}\` and`,
  `\`${NAMES.runResults}\` with the run id, and \`${NAMES.showImages}\` to see a picture the run produced.`,
  "When the Pipelex plugin's `mthds_*` tools are also present, use them for all method work instead of these, and never mix the two servers: each can be signed in to a different organization.",
  `\`${NAMES.showMethod}\` and \`${NAMES.run}\` take a saved method's catalog id (mt_…) as method_id or a published method's address as method_ref, resolved server-side.`,
  `Call \`${NAMES.listMethods}\` when the user asks what saved methods exist, names one without its`,
  "mt_ id, or a saved method may fit the task; choose by name and description, then pass the id on.",
  `A file input takes an http(s) URL or a pipelex-storage:// reference; a file attached to the conversation goes through \`${NAMES.uploadAttachments}\` first.`,
  `\`${NAMES.run}\` spends inference credit.`,
  `A picture from \`${NAMES.showImages}\` stays in the conversation for every turn that follows,`,
  "so show one when it is asked for, not by reflex.",
];

/**
 * The closing sentence for a host that renders views: the user sees the
 * method's graph and form, so after a show the model must leave them the
 * choice, and must not start the run the form is about to start.
 */
const VIEWS_SENTENCE = [
  `This host shows views: \`${NAMES.showMethod}\` shows the user the method's graph and an input form with a Run button, and a run shows a live status card.`,
  "After a show, unless the user already gave you the input values, let them choose between the form and the chat,",
  `and never call \`${NAMES.run}\` while they may be using the form: the method would run twice.`,
].join(" ");

/**
 * The closing sentence for a host that renders none: nothing shows the user a
 * form, so the model asks for the values itself.
 */
const NO_VIEWS_SENTENCE = [
  `This host shows no views, so no form: after \`${NAMES.showMethod}\`, ask the user for the input values`,
  `in chat unless they already gave them, then fill the template and call \`${NAMES.run}\`.`,
].join(" ");

/** The instructions a host that renders views receives. */
export const HOSTED_SERVER_INSTRUCTIONS_WITH_VIEWS = [
  ...HOSTED_INSTRUCTIONS_BODY,
  VIEWS_SENTENCE,
].join(" ");

/** The instructions a host that renders no views receives. */
export const HOSTED_SERVER_INSTRUCTIONS_WITHOUT_VIEWS = [
  ...HOSTED_INSTRUCTIONS_BODY,
  NO_VIEWS_SENTENCE,
].join(" ");

/**
 * The instructions a client declaring nothing receives, and the ones the
 * constructor carries. It is the no-views variant, because that is the safe
 * error: a model told of a form on a host that renders none waits for a user
 * who has nothing to fill in, while a model told of none on a host that has
 * one merely asks for values the user could also have typed into the form.
 */
export const HOSTED_SERVER_INSTRUCTIONS = HOSTED_SERVER_INSTRUCTIONS_WITHOUT_VIEWS;

/**
 * The MCP Apps extension's identifier in a client's declared capabilities
 * (`@modelcontextprotocol/ext-apps`' `EXTENSION_ID`), and the resource type
 * its views are served as (`RESOURCE_MIME_TYPE`). Restated rather than
 * imported: the package is not a dependency of this server, and the console's
 * bundle must not reach it.
 */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * Whether the host behind one `initialize` renders this console's views: it
 * declares the MCP Apps extension (with, when it lists its types, the one
 * these views are served as), or its `User-Agent` names ChatGPT, which renders
 * them without declaring the extension.
 */
export function hostRendersViews(
  capabilities: unknown,
  headers: RequestHeaders | undefined,
): boolean {
  if (consoleHost(userAgentOf(headers)) === "openai") return true;
  const extensions = recordOf(recordOf(capabilities)?.extensions);
  const declared = recordOf(extensions?.[MCP_APPS_EXTENSION_ID]);
  if (declared === undefined) return false;
  const mimeTypes = declared.mimeTypes;
  return !Array.isArray(mimeTypes) || mimeTypes.includes(MCP_APP_MIME_TYPE);
}

/** The instructions for a host that does, or does not, render views. */
export function hostedInstructionsFor(rendersViews: boolean): string {
  return rendersViews
    ? HOSTED_SERVER_INSTRUCTIONS_WITH_VIEWS
    : HOSTED_SERVER_INSTRUCTIONS_WITHOUT_VIEWS;
}

/**
 * The console's tool names before the split (design, D2). A host whose cached
 * tool list predates it still calls them; each is answered with the fix rather
 * than left to fail as an unknown tool, which would read as an outage.
 */
export const RETIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mthds_list_methods",
  "mthds_validate",
  "mthds_inputs_template",
  "mthds_codegen",
  "mthds_prepare_inputs",
  "mthds_upload_attachments",
  "mthds_run",
  "mthds_run_status",
  "mthds_run_results",
  "mthds_show_images",
]);

/** What a retired name answers: the one fix the user can apply. */
export const RETIRED_TOOL_MESSAGE =
  "This Pipelex connector's tool list is out of date: the tool you called no longer exists. " +
  "Tell the user to remove the Pipelex connector and add it again, which loads the current tools; nothing ran.";

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
      // Registered ahead of every tool, and before `run()`, which locks the
      // middleware in. Stateless: each request gets a fresh SDK server, so a
      // client's capabilities are readable at `initialize` and nowhere after;
      // the instructions are the one place a per-host sentence can ride.
      .mcpMiddleware("initialize", async (request, extra, next) => {
        const result = await next();
        return {
          ...result,
          instructions: hostedInstructionsFor(
            hostRendersViews(request.params.capabilities, extra.requestInfo?.headers),
          ),
        };
      })
      // A retired name is answered here, before the SDK looks it up: it is not
      // registered, so without this it would fail as an unknown tool.
      .mcpMiddleware("tools/call", async (request, _extra, next) => {
        if (RETIRED_TOOL_NAMES.has(request.params.name)) {
          return { content: [{ type: "text", text: RETIRED_TOOL_MESSAGE }], isError: true };
        }
        return next();
      })
      // The console's table, in the order a host lists it. One chained call
      // per tool rather than a loop, because the chain is what types
      // `AppType`, which the views' `useToolInfo` / `useCallTool` read.
      .registerTool(hostedToolConfig(pipelexListMethodsTool), (input, extra) =>
        pipelexListMethodsTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(pipelexShowMethodTool), (input, extra) =>
        pipelexShowMethodTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(pipelexUploadAttachmentsTool), (input, extra) =>
        pipelexUploadAttachmentsTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(pipelexRunTool), (input, extra) =>
        pipelexRunTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(pipelexRunStatusTool), (input, extra) =>
        pipelexRunStatusTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(pipelexRunResultsTool), (input, extra) =>
        pipelexRunResultsTool.handler(
          input,
          contextsForRequest(contexts, extra.authInfo, extra.requestInfo),
        ),
      )
      .registerTool(hostedToolConfig(pipelexShowImagesTool), (input, extra) =>
        pipelexShowImagesTool.handler(
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

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
