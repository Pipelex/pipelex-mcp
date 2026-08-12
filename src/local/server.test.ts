import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MethodData, MthdsFile, PipelexValidationReport } from "@pipelex/sdk";
import type { OAuthConfig } from "skybridge/server";
import { afterEach, describe, expect, it } from "vitest";

import { createHostedServer } from "../hosted/server.js";
import { consoleOnlyToolDefinitions, toolDefinitions } from "../tools.js";
import { buildLocalToolContexts, createLocalServer } from "./server.js";

/**
 * The console requires an `OAuthConfig` — per-user OAuth is its only auth
 * posture. These tests exercise the tool table, not the handshake, so a static
 * stand-in is enough: nothing here issues a `tools/call`, and the JWKS is
 * never fetched.
 */
const TEST_OAUTH: OAuthConfig = {
  oauthMetadata: {
    issuer: "https://test.authkit.app",
    authorization_endpoint: "https://test.authkit.app/oauth2/authorize",
    token_endpoint: "https://test.authkit.app/oauth2/token",
    response_types_supported: ["code"],
  },
  verify: { issuer: "https://test.authkit.app", audience: "https://console.test/" },
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("local stdio server", () => {
  it("registers the shared tool table with the same schemas as the hosted shell", async () => {
    const hostedTools = await listTools(createHostedServer(TEST_OAUTH));
    const localTools = await listTools(createLocalServer());
    const sharedNames: string[] = toolDefinitions.map((definition) => definition.name);

    expect(localTools.map((tool) => tool.name)).toEqual(sharedNames);
    // The contract of every SHARED tool must be byte-identical across shells —
    // no tool name may mean different things on the two deployments.
    expect(localTools.map(sharedContract)).toEqual(
      hostedTools.filter((tool) => sharedNames.includes(tool.name)).map(sharedContract),
    );
  });

  it("registers mthds_list_methods first with its read-only schema and dispatches it", async () => {
    const contexts = buildLocalToolContexts({ PIPELEX_API_KEY: "plx_sk_test" });
    let calls = 0;
    contexts.catalog.client = {
      async listMethods(): Promise<MethodData[]> {
        calls += 1;
        return [catalogMethod];
      },
    };

    const { client, close } = await connectClient(createLocalServer({ contexts }));
    try {
      const listed = await client.listTools();
      const tool = listed.tools[0];
      const inputSchema = tool?.inputSchema as {
        properties?: { limit?: { maximum?: number }; offset?: { minimum?: number } };
      };

      expect(tool?.name).toBe("mthds_list_methods");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(inputSchema.properties?.limit?.maximum).toBe(50);
      expect(inputSchema.properties?.offset?.minimum).toBe(0);

      const result = await client.callTool({
        name: "mthds_list_methods",
        arguments: { query: "invoice" },
      });

      expect(calls).toBe(1);
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        total_count: 1,
        matched_count: 1,
        methods: [{ method_id: "mt_invoice", name: "Invoice extractor" }],
      });
      expect(result._meta).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("registers catalog invocation messages on the hosted shell without a view", async () => {
    const hostedTools = await listTools(createHostedServer(TEST_OAUTH));
    const tool = hostedTools.find((candidate) => candidate.name === "mthds_list_methods");

    expect(tool?._meta).toMatchObject({
      "openai/toolInvocation/invoking": "Listing registered methods...",
      "openai/toolInvocation/invoked": "Registered methods listed.",
    });
    expect(tool?._meta).not.toHaveProperty("ui/resourceUri");
  });

  it("does NOT register the console-only attachment tool (D5)", async () => {
    const hostedTools = await listTools(createHostedServer(TEST_OAUTH));
    const localTools = await listTools(createLocalServer());
    const consoleOnlyNames: string[] = consoleOnlyToolDefinitions.map(
      (definition) => definition.name,
    );

    expect(consoleOnlyNames).toContain("mthds_upload_attachments");
    // Absent, not merely inert: the host gates the attachment substitution on
    // the declared schema and no stdio host performs it, so on the workshop the
    // tool is structurally unreachable. Advertising it would spend every
    // workshop user's tokens on every tools/list for a capability that cannot
    // fire, and would invite the model to attempt it.
    for (const name of consoleOnlyNames) {
      expect(localTools.map((tool) => tool.name)).not.toContain(name);
      expect(hostedTools.map((tool) => tool.name)).toContain(name);
    }
  });

  it("advertises the attachment channel in the hosted instructions only", async () => {
    const { client: hosted, close: closeHosted } = await connectClient(
      createHostedServer(TEST_OAUTH),
    );
    const { client: local, close: closeLocal } = await connectClient(createLocalServer());

    try {
      expect(hosted.getInstructions()).toContain("mthds_upload_attachments");
      expect(local.getInstructions()).not.toContain("mthds_upload_attachments");
    } finally {
      await closeHosted();
      await closeLocal();
    }
  });

  it("names `attachments` in openai/fileParams — the substitution mechanism itself", async () => {
    const hostedTools = await listTools(createHostedServer(TEST_OAUTH));
    const uploadTool = hostedTools.find((tool) => tool.name === "mthds_upload_attachments");

    // Without this key the host never rewrites the model's file reference into
    // the signed-URL object, and the tool is silently inert.
    expect(uploadTool?._meta?.["openai/fileParams"]).toEqual(["attachments"]);
    // The only tool here that reaches outside the configured Pipelex API.
    expect(uploadTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("emits the mandated four-field attachment JSON Schema", async () => {
    const hostedTools = await listTools(createHostedServer(TEST_OAUTH));
    const uploadTool = hostedTools.find((tool) => tool.name === "mthds_upload_attachments");
    const schema = uploadTool?.inputSchema as {
      required?: string[];
      properties?: { attachments?: { items?: Record<string, unknown> } };
    };
    const item = schema.properties?.attachments?.items as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: unknown;
    };

    // This is the JSON Schema OpenAI's app-review "Scan Tools" step reads and
    // the host's runtime substitution gate matches against: exactly these four
    // properties, exactly this required/optional split. A fifth property, a
    // missing one, or a wrongly-required optional fails review AND silently
    // stops the host populating the field. It is un-hotfixable once users have
    // added the connector, so it is pinned here rather than trusted.
    expect(schema.required).toEqual(["attachments"]);
    expect(item.type).toBe("object");
    expect(Object.keys(item.properties ?? {}).sort()).toEqual([
      "download_url",
      "file_id",
      "file_name",
      "mime_type",
    ]);
    expect(item.required).toEqual(["download_url", "file_id"]);
    expect(item).not.toHaveProperty("additionalProperties");
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
      async getMethodClosure() {
        throw new Error("getMethodClosure must not be called in this test");
      },
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

  it("handshakes through the actual stdio entry point without diagnostic output", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(process.cwd(), "src/local/main.ts")],
      cwd: process.cwd(),
      env: { ...process.env, PIPELEX_BASE_URL: "http://127.0.0.1:8081" },
      stderr: "pipe",
    });
    let stderrText = "";
    transport.stderr?.on("data", (chunk) => {
      stderrText += chunk.toString();
    });
    const client = new Client({ name: "pipelex-mcp-stdio-test", version: "0.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();

      expect(listed.tools.map((tool) => tool.name)).toEqual(
        toolDefinitions.map((definition) => definition.name),
      );
      expect(client.getInstructions()).toContain("Prefer the `{ path: string }` file form");
    } finally {
      await client.close();
    }

    expect(stderrText).toBe("");
  }, 10_000);
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

const catalogMethod: MethodData = {
  method_id: "mt_invoice",
  org_id: "org_test",
  created_by_user_id: "usr_test",
  name: "Invoice extractor",
  mthds: 'domain = "invoice"',
  description: "Extract invoice data",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
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
