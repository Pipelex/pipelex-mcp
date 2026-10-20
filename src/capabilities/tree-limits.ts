import type { MethodTreeLimits, TreeLimit } from "mthds";

/**
 * The limits a Pipelex deployment holds a method's tree to, as the workshop
 * learns them: `GET /v1/version`'s `limits.method_tree`, read through the
 * SDK's `methodTreeLimits()`, so a folder the platform would refuse is refused
 * while it is listed (`method-tree.ts`), before a file is hashed, and no limit
 * is hardcoded here (the design's open question 7). Only `mthds_save_method`
 * holds a folder to them, since only a save sends the whole tree: the
 * method-taking tools list under {@link READING_TREE_LIMITS} alone.
 *
 * One answer is kept per base URL, for ten minutes, in a memory the server's
 * save keeps (`createTreeLimitsMemories`), since the workshop decides
 * its base URL on every call and one platform's limits never stand for
 * another's. Only an answer is kept: a handshake that failed, or took more
 * than three seconds, is asked again by the next call. A failure never fails
 * the call: the listing then holds to the workshop's own limits, and the
 * platform, which enforces its limits whatever a sender read, refuses what is
 * too large for it.
 *
 * **Every limit is always bounded.** A limit the deployment does not announce
 * (a bare runner announces none), or every limit when the handshake failed or
 * timed out, takes the workshop's own value ({@link FALLBACK_TREE_LIMITS}), so
 * pointing a save at a home directory costs a refusal rather than a long scan,
 * and a save never reads an unbounded tree into memory. The byte limits are
 * the runner's defaults, which the hosted platform takes as its own (pipelex's
 * `api/pipelex_api/limits.py`, pipelex-server's `platform/docs/blob-store.md`),
 * so the workshop refuses nothing a default deployment takes. The file count
 * is a scan bound, above the runner's default of 1,000, since a count costs a
 * walk and not memory.
 *
 * **Whose each limit is, is recorded** (`FolderLimits.workshopSet`), so a
 * refusal names the right party: one the deployment announced is the
 * deployment's, and one the workshop set is the workshop's own scan limit,
 * which no deployment asked for.
 */

/** The most files a listing takes when the deployment announces no file count. */
export const FALLBACK_MAX_FILE_COUNT = 10_000;

/** The largest file a listing takes when the deployment announces no file size: the runner's default, 32 MiB. */
export const FALLBACK_MAX_FILE_SIZE = 32 * 1024 * 1024;

/** The most bytes a listing takes in all when the deployment announces no total: the runner's default, 64 MiB. */
export const FALLBACK_MAX_TOTAL_SIZE = 64 * 1024 * 1024;

/** The limits a listing of a method folder is held to, and which of them the workshop set itself. */
export interface FolderLimits extends Required<MethodTreeLimits> {
  /** The limits the deployment announced none for, which the workshop set to its own value. */
  readonly workshopSet: readonly TreeLimit[];
}

const ALL_LIMITS: readonly TreeLimit[] = ["maxFileCount", "maxFileSize", "maxTotalSize"];

/** The workshop's own limits, each standing for one the deployment did not announce. */
export const FALLBACK_TREE_LIMITS: FolderLimits = {
  maxFileCount: FALLBACK_MAX_FILE_COUNT,
  maxFileSize: FALLBACK_MAX_FILE_SIZE,
  maxTotalSize: FALLBACK_MAX_TOTAL_SIZE,
  workshopSet: ALL_LIMITS,
};

/**
 * The one bound a method-taking tool lists a folder under: the workshop's
 * file count, a scan bound. Those tools send only a folder's `.mthds` files
 * and the template files their steps name, judged on their own bounds, so the
 * limits a deployment stores a whole tree under, which only a save sends,
 * never refuse their folder, and no handshake is asked for them.
 */
export const READING_TREE_LIMITS: MethodTreeLimits & {
  readonly workshopSet: readonly TreeLimit[];
} = {
  maxFileCount: FALLBACK_MAX_FILE_COUNT,
  workshopSet: ["maxFileCount"],
};

/** How long an announced answer is believed. */
export const TREE_LIMITS_TTL_MS = 10 * 60_000;

/** How long a call waits on the handshake before listing under the workshop's own limits. */
export const TREE_LIMITS_HANDSHAKE_MS = 3_000;

