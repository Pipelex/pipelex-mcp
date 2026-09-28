/**
 * The names each shell gives its tools, as the capability core writes them into
 * model-facing text: result summaries, error hints and schema descriptions.
 *
 * The two servers do not share a tool name (`wip/mcp-server-split/design.md`,
 * D1 and D2): the workshop keeps `mthds_*`, the console calls its tools
 * `pipelex_*`, and the console has no validate, inputs-template, prepare,
 * codegen or download tool at all. So a sentence that names a tool is a
 * sentence about ONE shell, and the capability that writes it is handed that
 * shell's vocabulary on its context rather than a string it would have to
 * rewrite. Each vocabulary carries only the tools its shell registers, and
 * `shell` discriminates them, so a text that would name a tool the other shell
 * does not have has to be written twice, once per shell, and the compiler says
 * where.
 *
 * Every context defaults to the workshop's vocabulary, which is what every text
 * said before the console was renamed; the console states its own on each
 * context it builds (its `src/hosted/tools.ts`).
 *
 * Shell-free and dependency-free: the workshop's bundle reaches it.
 */

export const WORKSHOP_TOOL_NAMES = {
  shell: "workshop",
  listMethods: "mthds_list_methods",
  validate: "mthds_validate",
  inputsTemplate: "mthds_inputs_template",
  codegen: "mthds_codegen",
  prepareInputs: "mthds_prepare_inputs",
  run: "mthds_run",
  runStatus: "mthds_run_status",
  runResults: "mthds_run_results",
  showImages: "mthds_show_images",
  downloadArtifacts: "mthds_download_artifacts",
  saveMethod: "mthds_save_method",
  getMethod: "mthds_get_method",
} as const;

export const CONSOLE_TOOL_NAMES = {
  shell: "console",
  listMethods: "pipelex_list_methods",
  showMethod: "pipelex_show_method",
  uploadAttachments: "pipelex_upload_attachments",
  run: "pipelex_run",
  runStatus: "pipelex_run_status",
  runResults: "pipelex_run_results",
  showImages: "pipelex_show_images",
  requestUpload: "pipelex_request_upload",
} as const;

export type WorkshopToolNames = typeof WORKSHOP_TOOL_NAMES;
export type ConsoleToolNames = typeof CONSOLE_TOOL_NAMES;

/** One shell's vocabulary; branch on `shell` for a tool only one of them has. */
export type ToolNames = WorkshopToolNames | ConsoleToolNames;
