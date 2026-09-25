/**
 * `npm run check:tool-texts` — the length gate on the texts a host shows the model.
 *
 * Claude Code cuts MCP server instructions and each tool description at 2,048
 * characters, and at dev `c5e4652` the workshop's instructions reached the
 * model cut mid-word, because nothing measured them. This gate holds every one
 * of those texts to a ceiling below the cap; `src/tool-text-budget.ts` says why
 * the ceiling sits where it does and owns the arithmetic, which the hermetic
 * suite tests.
 *
 * It measures what the two servers actually EMIT, not the source constants:
 * some descriptions are assembled from parts (codegen's target rule is derived
 * from its target profiles), and a host sees only the assembled string. So it
 * builds both shells in process, exactly as the shell tests do,
 * connects a client to each over an in-memory transport, and reads the
 * `instructions` from `initialize` and every `description` from `tools/list`.
 * Nothing here touches the network or a build output, which is why
 * `npm run check` can run it before `build`.
 *
 * Lengths are Unicode code points. It also prints each tool's input and output
 * schema size and the whole `tools/list` payload, as information only: whether
 * those deserve a ceiling depends on which hosts pass `outputSchema` to the
 * model, which nobody has established yet.
 *
 * Exit code: 0 when every text is within the ceiling, 1 otherwise, naming each
 * text over it and by how much.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthConfig } from "skybridge/server";

import { createHostedServer } from "../src/hosted/server.js";
import { createLocalServer } from "../src/local/server.js";
import {
  HOST_TEXT_CAP,
  TOOL_TEXT_CEILING,
  budgetEmittedTexts,
  overCeiling,
} from "../src/tool-text-budget.js";
import type { EmittedText } from "../src/tool-text-budget.js";

// `no-console` is an error in this repo's eslint config; the report is this
// script's whole output. `scripts/smoke.ts` writes the same way.
const say = (text = ""): void => {
  process.stdout.write(`${text}\n`);
};

/**
 * The console requires an `OAuthConfig`, since per-user OAuth is its only auth
 * posture. Only `initialize` and `tools/list` are exchanged here, so a static
 * stand-in is enough and the JWKS is never fetched.
 */
const STAND_IN_OAUTH: OAuthConfig = {
  oauthMetadata: {
    issuer: "https://stand-in.authkit.app",
    authorization_endpoint: "https://stand-in.authkit.app/oauth2/authorize",
    token_endpoint: "https://stand-in.authkit.app/oauth2/token",
    response_types_supported: ["code"],
  },
  verify: { issuer: "https://stand-in.authkit.app", audience: "https://console.stand-in/" },
};

interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
}

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

interface ShellReading {
  shell: string;
  instructions: string;
  tools: ListedTool[];
  /** UTF-8 bytes of the whole `tools/list` result as the host receives it. */
  toolsListBytes: number;
}

/**
 * What a host that renders MCP Apps views declares at `initialize`. The console
 * tailors its instructions per handshake, so each variant is its own emitted
 * text, and the one a views host receives is read through this declaration.
 */
const VIEWS_HOST_CAPABILITIES = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
};

async function readShell(
  shell: string,
  server: ConnectableServer,
  capabilities: ConstructorParameters<typeof Client>[1] = undefined,
): Promise<ShellReading> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "pipelex-mcp-check-tool-texts", version: "0.0.0" },
    capabilities,
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return {
      shell,
      instructions: client.getInstructions() ?? "",
      tools: listed.tools,
      toolsListBytes: jsonBytes(listed),
    };
  } finally {
    await client.close();
    if (server.isConnected()) await server.close();
  }
}

function jsonBytes(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8");
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function label(name: string): string {
  return name === "instructions" ? "server instructions" : `${name} description`;
}

async function main(): Promise<void> {
  const readings = [
    await readShell("console", createHostedServer(STAND_IN_OAUTH)),
    await readShell("workshop", createLocalServer()),
  ];
  // The console's other instructions variant: only the instructions differ,
  // so only they are read off this handshake.
  const viewsHost = await readShell("console (views host)", createHostedServer(STAND_IN_OAUTH), {
    capabilities: VIEWS_HOST_CAPABILITIES,
  });

  const emitted: EmittedText[] = [
    ...readings.flatMap(({ shell, instructions, tools }) => [
      { shell, name: "instructions", text: instructions },
      ...tools.map((tool) => ({ shell, name: tool.name, text: tool.description ?? "" })),
    ]),
    { shell: viewsHost.shell, name: "instructions", text: viewsHost.instructions },
  ];
  const entries = budgetEmittedTexts(emitted);

  say(
    `Model-facing texts, as each shell emits them: ceiling ${formatCount(TOOL_TEXT_CEILING)} ` +
      `code points (Claude Code cuts at ${formatCount(HOST_TEXT_CAP)}).`,
  );
  say();
  say(`${"length".padStart(7)}  ${"headroom".padStart(8)}  ${"shells".padEnd(17)}  text`);
  for (const entry of entries) {
    say(
      `${formatCount(entry.length).padStart(7)}  ${formatCount(entry.headroom).padStart(8)}  ` +
        `${entry.shells.join("+").padEnd(17)}  ${label(entry.name)}`,
    );
  }

  say();
  say("Schema weight in UTF-8 bytes, for information only (no ceiling):");
  say();
  // One row per tool whose schemas both shells emit at the same size, as for the texts.
  const schemaRows = new Map<
    string,
    { name: string; shells: string[]; input: number; output: number }
  >();
  for (const { shell, tools } of readings) {
    for (const tool of tools) {
      const input = jsonBytes(tool.inputSchema);
      const output = jsonBytes(tool.outputSchema);
      const key = `${tool.name}:${input}:${output}`;
      const row = schemaRows.get(key);
      if (row) row.shells.push(shell);
      else schemaRows.set(key, { name: tool.name, shells: [shell], input, output });
    }
  }
  say(`${"input".padStart(7)}  ${"output".padStart(7)}  ${"shells".padEnd(17)}  tool`);
  const sortedRows = [...schemaRows.values()].sort(
    (a, b) => b.input + b.output - (a.input + a.output),
  );
  for (const row of sortedRows) {
    say(
      `${formatCount(row.input).padStart(7)}  ${formatCount(row.output).padStart(7)}  ` +
        `${row.shells.join("+").padEnd(17)}  ${row.name}`,
    );
  }
  say();
  for (const { shell, toolsListBytes } of readings) {
    say(`tools/list payload, ${shell}: ${formatCount(toolsListBytes)} bytes`);
  }

  const over = overCeiling(entries);
  say();
  if (over.length === 0) {
    say(`PASS: every model-facing text is within ${formatCount(TOOL_TEXT_CEILING)} code points.`);
    return;
  }
  say(`FAIL: ${over.length} text(s) over the ${formatCount(TOOL_TEXT_CEILING)} ceiling:`);
  for (const entry of over) {
    say(
      `  ${entry.shells.join("+")} ${label(entry.name)}: ${formatCount(entry.length)} ` +
        `(${formatCount(-entry.headroom)} over)`,
    );
  }
  say();
  say(
    "Move the detail to the layer that owns it rather than raising the ceiling: " +
      "instructions are the map, a description says when to call the tool, a field " +
      "description carries parameter detail, and a result summary carries what matters only " +
      "after the call.",
  );
  process.exitCode = 1;
}

await main();
