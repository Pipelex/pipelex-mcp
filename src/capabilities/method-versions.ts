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
 *   content, which IS its draft, and a suffixed id is looked up literally and
 *   refused. There, `mt_abc@draft` is sent as the bare id, which reads the
 *   same draft, and `mt_abc@3` is refused here, since nothing on that platform
 *   can read a version by its id.
 * - **With version resolution**, every selector is sent as it was given, and a
 *   bare id reads the latest published version.
 *
 * Only `supported` is cached, for ten minutes, in the memory the workshop
 * shares across its tools (`createMethodVersionsMemory`). `unsupported` is
 * asked afresh by every call that depends on it, because it is the answer that
 * goes stale dangerously: once the platform resolves selectors, a draft sent as
 * a bare id reads the published version, and a bare id reported as the draft
 * is the published version, and a cached `unsupported` would keep doing both
 * for as long as it was believed. A fresh handshake narrows that to the time
 * between the handshake and the request, which a rolling deploy can still
 * stretch while old and new platform tasks answer side by side; a run's
 * acknowledgement catches it there, and a tooling route cannot. `unknown` is
 * never cached either. A handshake is given three seconds, and past that the
 * call reads `unknown`.
 *
 * **Unknown fails safe**: every selector is then sent as it was given, so a
 * platform that resolves it reads exactly what was addressed and one that does
 * not refuses it, loudly, and nothing reads other content than the caller
 * named. Each tool's result says which content it ran or read: the draft, a
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
  /** The `method_id` to send. */
  send: string;
  /** The bare id, for the result's sentences. */
  methodId: string;
  /** What the caller addressed. */
  selector: MethodSelector;
  /** The content the call reads, when this server can tell; absent when it cannot. */
  reads?: MethodVersionReport;
  /** The platform's answer this plan was made on. */
  support: MethodVersionsSupport;
  /** `@draft` sent as the bare id, because the platform reads its bare id as the draft. */
  translated: boolean;
}

/**
 * A refusal carries its own headline: nothing was sent, so the calling tool's
 * "the Pipelex API rejected the request" would misreport it.
 */
export type PlanOutcome =
  | { ok: true; plan: SelectorPlan }
  | { ok: false; error: ToolError; summary: string };

/**
 * Plan a by-id call of a tooling route (`mthds_validate`,
 * `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`) or of a
 * run, where the id alone names what runs.
 *
 * `askSupport` is only called when the answer changes what is sent or what
 * the result can say: never for an opaque id, and for a bare id only when
 * `needBareReport` is set. The run passes it unset, since its acknowledgement
 * says which version it ran.
 */
export async function planMethodSelector(
  value: string,
  askSupport: () => Promise<MethodVersionsSupport>,
  options: { needBareReport: boolean },
): Promise<PlanOutcome> {
  const selector = readMethodSelector(value);
  const base = { methodId: selector.methodId, selector, translated: false };

  if (selector.form === "opaque") {
    return { ok: true, plan: { ...base, send: value, support: "unknown" } };
  }

  if (selector.form === "bare") {
    if (!options.needBareReport) {
      return { ok: true, plan: { ...base, send: value, support: "unknown" } };
    }
    const support = await askSupport();
    const reads: MethodVersionReport | undefined =
      support === "supported" ? "latest" : support === "unsupported" ? "draft" : undefined;
    return {
      ok: true,
      plan: { ...base, send: value, support, ...(reads === undefined ? {} : { reads }) },
    };
  }

  const support = await askSupport();

  if (selector.form === "draft") {
    // On a platform that reads a bare id as its stored content, that content
    // IS the draft, so the bare id reads exactly what `@draft` names.
    return support === "unsupported"
      ? {
          ok: true,
          plan: { ...base, send: selector.methodId, reads: "draft", support, translated: true },
        }
      : { ok: true, plan: { ...base, send: value, reads: "draft", support } };
  }

  if (support === "unsupported") {
    return {
      ok: false,
      error: versionUnresolvableError(selector.methodId, selector.version),
      summary: `Nothing was sent: this Pipelex platform cannot read \`${value}\` by its id yet.`,
    };
  }
  return { ok: true, plan: { ...base, send: value, reads: selector.version, support } };
}

