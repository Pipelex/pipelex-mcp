import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { errorMessage } from "./capabilities/workspace-boundary.js";
import { writeStderr } from "./log.js";
import { runLoginCommand } from "./login/command.js";
import { createLocalServer } from "./server.js";

// `login` is the one subcommand. A first argument of `login` always runs it,
// its own arguments refused with the usage when they are not `--paste` or
// `--help`, so a mistyped `login --paset` says what is wrong instead of
// starting the server, which would wait silently on standard input. Every
// other argument list starts the stdio server exactly as before, stray
// arguments included, so no host registration that passes some can break.
const [first, ...rest] = process.argv.slice(2);
if (first === "login") {
  try {
    process.exitCode = await runLoginCommand(rest);
  } catch (err) {
    writeStderr(`pipelex-mcp login failed: ${errorMessage(err)}`);
    process.exitCode = 1;
  }
} else {
  await serveStdio();
}

async function serveStdio(): Promise<void> {
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
}
