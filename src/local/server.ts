import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

import {
  PIPELEX_MCP_SERVER_INFO,
  buildToolContexts,
  toolDefinitions,
  workshopOnlyToolDefinitions,
} from "../tools.js";
import type { AnyToolDefinition, ToolContexts } from "../tools.js";
import { localFileResolver } from "./files.js";

export const LOCAL_SERVER_INSTRUCTIONS = [
  "pipelex-mcp is the local workshop for executable AI Methods written in the MTHDS language (.mthds).",
  "Prefer the `{ path: string }` file form for workspace .mthds files: paths are resolved relative to",
  "the directory where the host starts this server, and diagnostics keep that path as provenance.",
  "Inline `{ content: string, uri?: string }` files remain accepted for parity with the hosted console.",
  "A method that already lives somewhere needs no files at all: name it by a published method's address",
  "as method_ref (github.com/<owner>/<repo>[/<selector>][@<tag>]) or by a registered method's catalog",
  "id (mt_…) as method_id, and it is resolved server-side with no bundle entering the conversation.",
  "Call `mthds_list_methods` when the user asks what saved methods exist or names one without its",
  "mt_ id; choose or disambiguate by name and description, then pass the returned id into the",
  "current-content validate, inputs-template, and run flow.",
  "The catalog is writable from here. `mthds_save_method` sends a bundle on disk to it — one call",
  "validates the files and saves those same bytes — with the ROOT .mthds file first, because the",
  "platform derives the method's listed description from it. Absent `method_id` creates, present",
  "updates: read it from `pipelex-method.json` beside the bundle when that file is there, which is",
  "what makes a second save an update instead of a duplicate, and tell the user to commit that file",
  "so a teammate updates the same method. `mthds_get_method` brings a saved method's files back —",
  "pass `output_dir` to write them to disk with the link file beside them, and use the inline arm",
  "only to read a method you cannot see on disk. It refuses a directory it does not own rather than",
  "overwriting it, and `overwrite` is for after you have asked the user.",
  "Use `mthds_validate` for a structured validation verdict and `mthds_inputs_template` for a pipe's",
  "fill-in input template — both take files, a method_ref address, or a method_id.",
  "Use `mthds_codegen` to project a method's concepts into typed code for the project you are in —",
  "TypeScript (target ts-zod) or Python (python-pydantic for a consumer, python-structures for a",
  "Pipelex host) — from files, a method_ref address, or a method_id. Pass `output_dir` (a dedicated",
  "generated directory such as src/generated/<method>/) so this workshop writes the tree and its",
  "codegen.lock straight to disk, verbatim, instead of returning the bytes through the conversation.",
  "Once the template is filled, call `mthds_prepare_inputs` — with files, a method_ref address, or a",
  "method_id — to make file-bearing inputs run-ready: this workshop uploads local file paths,",
  "data: URLs, and bytes to Pipelex storage with your API key and rewrites them to",
  "pipelex-storage:// references (http(s) URLs pass through unchanged).",
  "Start durable execution with `mthds_run` (from files, a method_ref address, or a method_id),",
  "then use `mthds_run_status` and `mthds_run_results` with the returned run id. When a completed",
  "run's output references stored files (images, PDFs, documents as pipelex-storage:// URIs), call",
  "`mthds_download_artifacts` with that run id to save them under the working directory — the",
  "presigned links in the results expire within the hour. When the results list",
  "`image_candidates` and the user wants to look at one,",
  "call `mthds_show_images` with that run id — it returns the pictures themselves, and a picture",
  "you show stays in the conversation for every turn that follows, so show one when it is asked",
  "for, not by reflex. This tools-first workshop has no views at launch,",
  "so report the structured result and text summary directly to the user.",
].join(" ");

export interface LocalServerOptions {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  contexts?: ToolContexts;
}

export function buildLocalToolContexts(
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = process.cwd(),
): ToolContexts {
  return buildToolContexts({
    env,
    resolver: localFileResolver(rootDir),
    // A second resolver, gated on `.py`, for mthds_save_method's `python`. The
    // extension IS the read boundary, so one resolver serving both arguments
    // would let each read the other's files.
    pythonResolver: localFileResolver(rootDir, ".py"),
    viewsAvailable: false,
    // The workshop is co-located with the user's files, so it uploads
    // file-bearing inputs (local paths, data: URLs, bytes) for mthds_prepare_inputs.
    allowUpload: true,
    // ...and, in the other direction, writes under that same working
    // directory: run artifacts for mthds_download_artifacts, generated trees
    // for mthds_codegen's output_dir.
    workspaceRoot: rootDir,
  });
}

export function createLocalServer(options: LocalServerOptions = {}): McpServer {
  const contexts =
    options.contexts ?? buildLocalToolContexts(options.env, options.rootDir ?? process.cwd());
  const server = new McpServer(PIPELEX_MCP_SERVER_INFO, {
    capabilities: {},
    instructions: LOCAL_SERVER_INSTRUCTIONS,
  });

  for (const definition of toolDefinitions) {
    registerLocalTool(server, definition, contexts);
  }
  // The workshop-only table — the mirror of the console's `consoleOnlyToolDefinitions`.
  for (const definition of workshopOnlyToolDefinitions) {
    registerLocalTool(server, definition, contexts);
  }

  return server;
}

interface ErasedToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  outputSchema: ZodRawShapeCompat | AnySchema;
  annotations: AnyToolDefinition["annotations"];
  handler: (input: unknown, contexts: ToolContexts) => Promise<unknown>;
}

function registerLocalTool(
  server: McpServer,
  definition: AnyToolDefinition,
  contexts: ToolContexts,
): void {
  // The table retains each handler's precise input type for the hosted typed
  // chain. Registration through the plain SDK is necessarily homogeneous at
  // this loop boundary; the SDK validates input before this erased dispatch.
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