interface TreeLimitsMemory {
  cached?: { limits: MethodTreeLimits; expiresAt: number };
  inFlight?: Promise<MethodTreeLimits | undefined>;
}

/** The workshop's memory of each platform's announced limits, one per base URL. */
export interface TreeLimitsMemories {
  readonly byBaseUrl: Map<string, TreeLimitsMemory>;
}

export function createTreeLimitsMemories(): TreeLimitsMemories {
  return { byBaseUrl: new Map() };
}

/** The context field of every capability that lists a method folder. */
export interface TreeLimitsAware {
  treeLimits?: TreeLimitsMemories;
}

/** What reads the announced limits: the client's own `methodTreeLimits()`. */
type LimitsReader = () => Promise<MethodTreeLimits>;

/**
 * The `methodTreeLimits()` of a client, when it has one. A test seam that does
 * not declare it yields none, and the listing then holds to the file count
 * without a request, so a fake client never sends a handshake to a real host.
 */
function limitsReaderOf(client: unknown): LimitsReader | undefined {
  if (typeof client !== "object" || client === null) return undefined;
  const read = (client as { methodTreeLimits?: unknown }).methodTreeLimits;
  if (typeof read !== "function") return undefined;
  return () => (read as () => Promise<MethodTreeLimits>).call(client);
}

/**
 * The limits a listing of a method folder is held to on the platform this
 * context reaches: the announced ones, and the workshop's own for each limit
 * the deployment did not announce. `client` builds the context's client,
 * called only when no fresh answer is remembered. Never throws.
 */
export async function methodTreeLimitsOf(
  context: TreeLimitsAware & { baseUrl: string },
  client: () => unknown,
): Promise<FolderLimits> {
  return bounded(await announcedLimits(context, client));
}

function bounded(announced: MethodTreeLimits | undefined): FolderLimits {
  return {
    maxFileCount: announced?.maxFileCount ?? FALLBACK_TREE_LIMITS.maxFileCount,
    maxFileSize: announced?.maxFileSize ?? FALLBACK_TREE_LIMITS.maxFileSize,
    maxTotalSize: announced?.maxTotalSize ?? FALLBACK_TREE_LIMITS.maxTotalSize,
    workshopSet: ALL_LIMITS.filter((limit) => announced?.[limit] === undefined),
  };
}

async function announcedLimits(
  context: TreeLimitsAware & { baseUrl: string },
  client: () => unknown,
): Promise<MethodTreeLimits | undefined> {
  const memory = memoryFor(context.treeLimits, context.baseUrl);
  if (memory?.cached !== undefined && memory.cached.expiresAt > Date.now()) {
    return memory.cached.limits;
  }
  let read: LimitsReader | undefined;
  try {
    read = limitsReaderOf(client());
  } catch {
    return undefined;
  }
  if (read === undefined) return undefined;
  if (memory === undefined) return withinDeadline(ask(read, undefined));
  if (memory.inFlight === undefined) {
    const answer = withinDeadline(ask(read, memory));
    memory.inFlight = answer;
    void answer.finally(() => {
      if (memory.inFlight === answer) memory.inFlight = undefined;
    });
  }
  return memory.inFlight;
}

function memoryFor(
  memories: TreeLimitsMemories | undefined,
  baseUrl: string,
): TreeLimitsMemory | undefined {
  if (memories === undefined) return undefined;
  let memory = memories.byBaseUrl.get(baseUrl);
  if (memory === undefined) {
    memory = {};
    memories.byBaseUrl.set(baseUrl, memory);
  }
  return memory;
}

async function ask(
  read: LimitsReader,
  memory: TreeLimitsMemory | undefined,
): Promise<MethodTreeLimits | undefined> {
  let limits: MethodTreeLimits;
  try {
    limits = await read();
  } catch {
    return undefined;
  }
  if (memory !== undefined) {
    memory.cached = { limits, expiresAt: Date.now() + TREE_LIMITS_TTL_MS };
  }
  return limits;
}

function withinDeadline(
  handshake: Promise<MethodTreeLimits | undefined>,
): Promise<MethodTreeLimits | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), TREE_LIMITS_HANDSHAKE_MS);
  });
  return Promise.race([handshake, deadline]).finally(() => clearTimeout(timer));
}
