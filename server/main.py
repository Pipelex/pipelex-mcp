from __future__ import annotations

import argparse
import io
import json
import os
from contextlib import redirect_stdout
from itertools import groupby
from pathlib import Path
from typing import TYPE_CHECKING, Any

import fastmcp.settings
from fastmcp import Context, FastMCP
from pipelex import log
from pipelex.builder.builder_loop import BuilderLoop
from pipelex.builder.runner_code import generate_input_memory_json_string
from pipelex.config import get_config
from pipelex.core.memory.working_memory_factory import WorkingMemoryFactory
from pipelex.hub import get_library_manager, get_pipe_library
from pipelex.language.plx_factory import PlxFactory
from pipelex.pipelex import Pipelex
from pipelex.pipeline.execute import execute_pipeline
from pipelex.pipeline.validate_plx import validate_plx
from pipelex.tools.misc.file_utils import (
    ensure_directory_for_file_path,
    get_incremental_directory_path,
    save_text_to_path,
)
from typing_extensions import TypedDict

if TYPE_CHECKING:
    from pipelex.core.bundles.pipelex_bundle_blueprint import PipelexBundleBlueprint

# Disable the FastMCP CLI banner (prevents ASCII art on stdout)
fastmcp.settings.show_cli_banner = False  # pyright: ignore[reportAttributeAccessIssue]

mcp = FastMCP(
    name="pipelex",
    instructions="Build and run Pipelex pipelines.",
    version="2.0.0",
)


# ------------------------------------------------------------
# Utilities
# ------------------------------------------------------------
class _Sink(io.StringIO):
    """A sink that swallows writes (used to silence stray prints)."""

    def write(self, s: str) -> int:  # type: ignore[override]
        return len(s)


def _silence_stdout():
    """Context manager to silence stdout inside tools to protect JSON-RPC."""
    return redirect_stdout(_Sink())


class PipeBuilderResponse(TypedDict):
    plx_content: str
    inputs_format_to_run: str


# ------------------------------------------------------------
# Tools
# ------------------------------------------------------------
@mcp.tool(description="Build a Pipelex pipeline from a natural language request, do not modify it")
async def pipe_builder(untouched_user_request: str, ctx: Context) -> PipeBuilderResponse:
    """Build a Pipelex pipeline from a natural language request."""
    blueprint: PipelexBundleBlueprint | None = None
    try:
        with _silence_stdout():
            await ctx.info("Starting pipeline build", extra={"brief_length": len(untouched_user_request)})

            builder_loop = BuilderLoop()
            pipelex_bundle_spec = await builder_loop.build_and_fix(pipe_code="pipe_builder", inputs={"brief": untouched_user_request})
            get_library_manager().remove_from_blueprint(blueprint=pipelex_bundle_spec.to_blueprint())

            blueprint = pipelex_bundle_spec.to_blueprint()
            plx_content = PlxFactory.make_plx_content(blueprint=blueprint)
            (
                _,
                pipes,
            ) = await validate_plx(plx_content, remove_after_validation=False)
            # in the pipes, get the one that has the code "blueprint.main_pipe".
            main_pipe = next((pipe for pipe in pipes if pipe.code == blueprint.main_pipe), None)
            if main_pipe is None:
                msg = "Main pipe not found"
                log.error(msg)
                raise ValueError(msg)
            inputs_json = generate_input_memory_json_string(main_pipe.inputs)

            # Save PLX content to file
            builder_config = get_config().pipelex.builder_config
            bundle_file_name = f"{builder_config.default_bundle_file_name}.plx"

            # Generate single file: {base_dir}/{name}_01.plx
            dir_name = builder_config.default_directory_base_name
            extras_output_dir = get_incremental_directory_path(
                base_path=builder_config.default_output_dir,
                base_name=dir_name,
            )
            plx_file_path = os.path.join(extras_output_dir, bundle_file_name)

            # Save the PLX file
            ensure_directory_for_file_path(file_path=plx_file_path)
            plx_content = PlxFactory.make_plx_content(blueprint=pipelex_bundle_spec.to_blueprint())
            save_text_to_path(text=plx_content, path=plx_file_path)

            inputs_json_path = os.path.join(extras_output_dir, "inputs.json")
            save_text_to_path(text=inputs_json, path=inputs_json_path)

            await ctx.info("Pipeline built successfully", extra={"plx_content_length": len(plx_content)})
            return {"plx_content": plx_content, "inputs_format_to_run": inputs_json}
    except Exception:
        if blueprint is not None:
            get_library_manager().remove_from_blueprint(blueprint=blueprint)
        raise


