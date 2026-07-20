import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { writeStderr } from "./log.js";
import { createLocalServer } from "./server.js";

const server = createLocalServer();
const transport = new StdioServerTransport();
let stopping = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;

  try {
    await server.close();
  } catch (err) {
    writeStderr(`pipelex-mcp failed to shut down after ${signal}: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.connect(transport);
} catch (err) {
  writeStderr(`pipelex-mcp failed to start: ${errorMessage(err)}`);
  process.exitCode = 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
