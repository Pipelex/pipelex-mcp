import { ApiResponseError, ApiUnreachableError, ArtifactFetchError } from "@pipelex/sdk";
import type { FetchArtifactOptions, RunRead, RunResultState } from "@pipelex/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  INLINE_IMAGES_DEADLINE_MS,
  INLINE_IMAGE_TIMEOUT_MS,
  buildImagesContext,
  selectCandidates,
  showImagesInputSchemaFor,
  showImagesOutputSchemaFor,
  showImagesToolResult,
  showMthdsRunImages,
  validateShowImagesRequest,
} from "./images.js";
import type { ImagesClient, ImagesContext } from "./images.js";
import { RECORDED_FAILED_RUNS } from "./failed-run-fixtures.js";
import { CONSOLE_TOOL_NAMES } from "./tool-names.js";
import {
  DEFAULT_API_URL,
  INLINE_IMAGES_BUDGET,
  MAX_IMAGE_CANDIDATE_ENTRIES,
  MAX_INLINE_IMAGES,
  MAX_INLINE_IMAGE_BYTES,
} from "./shared.js";

const RUN_ID = "01JRUN0000000000000000TEST";

const COVER = "pipelex-storage://runs/01JRUN/outputs/cover.png";
const THUMB = "pipelex-storage://runs/01JRUN/outputs/thumb.jpg";
const REPORT = "pipelex-storage://runs/01JRUN/outputs/report.pdf";
const UNTYPED = "pipelex-storage://runs/01JRUN/outputs/blob";

/**
 * A 1x1 transparent PNG — the same real bytes the live suite uploads. Real,
 * because these tests assert the base64 that reaches the image block, and a
 * placeholder string would make that assertion prove nothing about the
 * encoding.
 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A completed run's main output, in the shape the runtime really serializes:
 * each produced file is content carrying its durable `pipelex-storage://`
 * reference in `url` beside an expiring `public_url` the walk ignores. Four
 * references, on purpose — two that look like images, one that plainly does
 * not, and one whose key has no extension at all, which only the fetched
 * content type can settle.
 */
function mainStuff(): unknown {
  return {
    cover: { url: COVER, public_url: "https://store.example/cover.png?sig=1" },
    appendix: [
      { url: REPORT, public_url: "https://store.example/report.pdf?sig=1" },
      { url: THUMB, public_url: "https://store.example/thumb.jpg?sig=1" },
      { url: UNTYPED, public_url: "https://store.example/blob?sig=1" },
    ],
  };
}

function completedRun(stuff: unknown = mainStuff()): RunResultState {
  return {
    state: "completed",
    pipeline_run_id: RUN_ID,
    result: { pipeline_run_id: RUN_ID, main_stuff: stuff },
  };
}

interface FetchRecord {
  uri: string;
  options?: FetchArtifactOptions;
}

/** One canned answer per reference: a `Response`, or something to throw. */
type Answer = { response: () => Response } | { throws: () => unknown };

function imageResponse(
  bytes: Buffer,
  contentType = "image/png",
  headers: Record<string, string> = {},
): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType, ...headers },
  });
}

/** The status read a failed arm is followed by; every other arm must not make one. */
function noStatusRead(): Promise<RunRead> {
  return Promise.reject(new Error("getRunStatus must not be called"));
}

function fakeClient(
  answers: Record<string, Answer>,
  state: RunResultState = completedRun(),
): { client: ImagesClient; fetches: FetchRecord[] } {
  const fetches: FetchRecord[] = [];
  const client: ImagesClient = {
    getRunStatus: noStatusRead,
    getRunResult: () => Promise.resolve(state),
    fetchArtifact: (uri, options) => {
      fetches.push({ uri, options });
      const answer = answers[uri];
      if (answer === undefined) {
        return Promise.reject(new Error(`unexpected fetch of ${uri}`));
      }
      return "throws" in answer
        ? Promise.reject(answer.throws())
        : Promise.resolve(answer.response());
    },
  };
  return { client, fetches };
}

function context(client: ImagesClient, overrides: Partial<ImagesContext> = {}): ImagesContext {
  return { baseUrl: DEFAULT_API_URL, apiKey: "plx_sk_test", client, ...overrides };
}

