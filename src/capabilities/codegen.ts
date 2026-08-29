import { PipelexApiClient } from "@pipelex/sdk";
import type {
  CodegenRequest,
  CodegenResponse,
  CodegenTarget,
  CodegenValidReport,
  MthdsFileItem,
  ValidationErrorItem,
} from "@pipelex/sdk";
import { z } from "zod";

import {
  DEFAULT_AUTH_HINT,
  METHOD_REF_GRAMMAR,
  buildApiConfig,
  classifyError,
  filesInputSchema,
  resolveSubmittedFiles,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateMethodSelectorRequest,
} from "./shared.js";
import type {
  AuthErrorTexture,
  ClassifyErrorOptions,
  ErrorSummaries,
  FileResolver,
  SubmittedFile,
  SubmittedFileInput,
  ToolError,
} from "./shared.js";

/**
 * What each engine target emits and who it is for — the table behind the tool
 * description's decision rule and the `target` schema description.
 *
 * Keyed by the SDK's `CodegenTarget` on purpose: a `Record` over the union
 * must name every member, so a target the SDK gains in a bump fails to compile
 * here until its profile is written. {@link CODEGEN_TARGETS} closes the other
 * direction (`satisfies` rejects a target the SDK no longer has). Together they
 * turn a silently missing option into a deliberate edit — the description, the
 * smoke section and the live target loop all derive from these two.
 */
interface CodegenTargetProfile {
  /** The fixed file names the target emits; what varies per method is the type names inside them. */
  files: string;
  /** Who wants it — one clause of the decision rule. */
  audience: string;
}

export const CODEGEN_TARGET_PROFILES: Record<CodegenTarget, CodegenTargetProfile> = {
  "ts-zod": {
    files: "types.ts + binder.ts",
    audience:
      "a TypeScript or JavaScript project (a package.json, .ts sources) — zod schemas and inferred types in types.ts plus a parse/serialize binder per concept in binder.ts, depending only on zod; keep both files",
  },
  "python-pydantic": {
    files: "models.py",
    audience:
      "a Python project that consumes run results without a Pipelex runtime — plain pydantic BaseModels, depending only on pydantic",
  },
  "python-structures": {
    files: "structures.py",
    audience:
      "writing a Pipelex host or a @pipe_func implementation — runtime StructuredContent subclasses",
  },
};

/** The targets in enum order — the `target` schema, and the loop the live detectors iterate. */
export const CODEGEN_TARGETS = [
  "ts-zod",
  "python-pydantic",
  "python-structures",
] as const satisfies readonly CodegenTarget[];

/** The decision rule as one sentence fragment, shared by the tool description and the schema. */
export const CODEGEN_TARGET_RULE = CODEGEN_TARGETS.map(
  (target) =>
    `${target} for ${CODEGEN_TARGET_PROFILES[target].audience} (${CODEGEN_TARGET_PROFILES[target].files})`,
).join("; ");

const codegenTargetSchema = z.enum(CODEGEN_TARGETS);

export const mthdsCodegenInputSchema = {
  files: filesInputSchema.optional(),
  method_ref: z
    .string()
    .optional()
    .describe(
      `Published method address — ${METHOD_REF_GRAMMAR}. Resolved server-side (the repository is fetched at the tag); no bundle enters the conversation. Supply exactly ONE of files / method_ref / method_id.`,
    ),
  method_id: z
    .string()
    .optional()
    .describe(
      "Catalog id (mt_…) of a registered method. Generates from the method's CURRENT stored content, resolved server-side by the hosted platform — requires an API key (the catalog is org-scoped). Supply exactly ONE of files / method_ref / method_id.",
    ),
  target: codegenTargetSchema.describe(
    `Which typed projection to emit. Required, no default — choose it from the calling context, and the user's explicit request wins: ${CODEGEN_TARGET_RULE}. Field keys are snake_case in every target.`,
  ),
};

const codegenArtifactSchema = z.object({
  path: z
    .string()
    .describe(
      "The artifact's path, relative to the generated directory — fixed per target (types.ts and binder.ts, models.py, or structures.py).",
    ),
  bytes: z.number().int().nonnegative().describe("Size of the artifact's content in UTF-8 bytes."),
  content: z
    .string()
    .optional()
    .describe(
      "The artifact's full content, verbatim — write it byte for byte. Absent when withheld for size (see truncated).",
    ),
});

