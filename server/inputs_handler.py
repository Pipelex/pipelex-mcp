from typing import Any

from pipelex.core.stuffs.structured_content import StructuredContent


class DictStuff(StructuredContent):
    concept: str
    content: Any


class PipelineInputs(StructuredContent):
    inputs: dict[str, DictStuff]
