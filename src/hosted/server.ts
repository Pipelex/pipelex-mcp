import { McpServer } from "skybridge/server";

import {
  PIPELEX_MCP_SERVER_INFO,
  buildToolContexts,
  mthdsInputsTemplateTool,
  mthdsRunResultsTool,
  mthdsRunStatusTool,
  mthdsRunTool,
  mthdsValidateTool,
} from "../tools.js";
import type { ToolContexts } from "../tools.js";

export const HOSTED_SERVER_INSTRUCTIONS = [
  "pipelex-mcp helps you work with executable AI Methods written in the MTHDS language (.mthds).",
  "Call `mthds_validate` with the file contents you hold to get a stable, structured verdict",
  "(is_valid / is_runnable, validation errors, pending signatures).",
  "When the method is valid, the tool also returns an interactive dry-run graph of the method,",
  "rendered through the run-graph view.",
  "Call `mthds_inputs_template` with the same file contents to get a fill-in template of a pipe's",
  "declared inputs, ready to populate for a run.",
  "Run a method durably with `mthds_run` (start by files + pipe + inputs, returns a durable run id),",
  "then check on it with `mthds_run_status` and fetch the outcome with `mthds_run_results` by that id.",
].join(" ");

export function createHostedServer(contexts: ToolContexts = buildToolContexts()) {
  return new McpServer(PIPELEX_MCP_SERVER_INFO, {
    capabilities: {},
    instructions: HOSTED_SERVER_INSTRUCTIONS,
  })
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
      (input) => mthdsValidateTool.handler(input, contexts),
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
      (input) => mthdsInputsTemplateTool.handler(input, contexts),
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
      (input) => mthdsRunTool.handler(input, contexts),
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
      (input) => mthdsRunStatusTool.handler(input, contexts),
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
      (input) => mthdsRunResultsTool.handler(input, contexts),
    );
}
