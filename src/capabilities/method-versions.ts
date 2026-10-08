import { ApiResponseError, parseMethodSelector } from "@pipelex/sdk";
import { z } from "zod";

import type { ToolError } from "./shared.js";
import { WORKSHOP_TOOL_NAMES } from "./tool-names.js";

/**
 * Saved methods' versions, as the workshop meets them on two platforms.
 *
 * A saved method (`mt_…`) has a draft, written by every save, and immutable
 * published versions numbered from 1. A method id may carry a version suffix:
 * `mt_abc@3` names version 3, `mt_abc@draft` the draft, and a bare `mt_abc`
 * the latest published version. The method routes (`mthds_save_method`,
 * `mthds_get_method`, `mthds_publish_method`) address the method itself and
 * take the bare id; the run route and the tooling routes take the selector.
 *
 * **The workshop is released before the platform resolves selectors**, so it
 * meets two platforms and must be right on both:
 *
 * - **Without version resolution** (it does not list `method_versions` in
 *   `GET /v1/version`'s `extensions`), a bare id reads the method's stored
 *   content, which IS its draft, and a suffixed id is refused: the run route's
 *   body pattern refuses the `@` with a `422`, and the tooling routes look the
 *   id up literally and miss it with a `404`.
 * - **With version resolution**, a bare id reads the latest published version,
 *   or is refused with a `409` `method_not_published` for a method never
 *   published.
 *
 * **Every selector is sent as it was given, on both.** The workshop never
 * rewrites a selector or refuses one by its own reading of the platform: that
 * reading can be stale while a release reaches the platform's tasks unevenly,
 * and a draft rewritten as the bare id would then read or run the latest
 * published version — every method existing when the platform started
 * resolving versions was published as version 1, so that version almost
 * always differs from an edited draft. A platform that does not resolve a
 * suffix refuses it, loudly, and the refusal's hint says that a bare id reads
 * the draft there.
 *
 * Only `supported` is cached, for ten minutes, in the memory the workshop
 * shares across its tools (`createMethodVersionsMemory`). `unsupported` is
 * asked afresh by every call that depends on it, because it is the answer that
 * goes stale misleadingly: once the platform resolves selectors, a bare id
 * reported as the draft is the published version, for as long as a cached
 * `unsupported` would be believed. A fresh handshake narrows that to the time
 * between the handshake and the request, which a rolling deploy can still
 * stretch while old and new platform tasks answer side by side; a run's
 * acknowledgement catches it there, and a tooling route cannot. `unknown` is
 * never cached either. A handshake is given three seconds, and past that the
 * call reads `unknown`. The answer is asked only for a bare id whose result
 * says what it read, and for a refusal's hint, and a bare id's is asked
 * beside its request, never before it: what is sent never depends on it, so
 * only the result's sentence waits for it.
 *
 * **Unknown says so**: a bare id's result then says it cannot tell which
 * content it read. Each tool's result says which content it ran or read: the draft, a
 * version number, the latest published version, or, for a bare id this server
 * could not place, that it could not tell. A run's start acknowledgement
 * carries `method_version` on a platform that resolves selectors, so a run
 * always says which it ran.
 *
 * This mirrors the webapp's `src/lib/method-versions-support.ts`, without its
 * server-instance concerns: one workshop process serves one user and one base
 * URL.
 */

/** The `GET /v1/version` extension a platform lists once it resolves version selectors. */
export const METHOD_VERSIONS_EXTENSION = "method_versions";

/**
 * `supported`: the platform lists the extension. `unsupported`: it answered
 * without it. `unknown`: the handshake failed or did not answer in time.
 */
export type MethodVersionsSupport = "supported" | "unsupported" | "unknown";

type KnownSupport = Exclude<MethodVersionsSupport, "unknown">;

/** How long `supported` is believed. `unsupported` and `unknown` are never cached. */
export const METHOD_VERSIONS_TTL_MS = 10 * 60_000;

/** How long a caller waits on the handshake before reading `unknown`. */
export const METHOD_VERSIONS_HANDSHAKE_MS = 3_000;

/**
 * The workshop's memory of the platform's answer, shared by every tool of one
 * server. A context without one asks on every call, which is what the hermetic
 * tests do so that no answer leaks from one test into the next.
 */
