import { PIPELEX_STORAGE_SCHEME, collectArtifacts } from "@pipelex/sdk";
import type { RunResults } from "@pipelex/sdk";

/**
 * Stored texts: a `Text`, `Markdown`, `Html` or `JSON` value of a run's output
 * that the runtime kept in the run's storage because it passed the inline
 * threshold, and that travels as its reference, `{ url, size, mime_type,
 * preview }`, in place of its value field (`text`, `inner_html`, `json_obj`).
 *
 * The workshop never loads one: its results are read by a model, and a large
 * text would put straight back into the model's context what the runtime kept
 * out of it. So `mthds_run_results` shows the reference with its size and
 * preview, and `mthds_download_artifacts` saves the text to disk as a text
 * file. Both need to tell a stored text from a stored file, which this module
 * does.
 *
 * **By concept, never by shape.** A stored text and a stored `Document` both
 * carry a `pipelex-storage://` reference in `url`, and a document may be
 * `text/plain` as well, so neither the URL nor the MIME type can tell them
 * apart. The standard's rule is that a value's kind comes from its concept, so
 * the walk reads the concept the run's output names at each position: the main
 * output's concept from the run's working memory (the stuff the `main_stuff`
 * alias names), and its structure from the run's output-form descriptors
 * (`output_form`), whose every concept-typed node carries its `concept_ref` and
 * its `refines` chain. A position is text-valued when its concept is one of the
 * storable natives, refines one, or is a description-only concept, which the
 * language makes text. A value is stored there when it carries a storage
 * reference in `url` and no value field.
 *
 * **When the facts are missing, nothing is a stored text.** A results read
 * without the working memory or the descriptors (an older platform, a run whose
 * artifacts were not written) still recognizes a main output whose concept is
 * itself a storable native, and otherwise reports every reference as a stored
 * file, as the workshop did before stored texts existed. That is the safe
 * direction: a file count one too high, never a file hidden.
 */

/** The natives whose value the runtime may store, and every concept refining one. */
export const STORABLE_NATIVES: readonly string[] = [
  "native.Text",
  "native.Markdown",
  "native.Html",
  "native.JSON",
];

/** The value fields of the storable natives: a stored value carries none of them. */
const VALUE_FIELDS = ["text", "inner_html", "json_obj"] as const;

/** The alias the runtime gives the run's main output in its working memory. */
const MAIN_STUFF_ALIAS = "main_stuff";

/** One step of a path into a walked value: an object key, or an array index. */
export type PathSegment = string | number;

/** One stored text of a run's output, as the walk found it. */
export interface StoredText {
  /** The `pipelex-storage://` reference in the value's `url`. */
  uri: string;
  /** Every `$`-rooted path of that `url` in the output, in walk order; the first names its file. */
  found_at: string[];
  /** The same paths as segments, for code that edits the output (`withoutStoredTexts`). */
  segments: PathSegment[][];
  /** The stored value's length in bytes, as the reference states it. */
  size: number | null;
  /** The stored value's MIME type, as the reference states it. */
  mime_type: string | null;
  /** The first few hundred characters of the value, as the reference states them. */
  preview: string | null;
}

/**
 * The slice of an output-form descriptor node the walk reads, narrowed from
 * the wire rather than trusted: the standard's `InputFormItem`.
 */
interface DescriptorNode {
  kind: string;
  name?: string;
  concept_ref?: string;
  refines?: string[];
  fields?: DescriptorNode[];
  item?: DescriptorNode;
}

/** The facts the walk reads from a run's results. */
export type ConceptSources = Pick<RunResults, "main_stuff" | "working_memory" | "output_form">;

/**
 * Every stored text of a run's main output, one entry per reference, in
 * discovery order, each with every path it sits at. Pure: no network.
 */
