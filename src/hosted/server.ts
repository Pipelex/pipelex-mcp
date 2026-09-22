import { McpServer } from "skybridge/server";
import type { OAuthConfig } from "skybridge/server";

import {
  PIPELEX_MCP_SERVER_INFO,
  buildToolContexts,
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
} from "../tools.js";
import type { ToolContexts } from "../tools.js";
import { contextsForRequest } from "./contexts.js";

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
  "This console uploads nothing else: `mthds_prepare_inputs` passes http(s) URLs and",
  "pipelex-storage:// references through and refuses a value that would need an upload.",
  "A valid `mthds_validate` verdict also shows the user an interactive graph of the method.",
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
 * builder synchronous — the cross-shell parity tests construct the server
 * directly and have no business awaiting an OAuth discovery fetch. The
 * entrypoint (`../server.ts`) resolves it from env and refuses to boot without
 * it.
 */
export function createHostedServer(
  oauth: OAuthConfig,
  contexts: ToolContexts = buildToolContexts(),
) {
  return new McpServer(
    PIPELEX_MCP_SERVER_INFO,
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
    .registerTool(
      {
        name: mthdsListMethodsTool.name,
        description: mthdsListMethodsTool.description,
        inputSchema: mthdsListMethodsTool.inputSchema,
        outputSchema: mthdsListMethodsTool.outputSchema,
        annotations: mthdsListMethodsTool.annotations,
        _meta: {
          "openai/toolInvocation/invoking": "Listing registered methods...",
          "openai/toolInvocation/invoked": "Registered methods listed.",
        },
      },
      (input, extra) =>
        mthdsListMethodsTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsValidateTool.name,
        description: mthdsValidateTool.description,
        inputSchema: mthdsValidateTool.inputSchema,
        outputSchema: mthdsValidateTool.outputSchema,
        annotations: mthdsValidateTool.annotations,
        view: {
          component: "run-graph",
          description:
            "Interactive run graph of the method (the dry-run graph from validation), plus an input form to run it.",
        },
        _meta: {
          "openai/toolInvocation/invoking": "Validating MTHDS files...",
          "openai/toolInvocation/invoked": "MTHDS validation finished.",
        },
      },
      (input, extra) =>
        mthdsValidateTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsInputsTemplateTool.name,
        description: mthdsInputsTemplateTool.description,
        inputSchema: mthdsInputsTemplateTool.inputSchema,
        outputSchema: mthdsInputsTemplateTool.outputSchema,
        annotations: mthdsInputsTemplateTool.annotations,
        _meta: {
          "openai/toolInvocation/invoking": "Projecting MTHDS inputs template...",
          "openai/toolInvocation/invoked": "MTHDS inputs template finished.",
        },
      },
      (input, extra) =>
        mthdsInputsTemplateTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsCodegenTool.name,
        description: mthdsCodegenTool.description,
        inputSchema: mthdsCodegenTool.inputSchema,
        outputSchema: mthdsCodegenTool.outputSchema,
        annotations: mthdsCodegenTool.annotations,
        _meta: {
          "openai/toolInvocation/invoking": "Generating typed code for the method...",
          "openai/toolInvocation/invoked": "Typed code generated.",
        },
      },
      (input, extra) =>
        mthdsCodegenTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsPrepareInputsTool.name,
        description: mthdsPrepareInputsTool.description,
        inputSchema: mthdsPrepareInputsTool.inputSchema,
        outputSchema: mthdsPrepareInputsTool.outputSchema,
        annotations: mthdsPrepareInputsTool.annotations,
        _meta: {
          "openai/toolInvocation/invoking": "Preparing MTHDS run inputs...",
          "openai/toolInvocation/invoked": "MTHDS run inputs prepared.",
        },
      },
      (input, extra) =>
        mthdsPrepareInputsTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsUploadAttachmentsTool.name,
        description: mthdsUploadAttachmentsTool.description,
        inputSchema: mthdsUploadAttachmentsTool.inputSchema,
        outputSchema: mthdsUploadAttachmentsTool.outputSchema,
        annotations: mthdsUploadAttachmentsTool.annotations,
        _meta: {
          // THE mechanism: naming `attachments` here is what makes the ChatGPT
          // host rewrite the model's file reference into the four-field
          // signed-URL object. Without it the field is never populated.
          "openai/fileParams": ["attachments"],
          "openai/toolInvocation/invoking": "Uploading attachments to Pipelex storage...",
          "openai/toolInvocation/invoked": "Attachments uploaded.",
        },
      },
      (input, extra) =>
        mthdsUploadAttachmentsTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsRunTool.name,
        description: mthdsRunTool.description,
        inputSchema: mthdsRunTool.inputSchema,
        outputSchema: mthdsRunTool.outputSchema,
        annotations: mthdsRunTool.annotations,
        view: {
          component: "run-follow",
          description: "Live-following status card for the durable run.",
          csp: {
            // Run-output images are presigned URLs on the hosted platform's
            // per-env storage buckets — a tight host allowlist, never a
            // wildcard. Anything else in main_stuff stays CSP-blocked and the
            // view falls back to the text preview.
            resourceDomains: [
              "https://pipelex-app-dev.s3.us-west-2.amazonaws.com",
              "https://pipelex-app-staging.s3.us-west-2.amazonaws.com",
              "https://pipelex-app-prod.s3.us-west-2.amazonaws.com",
            ],
          },
        },
        _meta: {
          "openai/toolInvocation/invoking": "Starting MTHDS run...",
          "openai/toolInvocation/invoked": "MTHDS run started.",
        },
      },
      (input, extra) => mthdsRunTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsRunStatusTool.name,
        description: mthdsRunStatusTool.description,
        inputSchema: mthdsRunStatusTool.inputSchema,
        outputSchema: mthdsRunStatusTool.outputSchema,
        annotations: mthdsRunStatusTool.annotations,
        _meta: {
          "openai/toolInvocation/invoking": "Checking MTHDS run status...",
          "openai/toolInvocation/invoked": "MTHDS run status checked.",
        },
      },
      (input, extra) =>
        mthdsRunStatusTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsRunResultsTool.name,
        description: mthdsRunResultsTool.description,
        inputSchema: mthdsRunResultsTool.inputSchema,
        outputSchema: mthdsRunResultsTool.outputSchema,
        annotations: mthdsRunResultsTool.annotations,
        _meta: {
          "openai/toolInvocation/invoking": "Fetching MTHDS run results...",
          "openai/toolInvocation/invoked": "MTHDS run results fetched.",
        },
      },
      (input, extra) =>
        mthdsRunResultsTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    )
    .registerTool(
      {
        name: mthdsShowImagesTool.name,
        description: mthdsShowImagesTool.description,
        inputSchema: mthdsShowImagesTool.inputSchema,
        outputSchema: mthdsShowImagesTool.outputSchema,
        annotations: mthdsShowImagesTool.annotations,
        _meta: {
          "openai/toolInvocation/invoking": "Fetching the run's images...",
          "openai/toolInvocation/invoked": "Images fetched.",
        },
      },
      (input, extra) =>
        mthdsShowImagesTool.handler(input, contextsForRequest(contexts, extra.authInfo)),
    );
}
