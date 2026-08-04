import { McpServer } from "skybridge/server";
import type { OAuthConfig } from "skybridge/server";

import {
  PIPELEX_MCP_SERVER_INFO,
  buildToolContexts,
  mthdsInputsTemplateTool,
  mthdsListMethodsTool,
  mthdsPrepareInputsTool,
  mthdsRunResultsTool,
  mthdsRunStatusTool,
  mthdsRunTool,
  mthdsUploadAttachmentsTool,
  mthdsValidateTool,
} from "../tools.js";
import type { ToolContexts } from "../tools.js";
import { byokKeyMiddleware, contextsForRequest, passthroughMiddleware } from "./byok.js";

export const HOSTED_SERVER_INSTRUCTIONS = [
  "pipelex-mcp helps you work with executable AI Methods written in the MTHDS language (.mthds).",
  "Call `mthds_list_methods` when the user asks what saved methods exist, names one without its",
  "mt_ id, or a saved method may fit the task; choose or disambiguate by name and description,",
  "then pass the returned id into the current-content validate, inputs-template, and run flow.",
  "Call `mthds_validate` with the file contents you hold (or a registered method's catalog id via",
  "method_id) to get a stable, structured verdict (is_valid / is_runnable, validation errors,",
  "pending signatures). When the method is valid, the tool also returns an interactive dry-run",
  "graph of the method, rendered through the run-graph view.",
  "Call `mthds_inputs_template` with the same file contents (or a registered method's catalog id",
  "via method_id) to get a fill-in template of a pipe's declared inputs, ready to populate for a run.",
  "Once the template is filled, call `mthds_prepare_inputs` to make file-bearing inputs run-ready",
  "(this hosted console is pass-through only — it accepts http(s) URLs and pipelex-storage:// references",
  "and refuses inputs that would need an upload; the local workshop uploads local files).",
  "When the user attaches a file to the conversation, call `mthds_upload_attachments` with that",
  "attachment to turn it into a run-ready pipelex-storage:// reference — its bytes never enter the",
  "conversation, and the reference can be filled straight into the inputs template.",
  "Run a method durably with `mthds_run` (start from files + pipe + inputs, or from a registered",
  "method's catalog id via method_id; returns a durable run id),",
  "then check on it with `mthds_run_status` and fetch the outcome with `mthds_run_results` by that id.",
].join(" ");

/**
 * Build the hosted console.
 *
 * `oauth` is resolved by the entrypoint rather than here so this stays
 * synchronous — the cross-shell parity tests construct the server directly and
 * have no business awaiting an OAuth discovery fetch. Passing it also flips the
 * transport auth posture: BYOK and OAuth cannot share `/mcp` (both write
 * `req.auth`), so the BYOK middleware stands down whenever an OAuth config is
 * present. See `../server.ts` for why the switch lives in env.
 */
export function createHostedServer(
  contexts: ToolContexts = buildToolContexts(),
  oauth?: OAuthConfig,
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
    // our own origin ("Cannot POST /register"). Pass `undefined` through
    // rather than spreading conditionally: a spread would defeat the
    // excess-property check that makes a wrong key a compile error here.
    { oauth },
  )
    .use("/mcp", oauth === undefined ? byokKeyMiddleware : passthroughMiddleware)
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
          description: "Interactive run graph of the method (the dry-run graph from validation).",
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
    );
}
