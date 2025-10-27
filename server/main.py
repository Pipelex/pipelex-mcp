from __future__ import annotations

import argparse
import io
import logging
import os
import sys
from contextlib import redirect_stdout
from logging.handlers import RotatingFileHandler
from typing import Any

import fastmcp.settings
from fastmcp import Context, FastMCP
from fastmcp.utilities.logging import get_logger
from pipelex.builder.bundle_spec import PipelexBundleSpec
from pipelex.core.memory.working_memory_factory import WorkingMemoryFactory
from pipelex.hub import get_library_manager
from pipelex.language.plx_factory import PlxFactory
from pipelex.pipelex import Pipelex
from pipelex.pipeline.execute import execute_pipeline

from server.helpers import jsonify, validate_and_load_pipes


# ------------------------------------------------------------
# Logging (stderr or file) — absolutely nothing to stdout
# ------------------------------------------------------------
def configure_logging(level: str = "INFO", log_file: str | None = None) -> None:
    root = logging.getLogger()
    root.setLevel(level.upper())

    # Remove existing handlers (esp. ones that might default to stdout)
    for h in list(root.handlers):
        root.removeHandler(h)

    formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")

    if log_file:
        fh = RotatingFileHandler(log_file, maxBytes=5_000_000, backupCount=3)
        fh.setLevel(level.upper())
        fh.setFormatter(formatter)
        root.addHandler(fh)
    else:
        sh = logging.StreamHandler(sys.stderr)  # <- stderr, not stdout
        sh.setLevel(level.upper())
        sh.setFormatter(formatter)
        root.addHandler(sh)


log = get_logger(__name__)

# Disable the FastMCP CLI banner (prevents ASCII art on stdout)
fastmcp.settings.show_cli_banner = False  # type: ignore[attr-defined]

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


# ------------------------------------------------------------
# Tools
# ------------------------------------------------------------
@mcp.tool(description="Build a Pipelex pipeline from a natural language brief")
async def pipe_builder(brief: str, ctx: Context) -> str:
    with _silence_stdout():
        try:
            await ctx.info("Starting pipeline build", extra={"brief_length": len(brief)})

            pipe_output = await execute_pipeline(
                pipe_code="pipe_builder",
                inputs={"brief": brief},
            )

            pipelex_bundle_spec = pipe_output.working_memory.get_stuff_as(
                name="pipelex_bundle_spec",
                content_type=PipelexBundleSpec,
            )
            blueprint = pipelex_bundle_spec.to_blueprint()
            plx_content = PlxFactory.make_plx_content(blueprint=blueprint)

            await ctx.info("Pipeline built successfully", extra={"plx_content_length": len(plx_content)})
            return plx_content

        except Exception as e:
            log.exception("Error building pipeline")
            await ctx.error(f"Failed to build pipeline: {e!s}")
            return f"Failed to build pipeline: {e!s}"


@mcp.tool(description="Run a Pipelex pipeline (optionally with PLX content)")
async def pipe_runner(pipe_code: str, plx_content: str | None, inputs: dict[str, Any] | None, ctx: Context) -> dict[str, Any] | None:
    with _silence_stdout():
        await ctx.info(
            "Starting pipeline execution",
            extra={
                "pipe_code": pipe_code,
                "has_plx_content": plx_content is not None,
                "has_inputs": inputs is not None,
            },
        )

        working_memory = WorkingMemoryFactory.make_from_pipeline_inputs(pipeline_inputs=inputs or {})

        if plx_content:
            library_manager = get_library_manager()
            blueprint, _, _ = await validate_and_load_pipes(plx_content)
            try:
                pipe_output = await execute_pipeline(
                    pipe_code=blueprint.main_pipe or pipe_code,
                    inputs=working_memory,
                )
            finally:
                library_manager.remove_from_blueprint(blueprint=blueprint)
        else:
            pipe_output = await execute_pipeline(
                pipe_code=pipe_code,
                inputs=working_memory,
            )

        # JSON-safe summary
        wm_json = None
        try:
            wm_json = jsonify(getattr(pipe_output, "working_memory", None))
        except Exception as ser_e:
            await ctx.warning(f"Could not serialize working memory: {ser_e!s}")
            wm_json = None

        await ctx.info("Pipeline execution completed", extra={"pipe_code": pipe_code})
        return wm_json


@mcp.tool(description="Simple health check")
async def health() -> dict[str, str]:
    return {"status": "ok", "server": "pipelex", "version": "2.0.0"}


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

    # Logging (stderr/file only)
    configure_logging(args.log_level, args.log_file)

    # Initialize Pipelex before starting transport (silence any stray prints)
    log.info("Initializing Pipelex…")
    with _silence_stdout():
        Pipelex.make()
    log.info("Pipelex initialized")

    if args.transport == "http":
        log.info("Starting Pipelex MCP Server on HTTP at %s:%s", args.host, args.port)
        mcp.run(transport="http", host=args.host, port=args.port)
    else:
        log.info("Starting Pipelex MCP Server on stdio")
        mcp.run()


if __name__ == "__main__":
    main()
