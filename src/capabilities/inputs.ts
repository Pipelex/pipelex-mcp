import { PipelexApiClient } from "@pipelex/sdk";
import type {
  BuildInputsRequest,
  BuildInputsResponse,
  BuildInputsValidReport,
  MthdsFileItem,
  ValidationErrorItem,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  buildApiConfig,
  classifyError,
  filesInputSchema,
  toolErrorSchema,
  validateRequest,
} from "./shared.js";
import type { ClassifyErrorOptions, SubmittedFile, ToolError } from "./shared.js";

const inputsTemplateFormatSchema = z.enum(["json", "toml"]);

export type InputsTemplateFormat = z.infer<typeof inputsTemplateFormatSchema>;

export const mthdsInputsInputSchema = {
  files: filesInputSchema,
  pipe_ref: z
    .string()
    .optional()
    .describe(
      "The pipe to project, as a qualified domain.pipe_code. Omit to default to the closure's declared main_pipe.",
    ),
  explicit: z
    .boolean()
    .optional()
    .describe(
      "Emit the ceremonial {concept, content} envelope per input. Defaults to false (the light shape).",
    ),
  format: inputsTemplateFormatSchema
    .optional()
    .describe(
      'Template encoding. "json" (default) returns a parsed object in `inputs`; "toml" returns raw TOML text in `inputs_toml`, preserving concept comments and key order.',
    ),
};

const inputsStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  pipe_ref: z
    .string()
    .optional()
    .describe("The resolved qualified pipe (domain.pipe_code) whose inputs were projected."),
  format: inputsTemplateFormatSchema.optional(),
  explicit: z.boolean().optional(),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The fill-in inputs template, as a parsed object (format "json").'),
  inputs_toml: z
    .string()
    .optional()
    .describe('The fill-in inputs template, as raw TOML text (format "toml").'),
  validation_errors: z.array(z.unknown()).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsInputsOutputSchema = inputsStructuredContentSchema;

export interface MthdsInputsInput {
  files: SubmittedFile[];
  pipe_ref?: string;
  explicit?: boolean;
  format?: InputsTemplateFormat;
}

export interface InputsStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  format?: InputsTemplateFormat;
  explicit?: boolean;
  inputs?: Record<string, unknown>;
  inputs_toml?: string;
  validation_errors?: unknown[];
  errors?: ToolError[];
}

export interface InputsResult {
  structuredContent: InputsStructuredContent;
  summary: string;
}

interface InputsClient {
  buildInputs(request: BuildInputsRequest): Promise<BuildInputsResponse>;
}

export interface InputsContext {
  baseUrl: string;
  apiKey?: string;
  client?: InputsClient;
}

export function buildInputsContext(env = process.env): InputsContext {
  return buildApiConfig(env);
}

const INPUTS_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/build/inputs",
  // A malformed closure is a produced 200 verdict on this route, so a 400/422
  // rejection is almost always the pipe selector: an unknown pipe_ref, an
  // unqualified one, or an unresolvable main_pipe default.
  badRequest: {
    location: "pipe_ref",
    hint: "Pass pipe_ref as a qualified domain.pipe_code; omitting it requires the closure to declare exactly one main_pipe.",
  },
};

