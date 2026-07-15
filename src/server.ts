import { McpServer } from "skybridge/server";
import {
  buildInputsContext,
  buildMthdsInputs,
  inputsToolResult,
  mthdsInputsInputSchema,
  mthdsInputsOutputSchema,
} from "./capabilities/inputs.js";
import {
  buildRunContext,
  getMthdsRunResults,
  getMthdsRunStatus,
  mthdsRunInputSchema,
  mthdsRunOutputSchema,
  mthdsRunResultsInputSchema,
  mthdsRunResultsOutputSchema,
  mthdsRunStatusInputSchema,
  mthdsRunStatusOutputSchema,
  runResultsToolResult,
  runStatusToolResult,
  runToolResult,
  startMthdsRun,
} from "./capabilities/run.js";
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
      "Run a method durably with `mthds_run` (start by files + pipe + inputs, returns a durable run id),",
      "then check on it with `mthds_run_status` and fetch the outcome with `mthds_run_results` by that id.",
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
  )
  .registerTool(
    {
      name: "mthds_run",
      description:
        "Start a durable run of a MTHDS method from submitted file contents, a pipe to run, and filled inputs. " +
        "Executes the method on the hosted Pipelex API and spends inference credit. " +
        "Validate the bundle with mthds_validate and fill the inputs template from mthds_inputs first — " +
        "the hosted API rejects a bad bundle at start with an opaque server error. " +
        "Returns the durable run id immediately (never blocks); follow up with mthds_run_status and mthds_run_results.",
      inputSchema: mthdsRunInputSchema,
      outputSchema: mthdsRunOutputSchema,
      annotations: {
        title: "Run MTHDS method",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Starting MTHDS run...",
        "openai/toolInvocation/invoked": "MTHDS run started.",
      },
    },
    async (input) => {
      const result = await startMthdsRun(input, buildRunContext());
      return runToolResult(result);
    },
  )
  .registerTool(
    {
      name: "mthds_run_status",
      description:
        "Check on a durable MTHDS run by its run id — one cheap status read. " +
        "Honor the retry hint in the response instead of polling in a tight loop.",
      inputSchema: mthdsRunStatusInputSchema,
      outputSchema: mthdsRunStatusOutputSchema,
      annotations: {
        title: "Check MTHDS run status",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Checking MTHDS run status...",
        "openai/toolInvocation/invoked": "MTHDS run status checked.",
      },
    },
    async (input) => {
      const result = await getMthdsRunStatus(input, buildRunContext());
      return runStatusToolResult(result);
    },
  )
  .registerTool(
    {
      name: "mthds_run_results",
      description:
        "Fetch the results of a durable MTHDS run by its run id: the main output when completed, " +
        "the failure details when failed, or a retry hint while still running.",
      inputSchema: mthdsRunResultsInputSchema,
      outputSchema: mthdsRunResultsOutputSchema,
      annotations: {
        title: "Fetch MTHDS run results",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Fetching MTHDS run results...",
        "openai/toolInvocation/invoked": "MTHDS run results fetched.",
      },
    },
    async (input) => {
      const result = await getMthdsRunResults(input, buildRunContext());
      return runResultsToolResult(result);
    },
  );

export default await server.run();

export type AppType = typeof server;
