import { ArtifactFetchError } from "@pipelex/sdk";
import type { FetchArtifactOptions, RunRead, RunResultState, RunStatus } from "@pipelex/sdk";
import { z } from "zod";

import type { RunFailure } from "./run-failure.js";
import {
  failedArmSummaryLines,
  failureOfFailedArm,
  readFailedRun,
  runFailureSchema,
  runResultsErrorOptions,
  runStatusSchema,
} from "./run.js";
import type { FailedRunState } from "./run.js";
import {
  BULK_RESOLVE_ERROR_OPTIONS,
  INLINE_IMAGES_BUDGET,
  INLINE_IMAGE_MIME_TYPES,
  MAX_IMAGE_CANDIDATE_ENTRIES,
  MAX_INLINE_IMAGES,
  MAX_INLINE_IMAGE_BYTES,
  allowsPlainHttp,
  buildArtifactFetchConfig,
  classifyError,
  createPipelexApiClient,
  imageCandidatesOf,
  itemToolError,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
  validateRunIdRequest,
} from "./shared.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";
import type { ToolNames } from "./tool-names.js";
import type {
  ApiConfig,
  AuthErrorTexture,
  ContentImage,
  ErrorSummaries,
  ImageCandidate,
  InlineImageMimeType,
  ToolError,
} from "./shared.js";

/**
 * `mthds_show_images` — the deliberate gesture that puts a picture a run
 * produced in front of the model, as MCP image content blocks.
 *
 * It is a tool of its own rather than a flag on `mthds_run_results`, and that
 * is the whole design. An image block is cheap to send — the host probe
 * (`wip/mcp-image-results/host-probe.md`) measured a host billing one at the
 * model's native vision price, with its base64 size free — but it is
 * **permanent**: once a picture is in the conversation it is in every prompt
 * that follows, and nothing takes it back. A results tool that inlined by
 * default would have an agentic loop quietly buying twenty images of context
 * nobody chose. So `mthds_run_results` reports the free inventory
 * (`image_candidates`) and fetches nothing, and seeing a picture is an act
 * with a name — one a person can say out loud, and the one a console button
 * will later call.
 *
 * Registered on BOTH shells, unlike `mthds_download_artifacts`: a call nobody
 * can make by accident is safe everywhere, and nothing here touches a
 * filesystem.
 *
 * The fetch is the SDK's (`client.fetchArtifact` — fresh link, redirects
 * refused, no credentials forwarded, the cap checked from `Content-Length` and
 * again per chunk), so what this capability owns is the tool envelope, the
 * candidate prefilter, the content-type gate, the caps, the classification of
 * every failure into `ToolError`s, and the prose. See SPEC.md → Run Scope.
 */

/**
 * The per-image budget for connecting, receiving the headers and reading the
 * body. Deliberately far under the SDK's own 120 s default: this tool may make
 * {@link MAX_INLINE_IMAGES} attempts in one call, and a tool call that can hang
 * for twelve minutes is not one a host will wait for. An object store serving
 * at most {@link MAX_INLINE_IMAGE_BYTES} has no honest reason to take longer.
 */
export const INLINE_IMAGE_TIMEOUT_MS = 30_000;

/**
 * The wall-clock budget for ONE call's fetches, all of them together.
 *
 * {@link INLINE_IMAGE_TIMEOUT_MS} bounds a single fetch and nothing else, and
 * the walk is sequential, so without this the per-image timeouts ACCUMULATE:
 * six stalled objects held one tool call for three minutes and more, since
 * each fetch also pays a resolve round-trip before its own timer starts. A
 * host whose deadline is shorter then fails the whole call — losing the
 * pictures that had already arrived and the reasons for the ones that had
 * not, which is the one outcome partial success exists to prevent.
 *
 * So the walk carries its own deadline — and it carries it TWO ways, because
 * `timeoutMs` alone does not hold it. The SDK resolves the storage reference
 * before arming that timer, and the resolve runs under a fixed budget of its
 * own, so a stalled resolve adds a whole further timeout to the candidate
 * being started: 90s of walk against this 60s, and ~120s of tool call once the
 * run lookup ahead of it is counted. Each fetch therefore gets whichever
 * timeout is smaller, its own or the time left, AND an `AbortSignal` for the
 * time left, which is the only thing reaching the resolve as well as the body.
 * A candidate the deadline has already passed is withheld as `deadline`
 * without being attempted. Chosen well under the accumulated worst case and
 * generous for six fetches of objects capped at
 * {@link MAX_INLINE_IMAGE_BYTES}.
 */
export const INLINE_IMAGES_DEADLINE_MS = 60_000;

