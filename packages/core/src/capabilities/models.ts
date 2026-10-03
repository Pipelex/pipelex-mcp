/**
 * The model deck capability (`mthds_models`, **workshop-only**): list the
 * model references a method's pipes can name in their `model` field, or check
 * one reference before it is written into a method.
 *
 * It reads `GET /v1/models`, the MTHDS Protocol's `ModelDeck`, through the SDK's
 * `models()`. On the Pipelex runner that deck is the flat `models` list, which
 * holds the PRESETS, each stamped with its category, plus two category-keyed
 * extensions: `aliases` (alias name → model handle) and `waterfalls` (waterfall
 * name → handles tried in order). It lists no model handle as such: a handle
 * appears only as an alias's target or a waterfall's step. So a bare handle the
 * deck does not name is `unconfirmed`, never `not_found`; validation checks a
 * handle against the runner's full model list, and the answer says so.
 *
 * The deck is what the runner can route to, not what the caller's account may
 * use: a gateway can refuse a listed model when a run starts. The description
 * and every summary say so, since that is the one thing a model reading the deck
 * would otherwise take for granted.
 *
 * The check mirrors the runner's own (`pipelex/cogt/models/model_suggestion.py`,
 * behind `pipelex-agent check-model` and validation's "did you mean"): the same
 * sigils, the same namespace prefixes, and `closeMatches`, a port of difflib's
 * `get_close_matches`, at the same cutoffs. The candidates are where the two
 * part. For a preset, an alias or a waterfall checked in one category they are
 * the runner's, so the names suggested here are the ones a failed validation of
 * the same reference would suggest. But the runner matches a handle against
 * every model of the pipe's type, which the deck does not list, and it checks
 * within one type, where a check here with no category pools every category.
 */

import { ApiResponseError } from "@pipelex/sdk";
import { MODEL_CATEGORIES } from "mthds/protocol";
import type { ModelCategory, ModelDeck, ModelInfo } from "mthds/protocol";
import { z } from "zod";

import {
  buildApiConfig,
  classifyError,
  createPipelexApiClient,
  summaryForToolError,
  toolErrorSchema,
  toolResultContent,
} from "./shared.js";
import type {
  ApiConfig,
  AuthErrorTexture,
  ClassifyErrorOptions,
  ErrorSummaries,
  ToolError,
} from "./shared.js";

/**
 * The pipe type that names a reference of each category, which is how an author
 * picks one. The categories themselves are the protocol's `MODEL_CATEGORIES`, in
 * its order, which is the order a listing shows them and the closed set the tool
 * takes as a filter. This record is total, so it fails the build when the
 * protocol gains a category this module has not been taught to describe, and its
 * excess-key check fails it when the protocol drops one.
 */
export const PIPE_TYPE_OF: Record<ModelCategory, string> = {
  llm: "PipeLLM",
  extract: "PipeExtract",
  img_gen: "PipeImgGen",
  search: "PipeSearch",
  judgment: "PipeJudge",
};

/**
 * A category as a deck names it: one of the protocol's, or one this module does
 * not know, kept under the runner's own name. The protocol's reader rule: "A
 * client reading a model list MUST NOT fail it because an entry carries a
 * category it does not recognize; it keeps that entry with its raw value or
 * leaves it out." This tool keeps it, so a runner of a later protocol minor
 * still has its new category listed and checked, labelled as one this tool
 * cannot place on a pipe type.
 */
export type DeckCategoryName = NonNullable<ModelInfo["type"]>;

/** Each category with the pipe type that names it, as the descriptions write them. */
export const CATEGORY_PIPE_TYPES = MODEL_CATEGORIES.map(
  (category) => `${category} for a ${PIPE_TYPE_OF[category]}`,
).join(", ");

