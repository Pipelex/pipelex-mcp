import logging
import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP
from pipelex.builder.bundle_spec import PipelexBundleSpec
from pipelex.client.protocol import PipelineInputs
from pipelex.core.memory.working_memory_factory import WorkingMemoryFactory
from pipelex.core.pipes.pipe_output import PipeOutput
from pipelex.hub import get_library_manager
from pipelex.language.plx_factory import PlxFactory
from pipelex.pipelex import Pipelex
from pipelex.pipeline.execute import execute_pipeline

from server.helpers import validate_and_load_pipes

LOG_DIR = Path("./logs")
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "pipelex.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        # Uncomment for mirrored logs in your dev console:
        logging.StreamHandler(sys.__stdout__),
    ],
)
logger = logging.getLogger("pipelex")

mcp = FastMCP("pipelex")

# ──────────────────────────── MCP helpers ──────────────────────────────────


@mcp.tool()
async def pipe_builder(brief: str) -> str:
    """Build a Pipelex pipeline based on a brief description in natural language.

    Args:
        brief: A brief description of the pipeline in natural language.

    Returns:
        str: The PLX content of the pipeline.
    """
    pipe_output = await execute_pipeline(
        pipe_code="pipe_builder",
        inputs={"brief": brief},
    )

    # Extract the pipelex bundle spec from the output
    pipelex_bundle_spec = pipe_output.working_memory.get_stuff_as(name="pipelex_bundle_spec", content_type=PipelexBundleSpec)

    # Generate PLX content from the blueprint
    blueprint = pipelex_bundle_spec.to_blueprint()
    return PlxFactory.make_plx_content(blueprint=blueprint)


@mcp.tool()
async def pipe_runner(plx_content: str, inputs: PipelineInputs) -> PipeOutput:
    """Run a Pipelex pipeline based on the provided PLX content and the inputs.
    To construct the inputs, favor DictStuff. 
    For example, if you want to pass a list of strings, you can use:
    ```
    inputs = {
        "my_text": DictStuff(concept="native.Text", content={"text": "Hello, world!"})
    }
    ```
    or the content can be the structure in the plx_content file.
    """
    library_manager = get_library_manager()
    blueprint, _, _ = await validate_and_load_pipes(plx_content)
    working_memory = WorkingMemoryFactory.make_from_pipeline_inputs(pipeline_inputs=inputs or {})

    pipe_output = await execute_pipeline(
        pipe_code=blueprint.main_pipe,
        inputs=working_memory,
    )

    library_manager.remove_from_blueprint(blueprint=blueprint)
    return pipe_output


def mcp_print(*args: Any, **kwargs: Any) -> None:
    """Print *only* to Cursor's MCP channel (original stdout).
    Flush immediately so Cursor sees each line as it happens.
    """
    print(*args, **kwargs, file=sys.__stdout__, flush=True)


if __name__ == "__main__":
    Pipelex.make()
    mcp.run()