/** The input schema, its descriptions naming the tools of the shell that registers it. */
export function showImagesInputSchemaFor(names: ToolNames) {
  return {
    run_id: z
      .string()
      .describe(`The durable run id returned by ${names.run} — the run whose images to show.`),
    images: z
      .array(z.string())
      .optional()
      .describe(
        `Which pictures to show, as pipelex-storage:// references taken from ${names.runResults}' image_candidates. Omit to show every candidate (up to the per-call cap). Mutually exclusive with indices.`,
      ),
    indices: z
      .array(z.number().int())
      .optional()
      .describe(
        `Which pictures to show, as zero-based positions in ${names.runResults}' image_candidates. Omit to show every candidate (up to the per-call cap). Mutually exclusive with images.`,
      ),
  };
}

export const mthdsShowImagesInputSchema = showImagesInputSchemaFor(WORKSHOP_TOOL_NAMES);

const withheldReasonSchema = z.enum(["size", "budget", "count", "type", "deadline", "empty"]);

const shownImageSchema = z.object({
  uri: z.string().describe("The pipelex-storage:// reference this entry is about."),
  mime_type: z
    .string()
    .optional()
    .describe(
      "The content type the object store answered with — present once the object was fetched, on the withheld arm too.",
    ),
  bytes: z.number().optional().describe("Size of the stored object, when it was measured."),
  inlined: z
    .boolean()
    .describe("True when this picture is one of the image blocks in this result's content."),
  withheld: withheldReasonSchema
    .optional()
    .describe(
      'Why a picture was not inlined, when no error occurred: "size" (over the per-image cap), "budget" (would cross this call\'s total), "count" (past the per-call attempt cap — not fetched), "type" (the stored object is not an inlineable image type), "deadline" (this call ran out of its total time budget before reaching it — not fetched), "empty" (the stored object declares an image type but holds no bytes).',
    ),
  error: toolErrorSchema.optional().describe("Present when this picture could not be read at all."),
});

/** The output schema, its descriptions naming the tools of the shell that registers it. */
export function showImagesOutputSchemaFor(names: ToolNames) {
  return z.object({
    status: z.enum(["ok", "error"]),
    run_id: z.string().optional(),
    state: z
      .enum(["running", "completed", "failed"])
      .optional()
      .describe(
        `The run lookup outcome, as ${names.runResults} reports it: "running" (nothing to show yet), "completed" (the walk below ran), "failed" (a failed run produces no images).`,
      ),
    retry_after_seconds: z
      .number()
      .nullable()
      .optional()
      .describe('State "running" only — check again after this many seconds.'),
    run_status: runStatusSchema
      .optional()
      .describe('State "failed" only — the terminal lifecycle status.'),
    failure_message: z
      .string()
      .optional()
      .describe('State "failed" only — the platform\'s one-sentence account of the ending.'),
    failure: runFailureSchema
      .optional()
      .describe(
        `State "failed" only, when the run stored an error report — the same object ${names.runResults} carries: why it failed, what to do next, whether running it again can help, and what to give support.`,
      ),
    images: z
      .array(shownImageSchema)
      .optional()
      .describe(
        'State "completed" only — one entry per candidate considered, in the order they were considered: the order you named them when images or indices was given, else discovery order. Bounded — see omitted. Branch on inlined, never on the presence of an image block.',
      ),
    omitted: z
      .number()
      .optional()
      .describe(
        "State \"completed\" only, and only when something was left out — how many of the candidates THIS CALL considered are past the listed ones and so not enumerated here, so a call cannot flood the response. It counts this listing's truncation, not the run's surplus: a narrowed call that named more than the listing holds reports its own excess here. Reach one by its position with indices, which are positions in the run's full candidate list and not in this listing.",
      ),
    all_inlined: z
      .boolean()
      .optional()
      .describe(
        'State "completed" only — true when every candidate THIS RUN produced became an image block: nothing withheld, nothing failed, nothing omitted from the listing, and nothing left unconsidered by a narrowed images/indices selection (vacuously true when the run produced no candidate). So a narrowed call reports false whenever the run holds a picture it did not ask for, and this member keeps answering "is everything this run produced now in front of me" rather than "did what I asked for arrive".',
      ),
    errors: z.array(toolErrorSchema).optional(),
  });
}

export const mthdsShowImagesOutputSchema = showImagesOutputSchemaFor(WORKSHOP_TOOL_NAMES);

export interface MthdsShowImagesInput {
  run_id: string;
  images?: string[];
  indices?: number[];
}

export type WithheldReason = z.infer<typeof withheldReasonSchema>;

