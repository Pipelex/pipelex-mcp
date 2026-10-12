/**
 * The one-shot loopback listener the login waits on for the browser to hand
 * back a Pipelex API key, a port of `pipelex login`'s (`loopback.py`).
 *
 * It binds `127.0.0.1`, never `localhost`, which can resolve elsewhere
 * (RFC 8252 §7.3), on a port the system picks, and accepts one thing:
 * `GET /callback` carrying exactly one `state`, equal to the one this login
 * generated, and exactly one non-empty `api_key`. Any other request is answered
 * and ignored, and the wait goes on: a callback whose `state` is missing or
 * different did not come from the page this login opened, since any page open
 * in the browser can send a request to a local port, so its key is discarded.
 *
 * The callback's URL carries the key, so the listener logs nothing, and the
 * pages it serves tell the browser not to cache them nor send them on as a
 * referrer. A connection that sends nothing is dropped after a read timeout,
 * so it cannot hold the listener, and closing the listener closes every
 * connection, a browser's idle keep-alive or speculative socket included, so
 * the command exits as soon as it is done.
 *
 * The page's side of the contract is `pipelex-app/src/lib/cli-login.ts`: it
 * takes `callback_port` from 1 to 65535 and a `state` matching
 * `[A-Za-z0-9._~-]{1,256}`, and redirects to
 * `http://127.0.0.1:<port>/callback?api_key=<key>&state=<state>`.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";

/** The interface the listener binds: the loopback address itself, not `localhost`. */
export const LOOPBACK_HOST = "127.0.0.1";

/** The one path the listener accepts. */
export const CALLBACK_PATH = "/callback";

/** How long one connection may stay silent before it is dropped. */
export const DEFAULT_READ_TIMEOUT_MS = 10_000;

/** Why the listener turned a `/callback` request away. */
export type CallbackRefusal = "state_mismatch" | "no_api_key";

export interface WaitOptions {
  /** How long to wait in all, in milliseconds. */
  timeoutMs: number;
  /** Called with each refused callback, as it is refused, so the terminal can say what the browser was told. */
  onRefusal?: (refusal: CallbackRefusal) => void;
}

export interface LoopbackListener {
  /** The port the system gave the listener. */
  readonly port: number;
  /** This login's `state`, which only the page it opened can echo back. */
  readonly state: string;
  /** Answer requests until a callback carrying this login's `state` hands over a key, or the time runs out. */
  waitForApiKey(options: WaitOptions): Promise<string | undefined>;
  /** Stop listening and close every connection. Idempotent. */
  close(): Promise<void>;
}

export interface ListenerOptions {
  /** How long one connection may stay silent, in milliseconds. */
  readTimeoutMs?: number;
}

/**
 * A fresh unguessable value for one login: 32 random bytes in base64url, 43
 * characters, all inside the page's `[A-Za-z0-9._~-]{1,256}`.
 */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/** Whether two values are equal, compared in constant time once their lengths match. */
function sameState(received: string, expected: string): boolean {
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Open the listener. It listens from now until {@link LoopbackListener.close}. */
export async function openLoopbackListener(
  options: ListenerOptions = {},
): Promise<LoopbackListener> {
  const state = generateState();
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const sockets = new Set<Socket>();
  let received: string | undefined;
  let handedOver: string | undefined;
  let deliver: ((key: string) => void) | undefined;
  let refused: ((refusal: CallbackRefusal) => void) | undefined;

  const server = http.createServer((request, response) => {
    const answer = (status: number, heading: string, body: string, then?: () => void): void => {
      sendPage(response, status, heading, body, then);
    };
    if (request.method !== "GET") {
      answer(405, "Not allowed", "This address only answers the Pipelex login callback.");
      return;
    }
    const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== CALLBACK_PATH) {
      answer(404, "Not found", "This address only answers the Pipelex login callback.");
      return;
    }
    if (received !== undefined) {
      answer(
        409,
        "Already logged in",
        "This login has already received its key. You can close this tab.",
      );
      return;
    }
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || !sameState(states[0], state)) {
      refused?.("state_mismatch");
      answer(
        400,
        "Login refused",
        "This sign-in did not come from the page the login opened, so its key was discarded. Use the link your terminal printed.",
      );
      return;
    }
    const keys = url.searchParams.getAll("api_key");
    if (keys.length !== 1 || keys[0] === "") {
      refused?.("no_api_key");
      answer(
        400,
        "No key received",
        "The sign-in came back without an API key. Try again from the link your terminal printed.",
      );
      return;
    }
    const key = keys[0];
    received = key;
    // The key is handed over once the page is flushed, so closing the
    // listener right after cannot cut the browser's answer short.
    answer(
      200,
      "Logged in",
      "The Pipelex login received your key. You can close this tab and return to your terminal.",
      () => {
        handedOver = key;
        deliver?.(key);
      },
    );
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // A connection that sends nothing, or stops halfway, is dropped once it has
  // been silent this long; the server's own request timeout backs it up.
  server.setTimeout(readTimeoutMs, (socket: Socket) => socket.destroy());
  server.requestTimeout = readTimeoutMs;
  server.headersTimeout = readTimeoutMs;
  // An error on one connection, a reset for instance, must not end the login.
  server.on("clientError", (_err, socket: Socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the login's loopback listener has no port");
  }

  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    state,
    waitForApiKey({ timeoutMs, onRefusal }: WaitOptions): Promise<string | undefined> {
      if (handedOver !== undefined) return Promise.resolve(handedOver);
      return new Promise((resolve) => {
        const finish = (key: string | undefined): void => {
          clearTimeout(timer);
          deliver = undefined;
          refused = undefined;
          resolve(key);
        };
        const timer = setTimeout(() => finish(undefined), timeoutMs);
        deliver = (key) => finish(key);
        refused = onRefusal;
      });
    },
    close(): Promise<void> {
      closing ??= new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

const PAGE_TEMPLATE =
  "<!doctype html><html><head><meta charset='utf-8'><title>Pipelex login</title></head>" +
  "<body style='font-family:system-ui,sans-serif;text-align:center;padding:60px'>" +
  "<h1>{heading}</h1><p>{body}</p></body></html>";

function sendPage(
  response: http.ServerResponse,
  status: number,
  heading: string,
  body: string,
  then?: () => void,
): void {
  const content = Buffer.from(
    PAGE_TEMPLATE.replace("{heading}", heading).replace("{body}", body),
    "utf8",
  );
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(content.length),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  });
  if (then !== undefined) {
    // Once the page is flushed, or once the connection is gone if it never
    // could be: a key the listener accepted is handed over either way.
    let done = false;
    const once = (): void => {
      if (done) return;
      done = true;
      then();
    };
    response.once("finish", once);
    response.once("close", once);
  }
  response.end(content);
}
