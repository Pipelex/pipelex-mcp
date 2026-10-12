import http from "node:http";
import net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CALLBACK_PATH, LOOPBACK_HOST, generateState, openLoopbackListener } from "./loopback.js";
import type { CallbackRefusal, LoopbackListener } from "./loopback.js";

const KEY = "plx_sk_from_the_page";
const listeners: LoopbackListener[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
});

async function listen(readTimeoutMs?: number): Promise<LoopbackListener> {
  const listener = await openLoopbackListener(readTimeoutMs === undefined ? {} : { readTimeoutMs });
  listeners.push(listener);
  return listener;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One request to the listener, on a fresh connection, as a browser's redirect makes it. */
function get(port: number, pathAndQuery: string, method = "GET"): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: LOOPBACK_HOST, port, path: pathAndQuery, method, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function callback(params: Record<string, string | string[]>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    for (const one of Array.isArray(value) ? value : [value]) query.append(name, one);
  }
  return `${CALLBACK_PATH}?${query.toString()}`;
}

describe("generateState", () => {
  it("is 32 random bytes in base64url, inside the page's state pattern, and fresh each time", () => {
    const state = generateState();

    expect(state).toMatch(/^[A-Za-z0-9._~-]{1,256}$/);
    expect(Buffer.from(state, "base64url")).toHaveLength(32);
    expect(generateState()).not.toBe(state);
  });
});

describe("the loopback listener", () => {
  it("binds 127.0.0.1 on a port the system picks", async () => {
    const listener = await listen();

    expect(listener.port).toBeGreaterThan(0);
    expect(listener.port).toBeLessThanOrEqual(65_535);
    const socket = net.connect(listener.port, LOOPBACK_HOST);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.destroy();
  });

  it("hands over the key of a callback carrying this login's state, on a page nothing caches", async () => {
    const listener = await listen();
    const waiting = listener.waitForApiKey({ timeoutMs: 5_000 });

    const answer = await get(listener.port, callback({ api_key: KEY, state: listener.state }));

    expect(await waiting).toBe(KEY);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain("Logged in");
    expect(answer.body).not.toContain(KEY);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
  });

  it("keeps a key that arrives before the wait starts", async () => {
    const listener = await listen();

    await get(listener.port, callback({ api_key: KEY, state: listener.state }));

    expect(await listener.waitForApiKey({ timeoutMs: 5_000 })).toBe(KEY);
  });

  it("refuses a wrong, missing or repeated state, discards its key, and goes on waiting", async () => {
    const listener = await listen();
    const refusals: CallbackRefusal[] = [];
    const waiting = listener.waitForApiKey({
      timeoutMs: 5_000,
      onRefusal: (refusal) => refusals.push(refusal),
    });

    const wrong = await get(listener.port, callback({ api_key: "plx_sk_forged", state: "x" }));
    const missing = await get(listener.port, callback({ api_key: "plx_sk_forged" }));
    const repeated = await get(
      listener.port,
      callback({ api_key: "plx_sk_forged", state: [listener.state, "x"] }),
    );
    const longer = await get(
      listener.port,
      callback({ api_key: "plx_sk_forged", state: `${listener.state}x` }),
    );
    await get(listener.port, callback({ api_key: KEY, state: listener.state }));

    expect(await waiting).toBe(KEY);
    for (const answer of [wrong, missing, repeated, longer]) {
      expect(answer.status).toBe(400);
      expect(answer.body).toContain("Login refused");
      expect(answer.headers["cache-control"]).toBe("no-store");
    }
    expect(refusals).toEqual([
      "state_mismatch",
      "state_mismatch",
      "state_mismatch",
      "state_mismatch",
    ]);
  });

  it("refuses a callback without exactly one non-empty key, and goes on waiting", async () => {
    const listener = await listen();
    const refusals: CallbackRefusal[] = [];
    const waiting = listener.waitForApiKey({
      timeoutMs: 5_000,
      onRefusal: (refusal) => refusals.push(refusal),
    });

    const none = await get(listener.port, callback({ state: listener.state }));
    const empty = await get(listener.port, callback({ api_key: "", state: listener.state }));
    const two = await get(
      listener.port,
      callback({ api_key: [KEY, "plx_sk_other"], state: listener.state }),
    );
    await get(listener.port, callback({ api_key: KEY, state: listener.state }));

    expect(await waiting).toBe(KEY);
    for (const answer of [none, empty, two]) {
      expect(answer.status).toBe(400);
      expect(answer.body).toContain("No key received");
    }
    expect(refusals).toEqual(["no_api_key", "no_api_key", "no_api_key"]);
  });

  it("answers another path or method without reading it, and goes on waiting", async () => {
    const listener = await listen();
    const onRefusal = vi.fn();
    const waiting = listener.waitForApiKey({ timeoutMs: 5_000, onRefusal });

    const otherPath = await get(
      listener.port,
      `/elsewhere?api_key=plx_sk_forged&state=${listener.state}`,
    );
    const otherMethod = await get(
      listener.port,
      callback({ api_key: "plx_sk_forged", state: listener.state }),
      "POST",
    );
    await get(listener.port, callback({ api_key: KEY, state: listener.state }));

    expect(await waiting).toBe(KEY);
    expect(otherPath.status).toBe(404);
    expect(otherMethod.status).toBe(405);
    expect(onRefusal).not.toHaveBeenCalled();
  });

  it("keeps the first key and refuses any later callback", async () => {
    const listener = await listen();

    await get(listener.port, callback({ api_key: KEY, state: listener.state }));
    const later = await get(
      listener.port,
      callback({ api_key: "plx_sk_second", state: listener.state }),
    );

    expect(later.status).toBe(409);
    expect(await listener.waitForApiKey({ timeoutMs: 5_000 })).toBe(KEY);
  });

  it("gives up when no key arrives in time", async () => {
    const listener = await listen();

    expect(await listener.waitForApiKey({ timeoutMs: 30 })).toBeUndefined();
  });

  it("writes nothing to the terminal, since the callback's URL carries the key", async () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    try {
      const listener = await listen();
      const waiting = listener.waitForApiKey({ timeoutMs: 5_000 });
      await get(listener.port, callback({ api_key: "plx_sk_forged", state: "x" }));
      await get(listener.port, callback({ api_key: KEY, state: listener.state }));
      await waiting;
      await listener.close();

      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("drops a connection that stays silent past the read timeout", async () => {
    const listener = await listen(50);
    const socket = net.connect(listener.port, LOOPBACK_HOST);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => undefined);

    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("closes a browser's idle keep-alive connection when it stops, so the command can exit", async () => {
    const listener = await listen();
    const waiting = listener.waitForApiKey({ timeoutMs: 5_000 });
    // A browser opens a spare connection ahead of a request it may make, and
    // keeps it open; the listener's read timeout is far longer than this test.
    const spare = net.connect(listener.port, LOOPBACK_HOST);
    spare.on("error", () => undefined);
    await new Promise<void>((resolve) => spare.once("connect", () => resolve()));
    const spareClosed = new Promise<void>((resolve) => spare.once("close", () => resolve()));

    await get(listener.port, callback({ api_key: KEY, state: listener.state }));
    expect(await waiting).toBe(KEY);
    const started = Date.now();
    await listener.close();
    await spareClosed;

    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(get(listener.port, CALLBACK_PATH)).rejects.toThrow();
  });

  it("closes once, however often it is asked to", async () => {
    const listener = await listen();

    await Promise.all([listener.close(), listener.close()]);
    await listener.close();
  });
});
