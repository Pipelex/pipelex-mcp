import pkg from "../../package.json" with { type: "json" };

import {
  consoleHost,
  mcpAppInfo,
  userAgentOf,
} from "@pipelex/mcp-core/capabilities/client-identification.js";
import type {
  AppInfoSource,
  McpShell,
  RequestHeaders,
} from "@pipelex/mcp-core/capabilities/client-identification.js";
import type { AuthErrorTexture } from "@pipelex/mcp-core/capabilities/shared.js";
import { patchHostedApiContexts } from "./tools.js";
import type { HostedToolContexts } from "./tools.js";

/**
 * Per-request capability contexts for the hosted console.
 *
 * The console's auth posture is per-user OAuth and nothing else: the caller
 * signs in with their Pipelex account through WorkOS AuthKit, Skybridge
 * verifies the bearer token against the AuthKit JWKS, and the verified token
 * is what this module lifts into every capability context's `apiKey` — which
 * `@pipelex/sdk` then sends upstream as `Authorization: Bearer`. Identity
 * flows through; the console mints nothing and holds no key of its own.
 *
 * The token rides the transport only — never a tool argument, so it never
 * enters the model's context.
 *
 * Bring-your-own-key is gone. There is no second posture to fall back
 * to, which is why `createHostedServer` requires an `OAuthConfig` and the
 * entrypoint refuses to boot without one: a console that cannot authenticate a
 * caller must not serve, rather than quietly serving with a shared key.
 */

const REJECTED_TOKEN_AUTH_ERROR: AuthErrorTexture = {
  location: "authorization",
  hint: "The Pipelex API rejected this session. It may have expired or been revoked, or your account may not have access to this organization — reconnect the Pipelex connector and sign in again.",
};

/**
 * Texture for the branch that should be unreachable: Skybridge mounts
 * `requireBearerAuth` server-wide whenever an `oauth` config is present (no
 * console tool allows anonymous), so a request without a verified token is
 * rejected at the transport and never reaches a handler. If one ever does, it
 * must fail as a legible `config` no-verdict rather than borrow whatever key
 * the process env happens to carry.
 */
const MISSING_TOKEN_AUTH_ERROR: AuthErrorTexture = {
  location: "authorization",
  hint: "This request carried no verified sign-in. Reconnect the Pipelex connector and sign in with your Pipelex account.",
};

/**
 * "Explicitly no credential" — and it must be the empty string, not
 * `undefined`. `PipelexApiClient`'s constructor reads
 * `options.apiKey ?? process.env.PIPELEX_API_KEY`, so an absent key silently
 * falls back to whatever the deployment's env carries: passing `undefined`
 * here would spend the operator's key on an unauthenticated caller, the exact
 * opposite of failing closed. An empty string is not nullish, so it wins the
 * `??`, and the SDK then guards its header with `if (this.apiKey)` — no
 * `Authorization` goes out, the platform authorizer denies, and the caller
 * gets the intended `config`@`authorization` no-verdict.
 */
const NO_CREDENTIAL = "";

/**
 * Derive the per-request capability contexts from the shell's base contexts.
 * The verified token always overrides the API key everywhere — a server-held
 * `PIPELEX_API_KEY` must never fund a signed-in caller's work, since the key
 * determines the active organization and therefore the whole visible catalog.
 *
 * The request's own headers name the calling AI host: every client built for
 * this request identifies itself as `pipelex-mcp/<v> (console; host=<host>)`,
 * where `<host>` is the coarse `claude` / `openai` read from the connector's
 * `User-Agent` (`consoleHost`), or absent when it names neither. Nothing links
 * a stateless `tools/call` to its `initialize`, so the request is all there is.
 */
export function contextsForRequest(
  base: HostedToolContexts,
  authInfo: { token: string } | undefined,
  requestInfo?: { headers: RequestHeaders },
): HostedToolContexts {
  const appInfo = consoleAppInfoSource(requestInfo?.headers);
  const token = authInfo?.token;
  if (token !== undefined && token !== "") {
    return patchHostedApiContexts(base, {
      apiKey: token,
      authError: REJECTED_TOKEN_AUTH_ERROR,
      appInfo,
    });
  }
  // `apiKey` is set unconditionally — overriding it is the whole point on both
  // branches, which `patchHostedApiContexts` does for every key the patch carries.
  return patchHostedApiContexts(base, {
    apiKey: NO_CREDENTIAL,
    authError: MISSING_TOKEN_AUTH_ERROR,
    appInfo,
  });
}

/**
 * The console as its `User-Agent` names it: the shell and the version it
 * shipped as, read from the console's own package.json, since the console is
 * released on a track of its own.
 */
export const CONSOLE_SHELL: McpShell = { mode: "console", version: pkg.version };

/** The console's identity for one request, computed once and handed to every client it builds. */
export function consoleAppInfoSource(headers: RequestHeaders | undefined): AppInfoSource {
  const appInfo = mcpAppInfo(CONSOLE_SHELL, consoleHost(userAgentOf(headers)));
  return () => appInfo;
}