const codegenLockSchema = z.object({
  filename: z
    .string()
    .describe("The filename the lock must be written as (codegen.lock), beside the artifacts."),
  bytes: z.number().int().nonnegative().describe("Size of the lock's content in UTF-8 bytes."),
  content: z
    .string()
    .optional()
    .describe(
      "The lock's TOML content, verbatim — write it byte for byte. Absent when withheld for size (see truncated).",
    ),
});

const codegenStructuredContentSchema = z.object({
  status: z.enum(["ok", "error"]),
  is_valid: z.boolean(),
  target: codegenTargetSchema.optional(),
  kind: z.literal("types").optional(),
  crate_fingerprint: z
    .string()
    .optional()
    .describe("Fingerprint of the normalized crate the artifacts were generated from."),
  engine_version: z.string().optional().describe("The Pipelex engine version that generated them."),
  artifacts: z.array(codegenArtifactSchema).optional(),
  lock: codegenLockSchema.optional(),
  truncated: z
    .boolean()
    .optional()
    .describe(
      "True when some content was withheld for size — whole files only, never a cut file; the withheld entries carry path and bytes with content absent.",
    ),
  validation_errors: z.array(z.unknown()).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export const mthdsCodegenOutputSchema = codegenStructuredContentSchema;

export interface MthdsCodegenInput {
  files?: SubmittedFileInput[];
  method_ref?: string;
  method_id?: string;
  target: CodegenTarget;
}

/** The codegen request after `{ path }` resolution — what the checks and the API call consume. */
interface ResolvedCodegenRequest {
  files: SubmittedFile[];
  method_ref?: string;
  method_id?: string;
  target: CodegenTarget;
}

export interface CodegenArtifactContent {
  path: string;
  bytes: number;
  content?: string;
}

export interface CodegenLockContent {
  filename: string;
  bytes: number;
  content?: string;
}

export interface CodegenStructuredContent {
  status: "ok" | "error";
  is_valid: boolean;
  target?: CodegenTarget;
  kind?: "types";
  crate_fingerprint?: string;
  engine_version?: string;
  artifacts?: CodegenArtifactContent[];
  lock?: CodegenLockContent;
  truncated?: boolean;
  validation_errors?: unknown[];
  errors?: ToolError[];
}

export interface CodegenResult {
  structuredContent: CodegenStructuredContent;
  summary: string;
}

/** The slice of `PipelexApiClient` the codegen capability calls (test seam). */
export interface CodegenClient {
  codegen(request: CodegenRequest): Promise<CodegenResponse>;
}

export interface CodegenContext {
  baseUrl: string;
  apiKey?: string;
  client?: CodegenClient;
  /** Fills `{ path }` items from disk (local workshop); absent on the hosted console. */
  resolver?: FileResolver;
  /** Deployment-specific auth-failure texture (the hosted console overrides it per request); default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildCodegenContext(env = process.env): CodegenContext {
  return buildApiConfig(env);
}

/**
 * The budget for artifact content riding the response, in UTF-8 bytes across
 * the whole set (artifacts, then the lock). Sized for this artifact class
 * rather than copied from `MAIN_STUFF_CAP`: a small method's types.ts is a
 * few kilobytes and a large concept set's is tens, so the ordinary case never
 * truncates and the pathological one degrades to paths and byte counts. It is
 * applied by WHOLE file, in order, stopping at the first that does not fit —
 * a half types.ts neither compiles nor passes the offline check, and a
 * binder.ts without its types.ts is no more useful than none.
 */
export const CODEGEN_CONTENT_CAP = 64 * 1024;

const TARGET_LIST = CODEGEN_TARGETS.join(", ");

const CODEGEN_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/codegen",
  // An unresolvable closure is a produced 200 verdict on this route, so a
  // 400/422 on a files request is the projection axes — and this client always
  // sends `kind: "types"` and never a `pipe_ref`, which leaves `target`.
  badRequest: {
    location: "target",
    hint: `Pass target as one of ${TARGET_LIST}. If the target is right, the configured Pipelex API may predate it — check its version.`,
  },
};

/**
 * Classify options for an address-shaped request: a 400/422 can be the ref
 * (parse/fetch/ambiguity) as well as the target, a 404 is the runner's
 * no-matching-package refusal, and a 501 is the reserved registry form — all
 * the caller's own selector, located at `method_ref`.
 */
const CODEGEN_BY_REF_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/codegen",
  badRequest: {
    location: "method_ref",
    hint: `Check the address and tag — ${METHOD_REF_GRAMMAR} — and that the tag is a git tag on the repository. If the address resolved, check target is one of ${TARGET_LIST}.`,
  },
  notFound: {
    location: "method_ref",
    hint: "The repository was fetched but holds no package matching this address by manifest identity. Check the package selector against the repository's METHODS.toml manifests.",
  },
  notImplemented: {
    location: "method_ref",
    hint: `Only address-form refs are supported (${METHOD_REF_GRAMMAR}); registry references are reserved until a method registry exists.`,
  },
};

/**
 * Classify options for an id-shaped request. The hosted platform resolves the
 * id and injects the stored source before the runner sees the request; an
 * unknown or foreign-org id is a 404 (indistinguishable by design), a stored
 * method with no MTHDS source is a 422, and a deployment with no catalog (a
 * bare pipelex-api runner, or a hosted plane that predates the tooling
 * selector on this route) rejects the request-shape too — the 422 hint covers
 * all three, plus the target.
 */
const CODEGEN_BY_ID_ERROR_OPTIONS: ClassifyErrorOptions = {
  route: "/v1/codegen",
  badRequest: {
    location: "method_id",
    hint: `The stored method may have no MTHDS source yet, or this deployment may not resolve method_id on /v1/codegen — the selector is hosted-only (a bare pipelex-api runner has no catalog). If the id resolved, check target is one of ${TARGET_LIST}. Submit files or a method_ref instead if it persists.`,
  },
  notFound: {
    location: "method_id",
    hint: "No registered method with this id is visible to the API key's organization. Check the id as the catalog returned it — the catalog is org-scoped, so a method from another organization reads exactly like a miss.",
  },
};

/**
 * The 403 texture. The hosted authorizer gates `/v1/codegen` on a feature flag
 * as well as on the plan, so a caller whose credential is perfectly valid can
 * still be refused — and the generic "check your key" would send them to debug
 * the wrong thing. Composed per call so the deployment's own auth wording
 * (the console's "reconnect and sign in again") stays in front.
 */
function forbiddenTexture(auth: AuthErrorTexture | undefined): { hint: string } {
  return {
    hint: `${auth?.hint ?? DEFAULT_AUTH_HINT} If the credential is valid, code generation is not enabled for this organization on the hosted Pipelex API — its plan or feature flags do not cover /v1/codegen; ask for it to be enabled.`,
  };
}

// Constructed inside each caught block (mirroring run.ts's runClient): the SDK
// constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
function codegenClient(context: CodegenContext): CodegenClient {
  return (
    context.client ??
    new PipelexApiClient({
      baseUrl: context.baseUrl,
      apiKey: context.apiKey,
    })
  );
}

const INVALID_REQUEST_SUMMARY = "Code generation was not run: request input is invalid.";

export async function generateMthdsCode(
  input: MthdsCodegenInput,
  context: CodegenContext = buildCodegenContext(),
): Promise<CodegenResult> {
  const resolution = await resolveSubmittedFiles(input.files ?? [], context.resolver);
  if (resolution.errors.length > 0) {
    return errorResult(INVALID_REQUEST_SUMMARY, resolution.errors);
  }

  const request: ResolvedCodegenRequest = { ...input, files: resolution.files };
  const inputErrors = validateMethodSelectorRequest(request.files, request, {
    rule: "one_selector",
  });
  if (inputErrors.length > 0) {
    return errorResult(INVALID_REQUEST_SUMMARY, inputErrors);
  }

  // Classify options follow the request's selector shape — each failure
  // locates at the field that caused it.
  const classifyOptions =
    request.files.length > 0
      ? CODEGEN_ERROR_OPTIONS
      : request.method_ref !== undefined
        ? CODEGEN_BY_REF_ERROR_OPTIONS
        : CODEGEN_BY_ID_ERROR_OPTIONS;

  let report: CodegenResponse;
  try {
    report = await codegenClient(context).codegen(toCodegenRequest(request));
  } catch (err) {
    const error = classifyError(err, {
      ...classifyOptions,
      auth: context.authError,
      forbidden: forbiddenTexture(context.authError),
    });
    return errorResult(summaryForError(error), [error]);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report (a valid arm without its artifacts or lock) is a
  // reachable contract violation, surfaced as a runtime no-verdict error.
  try {
    return codegenResult(report);
  } catch (err) {
    return errorResult(
      "Code generation produced no verdict: the Pipelex API returned a malformed report.",
      [
        {
          class: "runtime",
          message:
            err instanceof Error
              ? err.message
              : "The Pipelex API returned a malformed codegen report.",
          hint: "The API responded but its report was missing required fields; inspect pipelex-api logs.",
          retryable: false,
        },
      ],
    );
  }
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "Code generation could not start: the Pipelex API is unreachable or misconfigured.",
  input_domain: "Code generation was not run: the Pipelex API rejected the request.",
  runtime: "Code generation could not be completed: the Pipelex API returned an error.",
  paywall:
    "Code generation could not start: the organization's Pipelex plan does not cover this call.",
};

function summaryForError(error: ToolError): string {
  return summaryForToolError(error, ERROR_SUMMARIES);
}

/** No `_meta`: this tool has no view on either shell, so the bounded copies below are the whole response. */
export function codegenToolResult(result: CodegenResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary, result.structuredContent.errors),
    isError: result.structuredContent.status === "error",
  };
}

