import { McpServer } from "skybridge/server";
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
  { capabilities: {} },
).registerTool(
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
    _meta: {
      "openai/toolInvocation/invoking": "Validating MTHDS files...",
      "openai/toolInvocation/invoked": "MTHDS validation finished.",
    },
  },
  async (input) => {
    const { structuredContent, summary } = await validateMthds(input, buildValidationContext());
    return toolResult(structuredContent, summary);
  },
);

export default await server.run();

export type AppType = typeof server;
