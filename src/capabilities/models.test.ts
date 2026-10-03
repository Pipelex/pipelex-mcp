import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError, ClientAuthenticationError } from "@pipelex/sdk";
import { MODEL_CATEGORIES } from "mthds/protocol";
import type { ModelCategory, ModelDeck } from "mthds/protocol";

import {
  MAX_REFERENCE_LENGTH,
  PIPE_TYPE_OF,
  closeMatches,
  mthdsModelsInputSchema,
  modelsToolResult,
  parseModelReference,
  readMthdsModels,
  similarity,
} from "./models.js";
import type {
  ModelDeckListing,
  ModelReferenceCheck,
  ModelsContext,
  ModelsResult,
  MthdsModelsInput,
} from "./models.js";
import { DEFAULT_API_URL } from "./shared.js";

/**
 * A deck shaped as the Pipelex runner answers `GET /v1/models` (measured on the
 * dev API on 2026-09-27): the presets in `models`, each stamped with its
 * category, and the category-keyed `aliases` and `waterfalls` extensions. The
 * dev deck has no waterfall, so this one adds one to exercise that kind, and no
 * judgment preset, since the kit deck ships the judgment alias alone, so this
 * one adds one to list the protocol's fifth category in full.
 */
const DECK = {
  models: [
    { name: "writing-factual", type: "llm" },
    { name: "writing-factual-cheap", type: "llm" },
    { name: "writing-creative", type: "llm" },
    { name: "vision", type: "llm" },
    { name: "extract-testing", type: "extract" },
    { name: "gen-image", type: "img_gen" },
    { name: "gen-image-fast", type: "img_gen" },
    { name: "standard", type: "search" },
    { name: "judgment-strict", type: "judgment" },
  ],
  aliases: {
    llm: {
      "best-claude": "claude-4.6-sonnet",
      "best-gpt": "gpt-5.6-sol",
      "default-small": "gpt-5.6-luna",
    },
    img_gen: { "best-gpt": "gpt-image-2", "default-small": "gpt-image-1-mini" },
    extract: { "default-premium": "azure-document-intelligence" },
    search: { "default-search": "linkup-standard" },
    judgment: { "default-judgment": "jev-1.13.0" },
  },
  waterfalls: {
    llm: { "robust-llm": ["claude-4.6-sonnet", "gpt-5.6-sol"] },
    img_gen: {},
    extract: {},
    search: {},
    judgment: {},
  },
};

interface Recorded {
  calls: Array<ModelCategory | undefined>;
  context: ModelsContext;
}

function contextAnswering(deck: unknown = DECK): Recorded {
  const calls: Array<ModelCategory | undefined> = [];
  return {
    calls,
    context: {
      baseUrl: DEFAULT_API_URL,
      client: {
        async models(category?: ModelCategory) {
          calls.push(category);
          return deck as ModelDeck;
        },
      },
    },
  };
}

function contextFailing(error: unknown, overrides: Partial<ModelsContext> = {}): ModelsContext {
  return {
    baseUrl: DEFAULT_API_URL,
    client: {
      async models() {
        throw error;
      },
    },
    ...overrides,
  };
}

async function listing(input: MthdsModelsInput = {}, deck: unknown = DECK) {
  const recorded = contextAnswering(deck);
  const result = await readMthdsModels(input, recorded.context);
  return { result, structured: result.structuredContent as ModelDeckListing, recorded };
}

async function checkAgainst(input: MthdsModelsInput, deck: unknown) {
  const recorded = contextAnswering(deck);
  const result = await readMthdsModels(input, recorded.context);
  return { result, structured: result.structuredContent as ModelReferenceCheck };
}

async function check(reference: string, category?: ModelCategory) {
  const recorded = contextAnswering();
  const result = await readMthdsModels(
    { reference, ...(category === undefined ? {} : { category }) },
    recorded.context,
  );
  return { result, structured: result.structuredContent as ModelReferenceCheck, recorded };
}

