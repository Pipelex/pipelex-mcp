/**
 * What the workshop's server tests use: an in-memory MCP client and the
 * reading of what the server emits to a host. Never shipped code — no
 * entrypoint imports it, so the workshop's build never reaches it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface TestServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/**
 * Connect an in-memory MCP client to a server. `clientInfo` is what the client
 * declares on `initialize` — the host identity the workshop's `User-Agent`
 * reads — and defaults to a neutral test name. The client declares no
 * capabilities.
 */
export async function connectClient(
  server: TestServer,
  clientInfo: { name: string; version: string } = { name: "pipelex-mcp-test", version: "0.0.0" },
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(clientInfo);

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

/** How early the server instructions must have named every step of the flow: well inside any host's cut. */
export const FLOW_HEAD_LENGTH = 500;

/**
 * Stands in for the package version in a pinned contract. The version is the
 * one field of the handshake that moves on every release, so pinning its value
 * would fail the suite at each `/release`; what is pinned instead is that it
 * IS the workshop's own package version, which {@link emittedContract} asserts
 * on the way.
 */
export const PACKAGE_VERSION_PLACEHOLDER = "<package.json version>";

/**
 * Everything a host is shown by the server before its first tool call: the
 * `initialize` result (server identity, capabilities, instructions) and the
 * whole `tools/list` result. Serialized for a file snapshot.
 *
 * The serialization is the snapshot's format, so it is stable by construction:
 * `JSON.stringify` keeps the emitted key order, which is the order a host
 * receives. `packageVersion` is the version of the package the server ships
 * in, which its test reads from its own `package.json`.
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
    };
    return `${JSON.stringify(contract, null, 2)}\n`;
  } finally {
    await close();
  }
}
