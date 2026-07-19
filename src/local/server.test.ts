import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MthdsFile, PipelexValidationReport } from "@pipelex/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { createHostedServer } from "../hosted/server.js";
import { toolDefinitions } from "../tools.js";
import { buildLocalToolContexts, createLocalServer } from "./server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("local stdio server", () => {
  it("registers the same tool names and schemas as the hosted shell", async () => {
    const hostedTools = await listTools(createHostedServer());
    const localTools = await listTools(createLocalServer());

    expect(localTools.map((tool) => tool.name)).toEqual(
      toolDefinitions.map((definition) => definition.name),
    );
    expect(localTools.map(sharedContract)).toEqual(hostedTools.map(sharedContract));
  });

  it("advertises paths as the headline and makes the local resolver available to files tools", async () => {
    const rootDir = await makeTempDir();
    await fs.writeFile(path.join(rootDir, "bundle.mthds"), 'domain = "demo"', "utf8");

    const contexts = buildLocalToolContexts({ PIPELEX_BASE_URL: "http://127.0.0.1:8081" }, rootDir);

    expect(contexts.validation.resolver).toBe(contexts.inputs.resolver);
    expect(contexts.validation.resolver).toBe(contexts.run.resolver);
    expect(contexts.validation.viewsAvailable).toBe(false);
    expect(contexts.run.viewsAvailable).toBe(false);
    await expect(contexts.validation.resolver?.resolve("bundle.mthds")).resolves.toEqual({
      ok: true,
      content: 'domain = "demo"',
    });

    const { client, close } = await connectClient(createLocalServer({ contexts }));
    try {
      expect(client.getInstructions()).toContain("Prefer the `{ path: string }` file form");
      expect(client.getInstructions()).toContain("Inline `{ content: string, uri?: string }`");
      expect(client.getInstructions()).toContain("no views at launch");
    } finally {
      await close();
    }
  });

  it("resolves a path through the registered validation handler without advertising a view", async () => {
    const rootDir = await makeTempDir();
    await fs.writeFile(path.join(rootDir, "bundle.mthds"), 'domain = "demo"', "utf8");

    let submittedFiles: MthdsFile[] | undefined;
    const contexts = buildLocalToolContexts({}, rootDir);
    contexts.validation.client = {
      async validateFiles(files) {
        submittedFiles = files;
        return validReport;
      },
    };

    const { client, close } = await connectClient(createLocalServer({ contexts }));
    try {
      const result = await client.callTool({
        name: "mthds_validate",
        arguments: { files: [{ path: "bundle.mthds" }] },
      });

      expect(submittedFiles).toEqual([{ content: 'domain = "demo"', uri: "bundle.mthds" }]);
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        is_valid: true,
        available_view_specs: [],
      });
      expect(result._meta?.graph_spec).toBeUndefined();
      expect(result.content).toEqual([{ type: "text", text: "# Valid" }]);
    } finally {
      await close();
    }
  });
});

const validReport: PipelexValidationReport = {
  is_valid: true,
  bundle_blueprint: { main_pipe: "main" },
  pipe_io_contracts: { "demo.main": { inputs: {}, output: "Text" } },
  graph_spec: { nodes: [{ id: "demo.main" }] },
  validated_pipes: [],
  pending_signatures: [],
  is_runnable: true,
  message: "ok",
  rendered_markdown: "# Valid",
};

function sharedContract(tool: Awaited<ReturnType<Client["listTools"]>>["tools"][number]) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  };
}

interface TestServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
}

async function listTools(server: TestServer) {
  const { client, close } = await connectClient(server);
  try {
    return (await client.listTools()).tools;
  } finally {
    await close();
  }
}

async function connectClient(server: TestServer) {
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

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-local-server-"));
  tempDirs.push(dir);
  return dir;
}
