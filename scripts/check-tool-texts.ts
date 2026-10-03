/**
 * `npm run check:tool-texts` — the length gate on the texts a host shows the model.
 *
 * Claude Code cuts MCP server instructions and each tool description at 2,048
 * characters, and at dev `c5e4652` the workshop's instructions reached the
 * model cut mid-word, because nothing measured them. This gate holds every one
 * of those texts to a ceiling below the cap; `scripts/tool-text-budget.ts` says why
 * the ceiling sits where it does and owns the arithmetic, which the hermetic
 * suite tests.
 *
 * It measures what the workshop actually EMITS, not the source constants:
 * some descriptions are assembled from parts (codegen's target rule is derived
 * from its target profiles), and a host sees only the assembled string. So it
 * builds the server in process, exactly as the shell tests do, connects a
 * client to it over an in-memory transport, and reads the `instructions` from
 * `initialize` and every `description` from `tools/list`.
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

import { createLocalServer } from "../src/server.js";
import {
  HOST_TEXT_CAP,
  TOOL_TEXT_CEILING,
  budgetEmittedTexts,
  overCeiling,
} from "./tool-text-budget.js";
import type { EmittedText } from "./tool-text-budget.js";

// `no-console` is an error in this repo's eslint config; the report is this
// script's whole output. `scripts/smoke.ts` writes the same way.
const say = (text = ""): void => {
  process.stdout.write(`${text}\n`);
};

interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
}

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

interface ServerReading {
  instructions: string;
  tools: ListedTool[];
  /** UTF-8 bytes of the whole `tools/list` result as the host receives it. */
  toolsListBytes: number;
}

async function readServer(server: ConnectableServer): Promise<ServerReading> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pipelex-mcp-check-tool-texts", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return {
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
  const { instructions, tools, toolsListBytes } = await readServer(createLocalServer());

  const emitted: EmittedText[] = [
    { name: "instructions", text: instructions },
    ...tools.map((tool) => ({ name: tool.name, text: tool.description ?? "" })),
  ];
  const entries = budgetEmittedTexts(emitted);

  say(
    `Model-facing texts, as the workshop emits them: ceiling ${formatCount(TOOL_TEXT_CEILING)} ` +
      `code points (Claude Code cuts at ${formatCount(HOST_TEXT_CAP)}).`,
  );
  say();
  say(`${"length".padStart(7)}  ${"headroom".padStart(8)}  text`);
  for (const entry of entries) {
    say(
      `${formatCount(entry.length).padStart(7)}  ${formatCount(entry.headroom).padStart(8)}  ` +
        label(entry.name),
    );
  }

  say();
  say("Schema weight in UTF-8 bytes, for information only (no ceiling):");
  say();
  const schemaRows = tools
    .map((tool) => ({
      name: tool.name,
      input: jsonBytes(tool.inputSchema),
      output: jsonBytes(tool.outputSchema),
    }))
    .sort((a, b) => b.input + b.output - (a.input + a.output));
  say(`${"input".padStart(7)}  ${"output".padStart(7)}  tool`);
  for (const row of schemaRows) {
    say(
      `${formatCount(row.input).padStart(7)}  ${formatCount(row.output).padStart(7)}  ${row.name}`,
    );
  }
  say();
  say(`tools/list payload: ${formatCount(toolsListBytes)} bytes`);

  const over = overCeiling(entries);
  say();
  if (over.length === 0) {
    say(`PASS: every model-facing text is within ${formatCount(TOOL_TEXT_CEILING)} code points.`);
    return;
  }
  say(`FAIL: ${over.length} text(s) over the ${formatCount(TOOL_TEXT_CEILING)} ceiling:`);
  for (const entry of over) {
    say(
      `  ${label(entry.name)}: ${formatCount(entry.length)} ` +
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