export interface ShownImageEntry {
  uri: string;
  mime_type?: string;
  bytes?: number;
  inlined: boolean;
  withheld?: WithheldReason;
  error?: ToolError;
}

export interface ShowImagesStructuredContent {
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";
  retry_after_seconds?: number | null;
  run_status?: RunStatus;
  failure_message?: string;
  /** State "failed" only, when the run stored an error report. */
  failure?: RunFailure;
  images?: ShownImageEntry[];
  omitted?: number;
  all_inlined?: boolean;
  errors?: ToolError[];
}

export interface ShowImagesResult {
  structuredContent: ShowImagesStructuredContent;
  summary: string;
  /**
   * The pictures themselves, appended to the result's `content` after the text
   * block so a host that renders in order shows the summary and then the
   * images. Empty on every arm that inlined nothing.
   */
  imageBlocks: ContentImage[];
}

/**
 * The slice of `PipelexApiClient` this capability calls (test seam). The
 * fetch is the client's own bounded method rather than a separately injected
 * function: it is the same seam shape `ArtifactClient` uses, and
 * `PipelexApiClient` satisfies it structurally.
 */
export interface ImagesClient {
  getRunResult(runId: string): Promise<RunResultState>;
  /** Read once after a failed results arm, for when the run ended and its report (`readFailedRun`). */
  getRunStatus(runId: string, options?: { signal?: AbortSignal }): Promise<RunRead>;
  fetchArtifact(uri: string, options?: FetchArtifactOptions): Promise<Response>;
}

export interface ImagesContext extends ApiConfig {
  client?: ImagesClient;
  /**
   * The explicit plain-http override, read from `ALLOW_HTTP_ENV` in
   * `shared.ts` — the same knob the download tool reads, since both cross the
   * same fetch boundary.
   */
  allowHttp?: boolean;
  /**
   * Whether this shell registers `mthds_download_artifacts`. When true, the
   * summary reminds the caller that the full files can be saved to disk —
   * prose only; the structured contract is identical on both shells.
   */
  artifactDownloadAvailable?: boolean;
  /** The tool names this shell's texts use; the workshop's when absent. */
  toolNames?: ToolNames;
  /** Deployment-specific auth-failure texture; default env-var wording when absent. */
  authError?: AuthErrorTexture;
}

export function buildImagesContext(env = process.env): ImagesContext {
  return buildArtifactFetchConfig(env);
}

// Constructed inside the caught block (mirroring the sibling capabilities): the
// SDK constructor throws PipelineRequestError on a malformed base URL, and that
// must classify to a config ToolError, not reject the MCP handler.
function imagesClient(context: ImagesContext): ImagesClient {
  return context.client ?? createPipelexApiClient(context);
}

export function validateShowImagesRequest(
  input: MthdsShowImagesInput,
  names: ToolNames = WORKSHOP_TOOL_NAMES,
): ToolError[] {
  const errors = validateRunIdRequest(input.run_id, names);

  if (input.images !== undefined && input.indices !== undefined) {
    errors.push({
      class: "input_domain",
      location: "images",
      message: "Pass either images or indices, never both.",
      hint: `Both name the same candidates two ways. Pass the pipelex-storage:// references as images, or their positions in ${names.runResults}' image_candidates as indices, or neither to show them all.`,
      retryable: false,
    });
  }
  if (input.images !== undefined && input.images.length === 0) {
    errors.push(emptySelection("images"));
  }
  if (input.indices !== undefined && input.indices.length === 0) {
    errors.push(emptySelection("indices"));
  }

  return errors;
}

function emptySelection(location: "images" | "indices"): ToolError {
  return {
    class: "input_domain",
    location,
    message: `${location} must not be empty when supplied.`,
    hint: "Name at least one candidate, or omit the field to show every candidate the run produced.",
    retryable: false,
  };
}