export const REFERENCE_KINDS = ["preset", "alias", "waterfall", "handle"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** How a reference of each kind is written. A handle is written bare. */
export const SIGIL_OF: Record<ReferenceKind, string> = {
  preset: "$",
  alias: "@",
  waterfall: "~",
  handle: "",
};

/** The runner also accepts a spelled-out namespace in place of a sigil. */
const NAMESPACE_OF: Record<ReferenceKind, string> = {
  preset: "preset:",
  alias: "alias:",
  waterfall: "waterfall:",
  handle: "handle:",
};

/** The runner's cutoffs and counts: nearest names of the same kind, then of the other kinds. */
const SAME_KIND_MATCHES = 5;
const SAME_KIND_CUTOFF = 0.5;
const OTHER_KIND_MATCHES = 3;
const OTHER_KIND_CUTOFF = 0.7;

/**
 * The longest reference the tool takes. No model name comes near it (the
 * longest the runner knows is about sixty characters), and a reference over
 * three times a candidate's length cannot reach the nearest-name cutoff, so it
 * refuses nothing a method could use. It bounds the work of the match, which
 * is linear in the reference's length for every candidate, and it keeps the
 * word under the 200 characters from which difflib's junk heuristic would
 * apply, so the port below stays exact (see `similarity`).
 */
export const MAX_REFERENCE_LENGTH = 199;

/** The filter: the protocol's closed set, which a runner refuses a value outside of. */
const categorySchema = z.enum(MODEL_CATEGORIES);

/** A category in a result: any name the deck carried, the protocol's or not. */
const deckCategoryNameSchema = z.string();

export const mthdsModelsInputSchema = {
  category: categorySchema
    .optional()
    .describe(`Only this category: ${CATEGORY_PIPE_TYPES}. Omit it for every category.`),
  reference: z
    .string()
    .max(MAX_REFERENCE_LENGTH)
    .optional()
    .describe(
      "A model reference to check, exactly as it would be written in a pipe's model field: $preset, @alias, ~waterfall, or a bare model handle (preset:, alias:, waterfall: and handle: prefixes work too). Omit it to list the deck instead.",
    ),
};

export const mthdsModelsInputObjectSchema = z.object(mthdsModelsInputSchema);

const deckCategorySchema = z.object({
  category: deckCategoryNameSchema,
  presets: z.array(z.string()),
  aliases: z.array(z.object({ reference: z.string(), target: z.string() })),
  waterfalls: z.array(z.object({ reference: z.string(), fallbacks: z.array(z.string()) })),
});

const matchSchema = z.object({
  category: deckCategoryNameSchema,
  target: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
  via: z.array(z.string()).optional(),
});

// One Zod object for MCP SDK compatibility, as the catalog's is: the TypeScript
// result is a union of three arms, and the capability emits only the fields of
// the arm it produced.
export const mthdsModelsOutputSchema = z.object({
  status: z.enum(["ok", "error"]),
  category: categorySchema.optional(),
  deck: z.array(deckCategorySchema).optional(),
  reference: z.string().optional(),
  kind: z.enum(REFERENCE_KINDS).optional(),
  resolution: z.enum(["resolved", "not_found", "unconfirmed"]).optional(),
  matches: z.array(matchSchema).optional(),
  suggestions: z.array(z.string()).optional(),
  other_kinds: z.array(z.string()).optional(),
  other_categories: z.array(deckCategoryNameSchema).optional(),
  errors: z.array(toolErrorSchema).optional(),
});

export interface MthdsModelsInput {
  category?: ModelCategory;
  reference?: string;
}

export interface DeckCategory {
  category: DeckCategoryName;
  /** Each preset as it is written, `$name`, in the runner's order. */
  presets: string[];
  aliases: Array<{ reference: string; target: string }>;
  waterfalls: Array<{ reference: string; fallbacks: string[] }>;
}

/** One category a checked reference resolves in, with what it resolves to there. */
export interface ReferenceMatch {
  category: DeckCategoryName;
  /** An alias's model handle. */
  target?: string;
  /** A waterfall's handles, in the order they are tried. */
  fallbacks?: string[];
  /** For a handle: the aliases and waterfalls of this category that name it. */
  via?: string[];
}

/**
 * - `resolved`: the reference names something in the categories checked.
 * - `not_found`: a preset, alias or waterfall the deck does not hold, which is
 *   definitive, since the deck lists every one of them.
 * - `unconfirmed`: a bare handle no alias or waterfall names, which the deck
 *   cannot settle either way.
 */
export type ReferenceResolution = "resolved" | "not_found" | "unconfirmed";

export interface ModelDeckListing {
  status: "ok";
  category?: ModelCategory;
  deck: DeckCategory[];
}

export interface ModelReferenceCheck {
  status: "ok";
  category?: ModelCategory;
  /** The reference as checked: the caller's, trimmed. */
  reference: string;
  kind: ReferenceKind;
  resolution: ReferenceResolution;
  /** Where it resolves; empty unless `resolved`. */
  matches: ReferenceMatch[];
  /** The nearest names, written with their sigils; empty when `resolved`. */
  suggestions: string[];
  /** The same name under another kind, written with that kind's sigil (`best-claude` → `@best-claude`); empty when `resolved`. */
  other_kinds: string[];
  /** With a category: the other categories the same reference resolves in; empty otherwise. */
  other_categories: DeckCategoryName[];
}

export interface ModelsFailure {
  status: "error";
  errors: ToolError[];
}

export type ModelsStructuredContent = ModelDeckListing | ModelReferenceCheck | ModelsFailure;

export interface ModelsResult {
  structuredContent: ModelsStructuredContent;
  summary: string;
}

/** The narrow SDK seam the tests supply. */
export interface ModelsClient {
  models(category?: ModelCategory): Promise<ModelDeck>;
}

export interface ModelsContext extends ApiConfig {
  client?: ModelsClient;
  /** Deployment-specific auth-failure texture; the `PIPELEX_API_KEY` wording by default. */
  authError?: AuthErrorTexture;
}

export function buildModelsContext(env = process.env): ModelsContext {
  return buildApiConfig(env);
}

function modelsClient(context: ModelsContext): ModelsClient {
  return context.client ?? createPipelexApiClient(context);
}

export interface ParsedReference {
  /** The caller's reference, trimmed. */
  raw: string;
  kind: ReferenceKind;
  /** The name without its sigil or namespace. */
  name: string;
}

export async function readMthdsModels(
  input: MthdsModelsInput,
  context: ModelsContext,
): Promise<ModelsResult> {
  const parsedInput = mthdsModelsInputObjectSchema.safeParse(input);
  if (!parsedInput.success) {
    return errorResult(
      "Model deck was not read: request input is invalid.",
      parsedInput.error.issues.map((issue) => ({
        class: "input_domain",
        ...(issue.path.length === 0 ? {} : { location: issue.path.join(".") }),
        message: issue.message,
        hint: `Use category as one of ${MODEL_CATEGORIES.join(", ")}, and reference as text of at most ${MAX_REFERENCE_LENGTH} characters.`,
        retryable: false,
      })),
    );
  }
  const { category } = parsedInput.data;

  let reference: ParsedReference | undefined;
  if (parsedInput.data.reference !== undefined) {
    const parsed = parseModelReference(parsedInput.data.reference);
    if (!parsed.ok) {
      // The headline names the fault the error names: a bare "$" is not empty,
      // and a model told it sent nothing would send the same "$" again.
      const fault =
        parsedInput.data.reference.trim() === ""
          ? "it is empty"
          : "it has no name after its prefix";
      return errorResult(`Model reference was not checked: ${fault}.`, [parsed.error]);
    }
    reference = parsed.reference;
  }

  let wire: ModelDeck;
  try {
    // A check reads the whole deck, so that a reference missing from the
    // category asked about can still be reported as living in another one: a
    // `$gen-image` written into a PipeLLM is a wrong category, not a typo. A
    // listing asks the route for the category, which is the route's own filter.
    // Client construction stays inside the caught path, so a malformed base URL
    // becomes a classified error rather than a rejected handler.
    wire = await modelsClient(context).models(reference === undefined ? category : undefined);
  } catch (err) {
    const error = classifyError(err, modelsErrorOptions(context, err));
    return errorResult(summaryForToolError(error, ERROR_SUMMARIES), [error]);
  }

  let deck: Map<DeckCategoryName, DeckCategory>;
  try {
    deck = projectDeck(wire);
  } catch (err) {
    return errorResult("Model deck produced no answer: the API returned a malformed deck.", [
      {
        class: "runtime",
        message: err instanceof Error ? err.message : "The Pipelex API returned a malformed deck.",
        hint: "The API responded, but its model deck violated the protocol's ModelDeck shape; inspect the hosted API.",
        retryable: false,
      },
    ]);
  }

  if (reference === undefined) {
    const listing: ModelDeckListing = {
      status: "ok",
      ...(category === undefined ? {} : { category }),
      deck: scopeOf(deck, category),
    };
    return { structuredContent: listing, summary: listingSummary(listing) };
  }

  const check = checkReference(reference, deck, category);
  return { structuredContent: check, summary: checkSummary(check) };
}

/**
 * Parse a reference the way the runner does (`ModelReference.parse`): a sigil,
 * then a spelled-out namespace, else a bare handle. The name after a sigil or a
 * namespace must not be empty.
 */
export function parseModelReference(
  value: string,
): { ok: true; reference: ParsedReference } | { ok: false; error: ToolError } {
  const raw = value.trim();
  if (raw === "") {
    return {
      ok: false,
      error: {
        class: "input_domain",
        location: "reference",
        message: "The model reference is empty.",
        hint: "Pass a reference such as $writing-factual or @best-gpt, or omit reference to list the deck.",
        retryable: false,
      },
    };
  }

  for (const kind of REFERENCE_KINDS) {
    for (const prefix of [SIGIL_OF[kind], NAMESPACE_OF[kind]]) {
      if (prefix === "" || !raw.startsWith(prefix)) continue;
      const name = raw.slice(prefix.length);
      if (name === "") {
        return {
          ok: false,
          error: {
            class: "input_domain",
            location: "reference",
            message: `The model reference "${raw}" has no name after its "${prefix}" prefix.`,
            hint: `Write the ${kind}'s name after the prefix, such as ${SIGIL_OF[kind]}${EXAMPLE_NAME_OF[kind]}.`,
            retryable: false,
          },
        };
      }
      return { ok: true, reference: { raw, kind, name } };
    }
  }
  return { ok: true, reference: { raw, kind: "handle", name: raw } };
}

const EXAMPLE_NAME_OF: Record<ReferenceKind, string> = {
  preset: "writing-factual",
  alias: "best-gpt",
  waterfall: "robust-llm",
  handle: "gpt-4o",
};

/**
 * Validate the wire and index it by category: the protocol's categories first,
 * in its order and each present even when empty, then any category this module
 * does not know, in the order the deck first names it, under the runner's name.
 *
 * What arrives is checked rather than trusted, since the SDK hands the body back
 * as parsed JSON: a missing `models` list, an entry without a string name, a
 * category that is present but not a name, or an extension that is present but
 * shaped wrong is a contract break and throws. A category this module does not
 * know is kept, under the protocol's reader rule (see `DeckCategoryName`), and
 * appears only once it holds a preset, an alias or a waterfall. Two things are
 * skipped rather than refused, because neither is a break: an entry whose `type`
 * is absent or null, which the protocol's schema allows and which leaves no
 * category to list it under, and an extension absent altogether (`aliases` and
 * `waterfalls` are the Pipelex runner's, not the protocol's).
 */
export function projectDeck(value: unknown): Map<DeckCategoryName, DeckCategory> {
  if (!isRecord(value)) {
    throw new Error("The model deck must be an object.");
  }
  if (!Array.isArray(value.models)) {
    throw new Error("The model deck is missing its models list.");
  }

  const deck = new Map<DeckCategoryName, DeckCategory>(
    MODEL_CATEGORIES.map((category) => [category, emptyCategory(category)]),
  );
  const categoryOf = (category: DeckCategoryName): DeckCategory => {
    const existing = deck.get(category);
    if (existing !== undefined) return existing;
    const added = emptyCategory(category);
    deck.set(category, added);
    return added;
  };

  value.models.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") {
      throw new Error(`Model deck entry ${index} has no name.`);
    }
    if (entry.type === undefined || entry.type === null) return;
    if (typeof entry.type !== "string" || entry.type === "") {
      throw new Error(`Model deck entry ${index} has a category that is not a name.`);
    }
    categoryOf(entry.type).presets.push(`${SIGIL_OF.preset}${entry.name}`);
  });

  for (const [category, aliases] of categoryEntries(value.aliases, "aliases")) {
    for (const [name, target] of Object.entries(aliases)) {
      if (typeof target !== "string" || target === "") {
        throw new Error(`Model deck alias ${category}.${name} has no model handle.`);
      }
      categoryOf(category).aliases.push({ reference: `${SIGIL_OF.alias}${name}`, target });
    }
  }

  for (const [category, waterfalls] of categoryEntries(value.waterfalls, "waterfalls")) {
    for (const [name, fallbacks] of Object.entries(waterfalls)) {
      if (
        !Array.isArray(fallbacks) ||
        !fallbacks.every((step) => typeof step === "string" && step !== "")
      ) {
        throw new Error(`Model deck waterfall ${category}.${name} is not a list of model handles.`);
      }
      categoryOf(category).waterfalls.push({
        reference: `${SIGIL_OF.waterfall}${name}`,
        fallbacks: fallbacks as string[],
      });
    }
  }

  return deck;
}

