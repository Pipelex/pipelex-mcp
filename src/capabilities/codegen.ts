import path from "node:path";

import {
  CodegenLockError,
  PipelexApiClient,
  isStampableArtifactPath,
  runCodegenCheck,
} from "@pipelex/sdk";
import type {
  CodegenRequest,
  CodegenResponse,
  CodegenTarget,
  CodegenValidReport,
  MthdsFileItem,
  ValidationErrorItem,
} from "@pipelex/sdk";
import { z } from "zod";

import { writeCodegenTree } from "./codegen-writer.js";
import type { CodegenWriteSuccess } from "./codegen-writer.js";
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
  output_dir: z
    .string()
    .optional()
    .describe(
      "LOCAL WORKSHOP ONLY. Write the generated tree straight to disk instead of returning its content, so the bytes never enter the conversation. A directory relative to the server's working directory, created if missing and required to stay inside it (no absolute paths, no `..`). Use a DEDICATED generated directory such as `src/generated/<method>/`: this tool overwrites files it generated (they carry a codegen stamp) and the codegen.lock beside them, and refuses the whole write rather than touch anything else. The hosted console takes no output_dir.",
    ),
};

const codegenArtifactSchema = z.object({
  path: z
    .string()
    .describe(
      "The artifact's path, relative to the generated directory — fixed per target (types.ts and binder.ts, models.py, or structures.py).",
    ),
  bytes: z.number().int().nonnegative().describe("Size of the artifact's content in UTF-8 bytes."),
  written_to: z
    .string()
    .optional()
    .describe(
      "Where the file was written, relative to the server's working directory — present only on the written arm (output_dir).",
    ),
  content: z
    .string()
    .optional()
    .describe(
      "The artifact's full content, verbatim — write it byte for byte. Absent for either of two reasons: the tree went to disk (output_dir is set, written_to says where) or the content was withheld for size (truncated is true).",
    ),
});

