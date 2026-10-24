/**
 * The model deck capability (`mthds_models`, **workshop-only**): list the
 * model references a method's pipes can name in their `model` field, or check
 * one reference before it is written into a method.
 *
 * A listing reads `GET /v1/models`, the MTHDS Protocol's `ModelDeck`, through
 * the SDK's `models()`. On the Pipelex runner that deck is the flat `models`
 * list, which holds the PRESETS, each stamped with its category, plus two
 * category-keyed extensions: `aliases` (alias name → model handle) and
 * `waterfalls` (waterfall name → handles tried in order). It lists no model
 * handle as such: a handle appears only as an alias's target or a waterfall's
 * step.
 *
 * A check asks the runner: `GET /v1/models/check`, through the SDK's
 * `checkModelReference`. The runner answers from pipelex's own reference
 * parser, resolver and suggestion rule, the ones a validation runs, and it
 * knows every model it can call, so its verdict is definitive either way and
 * a reference it finds `resolved` in a category is one a validation accepts
 * there. This module therefore parses nothing and ranks nothing: it relays the
 * verdict, checking its shape rather than trusting it, and words the summary.
 *
 * The deck is what the runner can route to, not what the caller's account may
 * use: a gateway can refuse a listed model when a run starts. The description
 * and every summary say so, since that is the one thing a model reading the deck
 * would otherwise take for granted.
 */

import { buildProblem } from "@pipelex/sdk";
import type { ModelCheckCategory, ModelReferenceVerdict } from "@pipelex/sdk";
import { MODEL_CATEGORIES } from "mthds/protocol";
import type { ModelCategory, ModelDeck, ModelInfo } from "mthds/protocol";
import { z } from "zod";

import {
  argumentProblem,
  asOneLine,
  buildApiConfig,
  createPipelexApiClient,
  faultsProblem,
  problemOf,
  problemSchema,
  problemSummary,
  toolResultContent,
} from "./shared.js";
import type { ApiConfig, ApiNotes, Problem } from "./shared.js";

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
 * The same table over the categories the runner's check covers, which are the
 * protocol's plus `doc_gen`, the family of `PipeDocGen`: the protocol defines no
 * category for it, so the listing leaves it out, but a method names a `doc_gen`
 * model like any other and a check without a category answers in it. Total over
 * the SDK's `ModelCheckCategory`, so the build fails when the SDK gains one.
 */
const CHECK_PIPE_TYPE_OF: Record<ModelCheckCategory, string> = {
  ...PIPE_TYPE_OF,
  doc_gen: "PipeDocGen",
};

/**
 * The categories a check takes, in the order it covers them: the protocol's,
 * then `doc_gen`. They are the keys of {@link CHECK_PIPE_TYPE_OF}, in its
 * insertion order, so the record's totality over the SDK's
 * `ModelCheckCategory` is what holds this list to it, both ways; the cast
 * only restores the non-empty tuple `z.enum` takes.
 */
const CHECK_CATEGORIES = Object.keys(CHECK_PIPE_TYPE_OF) as [
  ModelCheckCategory,
  ...ModelCheckCategory[],
];

/**
 * A category as a deck or a verdict names it: one of the protocol's, or one
 * this module does not know, kept under the runner's own name. The protocol's
 * reader rule: "A client reading a model list MUST NOT fail it because an entry
 * carries a category it does not recognize; it keeps that entry with its raw
 * value or leaves it out." This tool keeps it, so a runner of a later protocol
 * minor still has its new category listed and checked, labelled as one this
 * tool cannot place on a pipe type.
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

/**
 * The filter: the closed set a check takes, which a runner refuses a value
 * outside of. A listing takes the protocol's alone, since the deck has no
 * `doc_gen` category, and the capability refuses `doc_gen` without a reference.
 */
const categorySchema = z.enum(CHECK_CATEGORIES);

/** A category in a result: any name the deck or the verdict carried, the protocol's or not. */
const deckCategoryNameSchema = z.string();

export const mthdsModelsInputSchema = {
  category: categorySchema
    .optional()
    .describe(
      `Only this category: ${CATEGORY_PIPE_TYPES}, or, when checking a reference, doc_gen for a PipeDocGen, which the deck does not list. Omit it for every category; a check then covers doc_gen as well.`,
    ),
  reference: z
    .string()
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
  resolves_to: z
    .string()
    .nullable()
    .describe(
      "The model a run through the reference calls now in this category; null when it reaches none, so a run fails although validation accepts the reference.",
    ),
  target: z.string().optional(),
  description: z.string().nullable().optional(),
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
  name: z.string().optional(),
  resolution: z.enum(["resolved", "not_found"]).optional(),
  matches: z.array(matchSchema).optional(),
  suggestions: z.array(z.string()).optional(),
  other_kinds: z.array(z.string()).optional(),
  other_categories: z.array(deckCategoryNameSchema).optional(),
  problem: problemSchema.optional(),
});