/**
 * `mt_…@<n>` on a platform that cannot read a version by its id. It is
 * `input_domain`, not `config`, by the spec's test for the class: a request the
 * caller can write — the version's files, pulled — works on this same platform.
 */
function versionUnresolvableError(methodId: string, version: number): ToolError {
  return {
    class: "input_domain",
    location: "method_id",
    message: `This Pipelex platform does not resolve version suffixes yet, so \`${methodId}@${version}\` cannot be read by its id here. Nothing was sent.`,
    hint: `On this platform a bare \`${methodId}\` reads the method's draft. To use version ${version}, pull it with ${WORKSHOP_TOOL_NAMES.getMethod} ({ method_id: "${methodId}@${version}", output_dir }) and pass its files instead.`,
    retryable: false,
  };
}

/**
 * The run's linkage form: files run, and `method_id` beside them only files the
 * run under the method, so it must be the bare id. A suffix would claim a
 * version that did not run; the platform refuses it with a 422, and this says
 * why before anything is sent.
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
 * `verb` is the tool's own past tense ("validated", "projected the template
 * from"), so the sentence reads as the tool's.
 */
export function methodContentSentence(plan: SelectorPlan, verb: string): string | undefined {
  if (plan.selector.form === "opaque") return undefined;
  const id = plan.methodId;
  if (plan.reads === undefined) {
    return `This ${verb} \`${id}\` by its bare id, and this server could not ask the platform which content that names: the latest published version on a platform that resolves versions, the draft on one that does not yet. Pass \`${id}@draft\` or \`${id}@<n>\` to say which.`;
  }
  const phrase = methodContentPhrase(id, plan.reads);
  if (plan.translated) {
    return `This ${verb} ${phrase}. This platform does not resolve version suffixes yet, so the bare id was sent, which reads the draft there.`;
  }
  if (plan.selector.form === "bare" && plan.reads === "draft") {
    return `This ${verb} ${phrase}: this platform does not resolve versions yet, so a bare id reads the draft. Once it does, a bare id reads the latest published version, and \`${id}@draft\` the draft.`;
  }
  if (plan.reads === "latest") {
    return `This ${verb} ${phrase}, which is what a bare id names; \`${id}@draft\` names the draft, and \`${id}@<n>\` a fixed version.`;
  }
  return `This ${verb} ${phrase}.`;
}

/** The platform codes that prove it resolved the selector it was sent. */
const SELECTOR_RESOLVED_CODES: ReadonlySet<string> = new Set([
  "method_version_not_found",
  "method_not_published",
  "method_being_deleted",
]);

/**
 * An error for a request whose suffixed id the platform refused as unknown or
 * malformed, which is also how a platform that does not resolve selectors
 * answers one: the hint says so, and the memory forgets a `supported` that the
 * refusal contradicts. A refusal carrying one of the version codes came from a
 * platform that read the suffix, and is left as it is — unless the call sent
 * `@draft` as the bare id, believing the platform did not resolve suffixes:
 * then the code proves it does, the bare id named the published version, and
 * the hint says to call again with `@draft`.
 */
export function noteSelectorRefusal(
  err: unknown,
  error: ToolError,
  plan: SelectorPlan,
  memory: MethodVersionsMemory | undefined,
): ToolError {
  const resolvedCode =
    err instanceof ApiResponseError &&
    err.code !== undefined &&
    SELECTOR_RESOLVED_CODES.has(err.code);
  if (plan.translated && resolvedCode) {
    noteMethodVersionsSupported(memory);
    return {
      ...error,
      hint: `${error.hint ?? ""} This platform resolves version suffixes now, so the bare \`${plan.methodId}\` sent for the draft named the latest published version: call again with method_id \`${plan.methodId}@draft\`.`.trim(),
    };
  }
  const suffixed = plan.send !== plan.methodId && plan.selector.form !== "opaque";
  if (!suffixed || error.location !== "method_id" || error.class !== "input_domain") {
    return error;
  }
  if (resolvedCode) {
    return error;
  }
  forgetMethodVersionsSupported(memory);
  return {
    ...error,
    hint: `${error.hint ?? ""} If \`${plan.methodId}\` exists, this platform may not resolve version suffixes yet; on such a platform a bare \`${plan.methodId}\` reads the draft.`.trim(),
  };
}

