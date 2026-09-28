/**
 * What the shell tests share: an in-memory MCP client and the reading of what
 * a shell emits to a host. Never shipped code — no entrypoint imports it, so
 * neither server's build reaches it. The console's OAuth stand-in lives beside
 * the console (`hosted/test-oauth.ts` there), because it is a Skybridge type
 * and Skybridge belongs to the console alone.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

export interface TestServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/**
 * Connect an in-memory MCP client to a shell. `clientInfo` is what the client
 * declares on `initialize` — the host identity the workshop's `User-Agent`
 * reads — and defaults to a neutral test name. `capabilities` is what it
 * declares it can do, which the console reads to tailor its instructions;
 * absent, the client declares nothing.
 */
export async function connectClient(
  server: TestServer,
  clientInfo: { name: string; version: string } = { name: "pipelex-mcp-test", version: "0.0.0" },
  capabilities?: ClientCapabilities,
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(clientInfo, capabilities === undefined ? undefined : { capabilities });

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
 * The instruction sentences that name one tool, joined.
 *
 * Sentence-level rather than over the whole string, so an assertion about one
 * tool cannot be satisfied by a neighbour's prose; joined rather than asserted
 * per sentence, because a tool may be named twice — once for its selectors and
 * once for something else. The tool name is matched inside its backticks, so
 * `mthds_run` does not match `mthds_run_status`.
 */
export function sentencesAbout(instructions: string, tool: string): string {
  return instructions
    .split(/(?<=\.)\s+/)
    .filter((sentence) => sentence.includes(`\`${tool}\``))
    .join(" ");
}

/** How early a shell's instructions must have named every step of its flow: well inside any host's cut. */
export const FLOW_HEAD_LENGTH = 500;

/**
 * Stands in for the package version in a pinned contract. The version is the
 * one field of the handshake that moves on every release, so pinning its value
 * would fail the suite at each `/release`; what is pinned instead is that it
 * IS the shell's own package version, which {@link emittedContract} asserts on
 * the way.
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
 * receives. `packageVersion` is the version of the package the shell ships in,
 * which each server's test reads from its own `package.json`: the two servers
 * are released on separate tracks.
 */
export async function emittedContract(server: TestServer, packageVersion: string): Promise<string> {
  const { client, close } = await connectClient(server);
  try {
    const serverInfo = client.getServerVersion();
    if (serverInfo?.version !== packageVersion) {
      throw new Error(
        `the handshake reports version ${String(serverInfo?.version)}, not the package's ${packageVersion}`,
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