export async function showMthdsRunImages(
  input: MthdsShowImagesInput,
  context: ImagesContext = buildImagesContext(),
): Promise<ShowImagesResult> {
  const names = context.toolNames ?? WORKSHOP_TOOL_NAMES;
  const requestErrors = validateShowImagesRequest(input, names);
  if (requestErrors.length > 0) {
    return errorResult("No images were shown: request input is invalid.", requestErrors);
  }

  // The run is read first, so a run that is still running, that failed, or
  // that produced no picture at all is a produced verdict and never a fetch.
  let client: ImagesClient;
  let state: RunResultState;
  try {
    client = imagesClient(context);
    state = await client.getRunResult(input.run_id);
  } catch (err) {
    const error = classifyError(err, { ...runResultsErrorOptions(names), auth: context.authError });
    return errorResult(summaryForToolError(error, ERROR_SUMMARIES), [error]);
  }

  switch (state.state) {
    case "running":
      return runningResult(state.pipeline_run_id, state.retry_after_seconds, names);
    case "failed":
      return failedResult(state, await readFailedRun(client, state.pipeline_run_id));
    case "completed":
      break;
  }

  // The SDK guarantees a non-null main_stuff on a completed run (it throws
  // MissingMainStuffError otherwise); reaching here without one is a contract
  // violation, surfaced as a runtime no-verdict like mthds_run_results does.
  if (state.result.main_stuff == null) {
    return errorResult("No images were shown: the Pipelex API returned a malformed report.", [
      {
        class: "runtime",
        message: "Completed run results did not include main_stuff.",
        hint: "The API responded but its report was missing required fields; inspect the run on the platform.",
        retryable: false,
      },
    ]);
  }

  const runId = state.pipeline_run_id;
  const candidates = imageCandidatesOf(state.result.main_stuff);
  const selection = selectCandidates(candidates, input, names);
  if (!selection.ok) {
    return errorResult("No images were shown: request input is invalid.", [selection.error]);
  }
  if (selection.selected.length === 0) {
    return emptyWalkResult(runId, context.artifactDownloadAvailable === true);
  }

  const walk = await walkCandidates(client, context, selection.selected, candidates.length);

  // A whole-request refusal — the resolve route rejecting the credential, a
  // plan limit, an unreachable host — is not about one picture, and when it
  // stopped the walk before ANY picture was shown there is no partial answer
  // to report: nothing was produced. Reporting `status: "ok"` there told a
  // consumer the call had succeeded on a deployment where every call fails
  // deterministically, and it buried the classified cause (the `paywall`
  // headline above all) under a generic "no picture could be shown" line.
  // Once a picture HAS arrived, partial success is a produced verdict as
  // before and the error rides its own entry.
  if (walk.wholeRequestError !== undefined && walk.blocks.length === 0) {
    return errorResult(summaryForToolError(walk.wholeRequestError, ERROR_SUMMARIES), [
      walk.wholeRequestError,
    ]);
  }

  return completedResult(runId, walk, context.artifactDownloadAvailable === true);
}

// ── the selection ───────────────────────────────────────────────────

type Selection = { ok: true; selected: ImageCandidate[] } | { ok: false; error: ToolError };

/**
 * Intersect the caller's selection with what the run actually produced, so an
 * unknown reference or an out-of-range position is refused before any network
 * call rather than fetched and reported as missing. A selection is answered in
 * the caller's own order; an absent selection is every candidate, in discovery
 * order.
 *
 * A repeat is dropped rather than refused. Naming the same picture twice is a
 * plausible slip and refusing the whole call over it helps nobody, but obeying
 * it literally is worse than either: this tool's entire rationale is that a
 * shown picture is PERMANENT context the caller chose to buy, so a duplicate
 * would spend two of the six attempts, two shares of the byte budget and two
 * identical blocks in every prompt that follows, for one picture.
 */
export function selectCandidates(
  candidates: ImageCandidate[],
  input: Pick<MthdsShowImagesInput, "images" | "indices">,
  names: ToolNames = WORKSHOP_TOOL_NAMES,
): Selection {
  if (input.images !== undefined) {
    const known = new Map(candidates.map((candidate) => [candidate.uri, candidate]));
    const selected: ImageCandidate[] = [];
    const seen = new Set<string>();
    for (const uri of input.images) {
      const candidate = known.get(uri);
      if (candidate === undefined) {
        return {
          ok: false,
          error: {
            class: "input_domain",
            location: "images",
            message: `This run produced no image candidate with the reference ${uri}.`,
            hint: `Take the references from ${names.runResults}' image_candidates for this run id — only a stored reference whose key looks like an image can be shown.`,
            retryable: false,
          },
        };
      }
      if (seen.has(candidate.uri)) continue;
      seen.add(candidate.uri);
      selected.push(candidate);
    }
    return { ok: true, selected };
  }

  if (input.indices !== undefined) {
    const selected: ImageCandidate[] = [];
    const seen = new Set<string>();
    for (const index of input.indices) {
      const candidate = candidates[index];
      if (index < 0 || candidate === undefined) {
        return {
          ok: false,
          error: {
            class: "input_domain",
            location: "indices",
            message: `Index ${index} is outside this run's image candidates (${candidates.length} candidate(s)).`,
            hint: `Indices are zero-based positions in ${names.runResults}' image_candidates for this run id. Pass the references themselves as images when the positions are not to hand.`,
            retryable: false,
          },
        };
      }
      if (seen.has(candidate.uri)) continue;
      seen.add(candidate.uri);
      selected.push(candidate);
    }
    return { ok: true, selected };
  }

  return { ok: true, selected: candidates };
}