export function codegenResult(report: CodegenResponse): CodegenResult {
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

  assertValidReportShape(report);
  const bounded = boundArtifacts(report);

  return {
    structuredContent: {
      status: "ok",
      is_valid: true,
      target: report.target,
      kind: report.kind,
      crate_fingerprint: report.crate_fingerprint,
      engine_version: report.engine_version,
      artifacts: bounded.artifacts,
      lock: bounded.lock,
      truncated: bounded.truncated,
    },
    summary: validSummary(report, bounded),
  };
}

// The declared type says the valid arm carries its artifacts and lock; what
// ARRIVES is what gets written verbatim into a user's tree, so it is checked
// rather than trusted — a reachable-but-malformed report is a runtime
// no-verdict, never an empty tree reported as generated.
function assertValidReportShape(report: CodegenValidReport): void {
  if (
    !Array.isArray(report.artifacts) ||
    report.artifacts.some(
      (artifact) =>
        typeof artifact?.path !== "string" ||
        artifact.path === "" ||
        typeof artifact.content !== "string",
    )
  ) {
    throw new Error("Codegen report did not include a well-formed artifacts list.");
  }
  if (typeof report.lock !== "string") {
    throw new Error("Codegen report did not include the lock content.");
  }
  if (typeof report.lock_filename !== "string" || report.lock_filename === "") {
    throw new Error("Codegen report did not include the lock filename.");
  }
}