/** An extension's per-category maps, for every category it names. */
function categoryEntries(
  value: unknown,
  field: "aliases" | "waterfalls",
): Array<[DeckCategoryName, Record<string, unknown>]> {
  if (value === undefined || value === null) return [];
  if (!isRecord(value)) {
    throw new Error(`The model deck's ${field} must map each category to its names.`);
  }
  const entries: Array<[DeckCategoryName, Record<string, unknown>]> = [];
  for (const [category, names] of Object.entries(value)) {
    if (category === "") {
      throw new Error(`The model deck's ${field} name a category with a blank key.`);
    }
    if (!isRecord(names)) {
      throw new Error(`The model deck's ${field}.${category} must map each name to its models.`);
    }
    entries.push([category, names]);
  }
  return entries;
}

function isModelCategory(value: unknown): value is ModelCategory {
  return MODEL_CATEGORIES.some((category) => category === value);
}

function emptyCategory(category: DeckCategoryName): DeckCategory {
  return { category, presets: [], aliases: [], waterfalls: [] };
}

/** The categories a listing or a check covers: the one named, else every one the deck holds. */
function scopeOf(
  deck: Map<DeckCategoryName, DeckCategory>,
  category: ModelCategory | undefined,
): DeckCategory[] {
  return category === undefined
    ? [...deck.values()]
    : [deck.get(category) ?? emptyCategory(category)];
}

