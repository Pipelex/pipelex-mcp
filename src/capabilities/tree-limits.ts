import type { MethodTreeLimits } from "mthds";

/**
 * The limits a Pipelex deployment holds a method's tree to, as the workshop
 * learns them: `GET /v1/version`'s `limits.method_tree`, read through the
 * SDK's `methodTreeLimits()`, so a folder the platform would refuse is refused
 * while it is listed (`method-tree.ts`), before a file is hashed, and no limit
 * is hardcoded here (the design's open question 7).
 *
 * One answer is kept per base URL, for ten minutes, in a memory every tool of
 * one server shares (`createTreeLimitsMemories`), since the workshop decides
 * its base URL on every call and one platform's limits never stand for
 * another's. Only an answer is kept: a handshake that failed, or took more
 * than three seconds, is asked again by the next call. A failure never fails
 * the call: the listing then holds to the file count alone, and the platform,
 * which enforces its limits whatever a sender read, refuses what is too large.
 *
 * **The file count is always bounded.** A deployment that announces no file
 * count (a bare runner announces no limit at all), or a handshake that failed,
 * still lists at most {@link FALLBACK_MAX_FILE_COUNT} files, so pointing a
 * tool at a home directory costs a refusal rather than a long scan.
 */

/** The most files a listing takes when the deployment announces no file count. */
export const FALLBACK_MAX_FILE_COUNT = 10_000;

/** How long an announced answer is believed. */
export const TREE_LIMITS_TTL_MS = 10 * 60_000;

/** How long a call waits on the handshake before listing with the file count alone. */
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
 * context reaches: the announced ones, with the file count bounded whatever
 * was announced. `client` builds the context's client, called only when no
 * fresh answer is remembered. Never throws.
 */
export async function methodTreeLimitsOf(
  context: TreeLimitsAware & { baseUrl: string },
  client: () => unknown,
): Promise<MethodTreeLimits> {
  return bounded(await announcedLimits(context, client));
}

function bounded(announced: MethodTreeLimits | undefined): MethodTreeLimits {
  return { ...announced, maxFileCount: announced?.maxFileCount ?? FALLBACK_MAX_FILE_COUNT };
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