function firstError(result: ModelsResult) {
  return result.structuredContent.status === "error"
    ? result.structuredContent.errors[0]
    : undefined;
}

function apiError(status: number, message: string): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/models`,
    status,
    message,
    "{}",
    status === 402 ? "subscription_required" : "request_error",
    message,
    undefined,
    undefined,
  );
}

describe("the categories", () => {
  it("are the protocol's, in the protocol's order, each with the pipe type that names it", () => {
    expect(mthdsModelsInputSchema.category.unwrap().options).toEqual([...MODEL_CATEGORIES]);
    expect(Object.keys(PIPE_TYPE_OF)).toEqual([...MODEL_CATEGORIES]);
    expect(PIPE_TYPE_OF.judgment).toBe("PipeJudge");
  });

  it("names every category and its pipe type in the category's description", () => {
    expect(mthdsModelsInputSchema.category.description).toBe(
      "Only this category: llm for a PipeLLM, extract for a PipeExtract, img_gen for a PipeImgGen, search for a PipeSearch, judgment for a PipeJudge. Omit it for every category.",
    );
  });
});

describe("listing the deck", () => {
  it("lists every category, in order, each reference written as it is typed", async () => {
    const { structured, recorded } = await listing();

    expect(recorded.calls).toEqual([undefined]);
    expect(structured.status).toBe("ok");
    expect(structured).not.toHaveProperty("category");
    expect(structured.deck.map((each) => each.category)).toEqual([
      "llm",
      "extract",
      "img_gen",
      "search",
      "judgment",
    ]);
    expect(structured.deck[0]).toEqual({
      category: "llm",
      presets: ["$writing-factual", "$writing-factual-cheap", "$writing-creative", "$vision"],
      aliases: [
        { reference: "@best-claude", target: "claude-4.6-sonnet" },
        { reference: "@best-gpt", target: "gpt-5.6-sol" },
        { reference: "@default-small", target: "gpt-5.6-luna" },
      ],
      waterfalls: [{ reference: "~robust-llm", fallbacks: ["claude-4.6-sonnet", "gpt-5.6-sol"] }],
    });
    expect(structured.deck[4]).toEqual({
      category: "judgment",
      presets: ["$judgment-strict"],
      aliases: [{ reference: "@default-judgment", target: "jev-1.13.0" }],
      waterfalls: [],
    });
  });

  it("asks the route for one category when given one", async () => {
    const onlyLlm = {
      models: DECK.models.filter((model) => model.type === "llm"),
      aliases: { llm: DECK.aliases.llm },
      waterfalls: { llm: DECK.waterfalls.llm },
    };
    const { structured, recorded } = await listing({ category: "llm" }, onlyLlm);

    expect(recorded.calls).toEqual(["llm"]);
    expect(structured.category).toBe("llm");
    expect(structured.deck.map((each) => each.category)).toEqual(["llm"]);
  });

  it("answers an empty category rather than leaving it out", async () => {
    const { structured, result } = await listing({ category: "search" }, { models: [] });

    expect(structured.deck).toEqual([
      { category: "search", presets: [], aliases: [], waterfalls: [] },
    ]);
    expect(result.summary).toContain("Presets: none.");
  });

  it("summarizes the deck with the account caveat and the way to check a reference", async () => {
    const { result } = await listing();

    expect(result.summary).toContain("## llm (PipeLLM)");
    expect(result.summary).toContain("## img_gen (PipeImgGen)");
    expect(result.summary).toContain("## judgment (PipeJudge)");
    expect(result.summary).toContain("`$writing-factual`");
    expect(result.summary).toContain("`@best-gpt` → `gpt-5.6-sol`");
    expect(result.summary).toContain("`~robust-llm` → `claude-4.6-sonnet`, `gpt-5.6-sol`");
    expect(result.summary).toContain("Waterfalls: none.");
    expect(result.summary).toContain("not what this account may use");
    expect(result.summary).toContain("call mthds_models with reference");
  });

  it("skips an entry that carries no category", async () => {
    const { structured } = await listing(
      {},
      {
        models: [
          { name: "writing-factual", type: "llm" },
          { name: "untyped" },
          { name: "nulled", type: null },
        ],
      },
    );

    expect(structured.deck.flatMap((each) => each.presets)).toEqual(["$writing-factual"]);
  });

  it("keeps a category it does not know under the runner's name, after the protocol's", async () => {
    const { structured, result } = await listing(
      {},
      {
        models: [
          { name: "writing-factual", type: "llm" },
          { name: "voice-clear", type: "tts" },
        ],
        aliases: {
          llm: { "best-gpt": "gpt-5.6-sol" },
          tts: { "default-voice": "some-voice" },
          music: { "default-tune": "some-tune" },
        },
        // An unknown category with nothing in it adds nothing to list.
        waterfalls: { tts: {}, video: {} },
      },
    );

    expect(structured.status).toBe("ok");
    expect(structured.deck.map((each) => each.category)).toEqual([
      "llm",
      "extract",
      "img_gen",
      "search",
      "judgment",
      "tts",
      "music",
    ]);
    expect(structured.deck[5]).toEqual({
      category: "tts",
      presets: ["$voice-clear"],
      aliases: [{ reference: "@default-voice", target: "some-voice" }],
      waterfalls: [],
    });
    expect(result.summary).toContain("## tts (a category this tool does not know)");
    expect(result.summary).toContain("`@default-voice` → `some-voice`");
  });

  it("reads a deck carrying the protocol's base alone, with no extensions", async () => {
    const { structured } = await listing({}, { models: [{ name: "vision", type: "llm" }] });

    expect(structured.status).toBe("ok");
    expect(structured.deck[0]?.aliases).toEqual([]);
    expect(structured.deck[0]?.waterfalls).toEqual([]);
  });

  it.each([
    ["a non-object deck", "nope"],
    ["a deck without its models list", { aliases: {} }],
    ["an entry without a name", { models: [{ type: "llm" }] }],
    ["an entry whose category is not a name", { models: [{ name: "vision", type: 3 }] }],
    ["an entry whose category is blank", { models: [{ name: "vision", type: "" }] }],
    ["an extension keyed by a blank category", { models: [], aliases: { "": { a: "b" } } }],
    ["an alias without a model handle", { models: [], aliases: { llm: { "best-gpt": 3 } } }],
    ["a category's aliases that are not a map", { models: [], aliases: { llm: ["best-gpt"] } }],
    ["a waterfall that is not a list", { models: [], waterfalls: { llm: { robust: "a" } } }],
    ["a waterfall with a blank step", { models: [], waterfalls: { llm: { robust: [""] } } }],
  ])("refuses %s as a malformed deck", async (_label, deck) => {
    const { result } = await listing({}, deck);

    expect(result.structuredContent.status).toBe("error");
    expect(firstError(result)).toMatchObject({ class: "runtime", retryable: false });
    expect(result.summary).toContain("malformed deck");
  });
});

describe("checking a reference", () => {
  it("resolves a preset, reading the whole deck even when a category is named", async () => {
    const { structured, recorded, result } = await check("$writing-factual", "llm");

    // The whole deck, so that a miss can still be placed in another category.
    expect(recorded.calls).toEqual([undefined]);
    expect(structured).toEqual({
      status: "ok",
      category: "llm",
      reference: "$writing-factual",
      kind: "preset",
      resolution: "resolved",
      matches: [{ category: "llm" }],
      suggestions: [],
      other_kinds: [],
      other_categories: [],
    });
    expect(result.summary).toContain("`$writing-factual` resolves: it is a preset.");
    expect(result.summary).toContain("not what this account may use");
  });

  it("resolves an alias in every category that holds it, with its model there", async () => {
    const { structured, result } = await check("@default-small");

    expect(structured.resolution).toBe("resolved");
    expect(structured.matches).toEqual([
      { category: "llm", target: "gpt-5.6-luna" },
      { category: "img_gen", target: "gpt-image-1-mini" },
    ]);
    expect(result.summary).toContain("it is an alias");
    expect(result.summary).toContain("- img_gen (PipeImgGen) → `gpt-image-1-mini`");
  });

  it("resolves a waterfall with its steps in order", async () => {
    const { structured } = await check("~robust-llm");

    expect(structured.matches).toEqual([
      { category: "llm", fallbacks: ["claude-4.6-sonnet", "gpt-5.6-sol"] },
    ]);
  });

  it("resolves a bare handle an alias or a waterfall names, and says which", async () => {
    const { structured, result } = await check("gpt-5.6-sol");

    expect(structured.kind).toBe("handle");
    expect(structured.resolution).toBe("resolved");
    expect(structured.matches).toEqual([{ category: "llm", via: ["@best-gpt", "~robust-llm"] }]);
    expect(result.summary).toContain("named by `@best-gpt`, `~robust-llm`");
  });

  it("calls a handle nothing names unconfirmed, never not found, and sends it to validation", async () => {
    const { structured, result } = await check("claude-4.5-sonnet");

    expect(structured.resolution).toBe("unconfirmed");
    expect(structured.suggestions).toEqual(["claude-4.6-sonnet"]);
    expect(result.summary).toContain("mthds_validate");
    expect(result.summary).toContain("prefer a preset");
  });

  it("says a preset it does not hold does not resolve, with the nearest names in the runner's order", async () => {
    const { structured, result } = await check("$writing-factul");

    expect(structured.resolution).toBe("not_found");
    expect(structured.matches).toEqual([]);
    // Python's difflib.get_close_matches over the same names, cutoff 0.5.
    expect(structured.suggestions).toEqual([
      "$writing-factual",
      "$writing-factual-cheap",
      "$writing-creative",
    ]);
    expect(result.summary).toContain("no preset in any category has that name");
    expect(result.summary).toContain("Nearest names: `$writing-factual`");
  });

  it("names the right sigil for a name that exists as another kind", async () => {
    const bare = await check("best-claude");
    expect(bare.structured.resolution).toBe("unconfirmed");
    expect(bare.structured.other_kinds).toEqual(["@best-claude"]);
    expect(bare.result.summary).toContain(
      "The same name exists as `@best-claude`, an alias: write it with that sigil.",
    );
    // A missing sigil is the fault, so the summary does not send the caller to
    // validate a handle it never meant to write.
    expect(bare.result.summary).not.toContain("mthds_validate");

    const asPreset = await check("$best-gpt");
    expect(asPreset.structured.resolution).toBe("not_found");
    expect(asPreset.structured.other_kinds).toEqual(["@best-gpt"]);

    const asAlias = await check("@gpt-5.6-sol");
    expect(asAlias.structured.other_kinds).toEqual(["gpt-5.6-sol"]);
    expect(asAlias.result.summary).toContain("write it bare, without a sigil");
  });

  it("places a reference of the wrong category in the category that holds it", async () => {
    const { structured, result } = await check("$gen-image", "llm");

    expect(structured.resolution).toBe("not_found");
    expect(structured.other_categories).toEqual(["img_gen"]);
    expect(result.summary).toContain("It resolves in img_gen (PipeImgGen), not in llm (PipeLLM)");
  });

  it("resolves a reference in a category it does not know, and places it there", async () => {
    const unknown = {
      models: [
        { name: "writing-factual", type: "llm" },
        { name: "voice-clear", type: "tts" },
      ],
      aliases: { tts: { "default-voice": "some-voice" } },
    };
    const anywhere = await checkAgainst({ reference: "@default-voice" }, unknown);
    expect(anywhere.structured).toMatchObject({
      resolution: "resolved",
      matches: [{ category: "tts", target: "some-voice" }],
    });
    expect(anywhere.result.summary).toContain(
      "- tts (a category this tool does not know) → `some-voice`",
    );

    const misplaced = await checkAgainst({ reference: "$voice-clear", category: "llm" }, unknown);
    expect(misplaced.structured).toMatchObject({
      resolution: "not_found",
      other_categories: ["tts"],
    });
    expect(misplaced.result.summary).toContain(
      "It resolves in tts (a category this tool does not know), not in llm (PipeLLM)",
    );
  });

  it("reports no other category when none was named", async () => {
    const { structured } = await check("$nowhere");

    expect(structured.other_categories).toEqual([]);
  });

  it("accepts the spelled-out namespaces the runner accepts", async () => {
    expect((await check("alias:best-gpt", "llm")).structured).toMatchObject({
      kind: "alias",
      resolution: "resolved",
      matches: [{ category: "llm", target: "gpt-5.6-sol" }],
    });
    expect((await check("handle:gpt-image-2")).structured).toMatchObject({
      kind: "handle",
      resolution: "resolved",
      matches: [{ category: "img_gen", via: ["@best-gpt"] }],
    });
    expect((await check("  preset:vision  ")).structured).toMatchObject({
      reference: "preset:vision",
      kind: "preset",
      resolution: "resolved",
    });
  });

  it.each([
    ["", "it is empty"],
    ["   ", "it is empty"],
    ["$", "it has no name after its prefix"],
    ["@", "it has no name after its prefix"],
    ["~", "it has no name after its prefix"],
    ["preset:", "it has no name after its prefix"],
    ["handle:", "it has no name after its prefix"],
  ])("refuses %j without calling the API, saying %s", async (reference, fault) => {
    const { result, recorded } = await check(reference);

    expect(recorded.calls).toEqual([]);
    expect(result.summary).toBe(`Model reference was not checked: ${fault}.`);
    expect(firstError(result)).toMatchObject({
      class: "input_domain",
      location: "reference",
      retryable: false,
    });
  });

  it("refuses a reference longer than the bound without calling the API", async () => {
    const atBound = await check(`$${"a".repeat(MAX_REFERENCE_LENGTH - 1)}`);
    expect(atBound.structured).toMatchObject({ status: "ok", resolution: "not_found" });

    const { result, recorded } = await check(`$${"a".repeat(MAX_REFERENCE_LENGTH)}`);
    expect(recorded.calls).toEqual([]);
    expect(firstError(result)).toMatchObject({
      class: "input_domain",
      location: "reference",
      retryable: false,
    });
    expect(firstError(result)?.hint).toContain(`at most ${MAX_REFERENCE_LENGTH} characters`);
  });
});

describe("parseModelReference", () => {
  it.each([
    ["$writing-factual", "preset", "writing-factual"],
    ["@best-gpt", "alias", "best-gpt"],
    ["~robust-llm", "waterfall", "robust-llm"],
    ["gpt-4o", "handle", "gpt-4o"],
    ["waterfall:robust-llm", "waterfall", "robust-llm"],
    ["@alias:odd", "alias", "alias:odd"],
  ])("parses %j as a %s named %j", (value, kind, name) => {
    expect(parseModelReference(value)).toEqual({
      ok: true,
      reference: { raw: value, kind, name },
    });
  });
});

describe("the nearest-name match", () => {
  it("computes difflib's ratio", () => {
    // Values printed by Python's difflib.SequenceMatcher(None, a, b).ratio().
    expect(similarity("writing-factual", "writing-factul")).toBeCloseTo(0.9655172413793104, 12);
    expect(similarity("abcd", "bcda")).toBe(0.75);
    expect(similarity("", "")).toBe(1);
    expect(similarity("abc", "")).toBe(0);
  });

  it("breaks a tie the way difflib does, the greater name first", () => {
    // difflib.get_close_matches("ab", ["ab-x", "ab-y", "xab"], 3, 0.0).
    expect(closeMatches("ab", ["ab-x", "ab-y", "xab"], 3, 0)).toEqual(["xab", "ab-y", "ab-x"]);
  });
});

describe("failures", () => {
  it("refuses a category it does not know before calling the API", async () => {
    const recorded = contextAnswering();
    const result = await readMthdsModels({ category: "tts" as ModelCategory }, recorded.context);

    expect(recorded.calls).toEqual([]);
    expect(firstError(result)).toMatchObject({ class: "input_domain", location: "category" });
  });

  it("maps an unreachable API to a retryable config error", async () => {
    const result = await readMthdsModels(
      {},
      contextFailing(new ApiUnreachableError("refused", DEFAULT_API_URL, "ECONNREFUSED")),
    );

    expect(firstError(result)).toMatchObject({
      class: "config",
      location: "PIPELEX_BASE_URL",
      retryable: true,
    });
  });

  it("maps an auth failure through the deployment's texture", async () => {
    for (const error of [new ClientAuthenticationError("Unauthorized"), apiError(403, "no")]) {
      const result = await readMthdsModels(
        {},
        contextFailing(error, { authError: { location: "api_key", hint: "Use your key." } }),
      );
      expect(firstError(result)).toMatchObject({
        class: "config",
        location: "api_key",
        hint: "Use your key.",
      });
    }
  });

  it("blames the category for the runner's 422, and the credential for the platform's 400", async () => {
    const refusedCategory = await readMthdsModels(
      { category: "llm" },
      contextFailing(apiError(422, "Invalid model category")),
    );
    expect(firstError(refusedCategory)).toMatchObject({
      class: "input_domain",
      location: "category",
    });
    // A runner older than the category refuses it: the hint says so, rather
    // than offering the refused value back among the valid ones.
    expect(firstError(refusedCategory)?.hint).toContain("older MTHDS protocol");

    // A missing organization is the credential's fault, with a valid category
    // on the wire or none: a check sends no category, whatever the caller named.
    for (const input of [
      { category: "llm" as const },
      { category: "llm" as const, reference: "$vision" },
    ]) {
      const orgless = await readMthdsModels(
        input,
        contextFailing(apiError(400, "Organization context required")),
      );
      expect(firstError(orgless)).toMatchObject({ class: "config", location: "PIPELEX_API_KEY" });
      expect(firstError(orgless)?.hint).toContain("active organization");
    }
  });

  it("names the plan on a paywall, the route on a 404 and retries a server fault", async () => {
    const paywall = await readMthdsModels({}, contextFailing(apiError(402, "Pay")));
    expect(paywall.summary).toBe(
      "Model deck could not be read: the organization's Pipelex plan does not cover this call.",
    );

    const missing = await readMthdsModels({}, contextFailing(apiError(404, "Not Found")));
    expect(firstError(missing)).toMatchObject({ class: "config", location: "PIPELEX_BASE_URL" });
    expect(firstError(missing)?.hint).toContain("/v1/models");

    const fault = await readMthdsModels({}, contextFailing(apiError(500, "boom")));
    expect(firstError(fault)).toMatchObject({ class: "runtime", retryable: true });
  });
});

describe("modelsToolResult", () => {
  it("marks a failure as an error and carries its details into the text", async () => {
    const result = modelsToolResult(
      await readMthdsModels({}, contextFailing(apiError(500, "boom"))),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Model deck could not be read");
    expect(result.content[0].text).toContain("- boom");
  });

  it("returns a listing as a plain result", async () => {
    const result = modelsToolResult((await listing()).result);

    expect(result.isError).toBe(false);
    expect(result.structuredContent.status).toBe("ok");
  });
});