/** A category as a summary names it: with its pipe type, or as one this tool does not know. */
function categoryLabel(category: DeckCategoryName): string {
  return isModelCategory(category)
    ? `${category} (${PIPE_TYPE_OF[category]})`
    : `${category} (a category this tool does not know)`;
}

/** The bare names one category holds for one kind, in the deck's order. */
function namesOf(deck: DeckCategory, kind: ReferenceKind): string[] {
  switch (kind) {
    case "preset":
      return deck.presets.map((preset) => preset.slice(SIGIL_OF.preset.length));
    case "alias":
      return deck.aliases.map((alias) => alias.reference.slice(SIGIL_OF.alias.length));
    case "waterfall":
      return deck.waterfalls.map((waterfall) =>
        waterfall.reference.slice(SIGIL_OF.waterfall.length),
      );
    case "handle":
      return unique([
        ...deck.aliases.map((alias) => alias.target),
        ...deck.waterfalls.flatMap((waterfall) => waterfall.fallbacks),
      ]);
  }
}

function matchIn(deck: DeckCategory, reference: ParsedReference): ReferenceMatch | undefined {
  const { kind, name } = reference;
  switch (kind) {
    case "preset":
      return deck.presets.includes(`${SIGIL_OF.preset}${name}`)
        ? { category: deck.category }
        : undefined;
    case "alias": {
      const alias = deck.aliases.find((each) => each.reference === `${SIGIL_OF.alias}${name}`);
      return alias === undefined ? undefined : { category: deck.category, target: alias.target };
    }
    case "waterfall": {
      const waterfall = deck.waterfalls.find(
        (each) => each.reference === `${SIGIL_OF.waterfall}${name}`,
      );
      return waterfall === undefined
        ? undefined
        : { category: deck.category, fallbacks: waterfall.fallbacks };
    }
    case "handle": {
      const via = [
        ...deck.aliases.filter((alias) => alias.target === name).map((alias) => alias.reference),
        ...deck.waterfalls
          .filter((waterfall) => waterfall.fallbacks.includes(name))
          .map((waterfall) => waterfall.reference),
      ];
      return via.length === 0 ? undefined : { category: deck.category, via };
    }
  }
}

