import { workosProvider } from "skybridge/server";

import { createHostedServer } from "./hosted/server.js";
import { buildToolContexts } from "./tools.js";

/**
 * Console auth is a deploy-time switch. With both vars unset the console stays
 * on bring-your-own-key exactly as before; set them and the handshake becomes
 * OAuth. The two postures cannot coexist on `/mcp` — both write `req.auth`,
 * and since no console tool allows anonymous, Skybridge mounts
 * `requireBearerAuth` server-wide the moment an `oauth` config is present,
 * which kills both BYOK channels at the transport. Keeping the switch in env
 * makes rollback an env change rather than a redeploy.
 *
 * `baseUrl` is deliberately not passed: Skybridge then resolves the
 * protected-resource metadata origin per request from `x-forwarded-host`, so
 * the well-known documents follow whatever URL served them. `audience` gets no
 * such treatment — it must byte-match a Resource Indicator registered in the
 * WorkOS dashboard.
 */
const authkitDomain = process.env.WORKOS_AUTHKIT_DOMAIN?.trim();
const resourceIndicator = process.env.PIPELEX_MCP_RESOURCE_INDICATOR?.trim();
const oauth =
  authkitDomain && resourceIndicator
    ? await workosProvider({ domain: authkitDomain, audience: resourceIndicator })
    : undefined;

const server = createHostedServer(buildToolContexts(), oauth);

export default await server.run();

export type AppType = typeof server;