export interface MethodVersionsMemory {
  cached?: { support: "supported"; expiresAt: number };
  inFlight?: Promise<MethodVersionsSupport>;
  /** Bumped by every forget, so a handshake sent before it cannot restore a contradicted answer. */
  generation: number;
}

export function createMethodVersionsMemory(): MethodVersionsMemory {
  return { generation: 0 };
}

/** What reads `GET /v1/version`: the client's own `version()`. */
export type VersionReader = () => Promise<unknown>;

/**
 * The `version()` of a client, when it has one. A test seam that does not
 * declare it yields none, and the answer is then `unknown` without a request,
 * so a fake client never sends a handshake to a real host.
 */
export function versionReaderOf(client: unknown): VersionReader | undefined {
  if (typeof client !== "object" || client === null) return undefined;
  const version = (client as { version?: unknown }).version;
  if (typeof version !== "function") return undefined;
  return () => (version as () => Promise<unknown>).call(client);
}

/** Whether `GET /v1/version`'s answer lists {@link METHOD_VERSIONS_EXTENSION}. */
function supportOf(info: unknown): KnownSupport {
  const extensions =
    typeof info === "object" && info !== null
      ? (info as { extensions?: unknown }).extensions
      : undefined;
  return Array.isArray(extensions) && extensions.includes(METHOD_VERSIONS_EXTENSION)
    ? "supported"
    : "unsupported";
}

function isFresh(memory: MethodVersionsMemory, now: number): boolean {
  return memory.cached !== undefined && memory.cached.expiresAt > now;
}

function rememberSupported(memory: MethodVersionsMemory): void {
  memory.cached = { support: "supported", expiresAt: Date.now() + METHOD_VERSIONS_TTL_MS };
}

async function askPlatform(
  read: VersionReader,
  memory: MethodVersionsMemory | undefined,
): Promise<MethodVersionsSupport> {
  const askedAt = memory?.generation;
  let support: KnownSupport;
  try {
    support = supportOf(await read());
  } catch {
    return "unknown";
  }
  if (memory === undefined) return support;
  // A run acknowledgement that proved the capability while this handshake was
  // in flight is fresher than its answer, which may come from a platform task a
  // rollout has not reached.
  if (
    support === "unsupported" &&
    memory.cached?.support === "supported" &&
    isFresh(memory, Date.now())
  ) {
    return "supported";
  }
  // A selector refused while this handshake was in flight contradicts its
  // `supported`, which may come from a task a rollback has not reached.
  if (support === "supported" && memory.generation !== askedAt) {
    return isFresh(memory, Date.now()) ? (memory.cached?.support ?? "unknown") : "unknown";
  }
  if (support === "supported") {
    rememberSupported(memory);
  } else {
    memory.cached = undefined;
  }
  return support;
}