export function checkReference(
  reference: ParsedReference,
  deck: Map<DeckCategoryName, DeckCategory>,
  category: ModelCategory | undefined,
): ModelReferenceCheck {
  const scope = scopeOf(deck, category);
  const matches = scope.flatMap((each) => matchIn(each, reference) ?? []);
  const base = {
    status: "ok" as const,
    ...(category === undefined ? {} : { category }),
    reference: reference.raw,
    kind: reference.kind,
  };

  if (matches.length > 0) {
    return {
      ...base,
      resolution: "resolved",
      matches,
      suggestions: [],
      other_kinds: [],
      other_categories: [],
    };
  }

  const candidatesOf = (kind: ReferenceKind) =>
    unique(scope.flatMap((each) => namesOf(each, kind)));

  const suggestions = closeMatches(
    reference.name,
    candidatesOf(reference.kind),
    SAME_KIND_MATCHES,
    SAME_KIND_CUTOFF,
  ).map((name) => `${SIGIL_OF[reference.kind]}${name}`);
  const otherKinds: string[] = [];
  for (const kind of REFERENCE_KINDS) {
    if (kind === reference.kind) continue;
    const candidates = candidatesOf(kind);
    if (candidates.includes(reference.name)) {
      otherKinds.push(`${SIGIL_OF[kind]}${reference.name}`);
      continue;
    }
    for (const name of closeMatches(
      reference.name,
      candidates,
      OTHER_KIND_MATCHES,
      OTHER_KIND_CUTOFF,
    )) {
      suggestions.push(`${SIGIL_OF[kind]}${name}`);
    }
  }

  const otherCategories =
    category === undefined
      ? []
      : [...deck.values()]
          .filter((other) => other.category !== category && matchIn(other, reference) !== undefined)
          .map((other) => other.category);

  return {
    ...base,
    resolution: reference.kind === "handle" ? "unconfirmed" : "not_found",
    matches: [],
    suggestions: unique(suggestions),
    other_kinds: otherKinds,
    other_categories: otherCategories,
  };
}

