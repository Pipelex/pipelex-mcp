/**
 * The console's OAuth stand-in, for the tests that build the console in
 * process and for the repository's `scripts/check-tool-texts.ts`. Never shipped
 * code: no entrypoint imports it, so the console's bundle never reaches it.
 */

import type { OAuthConfig } from "skybridge/server";

/**
 * The console requires an `OAuthConfig` — per-user OAuth is its only auth
 * posture. Its users exercise the tool table, not the handshake, so a static
 * stand-in is enough: nothing issues an authenticated `tools/call`, and the
 * JWKS is never fetched.
 */
export const TEST_OAUTH: OAuthConfig = {
  oauthMetadata: {
    issuer: "https://test.authkit.app",
    authorization_endpoint: "https://test.authkit.app/oauth2/authorize",
    token_endpoint: "https://test.authkit.app/oauth2/token",
    response_types_supported: ["code"],
  },
  verify: { issuer: "https://test.authkit.app", audience: "https://console.test/" },
};