function withinDeadline(handshake: Promise<MethodVersionsSupport>): Promise<MethodVersionsSupport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<MethodVersionsSupport>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), METHOD_VERSIONS_HANDSHAKE_MS);
  });
  return Promise.race([handshake, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Whether the platform resolves version selectors, from the memory or one
 * handshake. Never throws: every failure is `unknown`.
 */
export function methodVersionsSupport(
  memory: MethodVersionsMemory | undefined,
  read: VersionReader | undefined,
): Promise<MethodVersionsSupport> {
  if (memory !== undefined && isFresh(memory, Date.now()) && memory.cached !== undefined) {
    return Promise.resolve(memory.cached.support);
  }
  if (read === undefined) return Promise.resolve("unknown");
  if (memory === undefined) return withinDeadline(askPlatform(read, undefined));
  if (memory.inFlight === undefined) {
    const handshake = askPlatform(read, memory);
    const answer = withinDeadline(handshake);
    memory.inFlight = answer;
    // Released when the deadline-bounded ANSWER settles, not the handshake: a
    // handshake that outlives its deadline answered `unknown`, and holding that
    // promise until the request ends would serve `unknown` to every call for
    // the rest of the request, a cached `unknown` in all but name. The
    // handshake still goes on, so a late answer reaches the memory through
    // `askPlatform`; the identity check keeps an old answer from releasing a
    // newer one.
    void answer.finally(() => {
      if (memory.inFlight === answer) memory.inFlight = undefined;
    });
  }
  return memory.inFlight;
}

/** A response proved the capability: a start acknowledgement carrying `method_version`. */
export function noteMethodVersionsSupported(memory: MethodVersionsMemory | undefined): void {
  if (memory !== undefined) rememberSupported(memory);
}

/**
 * A response showed a selector was not resolved, so a cached `supported` is
 * dropped and the next call asks again rather than believing it for ten minutes.
 */
export function forgetMethodVersionsSupported(memory: MethodVersionsMemory | undefined): void {
  if (memory === undefined) return;
  memory.generation += 1;
  if (memory.cached?.support === "supported") memory.cached = undefined;
}

// ── the selector ────────────────────────────────────────────────────

/**
 * A `method_id` as this server reads it. `opaque` is a value that is not a
 * selector in the platform's grammar (`mt_` then letters, digits, `_` or `-`,
 * and at most one `@<n>` or `@draft`): it is passed through untouched, since
 * the id's format beyond non-blank stays the server's to judge.
 */
export type MethodSelector =
  | { form: "bare"; methodId: string }
  | { form: "draft"; methodId: string }
  | { form: "version"; methodId: string; version: number }
  | { form: "opaque"; methodId: string };

/** Read a `method_id` into the bare id and the version it names. Never throws. */
export function readMethodSelector(value: string): MethodSelector {
  let parsed;
  try {
    parsed = parseMethodSelector(value);
  } catch {
    return { form: "opaque", methodId: value };
  }
  if (parsed.version === null) return { form: "bare", methodId: parsed.method_id };
  if (parsed.version === "draft") return { form: "draft", methodId: parsed.method_id };
  return { form: "version", methodId: parsed.method_id, version: parsed.version };
}

/**
 * Which content a call reads, as a result reports it in `method_version`: a
 * version's number, `"draft"`, or `"latest"` for a bare id on a platform that
 * resolves versions, read by a route that does not say which number it read.
 */
export type MethodVersionReport = number | "draft" | "latest";

/** What every by-id `method_id` field description says about the version suffix. */
export const METHOD_ID_SELECTOR_SENTENCE = `A bare id names the method's latest published version, mt_…@draft its draft (what ${WORKSHOP_TOOL_NAMES.saveMethod} wrote) and mt_…@<n> version n; the result says which content was read.`;

/** The run's twin of {@link METHOD_ID_SELECTOR_SENTENCE}. */
export const RUN_METHOD_ID_SELECTOR_SENTENCE = `A bare id runs the method's latest published version, mt_…@draft its draft (what ${WORKSHOP_TOOL_NAMES.saveMethod} wrote) and mt_…@<n> version n; the result says which ran.`;

/** The `method_version` a tooling result carries: the content it read, when this server can tell. */
export const methodVersionReportSchema = z
  .union([z.number().int(), z.enum(["draft", "latest"])])
  .optional()
  .describe(
    'By-id calls only: the content read — a version number, "draft", or "latest" for a bare id the platform resolved to its latest published version without saying which number. Absent when this server could not tell; the summary then says so.',
  );

/** The `method_version` a run result carries: what the run executes. */
export const runMethodVersionSchema = z
  .union([z.number().int(), z.literal("draft")])
  .optional()
  .describe(
    'By-id runs only: what the run executes — the version number, or "draft". A bare id runs the latest published version on a platform that resolves versions, and the draft on one that does not yet.',
  );

/**
 * The context field every capability that reads or runs a saved method by id
 * carries: the workshop's shared memory of the platform's answer.
 */
export interface MethodVersionsAware {
  methodVersions?: MethodVersionsMemory;
}

/** What a by-id call sends, and what it can say about the content it reads. */
export interface SelectorPlan {
  /** The `method_id` to send: the selector exactly as it was given. */
  send: string;
  /** The bare id, for the result's sentences. */
  methodId: string;
  /** What the caller addressed. */
  selector: MethodSelector;
  /**
   * The content the call reads, when this server can tell; `undefined` when it
   * cannot. Settled at once for a suffix. For a bare id whose result says what
   * it read, it waits on the platform's answer, asked when the plan is made and
   * awaited only once the request has its answer: the request never waited
   * for it, since what is sent does not depend on it, and waiting cost every
   * by-id call a handshake, up to its deadline where the platform does not
   * resolve versions and so never caches its answer. Never rejects.
   */
  reads: Promise<MethodVersionReport | undefined>;
  /** Asks the platform, for the hint of a refused suffix; absent when the client cannot. */
  readVersion?: VersionReader;
}

/**
 * Plan a by-id call of a tooling route (`mthds_validate`,
 * `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`) or of a
 * run, where the id alone names what runs. The selector is sent as it was
 * given, always, so the plan is made at once and the request goes out
 * without waiting on the platform.
 *
 * `askSupport` is called for a bare id alone, and only when `needBareReport`
 * is set: what a bare id reads depends on the platform, and the result says
 * which. The run passes it unset, since its acknowledgement says which
 * version it ran. A suffix needs no answer: a platform that reads it reads
 * exactly what it names, and one that does not refuses it.
 */
export function planMethodSelector(
  value: string,
  askSupport: () => Promise<MethodVersionsSupport>,
  options: { needBareReport: boolean },
  readVersion?: VersionReader,
): SelectorPlan {
  const selector = readMethodSelector(value);
  const base = {
    send: value,
    methodId: selector.methodId,
    selector,
    ...(readVersion === undefined ? {} : { readVersion }),
  };
  if (selector.form === "draft") return { ...base, reads: Promise.resolve("draft") };
  if (selector.form === "version") return { ...base, reads: Promise.resolve(selector.version) };
  if (selector.form === "bare" && options.needBareReport) {
    // Caught as well as never rejecting by contract: when the request fails,
    // nothing awaits this answer, and it must not surface as an unhandled
    // rejection.
    const reads = askSupport().then(
      (support): MethodVersionReport | undefined =>
        support === "supported" ? "latest" : support === "unsupported" ? "draft" : undefined,
      () => undefined,
    );
    return { ...base, reads };
  }
  return { ...base, reads: Promise.resolve(undefined) };
}

/**
 * The run's linkage form: files run, and `method_id` beside them only files the
 * run under the method, so it must be the bare id. A suffix would claim a
 * version that did not run; the platform refuses it with a 422, and this says
 * why before anything is sent. This refusal is the linkage form's own rule,
 * true on every platform, and reads nothing of the platform's answer.
 */
export function linkageSuffixError(value: string): ToolError | undefined {
  const selector = readMethodSelector(value);
  if (selector.form !== "draft" && selector.form !== "version") return undefined;
  return {
    class: "input_domain",
    location: "method_id",
    message: `Beside files, method_id only files the run under its method, so it must be the bare id \`${selector.methodId}\`, not \`${value}\`: the files are what runs, and a version suffix would claim a version that did not.`,
    hint: `Pass method_id "${selector.methodId}" to run these files and record the run under the method, or drop files to run \`${value}\` itself.`,
    retryable: false,
  };
}

// ── what a result says ──────────────────────────────────────────────

/** The content a call read, as a noun phrase: "version 3 of `mt_abc`". */
export function methodContentPhrase(methodId: string, reads: MethodVersionReport): string {
  if (reads === "draft") return `the draft of \`${methodId}\``;
  if (reads === "latest") return `the latest published version of \`${methodId}\``;
  return `version ${reads} of \`${methodId}\``;
}

/**
 * The sentence a tooling result carries about the content it read, or
 * `undefined` for an opaque id, which says nothing this server could place.
 * `reads` is the plan's settled answer, and `verb` is the tool's own past
 * tense ("validated", "projected the template from"), so the sentence reads
 * as the tool's.
 */
export function methodContentSentence(
  plan: Pick<SelectorPlan, "selector" | "methodId">,
  reads: MethodVersionReport | undefined,
  verb: string,
): string | undefined {
  if (plan.selector.form === "opaque") return undefined;
  const id = plan.methodId;
  if (reads === undefined) {
    return `This ${verb} \`${id}\` by its bare id, and this server could not ask the platform which content that names: the latest published version on a platform that resolves versions, the draft on one that does not yet. Pass \`${id}@draft\` or \`${id}@<n>\` to say which.`;
  }
  const phrase = methodContentPhrase(id, reads);
  if (plan.selector.form === "bare" && reads === "draft") {
    return `This ${verb} ${phrase}: this platform does not resolve versions yet, so a bare id reads the draft. Once it does, a bare id reads the latest published version, and \`${id}@draft\` the draft.`;
  }
  if (reads === "latest") {
    return `This ${verb} ${phrase}, which is what a bare id names; \`${id}@draft\` names the draft, and \`${id}@<n>\` a fixed version.`;
  }
  return `This ${verb} ${phrase}.`;
}

/** The platform codes that prove it resolved the selector it was sent. */
const SELECTOR_RESOLVED_CODES: ReadonlySet<string> = new Set([
  "method_version_not_found",
  "method_not_published",
]);

/**
 * Whether `err` is a refusal only a platform that resolves selectors sends: a
 * `409` `method_not_published` or a `404` `method_version_not_found`. Either
 * proves the capability, whatever the memory says.
 */
function provesMethodVersions(err: unknown): boolean {
  return (
    err instanceof ApiResponseError &&
    err.code !== undefined &&
    SELECTOR_RESOLVED_CODES.has(err.code)
  );
}

/**
 * How a platform that does not resolve selectors refuses a suffixed id, and
 * how certain that reading is.
 *
 * - `unread`: the run route's body pattern refuses the `@` before any lookup,
 *   with a `422` `validation_failed` naming `method_id`. A platform that
 *   resolves selectors never answers a well-formed one so.
 * - `missed`: the tooling routes look the id up literally and miss it, with a
 *   `404` `not_found`, which a platform that resolves selectors also answers
 *   for a method that does not exist.
 *
 * Any other refusal (a method being deleted, a draft with no source, inputs
 * refused) says nothing about the suffix.
 */
function suffixRefusalOf(err: unknown): "unread" | "missed" | undefined {
  if (!(err instanceof ApiResponseError)) return undefined;
  if (
    err.status === 422 &&
    err.code === "validation_failed" &&
    (err.errors ?? []).some((field) => field.field === "method_id")
  ) {
    return "unread";
  }
  if (err.status === 404 && err.code === "not_found") return "missed";
  return undefined;
}

function neverPublishedHint(methodId: string): string {
  return `\`${methodId}\` has a draft and no published version yet, and a bare id names the latest published version. Address its draft as \`${methodId}@draft\`, or publish it with ${WORKSHOP_TOOL_NAMES.publishMethod} — only when the user asks for a publish.`;
}

/**
 * Read a failed by-id call for what it says about the platform, and word the
 * error accordingly.
 *
 * A version refusal proves the capability, and a never-published one gets a
 * hint naming this method's own draft selector. A suffix the caller addressed
 * (`@draft` or `@<n>`) refused the way a platform that does not resolve
 * suffixes refuses one gets a hint about it:
 *
 * - `unread`, which only such a platform sends, says so plainly, and the
 *   memory forgets a `supported` the refusal contradicts.
 * - `missed` is also how a platform that resolves suffixes answers a method
 *   that does not exist, so it contradicts nothing, and the memory is left as
 *   it is. The platform's answer decides the wording: the one in memory, else
 *   one asked now. Where the platform resolves suffixes the miss is a plain
 *   miss; where it does not, the hint says so, on the condition that the
 *   method exists; where this server cannot tell, it hedges.
 */
export async function noteSelectorRefusal(
  err: unknown,
  error: ToolError,
  plan: SelectorPlan,
  memory: MethodVersionsMemory | undefined,
): Promise<ToolError> {
  if (provesMethodVersions(err)) {
    noteMethodVersionsSupported(memory);
    return err instanceof ApiResponseError && err.code === "method_not_published"
      ? { ...error, hint: neverPublishedHint(plan.methodId) }
      : error;
  }
  const addressed = plan.selector.form === "draft" || plan.selector.form === "version";
  const refusal = addressed ? suffixRefusalOf(err) : undefined;
  if (refusal === undefined) return error;
  const id = plan.methodId;
  if (refusal === "unread") {
    forgetMethodVersionsSupported(memory);
    return {
      ...error,
      hint: `This platform does not resolve version suffixes yet, so it refused \`${plan.send}\`. On it a bare \`${id}\` reads the method's draft.`,
    };
  }
  const support = await methodVersionsSupport(memory, plan.readVersion);
  if (support === "supported") return error;
  const reason =
    support === "unsupported"
      ? `it was not found because this platform does not resolve version suffixes yet; on it a bare \`${id}\` reads the draft.`
      : `this platform may not resolve version suffixes yet; on such a platform a bare \`${id}\` reads the draft.`;
  return { ...error, hint: `${error.hint ?? ""} If \`${id}\` exists, ${reason}`.trim() };
}

// ── the by-id wiring every method-taking tool shares ───────────────

/**
 * Plan a by-id call, asking the platform through `client`'s own `version()`
 * when the plan needs the answer — the one wiring `mthds_validate`,
 * `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs` and
 * `mthds_run` share. The plan is made at once; the answer settles beside the
 * request.
 */
export function planById(
  value: string,
  memory: MethodVersionsMemory | undefined,
  client: unknown,
  options: { needBareReport: boolean },
): SelectorPlan {
  const readVersion = versionReaderOf(client);
  return planMethodSelector(
    value,
    () => methodVersionsSupport(memory, readVersion),
    options,
    readVersion,
  );
}

/** A classified failure of a call that may have been planned: the selector note when it was. */
export async function selectorFailure(
  err: unknown,
  error: ToolError,
  plan: SelectorPlan | undefined,
  memory: MethodVersionsMemory | undefined,
): Promise<ToolError> {
  return plan === undefined ? error : noteSelectorRefusal(err, error, plan, memory);
}

/**
 * A tooling result with the content it came from: `method_version` in its
 * structured content and the closing sentence in its summary, `verb` being the
 * tool's own past tense ("validated"). Unplanned results pass through. This is
 * where a bare id's answer from the platform is awaited, once the request has
 * its own.
 */
export async function withMethodContent<
  R extends { structuredContent: { method_version?: MethodVersionReport }; summary: string },
>(result: R, plan: SelectorPlan | undefined, verb: string): Promise<R> {
  if (plan === undefined) return result;
  const reads = await plan.reads;
  const sentence = methodContentSentence(plan, reads, verb);
  return {
    ...result,
    structuredContent: {
      ...result.structuredContent,
      ...(reads === undefined ? {} : { method_version: reads }),
    },
    summary: sentence === undefined ? result.summary : `${result.summary}\n\n${sentence}`,
  };
}

// ── what a run ran ──────────────────────────────────────────────────

/** A start acknowledgement's `method_version`, or `undefined` when it carries none worth reading. */
function ackVersionOf(value: unknown): number | "draft" | undefined {
  if (value === "draft") return "draft";
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** What a by-id run executes, and the sentence its result carries about it. */
export interface RunContentReport {
  /** The version the run executes, or `"draft"`; absent when nothing can be said. */
  ran?: number | "draft";
  sentence?: string;
  /** The acknowledgement carried `method_version`, which proves the platform resolves selectors. */
  proved: boolean;
  /**
   * A run by bare id was acknowledged with no `method_version`, which only a
   * platform that does not resolve selectors sends: it contradicts a cached
   * `supported`, which the memory then forgets.
   */
  disproved?: true;
}

/**
 * Read what a by-id run executes from its start acknowledgement.
 *
 * A platform that resolves selectors says which version it ran, on every run
 * by id. One that does not says nothing: it refuses any suffix at the start,
 * before a run exists, and runs a bare id as its stored content, which is the
 * draft. So an acknowledgement naming no version still settles a suffix that
 * was accepted: only a platform that resolves it accepts it.
 */
export function runContentReport(plan: SelectorPlan, ackVersion: unknown): RunContentReport {
  const reported = ackVersionOf(ackVersion);
  const id = plan.methodId;
  const proved = reported !== undefined;

  if (reported !== undefined) {
    if (plan.selector.form === "bare" && typeof reported === "number") {
      return {
        ran: reported,
        proved,
        sentence: `It runs ${methodContentPhrase(id, reported)}, the latest published, which is what a bare id runs; \`${id}@draft\` runs the draft.`,
      };
    }
    return { ran: reported, proved, sentence: `It runs ${methodContentPhrase(id, reported)}.` };
  }

  if (plan.selector.form === "opaque") return { proved };
  if (plan.selector.form === "version") {
    return {
      ran: plan.selector.version,
      proved,
      sentence: `It runs ${methodContentPhrase(id, plan.selector.version)}.`,
    };
  }
  if (plan.selector.form === "bare") {
    return {
      ran: "draft",
      proved,
      disproved: true,
      sentence: `It runs the draft of \`${id}\`: the acknowledgement names no version, which is how a platform that does not resolve versions yet answers, and there a bare id runs the draft. Once it does, a bare id runs the latest published version, and \`${id}@draft\` the draft.`,
    };
  }
  return { ran: "draft", proved, sentence: `It runs the draft of \`${id}\`.` };
}