const codegenLockSchema = z.object({
  filename: z
    .string()
    .describe("The filename the lock must be written as (codegen.lock), beside the artifacts."),
  bytes: z.number().int().nonnegative().describe("Size of the lock's content in UTF-8 bytes."),
  written_to: z
    .string()
    .optional()
    .describe(
      "Where the lock was written, relative to the server's working directory — present only on the written arm (output_dir).",
    ),
  content: z
    .string()
    .optional()
    .describe(
      "The lock's TOML content, verbatim — write it byte for byte. Absent for either of two reasons: the tree went to disk (output_dir is set, written_to says where) or the content was withheld for size (truncated is true).",
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
      "True when some content was withheld for size — whole files only, never a cut file; the withheld entries carry path and bytes with content absent. Always false on the written arm.",
    ),
  output_dir: z
    .string()
    .optional()
    .describe(
      "The generated directory, relative to the server's working directory. Its PRESENCE is what says the tree went to disk: content is then absent on every stream, each file carries written_to, and truncated is false.",
    ),
  is_current: z
    .boolean()
    .optional()
    .describe(
      "Written arm only — the offline check's verdict over what actually landed on disk (`pipelex codegen check` reports the same). False when the directory also holds orphans.",
    ),
  orphans: z
    .array(z.string())
    .optional()
    .describe(
      "Written arm only, always present (empty when clean) — stamped files in the directory this lock does not track, left by an earlier generation. Reported, never deleted.",
    ),
  orphans_truncated: z
    .boolean()
    .optional()
    .describe(
      "Written arm only — true when the directory was too large to walk fully, so orphan detection is partial rather than clean.",
    ),
  drifts: z
    .array(z.unknown())
    .optional()
    .describe(
      "Written arm only, present when non-empty — every check drift that is NOT an orphan, which would mean the write itself is broken.",
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
  output_dir?: string;
}

/** The codegen request after `{ path }` resolution — what the checks and the API call consume. */
interface ResolvedCodegenRequest {
  files: SubmittedFile[];
  method_ref?: string;
  method_id?: string;
  target: CodegenTarget;
  output_dir?: string;
}

export interface CodegenArtifactContent {
  path: string;
  bytes: number;
  content?: string;
  written_to?: string;
}

export interface CodegenLockContent {
  filename: string;
  bytes: number;
  content?: string;
  written_to?: string;
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
  output_dir?: string;
  is_current?: boolean;
  orphans?: string[];
  orphans_truncated?: boolean;
  drifts?: unknown[];
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
  /**
   * The directory `output_dir` is resolved against — the workshop's working
   * directory, absolute. The same name and meaning as `ArtifactsContext.saveRoot`:
   * one `buildToolContexts` option fans out to both writers. Absent on the
   * hosted console, which then refuses `output_dir` instructively rather than
   * picking a directory of its own.
   */
  saveRoot?: string;
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

const WRITE_ARM_FALLBACK =
  "Omit output_dir to receive the artifacts in the response and write them yourself.";

/**
 * The `output_dir` request-shape checks, kept beside the selector checks
 * rather than inside `resolveSubmittedFiles` (which only ever sees files).
 * The "no write root" refusal is the `{ path }` console texture: an
 * affordance the shared tool definition advertises and this deployment cannot
 * serve, refused instructively with the shell that can.
 */
export function validateCodegenWriteRequest(
  outputDir: string | undefined,
  saveRoot: string | undefined,
): ToolError[] {
  if (outputDir === undefined) {
    return [];
  }
  if (outputDir.trim() === "") {
    return [
      {
        class: "input_domain",
        location: "output_dir",
        message: "output_dir must not be empty when supplied.",
        hint: `Pass a dedicated generated directory relative to the server's working directory, such as \`src/generated/<method>/\`. ${WRITE_ARM_FALLBACK}`,
        retryable: false,
      },
    ];
  }
  if (saveRoot === undefined) {
    return [
      {
        class: "input_domain",
        location: "output_dir",
        message: "This deployment has no working directory, so it cannot write a generated tree.",
        hint: `Writing the tree to disk is a local workshop capability — run the workshop server (npx @pipelex/mcp), which writes under the directory it was started in. ${WRITE_ARM_FALLBACK}`,
        retryable: false,
      },
    ];
  }
  if (path.isAbsolute(outputDir)) {
    return [
      {
        class: "input_domain",
        location: "output_dir",
        message: "output_dir must be relative to the server's working directory, not absolute.",
        hint: "The tree is written under the directory the host started this server in. Pass a relative directory such as `src/generated/<method>/`.",
        retryable: false,
      },
    ];
  }
  return [];
}

export async function generateMthdsCode(
  input: MthdsCodegenInput,
  context: CodegenContext = buildCodegenContext(),
): Promise<CodegenResult> {
  const resolution = await resolveSubmittedFiles(input.files ?? [], context.resolver);
  if (resolution.errors.length > 0) {
    return errorResult(INVALID_REQUEST_SUMMARY, resolution.errors);
  }

  const request: ResolvedCodegenRequest = { ...input, files: resolution.files };
  const inputErrors = [
    ...validateMethodSelectorRequest(request.files, request, { rule: "one_selector" }),
    ...validateCodegenWriteRequest(request.output_dir, context.saveRoot),
  ];
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

  // A produced-invalid verdict never touches disk, on either shell: it carries
  // no artifacts at all, so there is nothing to preflight and nothing to write.
  if (!report.is_valid) {
    return codegenResult(report);
  }

  // The API responded; projecting it must not be reported as an unreachable
  // API. A malformed report — a valid arm without its artifacts or lock, an
  // artifact path the check cannot verify, a lock filename that is not bare,
  // or a set that fails the SDK's own offline check — is a reachable contract
  // violation, surfaced as a runtime no-verdict error. The preflight runs on
  // BOTH shells, not only the write path: the console relays these bytes to a
  // model that will write them, so a report the workshop would refuse is one
  // the console must not hand over either.
  try {
    assertValidReportShape(report);
    await preflightReport(report);
  } catch (err) {
    return malformedReportError(err);
  }

  // The write arm. `output_dir` without a `saveRoot` was already refused as a
  // request-shape error, so reaching here with one means this shell can write.
  let written: CodegenWriteSuccess | undefined;
  if (request.output_dir !== undefined && context.saveRoot !== undefined) {
    const result = await writeCodegenTree({
      root: context.saveRoot,
      outputDir: request.output_dir,
      artifacts: report.artifacts,
      lock: report.lock,
      lockFilename: report.lock_filename,
    });
    // No fallback to riding the content: the caller asked for a write and none
    // happened, and silently inlining tens of kilobytes they did not ask for
    // would both blow the budget and change the shape they expected. The retry
    // is one cheap call with a fixed output_dir.
    if (!result.ok) {
      return errorResult(summaryForError(result.error), [result.error]);
    }
    written = result;
  }

  try {
    return codegenResult(report, written, context.saveRoot !== undefined);
  } catch (err) {
    return malformedReportError(err);
  }
}

/**
 * The SDK's own offline check, run in memory over the response before a byte
 * of it reaches disk or the model. `CodegenTreeFile` is structurally identical
 * to `GeneratedArtifact` precisely so a response feeds in with no mapping, and
 * one call establishes far more than a hand-rolled rule set would: the lock
 * parses and its version is readable, every path in the lock and in the
 * artifact set is safe, canonical and unique (control characters and drive
 * prefixes included), and every artifact's stamp and body hash agree with the
 * lock. A `CodegenLockError` and a non-current verdict are equally contract
 * violations, and both surface as runtime no-verdicts.
 */
async function preflightReport(report: CodegenValidReport): Promise<void> {
  const check = await runCodegenCheck({ lockContent: report.lock, files: report.artifacts });
  if (!check.isCurrent) {
    const detail = check.drifts
      .map((drift) => `${drift.path} (${drift.category}: ${drift.detail})`)
      .join("; ");
    throw new Error(
      `Codegen report failed the offline check against its own lock, before anything was written: ${detail}`,
    );
  }
}

function malformedReportError(err: unknown): CodegenResult {
  const detail =
    err instanceof CodegenLockError
      ? `The Pipelex API returned an unreadable codegen lock: ${err.message}`
      : err instanceof Error
        ? err.message
        : "The Pipelex API returned a malformed codegen report.";
  return errorResult(
    "Code generation produced no verdict: the Pipelex API returned a malformed report.",
    [
      {
        class: "runtime",
        message: detail,
        hint: "The API responded but its report did not hold together; nothing was written. Inspect pipelex-api logs.",
        retryable: false,
      },
    ],
  );
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

/**
 * Pure, synchronous and filesystem-free — it projects whichever arm it is
 * handed. The write itself lives in {@link generateMthdsCode}, so the bounding,
 * summary and invalid-arm tests keep running with no filesystem at all.
 *
 * `written` present means the tree went to disk: content is withheld on every
 * stream, each file carries where it landed, and the check verdict rides along.
 */
export function codegenResult(
  report: CodegenResponse,
  written?: CodegenWriteSuccess,
  canWrite = false,
): CodegenResult {
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

  if (written !== undefined) {
    return {
      structuredContent: {
        status: "ok",
        is_valid: true,
        target: report.target,
        kind: report.kind,
        crate_fingerprint: report.crate_fingerprint,
        engine_version: report.engine_version,
        artifacts: written.written.map((artifact) => ({
          path: artifact.path,
          bytes: artifact.bytes,
          written_to: artifact.writtenTo,
        })),
        lock: {
          filename: written.lock.filename,
          bytes: written.lock.bytes,
          written_to: written.lock.writtenTo,
        },
        // Nothing rode the response, so nothing was withheld for size either.
        truncated: false,
        output_dir: written.dir,
        is_current: written.isCurrent,
        // Always present, empty when clean, so a consumer never has to tell
        // absent from empty.
        orphans: written.orphans,
        ...(written.orphansTruncated ? { orphans_truncated: true } : {}),
        ...(written.drifts.length > 0 ? { drifts: written.drifts } : {}),
      },
      summary: writtenSummary(report, written),
    };
  }

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
    summary: validSummary(report, bounded, canWrite),
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
  for (const artifact of report.artifacts) {
    if (!isStampableArtifactPath(artifact.path)) {
      throw new Error(
        `Codegen report named an artifact the offline check cannot verify: ${artifact.path}.`,
      );
    }
  }
  if (typeof report.lock !== "string") {
    throw new Error("Codegen report did not include the lock content.");
  }
  if (typeof report.lock_filename !== "string" || report.lock_filename === "") {
    throw new Error("Codegen report did not include the lock filename.");
  }
  // The lock filename must be a BARE filename. The writer joins it under the
  // generated directory, and the console hands it to a model that will do the
  // same, so `../../…` is the one value in the whole path that would otherwise
  // reach a write uncontained. Containment in the writer still stands on its
  // own — canonical is not the same as contained — but the rule belongs here,
  // where it holds for both shells.
  if (
    report.lock_filename !== path.posix.basename(report.lock_filename) ||
    report.lock_filename.includes("\\") ||
    report.lock_filename.startsWith(".")
  ) {
    throw new Error(
      `Codegen report returned a lock filename that is not a bare filename: ${report.lock_filename}.`,
    );
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
 * file is included whole, in order, until the first that does not fit; from
 * there on every file carries only its path and size. `truncated` says whether
 * anything was withheld.
 *
 * The LOCK'S bytes are reserved off the top, and the artifacts fill what
 * remains. Filling artifacts first and letting the lock fall off the end would
 * drop the trust anchor to fit the code it anchors — leaving the model code it
 * cannot check, under a write instruction that promises the offline check will
 * pass on what it writes. The lock is the smallest file in the set, so the
 * reservation costs the artifacts almost nothing; a lock that alone exceeds
 * the cap is the one remaining truncation of it, and nothing rides then.
 */
export function boundArtifacts(
  report: CodegenValidReport,
  cap: number = CODEGEN_CONTENT_CAP,
): BoundedArtifacts {
  const lockBytes = byteLength(report.lock);
  const lockFits = lockBytes <= cap;
  let remaining = lockFits ? cap - lockBytes : 0;
  let stopped = !lockFits;

  const artifacts = report.artifacts.map((artifact): CodegenArtifactContent => {
    const bytes = byteLength(artifact.content);
    if (stopped || bytes > remaining) {
      stopped = true;
      return { path: artifact.path, bytes };
    }
    remaining -= bytes;
    return { path: artifact.path, bytes, content: artifact.content };
  });

  const lock: CodegenLockContent = lockFits
    ? { filename: report.lock_filename, bytes: lockBytes, content: report.lock }
    : { filename: report.lock_filename, bytes: lockBytes };

  return {
    artifacts,
    lock,
    truncated: !lockFits || artifacts.some((artifact) => artifact.content === undefined),
  };
}

const WRITE_INSTRUCTION =
  "Write each file below at its path and the lock beside them, all VERBATIM — byte for byte, no reformatting, no trailing-newline changes: any byte change breaks the stamp's content hash and the lock, and the offline check (`pipelex codegen check`, or `runCodegenCheck` from @pipelex/sdk) only passes on an untouched tree. Use a dedicated generated directory. Field keys are snake_case in every target. The exact bytes are in `structuredContent.artifacts[].content` and `structuredContent.lock.content`; the blocks below are the same bytes.";

// The codegen route returns a plain `message` rather than `rendered_markdown`,
// so the summary is composed here. The artifacts are deliberately duplicated
// into it: they are the payload the model must write out, and some hosts read
// prose more reliably than structured fields.
function validSummary(
  report: CodegenValidReport,
  bounded: BoundedArtifacts,
  canWrite = false,
): string {
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
        ...(canWrite
          ? [
              "Pass `output_dir` to write the tree to disk instead — the bytes then never enter the conversation.",
            ]
          : []),
        "Generate this method locally instead with the Pipelex CLI (`pipelex codegen types`), which writes the same stamped tree.",
      ].join("\n\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * The written arm's summary. No fenced blocks, and no content anywhere: the
 * whole point of `output_dir` is that the bytes never enter the conversation.
 * What the model needs instead is where the files are and whether the tree
 * checks out.
 */
function writtenSummary(report: CodegenValidReport, written: CodegenWriteSuccess): string {
  const sections: string[] = [
    `# Generated code written — ${report.target}`,
    report.message,
    `Target \`${report.target}\` · kind \`${report.kind}\` · crate fingerprint \`${report.crate_fingerprint}\` · engine ${report.engine_version}`,
    `Written under \`${written.dir}\`, relative to the server's working directory. The file contents are NOT in this response — they are on disk, byte for byte as the engine produced them, which is what keeps the stamps and the lock valid.`,
    [
      ...written.written.map((artifact) => `- \`${artifact.writtenTo}\` (${artifact.bytes} bytes)`),
      `- \`${written.lock.writtenTo}\` (${written.lock.bytes} bytes) — the lock`,
    ].join("\n"),
    checkVerdict(written),
  ];

  if (written.drifts.length > 0) {
    sections.push(
      [
        "## Unexpected drift",
        "The offline check reported drift that is not an orphan, which means the written tree does not agree with the lock that was just written beside it. Verify the directory with `pipelex codegen check` before using it:",
        written.drifts
          .map((drift) => `- \`${drift.path}\` — **${drift.category}**: ${drift.detail}`)
          .join("\n"),
      ].join("\n\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * D7: orphans are reported and never deleted. The wording says what they
 * actually are, because "delete them by hand" is wrong advice the moment a
 * user has generated two methods — or two targets — into one directory.
 */
function checkVerdict(written: CodegenWriteSuccess): string {
  const partial = written.orphansTruncated
    ? " The directory was too large to walk fully, so orphan detection is partial — point `output_dir` at a dedicated generated directory to get a complete verdict."
    : "";

  if (written.orphans.length === 0) {
    return `The offline check reports the tree **current** — \`pipelex codegen check\` and @pipelex/sdk's \`runCodegenCheck\` agree on it.${partial}`;
  }

  return [
    `The offline check reports the tree **not current**: it also holds stamped files this lock does not list — left there by an earlier generation (a different target, or an engine version that renamed an artifact).${partial}`,
    written.orphans.map((orphan) => `- \`${orphan}\``).join("\n"),
    "This tool never deletes them. Delete them yourself if they are stale; keep them if they belong to another method or target generated into the same directory, in which case the directory stays non-current by design and a dedicated directory per generation is the fix.",
  ].join("\n\n");
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