export async function buildMthdsInputs(
  input: MthdsInputsInput,
  context: InputsContext = buildInputsContext(),
): Promise<InputsResult> {
  const inputErrors = validateInputsRequest(input);
  if (inputErrors.length > 0) {
    return errorResult("Inputs template was not run: request input is invalid.", inputErrors);
  }

  let report: BuildInputsResponse;
  try {
    const client =
      context.client ??
      new PipelexApiClient({
        baseUrl: context.baseUrl,
        apiKey: context.apiKey,
      });
    report = await client.buildInputs(toBuildInputsRequest(input));
  } catch (err) {
    const error = classifyError(err, INPUTS_ERROR_OPTIONS);
    return errorResult(summaryForError(error), [error]);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (e.g. a valid arm missing its template field) is a
  // reachable contract violation, surfaced as a runtime no-verdict error.
  try {
    return inputsResult(report);
  } catch (err) {
    return errorResult(
      "Inputs template produced no verdict: the Pipelex API returned a malformed report.",
      [
        {
          class: "runtime",
          message:
            err instanceof Error
              ? err.message
              : "The Pipelex API returned a malformed inputs report.",
          hint: "The API responded but its report was missing required fields; inspect pipelex-api logs.",
        },
      ],
    );
  }
}

function summaryForError(error: ToolError): string {
  switch (error.class) {
    case "config":
      return "Inputs template could not start: the Pipelex API is unreachable or misconfigured.";
    case "input_domain":
      return "Inputs template was not run: the Pipelex API rejected the request.";
    case "runtime":
      return "Inputs template could not be completed: the Pipelex API returned an error.";
  }
}

export function inputsToolResult(result: InputsResult) {
  return {
    structuredContent: result.structuredContent,
    content: [{ type: "text" as const, text: result.summary }],
    isError: result.structuredContent.status === "error",
  };
}

export function validateInputsRequest(input: MthdsInputsInput): ToolError[] {
  const errors = validateRequest(input.files);

  if (input.pipe_ref !== undefined && input.pipe_ref.trim() === "") {
    errors.push({
      class: "input_domain",
      location: "pipe_ref",
      message: "pipe_ref must not be empty when supplied.",
      hint: "Pass a qualified domain.pipe_code, or omit pipe_ref to default to the closure's main_pipe.",
    });
  }

  return errors;
}

export function inputsResult(report: BuildInputsResponse): InputsResult {
  if (!report.is_valid) {
    return {
      structuredContent: {
        status: "ok",
        is_valid: false,
        validation_errors: report.validation_errors,
      },
      summary: invalidSummary(report.message, report.validation_errors),
    };
  }

  return {
    structuredContent: {
      status: "ok",
      is_valid: true,
      pipe_ref: report.pipe_ref,
      format: report.format,
      explicit: report.explicit,
      ...templateFields(report),
    },
    summary: validSummary(report),
  };
}

function templateFields(
  report: BuildInputsValidReport,
): Pick<InputsStructuredContent, "inputs" | "inputs_toml"> {
  if (report.format === "json") {
    if (report.inputs == null) {
      throw new Error("Inputs report did not include the json template.");
    }
    return { inputs: report.inputs };
  }
  if (report.inputs_toml == null) {
    throw new Error("Inputs report did not include the toml template.");
  }
  return { inputs_toml: report.inputs_toml };
}

// The build routes return a plain `message` rather than `rendered_markdown`,
// so the summary is composed here. Unlike validation, the template is
// deliberately duplicated into the summary: it is the payload the model must
// read, and some hosts read prose more reliably than structured fields.
function validSummary(report: BuildInputsValidReport): string {
  const fence =
    report.format === "json"
      ? "```json\n" + JSON.stringify(report.inputs, null, 2) + "\n```"
      : "```toml\n" + (report.inputs_toml ?? "").trimEnd() + "\n```";

  return ["# Inputs template", report.message, `Resolved pipe: \`${report.pipe_ref}\``, fence].join(
    "\n\n",
  );
}

function invalidSummary(message: string, validationErrors: ValidationErrorItem[]): string {
  const lines = validationErrors.map((error) => {
    const source = error.source ? ` (${error.source})` : "";
    return `- **${error.category}** — ${error.message}${source}`;
  });

  return [
    "# Inputs template not produced",
    message,
    ...(lines.length > 0 ? [lines.join("\n")] : []),
  ].join("\n\n");
}

function toBuildInputsRequest(input: MthdsInputsInput): BuildInputsRequest {
  return {
    files: toMthdsFileItems(input.files),
    ...(input.pipe_ref === undefined ? {} : { pipe_ref: input.pipe_ref }),
    format: input.format ?? "json",
    explicit: input.explicit ?? false,
  };
}

// The MCP surface spells the provenance label `uri` (mirroring mthds_validate);
// the SDK's build envelope spells it `source` (`MthdsFileItem`). Adapt here.
function toMthdsFileItems(files: SubmittedFile[]): MthdsFileItem[] {
  return files.map((file) => {
    if (file.uri === undefined || file.uri === null) {
      return { content: file.content };
    }
    return { content: file.content, source: file.uri };
  });
}

function errorResult(summary: string, errors: ToolError[]): InputsResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      errors,
    },
    summary,
  };
}