export interface MthdsModelsInput {
  category?: ModelCheckCategory;
  reference?: string;
}

export interface DeckCategory {
  category: DeckCategoryName;
  /** Each preset as it is written, `$name`, in the runner's order. */
  presets: string[];
  aliases: Array<{ reference: string; target: string }>;
  waterfalls: Array<{ reference: string; fallbacks: string[] }>;
}

/**
 * What a checked reference is in one category it resolves in. A field that
 * does not apply to the reference's kind is absent, as on the runner's verdict.
 */
export interface ReferenceMatch {
  category: DeckCategoryName;
  /** The model a run through the reference calls now in this category, or `null` when it reaches none. */
  resolves_to: string | null;
  /** A preset's or an alias's binding, as the deck writes it, which may itself be a reference. */
  target?: string;
  /** A preset's description, or `null` when the deck gives it none. */
  description?: string | null;
  /** A waterfall's steps, in order. */
  fallbacks?: string[];
  /** For a handle: the presets, aliases and waterfalls of this category whose binding names it. */
  via?: string[];
}

/**
 * The runner's two answers, both definitive since it knows every name it
 * holds. A value it sends that this tool does not know reads as `not_found`,
 * under the spec's reader rule that such a reference is treated as unresolved.
 */
export type ReferenceResolution = "resolved" | "not_found";

export interface ModelDeckListing {
  status: "ok";
  category?: ModelCategory;
  deck: DeckCategory[];
}

export interface ModelReferenceCheck {
  status: "ok";
  category?: ModelCheckCategory;
  /** The reference as checked: the caller's, trimmed by the runner. */
  reference: string;
  kind: ReferenceKind;
  /** The reference without its sigil or namespace. */
  name: string;
  resolution: ReferenceResolution;
  /** Where it resolves; empty unless `resolved`. */
  matches: ReferenceMatch[];
  /** The nearest names, written as a method writes them; empty when `resolved`. */
  suggestions: string[];
  /** The same name under another kind, written with that kind's sigil (`best-gpt` → `@best-gpt`); empty when `resolved`. */
  other_kinds: string[];
  /** With a category: the other categories the same reference resolves in; empty otherwise. */
  other_categories: DeckCategoryName[];
}

export interface ModelsFailure {
  status: "error";
  problem: Problem;
}

export type ModelsStructuredContent = ModelDeckListing | ModelReferenceCheck | ModelsFailure;

export interface ModelsResult {
  structuredContent: ModelsStructuredContent;
  summary: string;
}

/** The narrow SDK seam the tests supply. */
export interface ModelsClient {
  models(category?: ModelCategory): Promise<ModelDeck>;
  checkModelReference(
    reference: string,
    category?: ModelCheckCategory,
  ): Promise<ModelReferenceVerdict>;
}

export interface ModelsContext extends ApiConfig {
  client?: ModelsClient;
  /** Where the call's key and base URL came from, closing a failed request's summary. */
  apiNotes?: ApiNotes;
}

export function buildModelsContext(env = process.env): ModelsContext {
  return buildApiConfig(env);
}

function modelsClient(context: ModelsContext): ModelsClient {
  return context.client ?? createPipelexApiClient(context);
}

export async function readMthdsModels(
  input: MthdsModelsInput,
  context: ModelsContext,
): Promise<ModelsResult> {
  const parsedInput = mthdsModelsInputObjectSchema.safeParse(input);
  if (!parsedInput.success) {
    return errorResult(
      faultsProblem(
        parsedInput.error.issues.map((issue) =>
          argumentProblem(
            issue.path.length === 0 ? "arguments" : issue.path.join("."),
            issue.code,
            issue.message,
            `Use category as one of ${CHECK_CATEGORIES.join(", ")}, and reference as text.`,
          ),
        ),
      ),
      context,
    );
  }
  const { category, reference } = parsedInput.data;
  if (reference !== undefined) return checkReference(reference, category, context);
  if (category === "doc_gen") {
    return errorResult(
      argumentProblem(
        "category",
        "not_listed",
        "The MTHDS Protocol defines no doc_gen category, so the deck lists none; a check covers it.",
        `Pass reference to check a doc_gen reference, or list one of ${MODEL_CATEGORIES.join(", ")}.`,
      ),
      context,
    );
  }
  return listDeck(category, context);
}

