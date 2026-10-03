/**
 * Client identification: the `User-Agent` this server sends to the Pipelex API.
 *
 * Every call the workshop makes to the API names itself `pipelex-mcp/<version>`,
 * followed by a comment saying that the workshop made it and which AI host
 * drove it, so the platform attributes the call to the `mcp` surface and
 * records the host:
 *
 *   pipelex-mcp/<v> (workshop; host=claude-code/2.1.4) pipelex-sdk-js/<v> node/<v> (darwin; arm64)
 *
 * `@pipelex/sdk` builds the header itself from the `appInfo` this module
 * produces; `createPipelexApiClient` in `./shared.ts` is the one place a client
 * is constructed, and it always passes one. See `docs/client-identification.md`.
 *
 * The host is read lazily, which is why an `AppInfoSource` is a function and not
 * a value: the workshop only learns its host from the MCP `initialize`
 * handshake, after every context has been built.
 *
 * The header is self-declared and unauthenticated — analytics and diagnostics
 * only. It must never carry a secret, a user identifier, an email or a hostname.
 */
import { SDK_VERSION } from "@pipelex/sdk";
import type { AppInfo } from "@pipelex/sdk";

/** This server's product token name, from the client-identification token registry. */
export const MCP_TOKEN_NAME = "pipelex-mcp";

/** The ceiling the spec puts on the whole header value. */
export const MAX_USER_AGENT_LENGTH = 512;

/** The mode the `User-Agent` comment names. */
export type McpMode = "workshop";

/**
 * The server a call came from: its mode, and the version it shipped as. The
 * version is the workshop's own `package.json` version, which it reads and
 * hands in; the core is never released and has no version of its own to
 * report.
 */
export interface McpShell {
  mode: McpMode;
  version: string;
}

/** Produces the `appInfo` for a client being constructed now. */
export type AppInfoSource = () => AppInfo;

/**
 * The identity used when the workshop has not named itself: the e2e suites and
 * the scripts, which call capabilities directly. It still says `pipelex-mcp`, so
 * the platform attributes the call to the right surface. It carries no version,
 * because no released server is making the call, and no comment, because there
 * is no server and no host to report.
 */
export const BARE_APP_INFO: AppInfo = { name: MCP_TOKEN_NAME };

// RFC 9110 §5.6.2 `tchar`. Everything outside it — whitespace, `@`, `;`, `/`,
// parentheses, quotes, non-ASCII — would break the comment or be dropped by the
// platform (a field containing `@` is nulled there).
const NON_TCHAR_RUN = /[^!#$%&'*+\-.^_`|~0-9a-z]+/g;

/**
 * Turn an arbitrary host-supplied string into an RFC 9110 token, per the spec's
 * MCP host-name rule: lowercase it and replace every run of non-`tchar`
 * characters with a single `-`. Leading and trailing `-` left by that
 * replacement are trimmed, so `" Cursor "` becomes `cursor`, not `-cursor-`.
 * Returns `undefined` when nothing of it survives.
 */
export function sanitizeHostPart(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const token = raw
    .toLowerCase()
    .replace(NON_TCHAR_RUN, "-")
    .replace(/^-+|-+$/g, "");
  return token === "" ? undefined : token;
}

/** The slice of MCP's `Implementation` (the `initialize` handshake's `clientInfo`) read here. */
export interface McpClientInfo {
  name?: string;
  version?: string;
}

/**
 * The workshop's `host=` value, from the MCP `clientInfo` the host sent on
 * `initialize`: `<name>/<version>`, both sanitised. A host whose name sanitises
 * to nothing is omitted; a host whose version does is reported by name alone,
 * which the header grammar still admits (`value = token / name "/" version`).
 */
export function workshopHost(clientInfo: McpClientInfo | undefined): string | undefined {
  const name = sanitizeHostPart(clientInfo?.name);
  if (name === undefined) return undefined;
  const version = sanitizeHostPart(clientInfo?.version);
  return version === undefined ? name : `${name}/${version}`;
}

/** The slice of Node's `process` the runtime token is read from. */
export interface RuntimeProcess {
  versions?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
}

/**
 * The `User-Agent` `@pipelex/sdk` sends for this `appInfo` on Node:
 * `<appInfo> pipelex-sdk-js/<sdk version> node/<v> (<os>; <arch>)`. The SDK
 * exports no header builder, so this mirrors it for the one purpose of keeping
 * the header under its ceiling; a test pins it to what the SDK client actually
 * sends, so the two cannot drift apart.
 */
export function userAgentFor(
  appInfo: AppInfo,
  runtime: RuntimeProcess | null = (globalThis.process as RuntimeProcess | undefined) ?? null,
): string {
  const params = [...(appInfo.details ?? [])];
  if (appInfo.url) params.push(`+${appInfo.url}`);
  const product = appInfo.version ? `${appInfo.name}/${appInfo.version}` : appInfo.name;
  const parts = [
    params.length > 0 ? `${product} (${params.join("; ")})` : product,
    `pipelex-sdk-js/${SDK_VERSION}`,
  ];
  const node = runtime?.versions?.node;
  if (node) {
    const platform = [runtime?.platform, runtime?.arch].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    parts.push(platform.length > 0 ? `node/${node} (${platform.join("; ")})` : `node/${node}`);
  }
  return parts.join(" ");
}

/**
 * The `appInfo` for the workshop and its host: `pipelex-mcp/<version> (<mode>; host=<host>)`,
 * the version being the workshop's own. The `host=` parameter is omitted when there
 * is no host, and also when it would push the header past its ceiling — the SDK
 * refuses an over-long `appInfo` at construction, and a host name must never be
 * able to fail a tool call.
 */
export function mcpAppInfo(
  shell: McpShell,
  host: string | undefined,
  runtime?: RuntimeProcess | null,
): AppInfo {
  const bare: AppInfo = { ...BARE_APP_INFO, version: shell.version, details: [shell.mode] };
  if (host === undefined) return bare;
  const withHost: AppInfo = { ...bare, details: [shell.mode, `host=${host}`] };
  return userAgentFor(withHost, runtime).length <= MAX_USER_AGENT_LENGTH ? withHost : bare;
}