/**
 * difflib's `get_close_matches`: the candidates whose similarity to `word`
 * reaches `cutoff`, best first, at most `count` of them. Ties are broken the way
 * difflib's `heapq.nlargest` over `(score, candidate)` breaks them — the greater
 * candidate first — so the order matches the runner's own suggestions.
 */
export function closeMatches(
  word: string,
  candidates: readonly string[],
  count: number,
  cutoff: number,
): string[] {
  return candidates
    .map((candidate) => ({ candidate, score: similarity(candidate, word) }))
    .filter(({ score }) => score >= cutoff)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.candidate < b.candidate ? 1 : -1))
    .slice(0, count)
    .map(({ candidate }) => candidate);
}

/**
 * difflib's `SequenceMatcher(None, a, b).ratio()`: twice the characters the two
 * strings share in their matching blocks, over their total length. The blocks
 * are found as difflib finds them — the longest common run, earliest in `a` and
 * then in `b` on a tie, then the same on each side of it. difflib's junk
 * heuristic is left out: `get_close_matches` applies it to the word, which is
 * `b` here, and only from 200 characters, while `MAX_REFERENCE_LENGTH` keeps a
 * reference, and so the name it carries, below that.
 */
export function similarity(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const total = left.length + right.length;
  if (total === 0) return 1;

  const positionsInRight = new Map<string, number[]>();
  right.forEach((char, index) => {
    const positions = positionsInRight.get(char);
    if (positions === undefined) positionsInRight.set(char, [index]);
    else positions.push(index);
  });

  let matched = 0;
  const queue: Array<[number, number, number, number]> = [[0, left.length, 0, right.length]];
  while (queue.length > 0) {
    const [aLow, aHigh, bLow, bHigh] = queue.pop() as [number, number, number, number];
    let bestI = aLow;
    let bestJ = bLow;
    let bestSize = 0;
    let runEndingAt = new Map<number, number>();
    for (let i = aLow; i < aHigh; i++) {
      const next = new Map<number, number>();
      for (const j of positionsInRight.get(left[i] as string) ?? []) {
        if (j < bLow) continue;
        if (j >= bHigh) break;
        const size = (runEndingAt.get(j - 1) ?? 0) + 1;
        next.set(j, size);
        if (size > bestSize) {
          bestI = i - size + 1;
          bestJ = j - size + 1;
          bestSize = size;
        }
      }
      runEndingAt = next;
    }
    if (bestSize === 0) continue;
    matched += bestSize;
    if (aLow < bestI && bLow < bestJ) queue.push([aLow, bestI, bLow, bestJ]);
    if (bestI + bestSize < aHigh && bestJ + bestSize < bHigh) {
      queue.push([bestI + bestSize, aHigh, bestJ + bestSize, bHigh]);
    }
  }
  return (2 * matched) / total;
}