export interface BoundedArtifacts {
  artifacts: CodegenArtifactContent[];
  lock: CodegenLockContent;
  truncated: boolean;
}

const utf8 = new TextEncoder();

function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/**
 * Apply {@link CODEGEN_CONTENT_CAP} to a valid report's artifact set: each
 * file is included whole, in order (artifacts first, the lock last), until the
 * first that does not fit; from there on every file carries only its path and
 * size. `truncated` says whether anything was withheld.
 */
export function boundArtifacts(
  report: CodegenValidReport,
  cap: number = CODEGEN_CONTENT_CAP,
): BoundedArtifacts {
  let used = 0;
  let truncated = false;

  const fits = (bytes: number): boolean => {
    if (truncated || used + bytes > cap) {
      truncated = true;
      return false;
    }
    used += bytes;
    return true;
  };

  const artifacts = report.artifacts.map((artifact): CodegenArtifactContent => {
    const bytes = byteLength(artifact.content);
    return fits(bytes)
      ? { path: artifact.path, bytes, content: artifact.content }
      : { path: artifact.path, bytes };
  });

  const lockBytes = byteLength(report.lock);
  const lock: CodegenLockContent = fits(lockBytes)
    ? { filename: report.lock_filename, bytes: lockBytes, content: report.lock }
    : { filename: report.lock_filename, bytes: lockBytes };

  return { artifacts, lock, truncated };
}

const WRITE_INSTRUCTION =
  "Write each file below at its path and the lock beside them, all VERBATIM — byte for byte, no reformatting, no trailing-newline changes: any byte change breaks the stamp's content hash and the lock, and the offline check (`pipelex codegen check`, or `runCodegenCheck` from @pipelex/sdk) only passes on an untouched tree. Use a dedicated generated directory. Field keys are snake_case in every target. The exact bytes are in `structuredContent.artifacts[].content` and `structuredContent.lock.content`; the blocks below are the same bytes.";

