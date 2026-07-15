import { McpServer } from "skybridge/server";
import {
  buildInputsContext,
  buildMthdsInputs,
  inputsToolResult,
  mthdsInputsInputSchema,
  mthdsInputsOutputSchema,
} from "./capabilities/inputs.js";
import {
  buildValidationContext,
  mthdsValidateInputSchema,
  mthdsValidateOutputSchema,
  toolResult,
  validateMthds,
} from "./capabilities/validate.js";

const server = new McpServer(
  {
    name: "pipelex-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {},
    instructions: [
      "pipelex-mcp helps you work with executable AI Methods written in the MTHDS language (.mthds).",
      "Call `mthds_validate` with the file contents you hold to get a stable, structured verdict",
      "(is_valid / is_runnable, validation errors, pending signatures).",
      "When the method is valid, the tool also returns an interactive dry-run graph of the method,",
      "rendered through the run-graph view.",
      "Call `mthds_inputs` with the same file contents to get a fill-in template of a pipe's",
      "declared inputs, ready to populate for a run.",
    ].join(" "),
  },
)
  .registerTool(
    {
      name: "mthds_validate",
      description: "Validate submitted MTHDS file contents with the local Pipelex API.",
      inputSchema: mthdsValidateInputSchema,
      outputSchema: mthdsValidateOutputSchema,
      annotations: {
        title: "Validate MTHDS files",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      view: {
        component: "run-graph",
        description: "Interactive run graph of the method (the dry-run graph from validation).",
      },
      _meta: {
        "openai/toolInvocation/invoking": "Validating MTHDS files...",
        "openai/toolInvocation/invoked": "MTHDS validation finished.",
      },
    },
    async (input) => {
      const result = await validateMthds(input, buildValidationContext());
      return toolResult(result);
    },
  )
  .registerTool(
    {
      name: "mthds_inputs",
      description:
        "Project a pipe's declared inputs as a fill-in template from submitted MTHDS file contents.",
      inputSchema: mthdsInputsInputSchema,
      outputSchema: mthdsInputsOutputSchema,
      annotations: {
        title: "Build MTHDS inputs template",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Projecting MTHDS inputs template...",
        "openai/toolInvocation/invoked": "MTHDS inputs template finished.",
      },
    },
    async (input) => {
      const result = await buildMthdsInputs(input, buildInputsContext());
      return inputsToolResult(result);
    },
  );

export default await server.run();

export type AppType = typeof server;
