domain = "inputs_handler"
description = "Pipeline to parse user inputs and fill a JSON template"

[concept]
PipelineInputs = "The inputs of a pipe"

[concept.UserRawInput]
description = "Raw text input from user containing various data types like PDF links, image URLs, text, and JSON objects"
refines = "Text"

[pipe.parse_and_fill_inputs]
type = "PipeLLM"
description = "Parse user's raw inputs and fill the JSON template with appropriate values"
inputs = { json_template = "native.JSON", user_input = "UserRawInput" }
output = "PipelineInputs"
model = "llm_to_retrieve"
system_prompt = """You are a precise data extraction assistant. Your task is to parse unstructured user inputs and fill a JSON template with the appropriate values.

Guidelines:
- Carefully analyze the JSON template structure to understand what fields need to be filled
- Parse the user's raw input to extract relevant information for each field
- Match data types appropriately (strings for text, URLs for links, objects for nested structures)
- If a field cannot be determined from the user input, use null or an empty value as appropriate
- Preserve the exact structure of the template
- For URLs and file paths, extract them exactly as provided
- Return ONLY the filled JSON, with no additional text or explanations"""
prompt = """Fill the following JSON template with data extracted from the user's input.

JSON Template:
@json_template

User's Raw Input:
@user_input

Return the filled JSON with all available information from the user's input."""