// ── the walk ────────────────────────────────────────────────────────

interface Walk {
  entries: ShownImageEntry[];
  blocks: ContentImage[];
  /**
   * Candidates this call CONSIDERED that are past
   * {@link MAX_IMAGE_CANDIDATE_ENTRIES} and so are not enumerated. This is the
   * listing's own truncation; what the caller's selection left out of the run
   * entirely is {@link Walk.unselected}.
   */
  omitted: number;
  /**
   * Candidates the run produced that this call never considered, because
   * `images` or `indices` named others. Zero for a call that narrowed nothing.
   *
   * It exists so `all_inlined` can keep the meaning it is documented with. The
   * walk only ever sees the selection, so a five-picture run asked for one
   * picture had `omitted === 0` and every entry inlined, and reported
   * `all_inlined: true` — telling a consumer that everything the run produced
   * was on screen while four pictures had never been fetched.
   */
  unselected: number;
  /**
   * The failure that was not about any one picture and ended the walk, when
   * one occurred. It rides its own entry as well; this copy is what lets the
   * caller tell a call that produced a partial answer from one that produced
   * nothing at all.
   */
  wholeRequestError?: ToolError;
}

/**
 * Fetch each selected candidate, in order, under three bounds: at most
 * {@link MAX_INLINE_IMAGES} attempts (so one call makes a bounded number of
 * network exchanges whatever the run produced), at most
 * {@link MAX_INLINE_IMAGE_BYTES} per picture, and at most
 * {@link INLINE_IMAGES_BUDGET} across the call.
 *
 * It is bounded a fourth way, in time: {@link INLINE_IMAGES_DEADLINE_MS} caps
 * the whole walk, because the per-image timeout is per image and a sequential
 * walk of stalled objects would otherwise accumulate them into a call no host
 * will wait for. The cap is applied as a timeout AND as an abort signal, since
 * the SDK's timeout starts only after it has resolved the reference.
 *
 * And it is bounded a fifth way, in length: at most
 * {@link MAX_IMAGE_CANDIDATE_ENTRIES} candidates are enumerated at all, the
 * rest counted in `omitted`. One entry per candidate was itself unbounded
 * output on a run that produced hundreds of pictures.
 *
 * Nothing here throws. A per-reference failure is a value on its entry, and a
 * whole-request failure — the resolve route refusing the credential, say —
 * lands on the entry being worked and stops the walk, the untouched rest
 * reported as `count` since no call was made for them. Partial success is a
 * produced verdict: pictures that arrived are never discarded because a
 * sibling failed. The caller turns a whole-request failure that showed
 * NOTHING into a no-verdict; see `showMthdsRunImages`.
 */
