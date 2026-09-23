/**
 * What the shell tests share: an in-memory MCP client, the console's OAuth
 * stand-in, and the reading of what a shell emits to a host. Never shipped
 * code — no entrypoint imports it, so neither bundle reaches it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthConfig } from "skybridge/server";

import pkg from "../package.json" with { type: "json" };

/**
 * The console requires an `OAuthConfig` — per-user OAuth is its only auth
 * posture. The shell tests exercise the tool table, not the handshake, so a
 * static stand-in is enough: nothing issues an authenticated `tools/call`, and
 * the JWKS is never fetched.
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

export interface TestServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

export async function connectClient(server: TestServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pipelex-mcp-test", version: "0.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    async close() {
      await client.close();
      if (server.isConnected()) await server.close();
    },
  };
}

export async function listTools(server: TestServer): Promise<ListedTool[]> {
  const { client, close } = await connectClient(server);
  try {
    return (await client.listTools()).tools;
  } finally {
    await close();
  }
}

/**
 * Stands in for the package version in a pinned contract. The version is the
 * one field of the handshake that moves on every release, so pinning its value
 * would fail the suite at each `/release`; what is pinned instead is that it
 * IS the package's version, which {@link emittedContract} asserts on the way.
 */
export const PACKAGE_VERSION_PLACEHOLDER = "<package.json version>";

/**
 * Stands in for the origin Skybridge serves view assets from outside a build.
 * With no request to read a host from, it falls back to `localhost` on its own
 * dev port (`__PORT`, default 3000), which the view resources then carry in
 * their CSP. That is a property of the test process, not of the console, so it
 * is replaced rather than pinned.
 */
export const DEV_HOST_PLACEHOLDER = "<skybridge dev host>";

/**
 * Everything a host is shown by a shell before its first tool call: the
 * `initialize` result (server identity, capabilities, instructions), the whole
 * `tools/list` result, and — for a shell that advertises resources, which is
 * the console with its views — the `resources/list` result, where each view's
 * CSP lives. Serialized for a file snapshot.
 *
 * The serialization is the snapshot's format, so it is stable by construction:
 * `JSON.stringify` keeps the emitted key order, which is the order a host
 * receives.
 */
export async function emittedContract(server: TestServer): Promise<string> {
  const { client, close } = await connectClient(server);
  try {
    const serverInfo = client.getServerVersion();
    if (serverInfo?.version !== pkg.version) {
      throw new Error(
        `the handshake reports version ${String(serverInfo?.version)}, not the package's ${pkg.version}`,
      );
    }
    const capabilities = client.getServerCapabilities();
    const contract = {
      initialize: {
        serverInfo: { ...serverInfo, version: PACKAGE_VERSION_PLACEHOLDER },
        capabilities,
        instructions: client.getInstructions(),
      },
      tools: (await client.listTools()).tools,
      ...(capabilities?.resources ? { resources: (await client.listResources()).resources } : {}),
    };
    const devHost = `localhost:${process.env.__PORT || "3000"}`;
    return `${JSON.stringify(contract, null, 2)}\n`.replaceAll(devHost, DEV_HOST_PLACEHOLDER);
  } finally {
    await close();
  }
}
