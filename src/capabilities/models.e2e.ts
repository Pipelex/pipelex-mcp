/**
 * Live e2e — `mthds_models` against a real Pipelex API.
 *
 * `models.test.ts` proves the projection against a deck shaped like the one the
 * dev API answered, and the check against verdicts shaped as the spec writes
 * them. This proves both shapes are still what the API sends: a renamed
 * `aliases` extension, presets no longer stamped with their category, or a
 * reshaped `GET /v1/models/check` verdict would leave every unit test green
 * while the tool listed an empty deck or refused every check as malformed. It
 * reads and checks and nothing else, so it writes nothing and spends no
 * inference credit.
 */

import { MODEL_CATEGORIES } from "mthds/protocol";
import type { ModelCategory } from "mthds/protocol";
import { describe, expect, it } from "vitest";

import { liveApiConfig } from "./e2e-support.js";
import { readMthdsModels } from "./models.js";
import type { ModelDeckListing, ModelReferenceCheck, ModelsContext } from "./models.js";

// No `client` seam: this is the real PipelexApiClient talking to the real API.
const context: ModelsContext = liveApiConfig();

/**
 * The categories the hosted runner may still refuse as a filter, because it
 * implements a protocol older than the one that defined them: a runner before
 * protocol 0.7.0 answers `?type=judgment` with a 422. The leg accepts that
 * refusal, held to its classification, rather than skipping: the hosted
 * `/v1/version` does not yet report the runner's protocol, so nothing live can
 * say which answer to expect. Empty this set once the hosted runner serves the
 * category (L-261003-584d78), so the leg holds `judgment` to the deck again.
 */
const NEWER_THAN_THE_HOSTED_RUNNER: ReadonlySet<string> = new Set(["judgment"]);

async function liveListing(category?: ModelDeckListing["category"]): Promise<ModelDeckListing> {
  const result = await readMthdsModels(category === undefined ? {} : { category }, context);
  expect(result.structuredContent.status, result.summary).toBe("ok");
  return result.structuredContent as ModelDeckListing;
}

async function liveCheck(
  reference: string,
  category?: ModelCategory,
): Promise<ModelReferenceCheck> {
  const result = await readMthdsModels(
    category === undefined ? { reference } : { reference, category },
    context,
  );
  expect(result.structuredContent.status, result.summary).toBe("ok");
  return result.structuredContent as ModelReferenceCheck;
}

describe("mthds_models against the live API", () => {
  it("lists every category, with presets the runner stamped with their category", async () => {
    const listing = await liveListing();

    expect(listing.deck.map((each) => each.category)).toEqual([...MODEL_CATEGORIES]);
    // Every deployment serves LLM presets; an empty list here means the
    // presets stopped arriving with a category this tool can place.
    expect(listing.deck[0]?.presets.length).toBeGreaterThan(0);
    // The aliases extension is how the deck names handles at all.
    expect(listing.deck.flatMap((each) => each.aliases).length).toBeGreaterThan(0);
  });

  it("asks the route for each category and gets that category's share of the whole deck", async () => {
    const whole = await liveListing();

    for (const category of MODEL_CATEGORIES) {
      if (NEWER_THAN_THE_HOSTED_RUNNER.has(category)) {
        const result = await readMthdsModels({ category }, context);
        if (result.structuredContent.status === "error") {
          // The one refusal the tool documents for a runner that predates the
          // category, and nothing else.
          expect(result.structuredContent.errors[0], result.summary).toMatchObject({
            class: "input_domain",
            location: "category",
          });
          continue;
        }
      }
      const listing = await liveListing(category);
      // The tool scopes a listing to its category itself, so the shape alone
      // proves nothing: the entry is held to the unfiltered deck's, which
      // catches a `?type=` filter that drops or mislabels what it should keep.
      expect(listing.category).toBe(category);
      expect(listing.deck, category).toEqual(
        whole.deck.filter((each) => each.category === category),
      );
    }
  });

  it("resolves a listed preset and suggests it for a mistyped one", async () => {
    const preset = (await liveListing("llm")).deck[0]?.presets[0];
    expect(preset, "the live deck lists no LLM preset").toBeDefined();

    const resolved = await liveCheck(preset as string);
    expect(resolved.kind).toBe("preset");
    expect(resolved.resolution).toBe("resolved");
    const match = resolved.matches.find((each) => each.category === "llm");
    expect(match, resolved.reference).toBeDefined();
    // A preset's match carries its binding, its description and what a run calls.
    expect(typeof match?.target).toBe("string");
    expect(match).toHaveProperty("description");
    expect(match).toHaveProperty("resolves_to");

    const mistyped = await liveCheck((preset as string).slice(0, -1));
    expect(mistyped.resolution).toBe("not_found");
    expect(mistyped.suggestions).toContain(preset);
  });

  it("places a preset asked in another category in the category that holds it", async () => {
    const preset = (await liveListing("llm")).deck[0]?.presets[0];
    expect(preset, "the live deck lists no LLM preset").toBeDefined();

    const misplaced = await liveCheck(preset as string, "img_gen");
    expect(misplaced.category).toBe("img_gen");
    expect(misplaced.resolution).toBe("not_found");
    expect(misplaced.other_categories).toContain("llm");
  });

  it("resolves the model an alias runs as a handle that alias names", async () => {
    const aliases = (await liveListing()).deck.flatMap((each) =>
      each.aliases.map((alias) => ({ ...alias, category: each.category })),
    );
    expect(aliases.length, "the live deck lists no alias").toBeGreaterThan(0);

    // A handle resolves only where the runner can call it, which an alias's
    // target need not be, so the leg takes the first alias whose run calls
    // its own target. Checked without a category, so a category the hosted
    // runner may refuse as a filter is never sent.
    for (const alias of aliases) {
      const checked = await liveCheck(alias.reference);
      const match = checked.matches.find((each) => each.category === alias.category);
      if (match?.resolves_to !== alias.target) continue;

      const handle = await liveCheck(alias.target);
      expect(handle.kind).toBe("handle");
      expect(handle.resolution).toBe("resolved");
      const there = handle.matches.find((each) => each.category === alias.category);
      expect(there?.via, alias.target).toContain(alias.reference);
      return;
    }
    expect.fail("no alias of the live deck runs its own target");
  });

  it("refuses a reference the runner cannot read at reference", async () => {
    const result = await readMthdsModels({ reference: "$" }, context);

    expect(result.structuredContent.status, result.summary).toBe("error");
    if (result.structuredContent.status !== "error") return;
    expect(result.structuredContent.errors[0], result.summary).toMatchObject({
      class: "input_domain",
      location: "reference",
      retryable: false,
    });
  });
});