export function storedTextsOf(results: ConceptSources): StoredText[] {
  const node = mainOutputNode(results);
  if (node === undefined) return [];

  const byUri = new Map<string, StoredText>();
  const record = (value: Record<string, unknown>, url: string, at: PathSegment[]): void => {
    const segments = [...at, "url"];
    const known = byUri.get(url);
    if (known !== undefined) {
      known.segments.push(segments);
      known.found_at.push(renderPath(segments));
      return;
    }
    byUri.set(url, {
      uri: url,
      found_at: [renderPath(segments)],
      segments: [segments],
      size: typeof value.size === "number" ? value.size : null,
      mime_type: typeof value.mime_type === "string" ? value.mime_type : null,
      preview: typeof value.preview === "string" ? value.preview : null,
    });
  };

  walkMain(results.main_stuff, node, record);
  return [...byUri.values()];
}

/**
 * The main output with the reference of every stored text taken out, so that
 * what is left references the run's stored files alone: the `url` key of each
 * stored value is removed, and nothing else changes, so a file keeps the path
 * it has in the full output. The input is not modified.
 */
export function withoutStoredTexts(mainStuff: unknown, texts: readonly StoredText[]): unknown {
  if (texts.length === 0) return mainStuff;
  const copy = structuredClone(mainStuff);
  for (const text of texts) {
    for (const segments of text.segments) {
      const parent = valueAt(copy, segments.slice(0, -1));
      if (isRecord(parent)) delete parent.url;
    }
  }
  return copy;
}

/** The stored files of a main output: every storage reference that is not a stored text's. */
export function storedFilesOf(mainStuff: unknown, texts: readonly StoredText[]): string[] {
  return collectArtifacts(withoutStoredTexts(mainStuff, texts));
}

// ── the main output's descriptor ────────────────────────────────────

/**
 * The descriptor node of the main output's concept: the concept the working
 * memory names for the `main_stuff` alias, looked up among every concept-typed
 * node of the run's output-form descriptors. A storable native with no
 * descriptor is recognized from its reference alone.
 */
function mainOutputNode(results: ConceptSources): DescriptorNode | undefined {
  const concept = mainConceptOf(results.working_memory);
  if (concept === undefined) return undefined;
  const known = conceptNodesOf(results.output_form).get(concept);
  if (known !== undefined) return known;
  return STORABLE_NATIVES.includes(concept) ? { kind: "prose", concept_ref: concept } : undefined;
}

/** The concept reference of the stuff the working memory's `main_stuff` alias names. */
function mainConceptOf(workingMemory: unknown): string | undefined {
  if (!isRecord(workingMemory) || !isRecord(workingMemory.root)) return undefined;
  const aliases = isRecord(workingMemory.aliases) ? workingMemory.aliases : {};
  const target = aliases[MAIN_STUFF_ALIAS];
  const name = typeof target === "string" ? target : MAIN_STUFF_ALIAS;
  const stuff = workingMemory.root[name];
  if (!isRecord(stuff)) return undefined;
  // A runtime older than pipelex 0.60.0 wrote the concept as an object, which
  // states no reference this walk can match: the facts are missing.
  return typeof stuff.concept === "string" ? stuff.concept : undefined;
}

/**
 * Every concept-typed node of every pipe's output descriptor, by concept
 * reference. A concept's node is derived from the concept alone, so any
 * occurrence describes it; a `list` node names its element, which its `item`
 * describes, so the list node itself is not indexed.
 */
function conceptNodesOf(outputForm: unknown): Map<string, DescriptorNode> {
  const nodes = new Map<string, DescriptorNode>();
  const visit = (raw: unknown): void => {
    const node = narrowNode(raw);
    if (node === undefined) return;
    if (node.concept_ref !== undefined && node.kind !== "list" && !nodes.has(node.concept_ref)) {
      nodes.set(node.concept_ref, node);
    }
    for (const field of node.fields ?? []) visit(field);
    if (node.item !== undefined) visit(node.item);
  };
  if (isRecord(outputForm)) {
    for (const descriptor of Object.values(outputForm)) {
      if (isRecord(descriptor)) visit(descriptor.field);
    }
  }
  return nodes;
}