async function walkCandidates(
  client: ImagesClient,
  context: ImagesContext,
  selected: ImageCandidate[],
  produced: number,
): Promise<Walk> {
  const entries: ShownImageEntry[] = [];
  const blocks: ContentImage[] = [];
  const allowHttp = allowsPlainHttp(context);
  const listed = selected.slice(0, MAX_IMAGE_CANDIDATE_ENTRIES);
  const startedAt = Date.now();
  let attempts = 0;
  let spent = 0;
  let stopped = false;
  let wholeRequestError: ToolError | undefined;

  for (const candidate of listed) {
    const location = `images[${entries.length}].uri`;
    if (stopped || attempts >= MAX_INLINE_IMAGES) {
      entries.push({ uri: candidate.uri, inlined: false, withheld: "count" });
      continue;
    }
    // Whatever is left of the call's total budget. A candidate reached with
    // none left is withheld without an attempt, so the walk always returns
    // what it has rather than running past a host's own deadline.
    const remaining = INLINE_IMAGES_DEADLINE_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      entries.push({ uri: candidate.uri, inlined: false, withheld: "deadline" });
      continue;
    }
    attempts += 1;

    // `timeoutMs` bounds the body fetch alone — the SDK resolves the reference
    // first, under a budget of its own, and only a signal reaches that half.
    // Without this the walk could spend a whole extra resolve past its own
    // deadline on the candidate it was starting.
    const deadline = AbortSignal.timeout(remaining);

    let response: Response;
    try {
      response = await client.fetchArtifact(candidate.uri, {
        maxBytes: MAX_INLINE_IMAGE_BYTES,
        timeoutMs: Math.min(INLINE_IMAGE_TIMEOUT_MS, remaining),
        allowHttp,
        signal: deadline,
      });
    } catch (err) {
      // This tool's OWN deadline, which is a withholding and not a fault. The
      // SDK re-throws a caller's abort untouched, so it arrives as a raw
      // DOMException rather than an ArtifactFetchError and would otherwise
      // fall through to the whole-request arm below — reporting this tool's
      // time budget as a failure of the request, and as a no-verdict when
      // nothing had yet been inlined. `stopped` is deliberately not set: the
      // next candidate reads `remaining <= 0` and is withheld the same way,
      // which is the truthful reason, where `count` would not be.
      if (deadline.aborted) {
        entries.push({ uri: candidate.uri, inlined: false, withheld: "deadline" });
        continue;
      }
      if (err instanceof ArtifactFetchError) {
        // `too_large` is this tool's OWN cap refusing a declared size, not a
        // fault: it is a withholding with a reason, so the caller reads "too
        // big to show" rather than "something went wrong".
        entries.push(
          err.code === "too_large"
            ? { uri: candidate.uri, inlined: false, withheld: "size" }
            : {
                uri: candidate.uri,
                inlined: false,
                error: itemToolError({ code: err.code, detail: err.message }, location),
              },
        );
        continue;
      }
      // Not about this reference: the resolve route refused the whole request,
      // or the host is unreachable. Nothing after it can succeed either.
      const error = classifyError(err, { ...BULK_RESOLVE_ERROR_OPTIONS, auth: context.authError });
      entries.push({ uri: candidate.uri, inlined: false, error });
      wholeRequestError = error;
      stopped = true;
      continue;
    }

    const mimeType = inlineMimeTypeOf(response);
    if (mimeType === undefined) {
      await cancelBody(response);
      entries.push({
        uri: candidate.uri,
        ...declaredType(response),
        inlined: false,
        withheld: "type",
      });
      continue;
    }

    // The declared length, when the store gave one, spares reading a body
    // whose bytes could not be spent anyway. The real check below still runs:
    // a header may be absent, and it may lie.
    const declared = declaredLength(response);
    if (declared !== undefined && spent + declared > INLINE_IMAGES_BUDGET) {
      await cancelBody(response);
      entries.push({
        uri: candidate.uri,
        mime_type: mimeType,
        bytes: declared,
        inlined: false,
        withheld: "budget",
      });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      // The deadline can fire mid-body too, and reads the same way there.
      if (deadline.aborted) {
        entries.push({
          uri: candidate.uri,
          mime_type: mimeType,
          inlined: false,
          withheld: "deadline",
        });
        continue;
      }
      // The cap is also enforced per chunk, so a lying `Content-Length` errors
      // the stream here with the same code the declared-size refusal used.
      if (err instanceof ArtifactFetchError && err.code === "too_large") {
        entries.push({ uri: candidate.uri, mime_type: mimeType, inlined: false, withheld: "size" });
        continue;
      }
      entries.push({
        uri: candidate.uri,
        mime_type: mimeType,
        inlined: false,
        error:
          err instanceof ArtifactFetchError
            ? itemToolError({ code: err.code, detail: err.message }, location)
            : classifyError(err, { ...BULK_RESOLVE_ERROR_OPTIONS, auth: context.authError }),
      });
      continue;
    }

    // A zero-byte object clears every gate above — its declared type is an
    // image type and no cap can be crossed by nothing — and would be emitted
    // as `data: ""`. Hosts and model APIs refuse an empty image, and an image
    // block is PERMANENT: a block that can never render would sit in every
    // later prompt of the conversation. It is reachable rather than
    // theoretical, because nothing between an upload and a stored object
    // enforces a minimum length: `/v1/upload` declares a maximum only, the
    // SDK derives the content type from the filename, and the runtime's
    // storage interface takes the bytes as given. So it is withheld with a
    // reason, like every other picture that cannot be shown.
    if (bytes.length === 0) {
      entries.push({
        uri: candidate.uri,
        mime_type: mimeType,
        bytes: 0,
        inlined: false,
        withheld: "empty",
      });
      continue;
    }

    if (spent + bytes.length > INLINE_IMAGES_BUDGET) {
      entries.push({
        uri: candidate.uri,
        mime_type: mimeType,
        bytes: bytes.length,
        inlined: false,
        withheld: "budget",
      });
      continue;
    }

    spent += bytes.length;
    entries.push({ uri: candidate.uri, mime_type: mimeType, bytes: bytes.length, inlined: true });
    blocks.push({
      type: "image",
      data: bytes.toString("base64"),
      mimeType,
      // The storage reference, so a programmatic consumer can correlate this
      // block with the main_stuff value it came from. `_meta` never reaches
      // the model, so it costs the conversation nothing.
      //
      // NO `annotations` — see ContentImage in shared.ts. Codex refuses an
      // annotated image block outright with `Unexpected response type`.
      _meta: { uri: candidate.uri },
    });
  }

  return {
    entries,
    blocks,
    omitted: selected.length - listed.length,
    unselected: produced - selected.length,
    ...(wholeRequestError === undefined ? {} : { wholeRequestError }),
  };
}

