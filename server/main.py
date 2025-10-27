from __future__ import annotations

import argparse
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

import fastmcp.settings
from fastmcp import Context, FastMCP
from pipelex import log
from pipelex.builder.bundle_spec import PipelexBundleSpec
from pipelex.builder.runner_code import generate_input_memory_json_string
from pipelex.core.memory.working_memory_factory import WorkingMemoryFactory
from pipelex.hub import get_library_manager
from pipelex.language.plx_factory import PlxFactory
from pipelex.pipelex import Pipelex
from pipelex.pipeline.execute import execute_pipeline
from pipelex.pipeline.validate_plx import validate_plx
from typing_extensions import TypedDict

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
    with _silence_stdout():
        await ctx.info("Starting pipeline build", extra={"brief_length": len(untouched_user_request)})

        pipe_output = await execute_pipeline(
            pipe_code="pipe_builder",
            inputs={"brief": untouched_user_request},
        )

        pipelex_bundle_spec = pipe_output.working_memory.get_stuff_as(
            name="pipelex_bundle_spec",
            content_type=PipelexBundleSpec,
        )
        blueprint = pipelex_bundle_spec.to_blueprint()
        plx_content = PlxFactory.make_plx_content(blueprint=blueprint)
        (
            _,
            pipes,
        ) = await validate_plx(plx_content, remove_after_validation=True)
        # in the pipes, get the one that has the code "blueprint.main_pipe".
        main_pipe = next((pipe for pipe in pipes if pipe.code == blueprint.main_pipe), None)
        if main_pipe is None:
            msg = "Main pipe not found"
            log.error(msg)
            raise ValueError(msg)
        inputs_json = generate_input_memory_json_string(main_pipe.inputs)

        # Save PLX content to file
        results_dir = Path("results/mcp")
        results_dir.mkdir(parents=True, exist_ok=True)
        plx_file = results_dir / "plx_content.plx"
        plx_file.write_text(plx_content, encoding="utf-8")

        await ctx.info("Pipeline built successfully", extra={"plx_content_length": len(plx_content)})
        return {"plx_content": plx_content, "inputs_format_to_run": inputs_json}


@mcp.tool(description="Run a Pipelex pipeline (optionally with PLX content)")
async def pipe_runner(
    plx_content: str, specific_pipe_code_if_plx_content_has_no_main_pipe: str | None, inputs_json: dict[str, Any] | None, ctx: Context
) -> dict[str, Any] | None:
    """Run a Pipelex pipeline with optional PLX content.

    Args:
        plx_content: The Pipelex PLX code defining the pipeline(s) and concepts.
        specific_pipe_code_if_plx_content_has_no_main_pipe: The specific pipe to execute. Optional if plx_content defines a
                   "main_pipe" (will use that by default). Required if plx_content
                   does NOT specify a main_pipe.
        inputs_json: Dictionary of input parameters for the pipeline in JSON format.
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

        working_memory = WorkingMemoryFactory.make_from_pipeline_inputs(pipeline_inputs=inputs_json or {})

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
