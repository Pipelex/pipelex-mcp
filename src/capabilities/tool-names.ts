/**
 * The names the workshop gives its tools, as the capability core writes them
 * into model-facing text: result summaries, error hints and schema
 * descriptions.
 *
 * A sentence that names another tool takes the name from here rather than
 * spelling it, so a renamed tool cannot leave a text pointing at a name that
 * no longer exists. The Pipelex connector's `pipelex_*` tools are a separate
 * product (L-260923-d3c264) and are never named by the core.
 *
 * Dependency-free: the workshop's bundle reaches it.
 */

export const WORKSHOP_TOOL_NAMES = {
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
  publishMethod: "mthds_publish_method",
} as const;
