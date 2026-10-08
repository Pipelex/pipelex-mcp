import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type { ModelCheckCategory, ModelReferenceVerdict } from "@pipelex/sdk";
import { MODEL_CATEGORIES } from "mthds/protocol";
import type { ModelCategory, ModelDeck } from "mthds/protocol";

import {
  PIPE_TYPE_OF,
  mthdsModelsInputSchema,
  mthdsModelsOutputSchema,
  modelsToolResult,
  readMthdsModels,
} from "./models.js";
import type {
  ModelDeckListing,
  ModelReferenceCheck,
  ModelsClient,
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

/** What a `not_found` verdict carries beside its own lists, so a test states only those. */
const NOTHING_ELSE = { suggestions: [], other_kinds: [], other_categories: [] };

/** A verdict shaped as `GET /v1/models/check` answers it (conformance's `pipelex-models-api` spec). */
function verdict(fields: Record<string, unknown>): ModelReferenceVerdict {
  return { category: null, resolution: "resolved", ...NOTHING_ELSE, ...fields } as never;
}

interface Recorded {
  listings: Array<ModelCategory | undefined>;
  checks: Array<{ reference: string; category: ModelCheckCategory | undefined }>;
  context: ModelsContext;
}

/** A client that answers the listing with `deck` and the check with `answer`, recording each call. */
function contextAnswering(
  options: { deck?: unknown; answer?: unknown } = {},
  overrides: Partial<ModelsContext> = {},
): Recorded {
  const listings: Recorded["listings"] = [];
  const checks: Recorded["checks"] = [];
  const client: ModelsClient = {
    async models(category) {
      listings.push(category);
      return (options.deck ?? DECK) as ModelDeck;
    },
    async checkModelReference(reference, category) {
      checks.push({ reference, category });
      if (options.answer === undefined) throw new Error("the check was not expected");
      return options.answer as ModelReferenceVerdict;
    },
  };
  return { listings, checks, context: { baseUrl: DEFAULT_API_URL, client, ...overrides } };
}

function contextFailing(error: unknown, overrides: Partial<ModelsContext> = {}): ModelsContext {
  const fail = async (): Promise<never> => {
    throw error;
  };
  return {
    baseUrl: DEFAULT_API_URL,
    client: { models: fail, checkModelReference: fail },
    ...overrides,
  };
}

async function listing(input: MthdsModelsInput = {}, deck: unknown = DECK) {
  const recorded = contextAnswering({ deck });
  const result = await readMthdsModels(input, recorded.context);
  return { result, structured: result.structuredContent as ModelDeckListing, recorded };
}

async function check(input: MthdsModelsInput, answer: unknown) {
  const recorded = contextAnswering({ answer });
  const result = await readMthdsModels(input, recorded.context);
  return { result, structured: result.structuredContent as ModelReferenceCheck, recorded };
}

function firstError(result: ModelsResult) {
  return result.structuredContent.status === "error"
    ? result.structuredContent.errors[0]
    : undefined;
}

function apiError(
  status: number,
  message: string,
  errorType: string = status === 402 ? "subscription_required" : "request_error",
  route = "/v1/models",
): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}${route}`,
    status,
    message,
    "{}",
    errorType,
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
      "Only this category: llm for a PipeLLM, extract for a PipeExtract, img_gen for a PipeImgGen, search for a PipeSearch, judgment for a PipeJudge. Omit it for every category; a check then covers doc_gen, for a PipeDocGen, as well.",
    );
  });
});

describe("listing the deck", () => {
  it("lists every category, in order, each reference written as it is typed", async () => {
    const { structured, recorded } = await listing();

    expect(recorded.listings).toEqual([undefined]);
    expect(recorded.checks).toEqual([]);
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

    expect(recorded.listings).toEqual(["llm"]);
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
  it("asks the runner, with the reference as written and the category asked, and never reads the deck", async () => {
    const { structured, recorded, result } = await check(
      { reference: "  $writing-factual  ", category: "llm" },
      verdict({
        reference: "$writing-factual",
        kind: "preset",
        name: "writing-factual",
        category: "llm",
        matches: [
          {
            category: "llm",
            resolves_to: "claude-4.6-sonnet",
            target: "@best-claude",
            description: "Factual writing,\nplain and sourced.",
          },
        ],
      }),
    );

    expect(recorded.checks).toEqual([{ reference: "  $writing-factual  ", category: "llm" }]);
    expect(recorded.listings).toEqual([]);
    expect(structured).toEqual({
      status: "ok",
      category: "llm",
      reference: "$writing-factual",
      kind: "preset",
      name: "writing-factual",
      resolution: "resolved",
      matches: [
        {
          category: "llm",
          resolves_to: "claude-4.6-sonnet",
          target: "@best-claude",
          description: "Factual writing,\nplain and sourced.",
        },
      ],
      suggestions: [],
      other_kinds: [],
      other_categories: [],
    });
    expect(mthdsModelsOutputSchema.safeParse(structured).success).toBe(true);
    expect(result.summary).toContain("`$writing-factual` resolves: it is a preset.");
    expect(result.summary).toContain(
      "- llm (PipeLLM) → `@best-claude`, which runs `claude-4.6-sonnet` now: Factual writing, plain and sourced.",
    );
    expect(result.summary).toContain("not what this account may use");
  });

  it("sends no category when none was asked, and leaves it out of the result", async () => {
    const { structured, recorded } = await check(
      { reference: "$vision" },
      verdict({
        reference: "$vision",
        kind: "preset",
        name: "vision",
        matches: [
          { category: "llm", resolves_to: "gpt-5.6-sol", target: "gpt-5.6-sol", description: null },
        ],
      }),
    );

    expect(recorded.checks).toEqual([{ reference: "$vision", category: undefined }]);
    expect(structured).not.toHaveProperty("category");
    expect(structured.matches).toEqual([
      { category: "llm", resolves_to: "gpt-5.6-sol", target: "gpt-5.6-sol", description: null },
    ]);
  });

  it("relays an alias in every category that holds it, and warns where it reaches no model", async () => {
    const { structured, result } = await check(
      { reference: "@default-small" },
      verdict({
        reference: "@default-small",
        kind: "alias",
        name: "default-small",
        matches: [
          { category: "llm", resolves_to: "gpt-5.6-luna", target: "gpt-5.6-luna" },
          { category: "img_gen", resolves_to: null, target: "gpt-image-1-mini" },
        ],
      }),
    );

    expect(structured.resolution).toBe("resolved");
    expect(structured.matches).toEqual([
      { category: "llm", resolves_to: "gpt-5.6-luna", target: "gpt-5.6-luna" },
      { category: "img_gen", resolves_to: null, target: "gpt-image-1-mini" },
    ]);
    expect(result.summary).toContain("it is an alias");
    expect(result.summary).toContain("- llm (PipeLLM) → `gpt-5.6-luna`\n");
    expect(result.summary).toContain(
      "- img_gen (PipeImgGen) → `gpt-image-1-mini`, which reaches no model this runner can call now",
    );
    expect(result.summary).toContain("a validation accepts it but a run through it fails");
  });

  it("relays a waterfall with its steps in order and the step a run calls now", async () => {
    const { structured, result } = await check(
      { reference: "~robust-llm" },
      verdict({
        reference: "~robust-llm",
        kind: "waterfall",
        name: "robust-llm",
        matches: [
          {
            category: "llm",
            resolves_to: "gpt-5.6-sol",
            fallbacks: ["claude-4.6-sonnet", "gpt-5.6-sol"],
          },
        ],
      }),
    );

    expect(structured.matches).toEqual([
      {
        category: "llm",
        resolves_to: "gpt-5.6-sol",
        fallbacks: ["claude-4.6-sonnet", "gpt-5.6-sol"],
      },
    ]);
    expect(result.summary).toContain(
      "- llm (PipeLLM) → `claude-4.6-sonnet`, `gpt-5.6-sol`, which runs `gpt-5.6-sol` now",
    );
  });

  it("relays a bare handle with who names it, and one nothing names", async () => {
    const named = await check(
      { reference: "gpt-5.6-sol" },
      verdict({
        reference: "gpt-5.6-sol",
        kind: "handle",
        name: "gpt-5.6-sol",
        matches: [
          { category: "llm", resolves_to: "gpt-5.6-sol", via: ["@best-gpt", "~robust-llm"] },
        ],
      }),
    );
    expect(named.structured.kind).toBe("handle");
    expect(named.structured.matches).toEqual([
      { category: "llm", resolves_to: "gpt-5.6-sol", via: ["@best-gpt", "~robust-llm"] },
    ]);
    expect(named.result.summary).toContain(
      "- llm (PipeLLM), named by `@best-gpt`, `~robust-llm`\n",
    );

    // A model the runner calls that no deck entry names resolves all the same:
    // the runner knows every model it can call, which the deck never listed.
    const unnamed = await check(
      { reference: "claude-4.5-sonnet", category: "llm" },
      verdict({
        reference: "claude-4.5-sonnet",
        kind: "handle",
        name: "claude-4.5-sonnet",
        category: "llm",
        matches: [{ category: "llm", resolves_to: "claude-4.5-sonnet", via: [] }],
      }),
    );
    expect(unnamed.structured.resolution).toBe("resolved");
    expect(unnamed.result.summary).toContain("- llm (PipeLLM)\n");
  });

  it("says a reference it does not hold does not resolve, with the runner's nearest names", async () => {
    const { structured, result } = await check(
      { reference: "$writing-factul" },
      verdict({
        reference: "$writing-factul",
        kind: "preset",
        name: "writing-factul",
        resolution: "not_found",
        matches: [],
        suggestions: ["$writing-factual", "$writing-factual-cheap", "$writing-creative"],
      }),
    );

    expect(structured.resolution).toBe("not_found");
    expect(structured.matches).toEqual([]);
    expect(structured.suggestions).toEqual([
      "$writing-factual",
      "$writing-factual-cheap",
      "$writing-creative",
    ]);
    expect(result.summary).toContain(
      "`$writing-factul` does not resolve: no preset in any category has that name, so a validation refuses it too.",
    );
    expect(result.summary).toContain(
      "Nearest names: `$writing-factual`, `$writing-factual-cheap`, `$writing-creative`.",
    );
  });

  it("says a handle that does not resolve is no model the runner can call", async () => {
    const { result } = await check(
      { reference: "gpt-9", category: "llm" },
      verdict({
        reference: "gpt-9",
        kind: "handle",
        name: "gpt-9",
        category: "llm",
        resolution: "not_found",
        matches: [],
      }),
    );

    expect(result.summary).toContain(
      "no model this runner can call in llm (PipeLLM), and no alias or waterfall there, has that name",
    );
  });

  it("names the right sigil for a name that exists as another kind, first", async () => {
    const bare = await check(
      { reference: "best-claude" },
      verdict({
        reference: "best-claude",
        kind: "handle",
        name: "best-claude",
        resolution: "not_found",
        matches: [],
        other_kinds: ["@best-claude"],
        suggestions: ["claude-4.6-sonnet"],
      }),
    );
    expect(bare.structured.other_kinds).toEqual(["@best-claude"]);
    const lines = bare.result.summary.split("\n");
    expect(lines[1]).toBe(
      "The same name exists as `@best-claude`, an alias: write it with that sigil.",
    );

    const asAlias = await check(
      { reference: "@gpt-5.6-sol" },
      verdict({
        reference: "@gpt-5.6-sol",
        kind: "alias",
        name: "gpt-5.6-sol",
        resolution: "not_found",
        matches: [],
        other_kinds: ["gpt-5.6-sol"],
      }),
    );
    expect(asAlias.structured.other_kinds).toEqual(["gpt-5.6-sol"]);
    expect(asAlias.result.summary).toContain("write it bare, without a sigil");
  });

  it("places a reference of the wrong category in the category that holds it", async () => {
    const { structured, result } = await check(
      { reference: "$gen-image", category: "llm" },
      verdict({
        reference: "$gen-image",
        kind: "preset",
        name: "gen-image",
        category: "llm",
        resolution: "not_found",
        matches: [],
        other_categories: ["img_gen"],
      }),
    );

    expect(structured.resolution).toBe("not_found");
    expect(structured.other_categories).toEqual(["img_gen"]);
    expect(result.summary).toContain("It resolves in img_gen (PipeImgGen), not in llm (PipeLLM)");
  });

  it("labels doc_gen with its pipe type and a category it does not know as such", async () => {
    const { structured, result } = await check(
      { reference: "@default-docs" },
      verdict({
        reference: "@default-docs",
        kind: "alias",
        name: "default-docs",
        matches: [
          { category: "doc_gen", resolves_to: "docgen-pdf", target: "docgen-pdf" },
          { category: "tts", resolves_to: "some-voice", target: "some-voice" },
        ],
      }),
    );

    expect(structured.matches.map((match) => match.category)).toEqual(["doc_gen", "tts"]);
    expect(result.summary).toContain("- doc_gen (PipeDocGen) → `docgen-pdf`");
    expect(result.summary).toContain("- tts (a category this tool does not know) → `some-voice`");
  });

  it("reads a resolution it does not know as not resolved", async () => {
    const { structured, result } = await check(
      { reference: "$vision" },
      verdict({
        reference: "$vision",
        kind: "preset",
        name: "vision",
        resolution: "retired",
        matches: [],
      }),
    );

    expect(structured.resolution).toBe("not_found");
    expect(result.summary).toContain("`$vision` does not resolve");
  });

  it("keeps only the fields the contract declares", async () => {
    const { structured } = await check(
      { reference: "@best-gpt" },
      verdict({
        reference: "@best-gpt",
        kind: "alias",
        name: "best-gpt",
        category: null,
        extension: "a field a later runner adds",
        matches: [
          { category: "llm", resolves_to: "gpt-5.6-sol", target: "gpt-5.6-sol", weight: 3 },
        ],
      }),
    );

    expect(structured).not.toHaveProperty("extension");
    expect(structured.matches).toEqual([
      { category: "llm", resolves_to: "gpt-5.6-sol", target: "gpt-5.6-sol" },
    ]);
  });

  it.each([
    ["a verdict that is not an object", "nope"],
    [
      "a kind the spec does not define",
      verdict({ reference: "x", kind: "family", name: "x", matches: [] }),
    ],
    [
      "a preset match without its target",
      verdict({
        reference: "$a",
        kind: "preset",
        name: "a",
        matches: [{ category: "llm", resolves_to: null, description: null }],
      }),
    ],
    [
      "a match without resolves_to",
      verdict({
        reference: "@a",
        kind: "alias",
        name: "a",
        matches: [{ category: "llm", target: "m" }],
      }),
    ],
    [
      "a handle match without via",
      verdict({
        reference: "m",
        kind: "handle",
        name: "m",
        matches: [{ category: "llm", resolves_to: "m" }],
      }),
    ],
    [
      "suggestions that are not a list",
      verdict({ reference: "$a", kind: "preset", name: "a", matches: [], suggestions: "$b" }),
    ],
  ])("refuses %s as a malformed verdict", async (_label, answer) => {
    const { result } = await check({ reference: "$a" }, answer);

    expect(result.structuredContent.status).toBe("error");
    expect(firstError(result)).toMatchObject({ class: "runtime", retryable: false });
    expect(result.summary).toBe(
      "Model reference check produced no answer: the API returned a malformed verdict.",
    );
  });
});

describe("failures", () => {
  it("refuses a category it does not know before calling the API", async () => {
    const recorded = contextAnswering();
    const result = await readMthdsModels(
      { category: "tts" as ModelCategory, reference: "$vision" },
      recorded.context,
    );

    expect(recorded.listings).toEqual([]);
    expect(recorded.checks).toEqual([]);
    expect(firstError(result)).toMatchObject({ class: "input_domain", location: "category" });
  });

  it("refuses a reference that is not text before calling the API", async () => {
    const recorded = contextAnswering();
    const result = await readMthdsModels({ reference: 3 as unknown as string }, recorded.context);

    expect(recorded.checks).toEqual([]);
    expect(firstError(result)).toMatchObject({ class: "input_domain", location: "reference" });
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
    for (const input of [{}, { reference: "$vision" }]) {
      for (const error of [apiError(401, "Unauthorized"), apiError(403, "no")]) {
        const result = await readMthdsModels(
          input,
          contextFailing(error, { authError: { location: "api_key", hint: "Use your key." } }),
        );
        expect(firstError(result)).toMatchObject({
          class: "config",
          location: "api_key",
          hint: "Use your key.",
        });
      }
    }
  });

  it("blames the category for the listing's 422, and the credential for the platform's 400", async () => {
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

    // A missing organization is the credential's fault, on the listing and on
    // the check alike, whatever category was sent.
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

describe("the check's refusals", () => {
  const refused = (error: ApiResponseError, input: MthdsModelsInput = { reference: "$" }) =>
    readMthdsModels(input, contextFailing(error));

  it("points an unreadable reference at reference, with the runner's own reason", async () => {
    const result = await refused(
      apiError(
        422,
        "The model reference '$' has no name after its sigil.",
        "InvalidModelReference",
        "/v1/models/check",
      ),
    );

    expect(result.summary).toBe(
      "Model reference was not checked: the runner cannot read it as a reference.",
    );
    expect(firstError(result)).toMatchObject({
      class: "input_domain",
      location: "reference",
      message: "The model reference '$' has no name after its sigil.",
      retryable: false,
    });
    expect(firstError(result)?.hint).toContain("$preset, @alias, ~waterfall or a bare handle");
  });

  it("points a category the runner does not know at category, as a runner older than it", async () => {
    const result = await refused(
      apiError(
        422,
        "Unknown model category 'judgment'.",
        "InvalidModelCategory",
        "/v1/models/check",
      ),
      { reference: "$judgment-strict", category: "judgment" },
    );

    expect(result.summary).toBe(
      "Model reference was not checked: the runner does not know the category.",
    );
    expect(firstError(result)).toMatchObject({ class: "input_domain", location: "category" });
    expect(firstError(result)?.hint).toContain("older MTHDS protocol");
  });

  it("reads a request-shape refusal as the deployment's, since this tool built the request", async () => {
    const result = await refused(
      apiError(422, "Field required: reference", "ValidationError", "/v1/models/check"),
    );

    expect(result.summary).toBe(
      "Model reference could not be checked: the Pipelex API or its access is misconfigured.",
    );
    expect(firstError(result)).toMatchObject({ class: "config" });
    expect(firstError(result)).not.toHaveProperty("location");
    expect(firstError(result)?.hint).toContain("/v1/models/check");
  });

  it("names the check route on a runner that does not serve it", async () => {
    const result = await refused(apiError(404, "Not Found", "request_error", "/v1/models/check"));

    expect(firstError(result)).toMatchObject({ class: "config", location: "PIPELEX_BASE_URL" });
    expect(firstError(result)?.hint).toContain("/v1/models/check");
  });

  it("words a paywall and a server fault as a check", async () => {
    const paywall = await refused(apiError(402, "Pay"));
    expect(paywall.summary).toBe(
      "Model reference could not be checked: the organization's Pipelex plan does not cover this call.",
    );

    const fault = await refused(apiError(500, "boom"));
    expect(fault.summary).toBe(
      "Model reference could not be checked: the Pipelex API returned an error.",
    );
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

  it("returns a listing and a check as plain results", async () => {
    const listed = modelsToolResult((await listing()).result);
    expect(listed.isError).toBe(false);
    expect(listed.structuredContent.status).toBe("ok");

    const checked = modelsToolResult(
      (
        await check(
          { reference: "$nowhere" },
          verdict({
            reference: "$nowhere",
            kind: "preset",
            name: "nowhere",
            resolution: "not_found",
            matches: [],
          }),
        )
      ).result,
    );
    // A reference that resolves nowhere is a produced verdict, not an error.
    expect(checked.isError).toBe(false);
    expect(checked.structuredContent).toMatchObject({ status: "ok", resolution: "not_found" });
  });
});