const ACCOUNT_CAVEAT =
  "The deck is what the runner can serve, not what this account may use: a run can still refuse a listed model.";

function listingSummary(listing: ModelDeckListing): string {
  const scope =
    listing.category === undefined
      ? "every category"
      : `${listing.category}, for a ${PIPE_TYPE_OF[listing.category]}`;
  const lines = [
    `Model deck (${scope}): the references a pipe's model field can name.`,
    "Presets ($) pair a model with settings for a kind of task and are the ones to prefer; aliases (@) name one model; waterfalls (~) try models in order. " +
      "A bare model handle works too, but the deck names handles only as alias targets and waterfall steps.",
    ACCOUNT_CAVEAT,
  ];

  for (const category of listing.deck) {
    lines.push("", `## ${categoryLabel(category.category)}`);
    lines.push(`Presets: ${listOrNone(category.presets.map(code))}`);
    lines.push(
      `Aliases: ${listOrNone(category.aliases.map((alias) => `${code(alias.reference)} → ${code(alias.target)}`))}`,
    );
    lines.push(
      `Waterfalls: ${listOrNone(
        category.waterfalls.map(
          (waterfall) =>
            `${code(waterfall.reference)} → ${waterfall.fallbacks.map(code).join(", ")}`,
        ),
      )}`,
    );
  }

  lines.push(
    "",
    "To check a reference before writing it into a method, call mthds_models with reference.",
  );
  return lines.join("\n");
}