// The codegen route returns a plain `message` rather than `rendered_markdown`,
// so the summary is composed here. The artifacts are deliberately duplicated
// into it: they are the payload the model must write out, and some hosts read
// prose more reliably than structured fields.
function validSummary(report: CodegenValidReport, bounded: BoundedArtifacts): string {
  const sections: string[] = [
    `# Generated code — ${report.target}`,
    report.message,
    `Target \`${report.target}\` · kind \`${report.kind}\` · crate fingerprint \`${report.crate_fingerprint}\` · engine ${report.engine_version}`,
    WRITE_INSTRUCTION,
  ];

  for (const artifact of bounded.artifacts) {
    sections.push(`## \`${artifact.path}\` (${artifact.bytes} bytes)`);
    sections.push(
      artifact.content === undefined
        ? "_Content withheld for size — see below._"
        : fenced(artifact.content, languageFor(artifact.path)),
    );
  }

  sections.push(`## \`${bounded.lock.filename}\` (${bounded.lock.bytes} bytes)`);
  sections.push(
    bounded.lock.content === undefined
      ? "_Content withheld for size — see below._"
      : fenced(bounded.lock.content, "toml"),
  );

  if (bounded.truncated) {
    const withheld = [
      ...bounded.artifacts.filter((artifact) => artifact.content === undefined),
      ...(bounded.lock.content === undefined
        ? [{ path: bounded.lock.filename, bytes: bounded.lock.bytes }]
        : []),
    ].map((file) => `- \`${file.path}\` (${file.bytes} bytes)`);
    sections.push("## Withheld for size");
    sections.push(
      [
        `The artifact set exceeds the response budget (${CODEGEN_CONTENT_CAP} bytes), so these files carry only their path and size — whole files only, never a cut file, because a partial artifact neither compiles nor passes the check:`,
        withheld.join("\n"),
        "Generate this method locally instead with the Pipelex CLI (`pipelex codegen types`), which writes the same stamped tree.",
      ].join("\n\n"),
    );
  }

  return sections.join("\n\n");
}

function invalidSummary(message: string, validationErrors: ValidationErrorItem[]): string {
  const lines = validationErrors.map((error) => {
    const source = error.source ? ` (${error.source})` : "";
    return `- **${error.category}** — ${error.message}${source}`;
  });

  return ["# Code not generated", message, ...(lines.length > 0 ? [lines.join("\n")] : [])].join(
    "\n\n",
  );
}

/**
 * A fenced block whose fence is longer than any backtick run inside the
 * content, so a generated file that happens to contain ``` still renders as
 * one block. The body is shown with exactly one trailing newline before the
 * closing fence; the verbatim bytes are the structured field's.
 */
export function fenced(content: string, language: string): string {
  let longestRun = 0;
  for (const match of content.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `${fence}${language}\n${body}${fence}`;
}

/** The fence language from the artifact's extension — per file, not per target, so a mixed set tags each file right. */
function languageFor(artifactPath: string): string {
  if (artifactPath.endsWith(".ts") || artifactPath.endsWith(".tsx")) return "ts";
  if (artifactPath.endsWith(".py")) return "python";
  if (artifactPath.endsWith(".json")) return "json";
  if (artifactPath.endsWith(".toml")) return "toml";
  return "";
}

// Exactly one selector crosses the wire, and NO `pipe_ref` key: the route
// rejects one on the concept-set-wide `types` kind with a 422 rather than
// ignoring it. Every selector is a server pass-through — the runner resolves
// an address, the hosted platform resolves an id; nothing is expanded here.
function toCodegenRequest(request: ResolvedCodegenRequest): CodegenRequest {
  const selector: Pick<CodegenRequest, "files" | "method_ref" | "method_id"> =
    request.files.length > 0
      ? { files: toMthdsFileItems(request.files) }
      : request.method_ref !== undefined
        ? { method_ref: request.method_ref }
        : request.method_id !== undefined
          ? { method_id: request.method_id }
          : unreachableSelector();
  return { ...selector, kind: "types", target: request.target };
}

function unreachableSelector(): never {
  // The selector checks above guarantee a source.
  throw new Error("No method selector survived request validation.");
}

// The MCP surface spells the provenance label `uri` (mirroring mthds_validate);
// the SDK's crate envelope spells it `source` (`MthdsFileItem`). Adapt here.
function toMthdsFileItems(files: SubmittedFile[]): MthdsFileItem[] {
  return files.map((file) => {
    if (file.uri === undefined || file.uri === null) {
      return { content: file.content };
    }
    return { content: file.content, source: file.uri };
  });
}

function errorResult(summary: string, errors: ToolError[]): CodegenResult {
  return {
    structuredContent: {
      status: "error",
      is_valid: false,
      errors,
    },
    summary,
  };
}