// ── the by-id wiring every method-taking tool shares ───────────────

/**
 * Plan a by-id call, asking the platform through `client`'s own `version()`
 * when the plan needs the answer — the one wiring `mthds_validate`,
 * `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs` and
 * `mthds_run` share.
 */
export function planById(
  value: string,
  memory: MethodVersionsMemory | undefined,
  client: unknown,
  options: { needBareReport: boolean },
): Promise<PlanOutcome> {
  return planMethodSelector(
    value,
    () => methodVersionsSupport(memory, versionReaderOf(client)),
    options,
  );
}

/** A classified failure of a call that may have been planned: the selector note when it was. */
export function selectorFailure(
  err: unknown,
  error: ToolError,
  plan: SelectorPlan | undefined,
  memory: MethodVersionsMemory | undefined,
): ToolError {
  return plan === undefined ? error : noteSelectorRefusal(err, error, plan, memory);
}

/**
 * A tooling result with the content it came from: `method_version` in its
 * structured content and the closing sentence in its summary, `verb` being the
 * tool's own past tense ("validated"). Unplanned results pass through.
 */
export function withMethodContent<
  R extends { structuredContent: { method_version?: MethodVersionReport }; summary: string },
>(result: R, plan: SelectorPlan | undefined, verb: string): R {
  if (plan === undefined) return result;
  const sentence = methodContentSentence(plan, verb);
  return {
    ...result,
    structuredContent: {
      ...result.structuredContent,
      ...(plan.reads === undefined ? {} : { method_version: plan.reads }),
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
}

/**
 * Read what a by-id run executes from its start acknowledgement.
 *
 * A platform that resolves selectors says which version it ran, on every run
 * by id; one that does not says nothing and runs its stored content, which is
 * the draft. A run whose acknowledgement contradicts what was addressed — the
 * draft asked for, a version run — can only come from a bare id sent for
 * `@draft` on a platform this server believed did not resolve versions yet,
 * and which started to in the meantime: the run is already going, so the
 * result says it loudly rather than let it pass as the draft.
 */
export function runContentReport(plan: SelectorPlan, ackVersion: unknown): RunContentReport {
  const reported = ackVersionOf(ackVersion);
  const id = plan.methodId;
  const proved = reported !== undefined;

  if (plan.selector.form === "opaque") {
    return reported === undefined
      ? { proved }
      : { ran: reported, sentence: `It runs ${methodContentPhrase(id, reported)}.`, proved };
  }

  if (reported !== undefined) {
    const asked = plan.reads;
    if (asked !== undefined && asked !== "latest" && asked !== reported) {
      return {
        ran: reported,
        proved,
        sentence:
          asked === "draft"
            ? `WARNING: this run executes ${methodContentPhrase(id, reported)}, NOT the draft you asked for. The platform started resolving versions after this server last checked, so the bare id it was sent for the draft now names the latest published version. Start the run again with method_id \`${id}@draft\` to run the draft.`
            : `WARNING: this run executes ${methodContentPhrase(id, reported)}, not version ${asked} as asked.`,
      };
    }
    if (plan.selector.form === "bare" && typeof reported === "number") {
      return {
        ran: reported,
        proved,
        sentence: `It runs ${methodContentPhrase(id, reported)}, the latest published, which is what a bare id runs; \`${id}@draft\` runs the draft.`,
      };
    }
    return { ran: reported, proved, sentence: `It runs ${methodContentPhrase(id, reported)}.` };
  }

  // The platform said nothing: it does not resolve selectors, and it runs the
  // method's stored content, which is its draft.
  if (plan.selector.form === "version") {
    return {
      ran: plan.selector.version,
      proved,
      sentence: `It runs ${methodContentPhrase(id, plan.selector.version)}.`,
    };
  }
  return {
    ran: "draft",
    proved,
    sentence:
      plan.selector.form === "bare"
        ? `It runs the draft of \`${id}\`: the acknowledgement names no version, which is how a platform that does not resolve versions yet answers, and there a bare id runs the draft. Once it does, a bare id runs the latest published version, and \`${id}@draft\` the draft.`
        : `It runs the draft of \`${id}\`${plan.translated ? ", sent as the bare id, which runs the draft on this platform until it resolves versions" : ""}.`,
  };
}
