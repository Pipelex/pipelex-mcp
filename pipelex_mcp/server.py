import logging
import sys
from pathlib import Path
from typing import Any, Dict

from mcp.server.fastmcp import FastMCP
from pipelex.core.stuff_content import ImageContent, ListContent
from pipelex.core.working_memory_factory import WorkingMemoryFactory
from pipelex.hub import get_pipe_provider
from pipelex.pipelex import Pipelex
from pipelex.pipeline.execute import execute_pipeline

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

# ──────────────────────────── MCP helpers ──────────────────────────────────


def mcp_print(*args: Any, **kwargs: Any) -> None:
    """
    Print *only* to Cursor's MCP channel (original stdout).
    Flush immediately so Cursor sees each line as it happens.
    """
    print(*args, **kwargs, file=sys.__stdout__, flush=True)


mcp = FastMCP("pipelex")


@mcp.tool()
async def list_pipes() -> Dict[str, Dict[str, Dict[str, str]]]:
    """List the available pipes to use."""
    pipe_provider = get_pipe_provider()
    pipes = pipe_provider.get_pipes()

    result: Dict[str, Dict[str, Dict[str, str]]] = {}
    for pipe in pipes:
        if pipe.domain not in result:
            result[pipe.domain] = {}

        result[pipe.domain][pipe.code] = {
            "definition": pipe.definition or "",
            "input_concept_code": ", ".join([ipt for ipt in pipe.inputs.concepts]) or "",
            "output_concept_code": pipe.output_concept_code or "",
        }

    return result


@mcp.tool()
async def generate_company_mascott(company_context: str) -> ListContent[ImageContent]:
    """Generate multiple mascot options for a company using the complete design process.

    Args:
        company_context (str): Description of the company, its values, and visual preferences.
            Example: "A tech startup focused on sustainable energy, with modern and eco-friendly aesthetics"

    Returns:
        ListContent[ImageContent]: A list of generated images, where each image is:
            - A mascot design matching the company context
            - Accessible via a URL
            - Accompanied by a one-line description
    """
    working_memory = WorkingMemoryFactory.make_from_text(text=company_context, concept_str="mascot_generation.CompanyContext", name="company_context")

    pipe_output = await execute_pipeline(pipe_code="generate_mascot_options", working_memory=working_memory)

    # Example of using mcp_print for MCP communication
    mcp_print("Output the links of the images, and a one line description of the image")
    return pipe_output.main_stuff_as_list(item_type=ImageContent)


if __name__ == "__main__":
    Pipelex.make()
    mcp.run()