/** A descriptor node as the walk reads it, or `undefined` when the value is none. */
function narrowNode(raw: unknown): DescriptorNode | undefined {
  if (!isRecord(raw) || typeof raw.kind !== "string") return undefined;
  const fields = Array.isArray(raw.fields)
    ? raw.fields.flatMap((field) => {
        const node = narrowNode(field);
        return node === undefined ? [] : [node];
      })
    : undefined;
  const item = narrowNode(raw.item);
  return {
    kind: raw.kind,
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(typeof raw.concept_ref === "string" ? { concept_ref: raw.concept_ref } : {}),
    ...(Array.isArray(raw.refines)
      ? { refines: raw.refines.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    ...(fields === undefined ? {} : { fields }),
    ...(item === undefined ? {} : { item }),
  };
}

/**
 * Whether a node's concept is text-valued, so its value may be stored: a
 * storable native, a concept refining one, or a concept that reaches no native
 * and is text by the language's rule (`prose`, or `text` under a `label`
 * intent). A field with no concept, a structure's plain `text` field, is a
 * string and always inline. A `list` node names its element's concept, which
 * its `item` carries, so the list itself is never text-valued.
 */
function isTextValued(node: DescriptorNode): boolean {
  if (node.concept_ref === undefined || node.kind === "list") return false;
  const chain = [node.concept_ref, ...(node.refines ?? [])];
  if (chain.some((concept) => STORABLE_NATIVES.includes(concept))) return true;
  if (chain.some((concept) => concept.startsWith("native."))) return false;
  return node.kind === "prose" || node.kind === "text";
}

// ── the walk ────────────────────────────────────────────────────────

type Recorder = (value: Record<string, unknown>, url: string, at: PathSegment[]) => void;

/**
 * Walk the main output against its concept's node. A plural output arrives as
 * the envelope `{ items: [...] }` while the working memory names its element
 * concept, so an `items` array that the concept itself does not declare is
 * walked item by item.
 */
function walkMain(mainStuff: unknown, node: DescriptorNode, record: Recorder): void {
  const declaresItems =
    node.kind === "object" && (node.fields ?? []).some((f) => f.name === "items");
  if (
    isRecord(mainStuff) &&
    Array.isArray(mainStuff.items) &&
    !declaresItems &&
    !isStored(mainStuff)
  ) {
    mainStuff.items.forEach((item, index) => walk(item, node, ["items", index], record));
    return;
  }
  walk(mainStuff, node, [], record);
}

function walk(value: unknown, node: DescriptorNode, at: PathSegment[], record: Recorder): void {
  if (isTextValued(node)) {
    if (isRecord(value) && isStored(value)) record(value, value.url as string, at);
    return;
  }
  if (node.kind === "object" && isRecord(value)) {
    for (const field of node.fields ?? []) {
      if (field.name !== undefined && Object.hasOwn(value, field.name)) {
        walk(value[field.name], field, [...at, field.name], record);
      }
    }
    return;
  }
  if (node.kind === "list" && node.item !== undefined && Array.isArray(value)) {
    const item = node.item;
    value.forEach((entry, index) => walk(entry, item, [...at, index], record));
  }
}

/** A value in its stored form: a storage reference in `url`, and no value field. */
function isStored(value: Record<string, unknown>): boolean {
  const url = value.url;
  return (
    typeof url === "string" &&
    url.startsWith(PIPELEX_STORAGE_SCHEME) &&
    url.length > PIPELEX_STORAGE_SCHEME.length &&
    VALUE_FIELDS.every((field) => value[field] === undefined || value[field] === null)
  );
}

// ── paths ───────────────────────────────────────────────────────────

/** An object key rendered as `.key` in a path; any other key is rendered as `["…"]`. */
const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Segments to the `$`-rooted notation the SDK's `locateArtifacts` writes in
 * `found_at` (`$.pages[0].text_and_images.text.url`), so a stored text's path
 * reads, and names its file, exactly as a stored file's does.
 */
export function renderPath(segments: readonly PathSegment[]): string {
  let rendered = "$";
  for (const segment of segments) {
    if (typeof segment === "number") rendered += `[${segment}]`;
    else if (IDENTIFIER_KEY.test(segment)) rendered += `.${segment}`;
    else rendered += `[${JSON.stringify(segment)}]`;
  }
  return rendered;
}

function valueAt(root: unknown, segments: readonly PathSegment[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