/**
 * Drive `Date.now` through a fixed script, so the deadline's arithmetic can be
 * exercised at its boundaries without a test that really waits a minute. The
 * walk reads the clock once for `startedAt` and once per candidate it reaches,
 * so the script is `[start, atCandidate0, atCandidate1, ...]`; the last value
 * is held for any further read.
 */
function scriptedClock(times: number[]): () => void {
  let next = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => {
    const value = times[Math.min(next, times.length - 1)];
    next += 1;
    return value;
  });
  return () => spy.mockRestore();
}

function apiError(route: string, status: number, message: string): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}${route}`,
    status,
    "Error",
    "{}",
    "error",
    message,
    undefined,
    undefined,
  );
}

describe("validateShowImagesRequest", () => {
  it("takes a bare run id", () => {
    expect(validateShowImagesRequest({ run_id: RUN_ID })).toEqual([]);
  });

  it("refuses a blank run id", () => {
    const [error] = validateShowImagesRequest({ run_id: "  " });

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("run_id");
  });

  it("refuses naming the same candidates two ways", () => {
    const errors = validateShowImagesRequest({ run_id: RUN_ID, images: [COVER], indices: [0] });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ class: "input_domain", location: "images" });
    expect(errors[0].message).toContain("never both");
  });

  it("refuses an empty selection on either field", () => {
    expect(validateShowImagesRequest({ run_id: RUN_ID, images: [] })[0]).toMatchObject({
      location: "images",
    });
    expect(validateShowImagesRequest({ run_id: RUN_ID, indices: [] })[0]).toMatchObject({
      location: "indices",
    });
  });
});

describe("selectCandidates", () => {
  const candidates = [
    { uri: COVER, key: "runs/01JRUN/outputs/cover.png" },
    { uri: THUMB, key: "runs/01JRUN/outputs/thumb.jpg" },
  ];

  it("answers every candidate when nothing was selected", () => {
    const selection = selectCandidates(candidates, {});

    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.selected).toEqual(candidates);
  });

  it("answers a URI selection in the caller's own order", () => {
    const selection = selectCandidates(candidates, { images: [THUMB, COVER] });

    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.selected.map((item) => item.uri)).toEqual([THUMB, COVER]);
  });

  it("answers an index selection", () => {
    const selection = selectCandidates(candidates, { indices: [1] });

    expect(selection.ok).toBe(true);
    if (selection.ok) expect(selection.selected.map((item) => item.uri)).toEqual([THUMB]);
  });

  it("refuses a reference the run did not produce", () => {
    const selection = selectCandidates(candidates, { images: [REPORT] });

    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.error).toMatchObject({ class: "input_domain", location: "images" });
      expect(selection.error.message).toContain(REPORT);
    }
  });

  it("refuses an index outside the candidate list, at either end", () => {
    for (const index of [-1, 2]) {
      const selection = selectCandidates(candidates, { indices: [index] });
      expect(selection.ok).toBe(false);
      if (!selection.ok) expect(selection.error.location).toBe("indices");
    }
  });
});

describe("showMthdsRunImages", () => {
  it("inlines the candidates in discovery order and never fetches the PDF", async () => {
    const { client, fetches } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
      [THUMB]: { response: () => imageResponse(TINY_PNG, "image/jpeg") },
      [UNTYPED]: { response: () => imageResponse(TINY_PNG, "image/png") },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(fetches.map((call) => call.uri)).toEqual([COVER, THUMB, UNTYPED]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.state).toBe("completed");
    expect(result.structuredContent.all_inlined).toBe(true);
    expect(result.structuredContent.images).toEqual([
      { uri: COVER, mime_type: "image/png", bytes: TINY_PNG.length, inlined: true },
      { uri: THUMB, mime_type: "image/jpeg", bytes: TINY_PNG.length, inlined: true },
      { uri: UNTYPED, mime_type: "image/png", bytes: TINY_PNG.length, inlined: true },
    ]);
    expect(result.imageBlocks.map((block) => block.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/png",
    ]);
    expect(result.imageBlocks[0].data).toBe(TINY_PNG.toString("base64"));
    expect(result.imageBlocks[0]._meta).toEqual({ uri: COVER });
  });

  /**
   * The one property a host failure would otherwise teach us about in
   * production: Codex refuses an image block carrying `annotations` outright,
   * with an opaque `Unexpected response type`, and accepts the identical block
   * without them (`wip/mcp-image-results/host-probe.md`).
   */
  it("emits no annotations on any block", async () => {
    const { client } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
      [THUMB]: { response: () => imageResponse(TINY_PNG, "image/jpeg") },
      [UNTYPED]: { response: () => imageResponse(TINY_PNG) },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));
    const blocks = showImagesToolResult(result).content.filter((item) => item.type === "image");

    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block).not.toHaveProperty("annotations");
      expect(Object.keys(block).sort()).toEqual(["_meta", "data", "mimeType", "type"]);
    }
  });

  it("passes this tool's own bounds to every fetch", async () => {
    const { client, fetches } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
    });

    await showMthdsRunImages({ run_id: RUN_ID, images: [COVER] }, context(client));

    expect(fetches[0].options).toMatchObject({
      maxBytes: MAX_INLINE_IMAGE_BYTES,
      timeoutMs: INLINE_IMAGE_TIMEOUT_MS,
      allowHttp: false,
    });
    // The signal is not decoration: `timeoutMs` starts only once the SDK has
    // resolved the reference, so the signal is the only bound on the resolve.
    expect(fetches[0].options?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(fetches[0].options ?? {}).sort()).toEqual([
      "allowHttp",
      "maxBytes",
      "signal",
      "timeoutMs",
    ]);
  });

  it("derives the plain-http rule from the configured API, like the download tool", async () => {
    const { client, fetches } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
    });

    await showMthdsRunImages(
      { run_id: RUN_ID, images: [COVER] },
      context(client, { baseUrl: "http://localhost:8081" }),
    );

    expect(fetches[0].options?.allowHttp).toBe(true);
  });

  it("withholds a non-image type, cancels its body, and says what it was", async () => {
    const body = new Response("not an image", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    const { client } = fakeClient({ [UNTYPED]: { response: () => body } });

    const result = await showMthdsRunImages({ run_id: RUN_ID, images: [UNTYPED] }, context(client));

    expect(result.structuredContent.images).toEqual([
      { uri: UNTYPED, mime_type: "text/plain", inlined: false, withheld: "type" },
    ]);
    expect(result.structuredContent.all_inlined).toBe(false);
    expect(result.imageBlocks).toEqual([]);
    // The body was released rather than read.
    expect(body.bodyUsed || body.body === null || body.body.locked).toBe(true);
    expect(result.summary).toContain("## Withheld");
    expect(result.summary).toContain("not an image type");
  });

  it("reads the SDK's own oversize refusal as a withholding, not a failure", async () => {
    const { client } = fakeClient({
      [COVER]: {
        throws: () =>
          new ArtifactFetchError("declared 9.0 MiB, over the cap", COVER, "too_large", 200),
      },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID, images: [COVER] }, context(client));

    expect(result.structuredContent.images).toEqual([
      { uri: COVER, inlined: false, withheld: "size" },
    ]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.summary).toContain("per-image limit");
  });

  it("reads a body that crosses the cap mid-stream as the same withholding", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(
          new ArtifactFetchError("body crossed the cap", COVER, "too_large", undefined),
        );
      },
    });
    const { client } = fakeClient({
      [COVER]: {
        response: () =>
          new Response(stream, { status: 200, headers: { "content-type": "image/png" } }),
      },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID, images: [COVER] }, context(client));

    expect(result.structuredContent.images).toEqual([
      { uri: COVER, mime_type: "image/png", inlined: false, withheld: "size" },
    ]);
  });

  it("withholds the picture that would cross the call's budget and keeps walking", async () => {
    // Just over half the budget each, so the first fits and the second does not
    // — and a third, tiny one still does.
    const big = Buffer.alloc(Math.floor(INLINE_IMAGES_BUDGET * 0.6), 1);
    const { client, fetches } = fakeClient({
      [COVER]: { response: () => imageResponse(big) },
      [THUMB]: { response: () => imageResponse(big, "image/jpeg") },
      [UNTYPED]: { response: () => imageResponse(TINY_PNG) },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.images).toEqual([
      { uri: COVER, mime_type: "image/png", bytes: big.length, inlined: true },
      {
        uri: THUMB,
        mime_type: "image/jpeg",
        bytes: big.length,
        inlined: false,
        withheld: "budget",
      },
      { uri: UNTYPED, mime_type: "image/png", bytes: TINY_PNG.length, inlined: true },
    ]);
    // The walk kept going: the smaller sibling was still attempted.
    expect(fetches).toHaveLength(3);
    expect(result.imageBlocks).toHaveLength(2);
    expect(result.summary).toContain("total limit");
  });

  it("spares the body of a picture whose declared length alone crosses the budget", async () => {
    const big = Buffer.alloc(Math.floor(INLINE_IMAGES_BUDGET * 0.6), 1);
    const declared = new Response(new Uint8Array(big), {
      status: 200,
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(INLINE_IMAGES_BUDGET),
      },
    });
    const { client } = fakeClient({
      [COVER]: { response: () => imageResponse(big) },
      [THUMB]: { response: () => declared },
      [UNTYPED]: { response: () => imageResponse(TINY_PNG) },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.images?.[1]).toEqual({
      uri: THUMB,
      mime_type: "image/jpeg",
      bytes: INLINE_IMAGES_BUDGET,
      inlined: false,
      withheld: "budget",
    });
    expect(declared.bodyUsed || declared.body === null || declared.body.locked).toBe(true);
  });

  it("stops attempting past the count cap, and fetches nothing for the rest", async () => {
    const uris = Array.from(
      { length: MAX_INLINE_IMAGES + 2 },
      (_, index) => `pipelex-storage://runs/01JRUN/outputs/picture-${index}.png`,
    );
    const answers = Object.fromEntries(
      uris.map((uri) => [uri, { response: () => imageResponse(TINY_PNG) } as Answer]),
    );
    const { client, fetches } = fakeClient(
      answers,
      completedRun(uris.map((uri) => ({ url: uri }))),
    );

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(fetches).toHaveLength(MAX_INLINE_IMAGES);
    expect(result.imageBlocks).toHaveLength(MAX_INLINE_IMAGES);
    expect(result.structuredContent.images).toHaveLength(uris.length);
    for (const entry of result.structuredContent.images?.slice(MAX_INLINE_IMAGES) ?? []) {
      expect(entry).toMatchObject({ inlined: false, withheld: "count" });
      expect(entry).not.toHaveProperty("bytes");
    }
    expect(result.structuredContent.all_inlined).toBe(false);
    expect(result.summary).toContain(`at most ${MAX_INLINE_IMAGES} picture(s)`);
  });

  it("keeps a successful sibling when one reference has vanished", async () => {
    const { client } = fakeClient({
      [COVER]: {
        throws: () => new ArtifactFetchError("object is gone (HTTP 404).", COVER, "not_found", 404),
      },
      [THUMB]: { response: () => imageResponse(TINY_PNG, "image/jpeg") },
      [UNTYPED]: { response: () => imageResponse(TINY_PNG) },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.images?.[0]).toMatchObject({
      uri: COVER,
      inlined: false,
      error: { class: "input_domain", location: "images[0].uri", retryable: false },
    });
    expect(result.imageBlocks).toHaveLength(2);
    expect(result.summary).toContain("failed: object is gone");
  });

  it("is a NO-VERDICT when a whole-request refusal showed nothing at all", async () => {
    // Round 1's finding: a deployment where the resolve route rejects the
    // credential, or where a plan limit refuses it, failed every call
    // deterministically and answered `status: "ok"` — a consumer branching on
    // status read a success, and the classified cause was buried under a
    // generic "no picture could be shown" line.
    const { client, fetches } = fakeClient({
      [COVER]: { throws: () => apiError("/v1/resolve-storage-url/bulk", 400, "no active org") },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(fetches).toHaveLength(1);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({ class: "config" });
    expect(result.structuredContent).not.toHaveProperty("images");
    expect(showImagesToolResult(result).isError).toBe(true);
  });

  it("names the plan in the headline when the refusal is a paywall", async () => {
    // The whole point of routing a no-verdict through summaryForToolError: on
    // a host that shows the agent only the top content line, the generic
    // connectivity headline WAS the entire message for a billing refusal.
    const { client } = fakeClient({
      [COVER]: { throws: () => apiError("/v1/resolve-storage-url/bulk", 402, "plan limit") },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({ kind: "paywall" });
    expect(result.summary).toContain("plan does not cover this call");
  });

  it("stays a PRODUCED verdict when a picture had already arrived", async () => {
    // Partial success is still partial success: the refusal rides its own
    // entry, the pictures that arrived are never discarded, and the untouched
    // rest is reported as `count`.
    const { client, fetches } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
      [THUMB]: { throws: () => apiError("/v1/resolve-storage-url/bulk", 400, "no active org") },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(fetches).toHaveLength(2);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.imageBlocks).toHaveLength(1);
    expect(result.structuredContent.images?.[0]).toMatchObject({ uri: COVER, inlined: true });
    expect(result.structuredContent.images?.[1]).toMatchObject({
      uri: THUMB,
      inlined: false,
      error: { class: "config" },
    });
    expect(result.structuredContent.images?.slice(2)).toEqual([
      { uri: UNTYPED, inlined: false, withheld: "count" },
    ]);
    expect(result.structuredContent.all_inlined).toBe(false);
  });

  it("clamps a later fetch to what is left of the call's budget, not its own timeout", async () => {
    // The per-image timeout is per image and the walk is sequential, so
    // without a shared deadline six stalled objects held one call for three
    // minutes and more — and a host with a shorter deadline lost the whole
    // call, pictures already fetched included.
    //
    // This asserts the clamp ITSELF, with a number only the clamp can produce.
    // An assertion that each timeout is merely <= INLINE_IMAGE_TIMEOUT_MS and
    // <= INLINE_IMAGES_DEADLINE_MS holds just as well when every fetch gets
    // the flat per-image timeout, so it passed with the deadline deleted.
    const { client, fetches } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
      [THUMB]: { response: () => imageResponse(TINY_PNG, "image/jpeg") },
    });

    // 50s of the 60s budget is gone by the time the second candidate starts.
    const restore = scriptedClock([0, 0, 50_000]);
    try {
      await showMthdsRunImages({ run_id: RUN_ID, images: [COVER, THUMB] }, context(client));
    } finally {
      restore();
    }

    expect(fetches).toHaveLength(2);
    expect(fetches[0].options?.timeoutMs).toBe(INLINE_IMAGE_TIMEOUT_MS);
    expect(fetches[1].options?.timeoutMs).toBe(INLINE_IMAGES_DEADLINE_MS - 50_000);
    expect(fetches[1].options?.timeoutMs).toBeLessThan(INLINE_IMAGE_TIMEOUT_MS);
  });

  it("withholds a candidate the deadline has already passed, without attempting it", async () => {
    const { client, fetches } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
      [THUMB]: { response: () => imageResponse(TINY_PNG, "image/jpeg") },
    });

    // The budget is spent before the second candidate is reached.
    const restore = scriptedClock([0, 0, INLINE_IMAGES_DEADLINE_MS + 1_000]);
    let result;
    try {
      result = await showMthdsRunImages(
        { run_id: RUN_ID, images: [COVER, THUMB] },
        context(client),
      );
    } finally {
      restore();
    }

    expect(fetches.map((fetch) => fetch.uri)).toEqual([COVER]);
    expect(result.structuredContent.images?.[1]).toEqual({
      uri: THUMB,
      inlined: false,
      withheld: "deadline",
    });
    // Withheld, not failed — and the picture that did arrive is still shown.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.imageBlocks).toHaveLength(1);
  });

  it("reads its own deadline abort as a withholding, never as a whole-request failure", async () => {
    // The SDK re-throws a caller's abort untouched, so the deadline arrives as
    // a raw DOMException rather than an ArtifactFetchError. Left to the
    // whole-request arm it would end the walk AND — with nothing yet inlined —
    // turn this tool's own time budget into a `status: "error"` no-verdict.
    const fetches: string[] = [];
    const client: ImagesClient = {
      getRunStatus: noStatusRead,
      getRunResult: () => Promise.resolve(completedRun()),
      fetchArtifact: (uri, options) => {
        fetches.push(uri);
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject((options.signal as AbortSignal).reason);
          });
        });
      },
    };

    // 10ms left of the budget, so the signal really fires, quickly.
    const restore = scriptedClock([0, INLINE_IMAGES_DEADLINE_MS - 10]);
    let result;
    try {
      result = await showMthdsRunImages({ run_id: RUN_ID, images: [COVER] }, context(client));
    } finally {
      restore();
    }

    expect(fetches).toEqual([COVER]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.errors).toBeUndefined();
    expect(result.structuredContent.images).toEqual([
      { uri: COVER, inlined: false, withheld: "deadline" },
    ]);
  });

  it("enumerates at most the entry cap, and counts the rest as omitted", async () => {
    // One entry and one prose line per candidate was itself unbounded output:
    // a run with hundreds of pictures put hundreds of `withheld: "count"`
    // entries into a result that fetches six.
    const pictures = Array.from(
      { length: MAX_IMAGE_CANDIDATE_ENTRIES + 5 },
      (_unused, index) => `pipelex-storage://runs/01JRUN/outputs/frame-${index}.png`,
    );
    const { client } = fakeClient(
      { [pictures[0]]: { response: () => imageResponse(TINY_PNG) } },
      completedRun(pictures.map((url) => ({ url }))),
    );

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.images).toHaveLength(MAX_IMAGE_CANDIDATE_ENTRIES);
    expect(result.structuredContent.omitted).toBe(5);
    // Omission counts against it: a candidate nobody enumerated is not shown.
    expect(result.structuredContent.all_inlined).toBe(false);
    expect(result.summary).toContain("the other 5 are not enumerated here");
    // `indices` is the route that reaches them; `images` cannot, because the
    // references past the cap are exactly the ones nothing enumerates.
    expect(result.summary).toContain("`indices`");
  });

  it("withholds a stored object that declares an image type but holds no bytes", async () => {
    // Every gate above passes for nothing: the type is right, and no cap can
    // be crossed by zero bytes. Emitted, it is `data: ""` — which a host
    // refuses, and which would sit in every later prompt, because an image
    // block is permanent.
    const { client } = fakeClient({
      [COVER]: { response: () => imageResponse(Buffer.alloc(0)) },
      [THUMB]: { response: () => imageResponse(TINY_PNG, "image/jpeg") },
      [UNTYPED]: { response: () => imageResponse(TINY_PNG) },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.images?.[0]).toEqual({
      uri: COVER,
      mime_type: "image/png",
      bytes: 0,
      inlined: false,
      withheld: "empty",
    });
    // Withheld, not failed — and it never becomes a block.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.imageBlocks).toHaveLength(2);
    expect(result.imageBlocks.every((block) => block.data.length > 0)).toBe(true);
    expect(result.structuredContent.all_inlined).toBe(false);
    expect(result.summary).toContain("holds no bytes");
  });

  it("reports all_inlined false when a narrowed call left a run candidate unconsidered", async () => {
    // The walk only ever sees the selection, so `all_inlined` used to answer
    // "did what I asked for arrive" while the schema and SPEC both promise it
    // answers "is everything this run produced now in front of me". A
    // consumer branching on the documented meaning concluded the whole run was
    // on screen and never showed the rest.
    const { client } = fakeClient({ [COVER]: { response: () => imageResponse(TINY_PNG) } });

    const result = await showMthdsRunImages({ run_id: RUN_ID, images: [COVER] }, context(client));

    expect(result.structuredContent.images).toEqual([
      { uri: COVER, mime_type: "image/png", bytes: TINY_PNG.length, inlined: true },
    ]);
    // Everything asked for arrived, and the run still holds two more.
    expect(result.structuredContent.all_inlined).toBe(false);
    expect(result.summary).toContain("2 further picture(s) this call did not consider");
  });

  it("keeps all_inlined true when the call considered every candidate the run produced", async () => {
    const { client } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
      [THUMB]: { response: () => imageResponse(TINY_PNG, "image/jpeg") },
      [UNTYPED]: { response: () => imageResponse(TINY_PNG) },
    });

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.all_inlined).toBe(true);
    expect(result.summary).not.toContain("did not consider");
  });

  it("counts omitted as this listing's truncation, never as the run's surplus", async () => {
    // A hundred candidates, forty of them named. The listing truncates at 32,
    // so `omitted` is 8 — the call's own excess — while the run holds 60 more
    // the call never considered. The old prose called those 8 "further
    // picture(s) this run produced", which is a different and wrong number.
    const pictures = Array.from(
      { length: 100 },
      (_unused, index) => `pipelex-storage://runs/01JRUN/outputs/frame-${index}.png`,
    );
    const named = pictures.slice(0, 40);
    const answers = Object.fromEntries(
      pictures
        .slice(0, MAX_INLINE_IMAGES)
        .map((uri) => [uri, { response: () => imageResponse(TINY_PNG) }]),
    );
    const { client } = fakeClient(answers, completedRun(pictures.map((url) => ({ url }))));

    const result = await showMthdsRunImages({ run_id: RUN_ID, images: named }, context(client));

    expect(result.structuredContent.omitted).toBe(8);
    expect(result.summary).toContain("This call considered 40 picture(s) and lists the first 32");
    expect(result.summary).toContain("the other 8 are not enumerated here");
    expect(result.summary).toContain(
      "The run holds 60 further picture(s) this call did not consider",
    );
    expect(result.structuredContent.all_inlined).toBe(false);
  });

  it("produces a verdict, not an error, for a run that is still running", async () => {
    const client: ImagesClient = {
      getRunStatus: noStatusRead,
      getRunResult: () =>
        Promise.resolve({ state: "running", pipeline_run_id: RUN_ID, retry_after_seconds: 5 }),
      fetchArtifact: () => Promise.reject(new Error("must not fetch")),
    };

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      state: "running",
      retry_after_seconds: 5,
    });
    expect(result.imageBlocks).toEqual([]);
    expect(result.summary).toContain("~5s");
  });

  it("produces a verdict, not an error, for a failed run, saying why it failed", async () => {
    const { resultsArm, statusRead } = RECORDED_FAILED_RUNS.llmCompletion;
    const client: ImagesClient = {
      getRunStatus: () => Promise.resolve(statusRead),
      getRunResult: () => Promise.resolve(resultsArm),
      fetchArtifact: () => Promise.reject(new Error("must not fetch")),
    };

    const result = await showMthdsRunImages(
      { run_id: statusRead.pipeline_run_id },
      context(client),
    );

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      state: "failed",
      run_status: "FAILED",
      failure_message: resultsArm.message,
      failure: {
        run_id: statusRead.pipeline_run_id,
        error_type: "LLMCompletionError",
        title: "LLM completion",
        retryable: false,
        finished_at: statusRead.finished_at,
      },
    });
    expect(result.structuredContent.failure).not.toHaveProperty("provider_metadata");
    expect(result.summary).toContain("Why: LLM completion — ");
    expect(result.summary).toContain("What to do: The provider rejected the request");
    expect(result.summary).toContain(
      "Retry: The report does not expect running it again unchanged to help.",
    );
    expect(result.summary).toContain(
      `For support: Run ${statusRead.pipeline_run_id} · LLMCompletionError · ended ${statusRead.finished_at ?? ""}`,
    );
    expect(result.imageBlocks).toEqual([]);
  });

  it("takes the report from the failed arm when it relays one", async () => {
    const { relayedArm } = RECORDED_FAILED_RUNS.sandboxProvisioning;
    const client: ImagesClient = {
      getRunStatus: () => Promise.reject(new Error("status unavailable")),
      getRunResult: () => Promise.resolve(relayedArm),
      fetchArtifact: () => Promise.reject(new Error("must not fetch")),
    };

    const result = await showMthdsRunImages(
      { run_id: relayedArm.pipeline_run_id },
      context(client),
    );

    expect(result.structuredContent.failure).toEqual({
      run_id: relayedArm.pipeline_run_id,
      error_type: "SandboxProvisioningError",
      title: "Sandbox provisioning",
      message: relayedArm.error?.message,
    });
    expect(result.summary).not.toMatch(/Retry:/);
  });

  it("produces an empty verdict, and fetches nothing, for a run with no candidate", async () => {
    const { client, fetches } = fakeClient(
      {},
      completedRun({ doc: { url: REPORT }, answer: "no pictures here" }),
    );

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(fetches).toEqual([]);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      state: "completed",
      images: [],
      all_inlined: true,
    });
    expect(result.summary).toContain("nothing to show");
  });

  it("names the download tool only on a shell that has it", async () => {
    const { client } = fakeClient({}, completedRun({ answer: 42 }));

    const workshop = await showMthdsRunImages(
      { run_id: RUN_ID },
      context(client, { artifactDownloadAvailable: true }),
    );
    const console_ = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(workshop.summary).toContain("mthds_download_artifacts");
    expect(console_.summary).not.toContain("mthds_download_artifacts");
    // The structured contract is identical on both shells — that is the point.
    expect(workshop.structuredContent).toEqual(console_.structuredContent);
  });

  it("refuses a selection before reading anything from the network", async () => {
    const { client, fetches } = fakeClient({});

    const result = await showMthdsRunImages({ run_id: RUN_ID, images: [REPORT] }, context(client));

    expect(fetches).toEqual([]);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({ location: "images" });
    expect(result.imageBlocks).toEqual([]);
  });

  it("classifies an unreachable API as a no-verdict rather than a walk", async () => {
    const client: ImagesClient = {
      getRunStatus: noStatusRead,
      getRunResult: () =>
        Promise.reject(new ApiUnreachableError("refused", DEFAULT_API_URL, "ECONNREFUSED")),
      fetchArtifact: () => Promise.reject(new Error("must not fetch")),
    };

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "config",
      retryable: true,
    });
    expect(result.summary).toContain("unreachable or misconfigured");
  });

  it("reports a completed result with no main_stuff as a runtime no-verdict", async () => {
    const client: ImagesClient = {
      getRunStatus: noStatusRead,
      getRunResult: () =>
        Promise.resolve({
          state: "completed",
          pipeline_run_id: RUN_ID,
          result: { pipeline_run_id: RUN_ID, main_stuff: null },
        }),
      fetchArtifact: () => Promise.reject(new Error("must not fetch")),
    };

    const result = await showMthdsRunImages({ run_id: RUN_ID }, context(client));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0].class).toBe("runtime");
  });
});

