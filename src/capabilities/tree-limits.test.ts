import type { MethodTreeLimits } from "mthds";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_MAX_FILE_COUNT,
  TREE_LIMITS_HANDSHAKE_MS,
  TREE_LIMITS_TTL_MS,
  createTreeLimitsMemories,
  methodTreeLimitsOf,
} from "./tree-limits.js";

const BASE = "https://api-dev.pipelex.com";

/** A client whose handshake answers `answer`, counting the asks. */
function announcing(answer: () => Promise<MethodTreeLimits>) {
  const client = {
    asks: 0,
    async methodTreeLimits() {
      client.asks += 1;
      return answer();
    },
  };
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("methodTreeLimitsOf", () => {
  it("passes the announced limits through, keeping the announced file count", async () => {
    const client = announcing(async () => ({
      maxFileCount: 1000,
      maxFileSize: 32 * 1024 * 1024,
      maxTotalSize: 64 * 1024 * 1024,
    }));

    expect(await methodTreeLimitsOf({ baseUrl: BASE }, () => client)).toEqual({
      maxFileCount: 1000,
      maxFileSize: 32 * 1024 * 1024,
      maxTotalSize: 64 * 1024 * 1024,
    });
  });

  it("bounds the file count when the deployment announces none", async () => {
    const client = announcing(async () => ({ maxFileSize: 1024 }));

    expect(await methodTreeLimitsOf({ baseUrl: BASE }, () => client)).toEqual({
      maxFileSize: 1024,
      maxFileCount: FALLBACK_MAX_FILE_COUNT,
    });
  });

  it("never throws: a failed handshake, a client without one or a failing builder bound the count alone", async () => {
    const failing = announcing(async () => {
      throw new Error("unreachable");
    });

    expect(await methodTreeLimitsOf({ baseUrl: BASE }, () => failing)).toEqual({
      maxFileCount: FALLBACK_MAX_FILE_COUNT,
    });
    expect(await methodTreeLimitsOf({ baseUrl: BASE }, () => ({}))).toEqual({
      maxFileCount: FALLBACK_MAX_FILE_COUNT,
    });
    expect(
      await methodTreeLimitsOf({ baseUrl: BASE }, () => {
        throw new TypeError("Invalid URL");
      }),
    ).toEqual({ maxFileCount: FALLBACK_MAX_FILE_COUNT });
  });

  it("asks once per base URL while an answer is fresh, and again once it is stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const treeLimits = createTreeLimitsMemories();
    const client = announcing(async () => ({ maxFileCount: 7 }));

    await methodTreeLimitsOf({ baseUrl: BASE, treeLimits }, () => client);
    await methodTreeLimitsOf({ baseUrl: BASE, treeLimits }, () => client);
    expect(client.asks).toBe(1);

    // Another platform's limits never stand for this one's.
    await methodTreeLimitsOf({ baseUrl: "http://localhost:8081", treeLimits }, () => client);
    expect(client.asks).toBe(2);

    vi.setSystemTime(Date.now() + TREE_LIMITS_TTL_MS + 1);
    await methodTreeLimitsOf({ baseUrl: BASE, treeLimits }, () => client);
    expect(client.asks).toBe(3);
  });

  it("keeps only answers, so a failed handshake is asked again by the next call", async () => {
    const treeLimits = createTreeLimitsMemories();
    let fail = true;
    const client = announcing(async () => {
      if (fail) throw new Error("unreachable");
      return { maxFileCount: 7 };
    });

    expect(await methodTreeLimitsOf({ baseUrl: BASE, treeLimits }, () => client)).toEqual({
      maxFileCount: FALLBACK_MAX_FILE_COUNT,
    });
    fail = false;
    expect(await methodTreeLimitsOf({ baseUrl: BASE, treeLimits }, () => client)).toEqual({
      maxFileCount: 7,
    });
    expect(client.asks).toBe(2);
  });

  it("stops waiting on a slow handshake and lists under the file count alone", async () => {
    vi.useFakeTimers();
    const client = announcing(() => new Promise<MethodTreeLimits>(() => undefined));

    const limits = methodTreeLimitsOf({ baseUrl: BASE }, () => client);
    await vi.advanceTimersByTimeAsync(TREE_LIMITS_HANDSHAKE_MS);

    expect(await limits).toEqual({ maxFileCount: FALLBACK_MAX_FILE_COUNT });
  });
});
