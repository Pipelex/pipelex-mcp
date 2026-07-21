import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { AuthErrorTexture } from "../capabilities/shared.js";
import type { ToolContexts } from "../tools.js";

/**
 * Bring-your-own-key (BYOK) — the hosted console's interim auth posture until
 * per-user OAuth (the console auth workstream) ships. The public endpoint
 * holds no server-side key; each caller supplies their own `plx_sk_` platform
 * key at the transport level and spends against their own account. Two
 * channels, because remote-connector hosts differ:
 *
 * - `Authorization: Bearer plx_sk_...` header — hosts with header config
 *   (Claude Code, Cursor, Codex, scripted clients).
 * - `?api_key=plx_sk_...` on the connector URL — hosts whose connector UI
 *   accepts only a URL (claude.ai, ChatGPT, Cowork). URLs can end up in
 *   ingress logs; this channel is the documented until-real-auth compromise.
 *
 * The key travels at the transport level only — never as a tool argument, so
 * it never enters the LLM's context. Keyless requests are not rejected here
 * (the handshake must keep working); a keyless tool call fails downstream
 * with an instructive `config` no-verdict pointing at these channels. This
 * module is deliberately disposable: when console OAuth lands, it is deleted,
 * not migrated.
 */

/**
 * The slice of an Express request this module touches. Kept structural
 * because the workspace carries no express type declarations (skybridge's own
 * `import express` resolves untyped); `auth` mirrors the MCP SDK's Express
 * augmentation — the streamable HTTP transport reads `req.auth` and hands it
 * to tool handlers as `extra.authInfo`.
 */
export interface ByokRequest {
  headers: Record<string, string | string[] | undefined>;
  query?: unknown;
  auth?: AuthInfo;
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Extract the caller's API key from the request — `Authorization: Bearer`
 * header first, `?api_key=` query fallback. Returns undefined when neither
 * channel carries a non-blank value.
 */
export function extractRequestApiKey(request: ByokRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const token = BEARER_PATTERN.exec(header.trim())?.[1]?.trim();
    if (token) {
      return token;
    }
  }

  if (typeof request.query === "object" && request.query !== null) {
    const value = (request.query as Record<string, unknown>).api_key;
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return undefined;
}

/**
 * Express middleware on `/mcp`: attach the caller's key as `req.auth` so the
 * MCP SDK transport surfaces it to tool handlers as `extra.authInfo`. Never
 * rejects — a keyless request proceeds and fails instructively at the
 * capability layer, not with a transport 401 the host can't explain.
 */
export function byokKeyMiddleware(request: ByokRequest, _response: unknown, next: () => void) {
  const key = extractRequestApiKey(request);
  if (key !== undefined) {
    request.auth = { token: key, clientId: "byok", scopes: [] };
  }
  next();
}

const SUPPLIED_KEY_AUTH_ERROR: AuthErrorTexture = {
  location: "api_key",
  hint: "The Pipelex API rejected the supplied API key; check it is a valid plx_sk_ platform key for this API.",
};

const MISSING_KEY_AUTH_ERROR: AuthErrorTexture = {
  location: "api_key",
  hint: "This hosted console holds no API key — bring your own: send an `Authorization: Bearer plx_sk_...` header, or append `?api_key=plx_sk_...` to the connector URL. Get a key from your Pipelex account.",
};

/**
 * Derive the per-request capability contexts from the shell's base contexts.
 * A supplied BYOK key overrides the API key everywhere and switches the
 * auth-failure texture to "your key was rejected". Without one, a server-held
 * env key (an operator concern) keeps the default env-var texture; a fully
 * keyless request gets the "bring your own key" texture so the failure
 * explains the channels.
 */
export function contextsForRequest(
  base: ToolContexts,
  authInfo: { token: string } | undefined,
): ToolContexts {
  const key = authInfo?.token;
  if (key !== undefined && key !== "") {
    return overrideContexts(base, key, SUPPLIED_KEY_AUTH_ERROR);
  }
  if (base.validation.apiKey !== undefined) {
    return base;
  }
  return overrideContexts(base, undefined, MISSING_KEY_AUTH_ERROR);
}

function overrideContexts(
  base: ToolContexts,
  apiKey: string | undefined,
  authError: AuthErrorTexture,
): ToolContexts {
  const keyOverride = apiKey === undefined ? {} : { apiKey };
  return {
    validation: { ...base.validation, ...keyOverride, authError },
    inputs: { ...base.inputs, ...keyOverride, authError },
    run: { ...base.run, ...keyOverride, authError },
  };
}