async function listDeck(
  category: ModelCategory | undefined,
  context: ModelsContext,
): Promise<ModelsResult> {
  let wire: ModelDeck;
  try {
    // The route's own filter. Client construction stays inside the caught
    // path, so a malformed base URL becomes the SDK's problem rather than a
    // rejected handler.
    wire = await modelsClient(context).models(category);
  } catch (err) {
    // The API's own problem, relayed: a category an older runner does not
    // know, a key acting for no organization, a refused key.
    return errorResult(problemOf(err), context);
  }

  let deck: Map<DeckCategoryName, DeckCategory>;
  try {
    deck = projectDeck(wire);
  } catch (err) {
    return errorResult(
      unusableAnswer(
        err instanceof Error ? err.message : "The Pipelex API returned a malformed deck.",
      ),
      context,
    );
  }

  const listing: ModelDeckListing = {
    status: "ok",
    ...(category === undefined ? {} : { category }),
    deck: scopeOf(deck, category),
  };
  return { structuredContent: listing, summary: listingSummary(listing) };
}

async function checkReference(
  reference: string,
  category: ModelCheckCategory | undefined,
  context: ModelsContext,
): Promise<ModelsResult> {
  let wire: unknown;
  try {
    // The reference goes as the caller wrote it: the runner trims it, parses
    // it and refuses one it cannot read, and its rule is the only one.
    wire = await modelsClient(context).checkModelReference(reference, category);
  } catch (err) {
    // The runner's own problem, relayed: a reference it cannot read, a
    // category older than its protocol, a request it refused, each by its code.
    return errorResult(problemOf(err), context);
  }

  const parsed = wireVerdictSchema.safeParse(wire);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`;
    return errorResult(
      unusableAnswer(
        `The model reference verdict is malformed${at}: ${issue?.message ?? "it is not an object"}.`,
      ),
      context,
    );
  }

  const check = checkOf(parsed.data, category);
  return { structuredContent: check, summary: checkSummary(check) };
}

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

function emptyCategory(category: DeckCategoryName): DeckCategory {
  return { category, presets: [], aliases: [], waterfalls: [] };
}

/** The categories a listing covers: the one named, else every one the deck holds. */
function scopeOf(
  deck: Map<DeckCategoryName, DeckCategory>,
  category: ModelCategory | undefined,
): DeckCategory[] {
  return category === undefined
    ? [...deck.values()]
    : [deck.get(category) ?? emptyCategory(category)];
}

// ── the runner's verdict, checked ──
//
// The SDK hands the verdict back as parsed JSON typed as `ModelReferenceVerdict`
// without checking it, so these schemas do, one arm per kind as the wire is
// discriminated, each match holding exactly the fields its kind carries. Parsing
// strips any field the shape does not name, which is the projection: what
// reaches `structuredContent` is what the output schema declares. `resolution`
// and every category are read open, as the spec and the SDK read them.

const wireMatchBase = {
  category: z.string().min(1),
  resolves_to: z.string().nullable(),
};

const wireVerdictBase = {
  reference: z.string(),
  name: z.string(),
  resolution: z.string(),
  suggestions: z.array(z.string()),
  other_kinds: z.array(z.string()),
  other_categories: z.array(z.string().min(1)),
};

const wireVerdictSchema = z.discriminatedUnion("kind", [
  z.object({
    ...wireVerdictBase,
    kind: z.literal("preset"),
    matches: z.array(
      z.object({ ...wireMatchBase, target: z.string(), description: z.string().nullable() }),
    ),
  }),
  z.object({
    ...wireVerdictBase,
    kind: z.literal("alias"),
    matches: z.array(z.object({ ...wireMatchBase, target: z.string() })),
  }),
  z.object({
    ...wireVerdictBase,
    kind: z.literal("waterfall"),
    matches: z.array(z.object({ ...wireMatchBase, fallbacks: z.array(z.string()) })),
  }),
  z.object({
    ...wireVerdictBase,
    kind: z.literal("handle"),
    matches: z.array(z.object({ ...wireMatchBase, via: z.array(z.string()) })),
  }),
]);

type WireVerdict = z.infer<typeof wireVerdictSchema>;

/**
 * The tool's check from the runner's verdict. `category` is the one the
 * caller asked about, which the runner echoes, so the output keeps the
 * input's closed filter type and stays absent when none was asked. A
 * resolution this tool does not know reads as `not_found`, and so drops the
 * matches, which a `not_found` never carries.
 */
function checkOf(
  verdict: WireVerdict,
  category: ModelCheckCategory | undefined,
): ModelReferenceCheck {
  const resolved = verdict.resolution === "resolved";
  return {
    status: "ok",
    ...(category === undefined ? {} : { category }),
    reference: verdict.reference,
    kind: verdict.kind,
    name: verdict.name,
    resolution: resolved ? "resolved" : "not_found",
    matches: resolved ? verdict.matches : [],
    suggestions: verdict.suggestions,
    other_kinds: verdict.other_kinds,
    other_categories: verdict.other_categories,
  };
}

// ── summaries ──

/** The pipe type that names a category, for the categories this tool knows. */
function pipeTypeOf(category: string): string | undefined {
  return Object.hasOwn(CHECK_PIPE_TYPE_OF, category)
    ? CHECK_PIPE_TYPE_OF[category as ModelCheckCategory]
    : undefined;
}

/** A category as a summary names it: with its pipe type, or as one this tool does not know. */
function categoryLabel(category: string): string {
  const pipeType = pipeTypeOf(category);
  return pipeType === undefined
    ? `${category} (a category this tool does not know)`
    : `${category} (${pipeType})`;
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
  const where = check.category === undefined ? "any category" : categoryLabel(check.category);
  const lines: string[] = [];

  if (check.resolution === "resolved") {
    lines.push(`${code(check.reference)} resolves: it is ${article(check.kind)} ${check.kind}.`);
    for (const match of check.matches) {
      lines.push(`- ${categoryLabel(match.category)}${matchDetail(check, match)}`);
    }
    if (check.matches.some((match) => match.resolves_to === null)) {
      lines.push(
        "Where it reaches no model, a validation accepts it but a run through it fails: treat that as a warning, and prefer a reference that reaches one.",
      );
    }
  } else {
    const holder =
      check.kind === "handle"
        ? `no model this runner can call in ${where}, and no alias or waterfall there,`
        : `no ${check.kind} in ${where}`;
    lines.push(
      `${code(check.reference)} does not resolve: ${holder} has that name, so a validation refuses it too.`,
    );
  }

  // The likeliest fault first: a name the runner holds under another sigil is
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

  lines.push(ACCOUNT_CAVEAT);
  return lines.join("\n");
}

/** What a match says beyond its category: the binding, the steps or who names it, then what a run calls. */
function matchDetail(check: ModelReferenceCheck, match: ReferenceMatch): string {
  let shown: string | undefined;
  let detail = "";
  if (match.target !== undefined) {
    shown = match.target;
    detail = ` → ${code(match.target)}`;
  } else if (match.fallbacks !== undefined) {
    detail = ` → ${match.fallbacks.map(code).join(", ")}`;
  } else if (match.via !== undefined) {
    shown = check.name;
    detail = match.via.length === 0 ? "" : `, named by ${match.via.map(code).join(", ")}`;
  }

  if (match.resolves_to === null) {
    detail += ", which reaches no model this runner can call now";
  } else if (match.resolves_to !== shown) {
    detail += `, which runs ${code(match.resolves_to)} now`;
  }

  if (typeof match.description === "string" && match.description.trim() !== "") {
    detail += `: ${asOneLine(match.description)}`;
  }
  return detail;
}

/** The kind a reference the runner wrote is of, read from its sigil. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── failures ──

/**
 * An answer the API gave that breaks the route's contract, a deck or a verdict
 * this tool cannot read: `client.response_unreadable`, carrying what was wrong.
 * The SDK handed it back as a success, so it came on a `2xx`.
 */
function unusableAnswer(message: string): Problem {
  return buildProblem("client.response_unreadable", { status: 200 }, { extra: { message } });
}

/**
 * A no-verdict result: the problem, and its Markdown summary, closed by the
 * notes on the call's key and base URL when the fix may be one of them.
 */
function errorResult(problem: Problem, context: ModelsContext): ModelsResult {
  return {
    structuredContent: { status: "error", problem },
    summary: problemSummary(problem, context.apiNotes),
  };
}

export function modelsToolResult(result: ModelsResult) {
  return {
    structuredContent: result.structuredContent,
    content: toolResultContent(result.summary),
    isError: result.structuredContent.status === "error",
  };
}
