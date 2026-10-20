import type { MethodTreeLimits } from "mthds";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_MAX_FILE_COUNT,
  FALLBACK_MAX_FILE_SIZE,
  FALLBACK_MAX_TOTAL_SIZE,
  FALLBACK_TREE_LIMITS,
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
      workshopSet: [],
    });
  });

  it("bounds the file count when the deployment announces none", async () => {
    const client = announcing(async () => ({ maxFileSize: 1024, maxTotalSize: 4096 }));

    expect(await methodTreeLimitsOf({ baseUrl: BASE }, () => client)).toEqual({
      maxFileSize: 1024,
      maxTotalSize: 4096,
      maxFileCount: FALLBACK_MAX_FILE_COUNT,
      workshopSet: ["maxFileCount"],
    });
  });

  it("bounds the bytes when the deployment announces only a file count", async () => {
    const client = announcing(async () => ({ maxFileCount: 1000 }));

    expect(await methodTreeLimitsOf({ baseUrl: BASE }, () => client)).toEqual({
      maxFileCount: 1000,
      maxFileSize: FALLBACK_MAX_FILE_SIZE,
      maxTotalSize: FALLBACK_MAX_TOTAL_SIZE,
      workshopSet: ["maxFileSize", "maxTotalSize"],
    });
  });

  it("records every limit as the workshop's own when the handshake failed", () => {
    expect(FALLBACK_TREE_LIMITS.workshopSet).toEqual([
      "maxFileCount",
      "maxFileSize",
      "maxTotalSize",
    ]);
  });

  it("takes the runner's default byte limits as its own", () => {
    // pipelex's api/pipelex_api/limits.py, which the hosted platform defaults to.
    expect(FALLBACK_MAX_FILE_SIZE).toBe(32 * 1024 * 1024);
    expect(FALLBACK_MAX_TOTAL_SIZE).toBe(64 * 1024 * 1024);
  });

  it("never throws: a failed handshake, a client without one or a failing builder take the workshop's own limits", async () => {
    const failing = announcing(async () => {
      throw new Error("unreachable");
    });

    expect(await methodTreeLimitsOf({ baseUrl: BASE }, () => failing)).toEqual(
      FALLBACK_TREE_LIMITS,
    );
    expect(await methodTreeLimitsOf({ baseUrl: BASE }, () => ({}))).toEqual(FALLBACK_TREE_LIMITS);
    expect(
      await methodTreeLimitsOf({ baseUrl: BASE }, () => {
        throw new TypeError("Invalid URL");
      }),
    ).toEqual(FALLBACK_TREE_LIMITS);
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

    expect(await methodTreeLimitsOf({ baseUrl: BASE, treeLimits }, () => client)).toEqual(
      FALLBACK_TREE_LIMITS,
    );
    fail = false;
    expect(await methodTreeLimitsOf({ baseUrl: BASE, treeLimits }, () => client)).toMatchObject({
      maxFileCount: 7,
    });
    expect(client.asks).toBe(2);
  });

  it("stops waiting on a slow handshake and lists under the workshop's own limits", async () => {
    vi.useFakeTimers();
    const client = announcing(() => new Promise<MethodTreeLimits>(() => undefined));

    const limits = methodTreeLimitsOf({ baseUrl: BASE }, () => client);
    await vi.advanceTimersByTimeAsync(TREE_LIMITS_HANDSHAKE_MS);

    expect(await limits).toEqual(FALLBACK_TREE_LIMITS);
  });
});
