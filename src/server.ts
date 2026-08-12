import { workosProvider } from "skybridge/server";

import { createHostedServer } from "./hosted/server.js";
import { buildToolContexts } from "./tools.js";

/**
 * Console auth is per-user OAuth, and only that. Both vars are required: with
 * either unset the server refuses to boot rather than serving unauthenticated
 * (there is no second posture left to fall back to since bring-your-own-key
 * was removed, and falling back to a server-held key would fund
 * every anonymous caller's work from one account). A half-configured deploy
 * therefore fails loudly at startup instead of advertising metadata for an
 * unregistered audience.
 *
 * `baseUrl` is deliberately not passed: Skybridge then resolves the
 * protected-resource metadata origin per request from `x-forwarded-host`, so
 * the well-known documents follow whatever URL served them. `audience` gets no
 * such treatment — it must byte-match a Resource Indicator registered in the
 * WorkOS dashboard (the server ORIGIN with a trailing slash, not `/mcp`).
 */
const authkitDomain = process.env.WORKOS_AUTHKIT_DOMAIN?.trim();
const resourceIndicator = process.env.PIPELEX_MCP_RESOURCE_INDICATOR?.trim();

if (!authkitDomain || !resourceIndicator) {
  const missing = [
    authkitDomain ? undefined : "WORKOS_AUTHKIT_DOMAIN",
    resourceIndicator ? undefined : "PIPELEX_MCP_RESOURCE_INDICATOR",
  ].filter((name): name is string => name !== undefined);

  throw new Error(
    `pipelex-mcp hosted console cannot start: missing ${missing.join(" and ")}. ` +
      "The console authenticates every caller through WorkOS AuthKit and has no keyless mode. " +
      "Set WORKOS_AUTHKIT_DOMAIN to the AuthKit domain (e.g. <tenant>.authkit.app) and " +
      "PIPELEX_MCP_RESOURCE_INDICATOR to the server origin with a trailing slash " +
      "(e.g. https://mcp.pipelex.com/), registered as a Resource Indicator in the WorkOS dashboard.",
  );
}

/**
 * A wrong-shaped Resource Indicator boots cleanly and then fails *every* tool
 * call at audience verification — surfacing as the "reconnect and sign in
 * again" hint, which points the operator away from the real cause. The two
 * ways to get it wrong are both mechanical, so catch them here: registering
 * the `/mcp` endpoint instead of the origin, and dropping the trailing slash.
 * The advertised `resource` is the request origin with a trailing slash
 * (`OAuthConfig.baseUrl` is omitted, so Skybridge derives it per request), and
 * the token's `aud` must byte-match it.
 */
const indicatorUrl = URL.parse(resourceIndicator);
if (
  indicatorUrl === null ||
  indicatorUrl.pathname !== "/" ||
  indicatorUrl.search !== "" ||
  indicatorUrl.hash !== "" ||
  !resourceIndicator.endsWith("/")
) {
  throw new Error(
    `pipelex-mcp hosted console cannot start: PIPELEX_MCP_RESOURCE_INDICATOR ` +
      `("${resourceIndicator}") must be the server ORIGIN with a trailing slash and no path, ` +
      `query, or fragment — e.g. https://mcp.pipelex.com/ (not .../mcp, and not without the ` +
      `trailing slash). It must byte-match a Resource Indicator registered in the WorkOS ` +
      "dashboard, because it becomes the issued token's `aud`.",
  );
}

const oauth = await workosProvider({ domain: authkitDomain, audience: resourceIndicator });

const server = createHostedServer(oauth, buildToolContexts());

export default await server.run();

export type AppType = typeof server;