function checkSummary(check: ModelReferenceCheck): string {
  const where =
    check.category === undefined
      ? "any category"
      : `${check.category} (${PIPE_TYPE_OF[check.category]})`;
  const lines: string[] = [];

  switch (check.resolution) {
    case "resolved":
      lines.push(`${code(check.reference)} resolves: it is ${article(check.kind)} ${check.kind}.`);
      for (const match of check.matches) {
        lines.push(`- ${categoryLabel(match.category)}${matchDetail(match)}`);
      }
      break;
    case "not_found":
      lines.push(
        `${code(check.reference)} does not resolve: no ${check.kind} in ${where} has that name.`,
      );
      break;
    case "unconfirmed":
      lines.push(
        `${code(check.reference)} is a bare model handle the deck cannot confirm: no alias or waterfall in ${where} names it, and the deck lists no handle otherwise.`,
      );
      break;
  }

  // The likeliest fault first: a name the deck holds under another sigil is
  // almost always a sigil left off or mistyped, so it leads what follows.
  for (const other of check.other_kinds) {
    const kind = kindOf(other);
    lines.push(
      `The same name exists as ${code(other)}, ${article(kind)} ${kind}: write it ${kind === "handle" ? "bare, without a sigil" : "with that sigil"}.`,
    );
  }
  if (check.other_categories.length > 0) {
    const others = check.other_categories.map(categoryLabel).join(", ");
    lines.push(
      `It resolves in ${others}, not in ${where}: a reference names a model of its pipe's own category.`,
    );
  }
  if (check.suggestions.length > 0) {
    lines.push(`Nearest names: ${check.suggestions.map(code).join(", ")}.`);
  }
  if (
    check.resolution === "unconfirmed" &&
    check.other_kinds.length === 0 &&
    check.other_categories.length === 0
  ) {
    lines.push(
      "mthds_validate checks a handle against the runner's full model list; prefer a preset where one fits.",
    );
  }

  lines.push(ACCOUNT_CAVEAT);
  return lines.join("\n");
}

function matchDetail(match: ReferenceMatch): string {
  if (match.target !== undefined) return ` → ${code(match.target)}`;
  if (match.fallbacks !== undefined) return ` → ${match.fallbacks.map(code).join(", ")}`;
  if (match.via !== undefined) return `, named by ${match.via.map(code).join(", ")}`;
  return "";
}

/** The kind a sigiled reference this module wrote is of. */
function kindOf(reference: string): ReferenceKind {
  return (
    REFERENCE_KINDS.find((kind) => kind !== "handle" && reference.startsWith(SIGIL_OF[kind])) ??
    "handle"
  );
}

function article(kind: ReferenceKind): string {
  return kind === "alias" ? "an" : "a";
}

function code(text: string): string {
  return `\`${text}\``;
}

function listOrNone(items: string[]): string {
  return items.length === 0 ? "none." : items.join(", ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The 400/422 arm is picked by status, as the upload grant's is, because the
 * two refusals come from two layers. A 422 is the runner's, and its only one on
 * this route is a `type` it does not know, which only a listing with a category
 * sends. This tool declares the protocol's categories, so a runner refuses one
 * only when it implements an older protocol than the one that defined it, as a
 * runner before protocol 0.7.0 refuses `judgment`; the hint says so rather than
 * offering the refused value back. A 400 is the platform's missing active-organization refusal: the
 * route takes a user credential alone today and never answers it, but the
 * refusal is the platform's on every organization-scoped route, and it would
 * arrive with a category or without one, so the category must not take the
 * blame for it.
 */
function modelsErrorOptions(context: ModelsContext, err: unknown): ClassifyErrorOptions {
  const orgless = err instanceof ApiResponseError && err.status === 400;
  return {
    route: "/v1/models",
    badRequest: orgless
      ? {
          class: "config",
          location: context.authError?.location ?? "PIPELEX_API_KEY",
          hint: "The model deck needs an active organization context. Use a platform key minted for the intended organization, then retry.",
        }
      : {
          location: "category",
          hint: "The runner does not know this category, which happens when it implements an older MTHDS protocol than the one that defined it. Omit category to list every category it serves.",
        },
    auth: context.authError,
  };
}

const ERROR_SUMMARIES: ErrorSummaries = {
  config: "Model deck could not be read: the Pipelex API or its access is misconfigured.",
  input_domain: "Model deck was not read: the Pipelex API rejected the request.",
  runtime: "Model deck could not be read: the Pipelex API returned an error.",
  paywall:
    "Model deck could not be read: the organization's Pipelex plan does not cover this call.",
};

function errorResult(summary: string, errors: ToolError[]): ModelsResult {
  return { structuredContent: { status: "error", errors }, summary };
}

export function modelsToolResult(result: ModelsResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(
      result.summary,
      result.structuredContent.status === "error" ? result.structuredContent.errors : undefined,
    ),
    isError: result.structuredContent.status === "error",
  };
}