/**
 * The response's content type, when it is one this tool may emit. The object
 * store's header is the authority: it answers with the type the runtime stored
 * (`store(..., content_type=mime_type)`), where the resolve route's own
 * `content_type` is documented as a guess from the reference's extension.
 * Parameters (`; charset=…`) are stripped and the type lower-cased.
 */
function inlineMimeTypeOf(response: Response): InlineImageMimeType | undefined {
  const declared = declaredType(response).mime_type;
  return declared !== undefined && (INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(declared)
    ? (declared as InlineImageMimeType)
    : undefined;
}

/** The bare content type the store declared, lower-cased, without parameters. */
function declaredType(response: Response): { mime_type?: string } {
  const header = response.headers.get("content-type");
  if (header === null) return {};
  const bare = header.split(";", 1)[0].trim().toLowerCase();
  return bare === "" ? {} : { mime_type: bare };
}

/** The declared body length, when the store gave a usable one. */
function declaredLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Drop a body this tool will not read, so the connection is released rather
 * than left to the garbage collector. A cancel can itself reject (the stream
 * may already be errored by the SDK's own cap), and that is not a failure of
 * anything the caller asked for.
 */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to report: the body is gone either way.
  }
}

// ── projections ─────────────────────────────────────────────────────

/** Mirrors the SDK's base poll interval, like mthds_run_results. */
const DEFAULT_RETRY_SECONDS = 2;

function runningResult(
  runId: string,
  retryAfterSeconds: number | null,
  names: ToolNames,
): ShowImagesResult {
  const seconds = retryAfterSeconds ?? DEFAULT_RETRY_SECONDS;
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "running",
      retry_after_seconds: retryAfterSeconds,
    },
    summary: `Run \`${runId}\` has no result yet — it is still running, so there is nothing to show. Check again in ~${seconds}s with \`${names.runStatus}\`, then call this tool once it is COMPLETED.`,
    imageBlocks: [],
  };
}

function failedResult(state: FailedRunState, failedRead: RunRead | undefined): ShowImagesResult {
  const runId = state.pipeline_run_id;
  const failure = failureOfFailedArm(state, failedRead);
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "failed",
      run_status: state.status,
      failure_message: state.message,
      ...(failure === undefined ? {} : { failure }),
    },
    summary: [
      "# No images",
      failedArmSummaryLines(state, failure, failedRead).join("\n"),
      "A failed run produces no images to show.",
    ].join("\n\n"),
    imageBlocks: [],
  };
}

/** A completed run whose output holds no image candidate at all — a verdict, not an error. */
function emptyWalkResult(runId: string, artifactDownloadAvailable: boolean): ShowImagesResult {
  const parts = [
    "# No images",
    `Run \`${runId}\` completed, but its main output references no stored file whose key looks like an image, so there is nothing to show.`,
  ];
  if (artifactDownloadAvailable) {
    parts.push(
      "Whatever files it did produce can be saved with `mthds_download_artifacts` using this run id.",
    );
  }
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "completed",
      images: [],
      all_inlined: true,
    },
    summary: parts.join("\n\n"),
    imageBlocks: [],
  };
}

/**
 * Verdict discipline, consistent with the download tool: once the walk has run
 * the result is PRODUCED (`status: "ok"`, `state: "completed"`), discriminated
 * on `all_inlined`. Partial success is a produced verdict, not an error.
 */
export function completedResult(
  runId: string,
  walk: Walk,
  artifactDownloadAvailable: boolean,
): ShowImagesResult {
  return {
    structuredContent: {
      status: "ok",
      run_id: runId,
      state: "completed",
      images: walk.entries,
      // Absent rather than zero, like every other "nothing to say" member here.
      ...(walk.omitted === 0 ? {} : { omitted: walk.omitted }),
      // "Everything this run produced is now in front of you" is the question
      // this member answers, so every way a candidate can fail to be in front
      // of the caller counts against it: withheld, failed, past the listing's
      // cap — and, the one that was missing, never selected at all. The walk
      // sees only the selection, so a narrowed call answered for the selection
      // and claimed the run.
      all_inlined:
        walk.omitted === 0 && walk.unselected === 0 && walk.entries.every((entry) => entry.inlined),
    },
    summary: completedSummary(runId, walk, artifactDownloadAvailable),
    imageBlocks: walk.blocks,
  };
}