@mcp.tool(description="Run a Pipelex pipeline (optionally with PLX content)")
async def pipe_runner(
    plx_content: str, specific_pipe_code_if_plx_content_has_no_main_pipe: str | None, inputs_json: dict[str, Any] | str | None, ctx: Context
) -> dict[str, Any] | None:
    """Run a Pipelex pipeline with optional PLX content.

    Args:
        plx_content: The Pipelex PLX code defining the pipeline(s) and concepts.
        specific_pipe_code_if_plx_content_has_no_main_pipe: The specific pipe to execute. Optional if plx_content defines a
                   "main_pipe" (will use that by default). Required if plx_content
                   does NOT specify a main_pipe.
        inputs_json: Input parameters for the pipeline. Can be either:
                - A dictionary of input parameters in JSON format
                - A JSON string that will be automatically parsed
                Must match the expected input structure of the pipe being executed.
                "inputs_format_to_run" shows how it should be formatted.
        ctx: The context of the pipeline execution.

    Returns:
        The output of the pipeline execution as a dictionary containing the working
        memory with all generated stuffs and results.
    """
    with _silence_stdout():
        await ctx.info(
            "Starting pipeline execution",
            extra={
                "specific_pipe_code_if_plx_content_has_no_main_pipe": specific_pipe_code_if_plx_content_has_no_main_pipe,
                "has_inputs": inputs_json is not None,
            },
        )

        # Handle case where MCP client sends inputs_json as a string instead of dict
        parsed_inputs: dict[str, Any] | None = None
        if inputs_json is not None:
            if isinstance(inputs_json, str):
                try:
                    parsed_inputs = json.loads(inputs_json)
                    await ctx.info("Converted string inputs to JSON", extra={"input_length": len(inputs_json)})
                except json.JSONDecodeError as e:
                    await ctx.error(f"Failed to parse inputs_json string as JSON: {e}")
                    msg = f"inputs_json must be valid JSON string or dict, got invalid JSON string: {e}"
                    raise ValueError(msg) from e
            else:
                # inputs_json is already a dict
                parsed_inputs = inputs_json

        working_memory = WorkingMemoryFactory.make_from_pipeline_inputs(pipeline_inputs=parsed_inputs or {})

        if plx_content:
            library_manager = get_library_manager()
            blueprint, _ = await validate_plx(plx_content, remove_after_validation=False)
            try:
                pipe_output = await execute_pipeline(
                    pipe_code=blueprint.main_pipe or specific_pipe_code_if_plx_content_has_no_main_pipe,
                    inputs=working_memory,
                )
            finally:
                library_manager.remove_from_blueprint(blueprint=blueprint)
        else:
            pipe_output = await execute_pipeline(
                pipe_code=specific_pipe_code_if_plx_content_has_no_main_pipe,
                inputs=working_memory,
            )

        # Save pipe output to file
        results_dir = Path("results/mcp")
        results_dir.mkdir(parents=True, exist_ok=True)
        output_file = results_dir / "pipe_output.json"
        output_data = pipe_output.model_dump(serialize_as_any=True)
        output_file.write_text(json.dumps(output_data, indent=2, ensure_ascii=False), encoding="utf-8")

        await ctx.info(
            "Pipeline execution completed",
            extra={"specific_pipe_code_if_plx_content_has_no_main_pipe": specific_pipe_code_if_plx_content_has_no_main_pipe},
        )
        return output_data


@mcp.tool(description="Simple health check")
async def health() -> dict[str, str]:
    return {"status": "ok", "server": "pipelex"}


@mcp.tool(description="List all available pipes in the Pipelex library")
async def list_available_pipes() -> dict[str, Any]:
    """List all available pipes in the Pipelex library.

    Returns:
        A formatted string listing all available pipes with their descriptions.
    """
    pipe_library = get_pipe_library()

    def _format_concept_code(concept_code: str | None, current_domain: str) -> str:
        """Format concept code by removing domain prefix if it matches current domain."""
        if not concept_code:
            return ""
        parts = concept_code.split(".")
        if len(parts) == 2 and parts[0] == current_domain:
            return parts[1]
        return concept_code

    pipes = pipe_library.get_pipes()

    # Sort pipes by domain and code
    ordered_items = sorted(pipes, key=lambda pipe: (pipe.domain or "", pipe.code or ""))

    # Create dictionary for return value
    pipes_dict: dict[str, dict[str, dict[str, str]]] = {}

    # Group by domain and create separate tables
    for domain, domain_pipes in groupby(ordered_items, key=lambda pipe: pipe.domain):
        if domain not in ["builder", "pipe_design", "concept", "inputs_handler"]:
            pipes_dict[domain] = {}

            for pipe in domain_pipes:
                inputs = pipe.inputs
                formatted_inputs = [f"{name}: {_format_concept_code(requirement.concept.code, domain)}" for name, requirement in inputs.items]

                pipes_dict[domain][pipe.code] = {
                    "description": pipe.description or "",
                    "inputs": ", ".join(formatted_inputs),
                    "output": _format_concept_code(pipe.output.code, domain),
                }

    return pipes_dict


# ------------------------------------------------------------
# Entrypoint
# ------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Pipelex MCP Server")
    parser.add_argument("--transport", choices=["stdio", "http"], default="stdio", help="Use 'stdio' for Claude/Cursor. Use 'http' for local dev.")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP host")
    parser.add_argument("--port", type=int, default=9003, help="HTTP port")
    parser.add_argument("--log-level", default=os.getenv("PIPELEX_MCP_LOG", "INFO"), help="Python logging level (default: INFO)")
    parser.add_argument("--log-file", default=os.getenv("PIPELEX_MCP_LOG_FILE"), help="If set, logs go to this file (rotating). Otherwise stderr.")
    args = parser.parse_args()

    # Initialize Pipelex before starting transport (silence any stray prints)
    with _silence_stdout():
        Pipelex.make()

    if args.transport == "http":
        mcp.run(transport="http", host=args.host, port=args.port)
    else:
        mcp.run()


if __name__ == "__main__":
    main()