describe("buildImagesContext", () => {
  it("reads the API coordinates and the shared plain-http override", () => {
    expect(buildImagesContext({}).baseUrl).toBe(DEFAULT_API_URL);
    expect(buildImagesContext({ PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP: "true" }).allowHttp).toBe(true);
  });
});

describe("showImagesToolResult", () => {
  it("puts the text block first and the pictures after it", async () => {
    const { client } = fakeClient({
      [COVER]: { response: () => imageResponse(TINY_PNG) },
      [THUMB]: { response: () => imageResponse(TINY_PNG, "image/jpeg") },
      [UNTYPED]: { response: () => imageResponse(TINY_PNG) },
    });

    const tool = showImagesToolResult(
      await showMthdsRunImages({ run_id: RUN_ID }, context(client)),
    );

    expect(tool.isError).toBe(false);
    expect(tool.content.map((item) => item.type)).toEqual(["text", "image", "image", "image"]);
  });

  it("carries no picture, and flags the error, on a no-verdict", async () => {
    const { client } = fakeClient({});

    const tool = showImagesToolResult(await showMthdsRunImages({ run_id: "  " }, context(client)));

    expect(tool.isError).toBe(true);
    expect(tool.content.map((item) => item.type)).toEqual(["text"]);
  });
});

describe("pipelex_show_images, the console's twin", () => {
  it("names only the console's tools in its schemas and refusals", () => {
    const schemas = JSON.stringify([
      z.toJSONSchema(z.object(showImagesInputSchemaFor(CONSOLE_TOOL_NAMES))),
      z.toJSONSchema(showImagesOutputSchemaFor(CONSOLE_TOOL_NAMES)),
    ]);
    const refusals = JSON.stringify([
      ...validateShowImagesRequest({ run_id: "  " }, CONSOLE_TOOL_NAMES),
      ...validateShowImagesRequest(
        { run_id: RUN_ID, images: [COVER], indices: [0] },
        CONSOLE_TOOL_NAMES,
      ),
    ]);

    expect(schemas).toContain("pipelex_run_results");
    for (const text of [schemas, refusals]) {
      expect(text).not.toContain("mthds_");
    }
  });
});