/** How each withholding reads in the prose — the reason, in the caller's terms. */
const WITHHELD_REASONS: Record<WithheldReason, string> = {
  size: `the stored file is larger than the ${formatBytes(MAX_INLINE_IMAGE_BYTES)} per-image limit`,
  budget: `it would cross this call's ${formatBytes(INLINE_IMAGES_BUDGET)} total limit`,
  // Worded for BOTH the cases the reason covers: the attempt cap, and a
  // whole-request failure that stopped the walk before reaching this one.
  count: `this call stopped attempting before reaching it — a call fetches at most ${MAX_INLINE_IMAGES} picture(s), and a failure that is not about one picture ends the walk`,
  type: "the stored object is not an image type that can be shown",
  empty: "the stored object declares an image type but holds no bytes",
  deadline: `this call used up its ${Math.round(INLINE_IMAGES_DEADLINE_MS / 1000)}s total time budget before reaching it`,
};

function completedSummary(runId: string, walk: Walk, artifactDownloadAvailable: boolean): string {
  const inlined = walk.blocks.length;
  const withheld = walk.entries.filter((entry) => !entry.inlined);

  const parts = ["# Images"];
  parts.push(
    inlined === 0
      ? `No picture from run \`${runId}\` could be shown; each candidate is listed below with why.`
      : `${inlined} picture(s) from run \`${runId}\` follow this message as image content. Each one is now part of this conversation and stays in every later prompt.`,
  );

  if (walk.omitted > 0) {
    // What this counts is the listing's truncation, which equals the run's
    // surplus only when the call considered the whole run. Saying "this run
    // produced N further" was therefore wrong for every narrowed call, and
    // `images` is the wrong instrument besides: the references past the cap
    // are exactly the ones no tool enumerates, so there is nothing to name.
    // `indices` is positional over the run's full list and always reaches them.
    const considered = walk.entries.length + walk.omitted;
    parts.push(
      `This call considered ${considered} picture(s) and lists the first ${walk.entries.length}; the other ${walk.omitted} are not enumerated here. Reach one with \`indices\` — positions run over this run's full candidate list, not over this listing.`,
    );
  }

  if (walk.unselected > 0) {
    parts.push(
      `The run holds ${walk.unselected} further picture(s) this call did not consider, because \`images\`/\`indices\` named others — so \`all_inlined\` is false even though everything named arrived.`,
    );
  }

  if (withheld.length > 0) {
    const lines = withheld.map((entry) => {
      if (entry.error !== undefined) {
        const hint = entry.error.hint === undefined ? "" : ` *Hint: ${entry.error.hint}*`;
        return `- \`${entry.uri}\` — failed: ${entry.error.message}${hint}`;
      }
      const reason =
        entry.withheld === undefined ? "it was not inlined" : WITHHELD_REASONS[entry.withheld];
      const type = entry.mime_type === undefined ? "" : ` (${entry.mime_type})`;
      return `- \`${entry.uri}\`${type} — not shown: ${reason}.`;
    });
    parts.push("## Withheld");
    parts.push(lines.join("\n"));
    parts.push(
      artifactDownloadAvailable
        ? "Call this tool again naming a withheld reference in `images` to retry one on its own, or save the full file with `mthds_download_artifacts` and this run id."
        : "Call this tool again naming a withheld reference in `images` to retry one on its own.",
    );
  }

  return parts.join("\n\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "Images could not be shown: the Pipelex API is unreachable or misconfigured.",
  input_domain: "No images were shown: the Pipelex API rejected the request.",
  runtime: "Images could not be shown: the Pipelex API returned an error.",
  paywall: "Images could not be shown: the organization's Pipelex plan does not cover this call.",
};

function errorResult(summary: string, errors: ToolError[]): ShowImagesResult {
  return {
    structuredContent: { status: "error", errors },
    summary,
    imageBlocks: [],
  };
}

export function showImagesToolResult(result: ShowImagesResult) {
  return {
    structuredContent: result.structuredContent,
    // The text block first, the pictures after it, so a host that renders in
    // order shows the summary and then what it is about.
    content: [
      ...toolResultContent(result.summary, result.structuredContent.errors),
      ...result.imageBlocks,
    ],
    isError: result.structuredContent.status === "error",
  };
}
