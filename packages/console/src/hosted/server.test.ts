import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  FLOW_HEAD_LENGTH,
  connectClient,
  emittedContract,
  listTools,
  sentencesAbout,
} from "@pipelex/mcp-core/shell-test-support.js";
import pkg from "../../package.json" with { type: "json" };
import {
  HOSTED_SERVER_INSTRUCTIONS,
  HOSTED_SERVER_INSTRUCTIONS_WITHOUT_VIEWS,
  HOSTED_SERVER_INSTRUCTIONS_WITH_VIEWS,
  MCP_APPS_EXTENSION_ID,
  RETIRED_TOOL_MESSAGE,
  RETIRED_TOOL_NAMES,
  createHostedServer,
  hostRendersViews,
  hostedInstructionsFor,
} from "./server.js";
import { TEST_OAUTH } from "./test-oauth.js";
import * as hostedTools from "./tools.js";

describe("the console's emitted contract", () => {
  /**
   * Everything a remote-connector host is shown, pinned byte for byte. ChatGPT
   * caches a connector's tool list when it is added and never refreshes it, so
   * any change here strands existing installs on the old list until each user
   * re-adds the connector: a diff to this file is a release note, never a
   * formality. Update it with `npx vitest run -u` only for a change you meant.
   */
  it("emits the pinned initialize result and tools/list", async () => {
    await expect(
      await emittedContract(createHostedServer(TEST_OAUTH), pkg.version),
    ).toMatchFileSnapshot("./console.contract.json");
  });
});

describe("the console's tool table", () => {
  it("registers every tool definition it exports, and nothing else", async () => {
    // The console registers its tools one by one through Skybridge's typed
    // chain, so a definition added to `tools.ts` without its link in the chain
    // would pass every other check: the snapshot would not move and nothing
    // flags an unused export. Reading the module rather than a list kept beside
    // the chain is what leaves nothing else to forget.
    const defined = Object.values(hostedTools as Record<string, unknown>)
      .filter(isToolDefinition)
      .map((tool) => tool.name);
    const registered = (await listTools(createHostedServer(TEST_OAUTH))).map((tool) => tool.name);

    expect([...registered].sort()).toEqual([...defined].sort());
  });

  it("lists the console's tools, in the order of its flow", async () => {
    const names = (await listTools(createHostedServer(TEST_OAUTH))).map((tool) => tool.name);

    expect(names).toEqual([
      "pipelex_list_methods",
      "pipelex_show_method",
      "pipelex_upload_attachments",
      "pipelex_run",
      "pipelex_run_status",
      "pipelex_run_results",
      "pipelex_show_images",
      "pipelex_request_upload",
    ]);
  });

  it("takes no files anywhere: every method is named by id or by address", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));

    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: object }).properties ?? {};
      expect(Object.keys(properties), tool.name).not.toContain("files");
    }
  });

  it("names none of the workshop's tools in any tool text or schema", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const emitted = JSON.stringify(tools);

    // The console has no validate, template, prepare, codegen or download tool,
    // so a text naming one sends the model to a tool it cannot call.
    expect(emitted).not.toContain("mthds_");
    for (const retired of [
      "validate",
      "inputs_template",
      "prepare_inputs",
      "codegen",
      "download",
    ]) {
      expect(emitted).not.toContain(`pipelex_${retired}`);
    }
  });

  it("registers pipelex_show_images", async () => {
    // Named rather than derived: the image tool's whole point is that it is a
    // deliberate gesture available wherever a run is, so dropping it out of the
    // table must fail here and not just change a derived list.
    const names = (await listTools(createHostedServer(TEST_OAUTH))).map((tool) => tool.name);

    expect(names).toContain("pipelex_show_images");
  });

  it("registers catalog invocation messages without a view", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const tool = tools.find((candidate) => candidate.name === "pipelex_list_methods");

    expect(tool?._meta).toMatchObject({
      "openai/toolInvocation/invoking": "Listing saved methods...",
      "openai/toolInvocation/invoked": "Saved methods listed.",
    });
    expect(tool?._meta).not.toHaveProperty("ui/resourceUri");
  });

  it("registers pipelex_show_method on the run-graph view, reading by id or by address", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const tool = tools.find((candidate) => candidate.name === "pipelex_show_method");
    const schema = tool?.inputSchema as { required?: string[]; properties?: object };

    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "method_id",
      "method_ref",
      "pipe_ref",
    ]);
    // Exactly one of the two selectors is enforced by the capability, which
    // answers instructively; the schema requires neither.
    expect(schema.required ?? []).toEqual([]);
    expect(tool?._meta?.["ui/resourceUri"]).toBe("ui://views/ext-apps/run-graph.html");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("registers pipelex_run on the run-follow view, with pipe_ref and no files", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const tool = tools.find((candidate) => candidate.name === "pipelex_run");
    const schema = tool?.inputSchema as { properties?: object };

    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "inputs",
      "method_id",
      "method_ref",
      "pipe_ref",
    ]);
    expect(tool?._meta?.["ui/resourceUri"]).toBe("ui://views/ext-apps/run-follow.html");
    // Its input walk refuses an upload-needing value by naming the tool that
    // stores an attachment, so the description names it too.
    expect(tool?.description).toContain("pipelex_upload_attachments");
  });

  it("registers pipelex_request_upload for the view alone, with no view of its own", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const tool = tools.find((candidate) => candidate.name === "pipelex_request_upload");
    const schema = tool?.inputSchema as { required?: string[]; properties?: object };

    // App-only, per the MCP Apps standard: a host that honours it keeps the
    // tool off the model's list, and the run-graph view calls it. Losing the
    // key would put a tool the model cannot usefully call in every prompt.
    expect(tool?._meta?.ui).toEqual({ visibility: ["app"] });
    expect(tool?._meta).not.toHaveProperty("ui/resourceUri");
    // Name, type and size — never the bytes.
    expect(schema.required?.sort()).toEqual(["filename", "size"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "content_type",
      "filename",
      "size",
    ]);
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tool?.description).toContain("pipelex_upload_attachments");
  });

  it("lets the run-graph view connect to the bucket an upload grant names", async () => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      const { resources } = await client.listResources();
      const runGraph = resources.find(
        (resource) => resource.uri === "ui://views/ext-apps/run-graph.html",
      );
      const ui = runGraph?._meta?.ui as { csp?: { connectDomains?: string[] } } | undefined;

      // The view is the show tool's now, with the CSP validate's view had.
      expect(runGraph?.name).toBe("pipelex_show_method");
      // The platform signs grants against the GLOBAL S3 host (measured on
      // api-dev); the regional one is allowed too, so a platform that pins its
      // endpoint later does not silently break uploads.
      for (const bucket of ["pipelex-app-dev", "pipelex-app-staging", "pipelex-app-prod"]) {
        expect(ui?.csp?.connectDomains).toContain(`https://${bucket}.s3.amazonaws.com`);
        expect(ui?.csp?.connectDomains).toContain(`https://${bucket}.s3.us-west-2.amazonaws.com`);
      }
    } finally {
      await close();
    }
  });

  it("names `attachments` in openai/fileParams — the substitution mechanism itself", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const uploadTool = tools.find((tool) => tool.name === "pipelex_upload_attachments");

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

  it("keeps the imperative the attachment substitution was measured under", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const description =
      tools.find((tool) => tool.name === "pipelex_upload_attachments")?.description ?? "";

    // The description gates the host's substitution as well as the schema: a
    // defensive wording measurably yields calls with the field omitted. Only
    // the sentence naming the next tools moved with the rename.
    expect(description.startsWith("ALWAYS pass the user's attached file(s) in `attachments`")).toBe(
      true,
    );
    expect(description).toContain(
      "Never construct a URL yourself, and never call this with the field omitted or empty.",
    );
    expect(description).toContain(
      "Fill the returned uris into pipelex_show_method's inputs template and call pipelex_run",
    );
  });

  it("emits the mandated four-field attachment JSON Schema", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const uploadTool = tools.find((tool) => tool.name === "pipelex_upload_attachments");
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
});

describe("a retired tool name", () => {
  /**
   * A ChatGPT install caches the tool list it was added with, so after the
   * rename it still calls the `mthds_*` names. Unregistered, each would fail as
   * an unknown tool, which reads as an outage; the console answers with the
   * one fix instead. Driven through a real client call, because the answer is
   * a middleware in front of the SDK's lookup, which nothing else exercises.
   */
  it.each([...RETIRED_TOOL_NAMES])("answers %s with the re-add instruction", async (name) => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      const result = await client.callTool({ name, arguments: {} });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(text).toBe(RETIRED_TOOL_MESSAGE);
      expect(text).toContain("remove the Pipelex connector and add it again");
    } finally {
      await close();
    }
  });

  it("leaves a current tool name to the SDK", async () => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      // An argument of the wrong type, so the SDK's own input validation
      // answers: proof the call went past the middleware, without reaching
      // the API.
      const result = await client.callTool({
        name: "pipelex_show_method",
        arguments: { method_id: 5 },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
      expect(text).not.toBe(RETIRED_TOOL_MESSAGE);
      expect(text).toContain("method_id");
    } finally {
      await close();
    }
  });

  it("covers every name the console registered before the split", () => {
    expect([...RETIRED_TOOL_NAMES].sort()).toEqual(
      [
        "mthds_codegen",
        "mthds_inputs_template",
        "mthds_list_methods",
        "mthds_prepare_inputs",
        "mthds_run",
        "mthds_run_results",
        "mthds_run_status",
        "mthds_show_images",
        "mthds_upload_attachments",
        "mthds_validate",
      ].sort(),
    );
  });
});

describe("the console's instructions", () => {
  /** The instructions a client declaring these capabilities receives. */
  async function instructionsFor(capabilities?: ClientCapabilities): Promise<string> {
    const { client, close } = await connectClient(
      createHostedServer(TEST_OAUTH),
      undefined,
      capabilities,
    );
    try {
      return client.getInstructions() ?? "";
    } finally {
      await close();
    }
  }

  const VIEWS_HOST: ClientCapabilities = {
    extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ["text/html;profile=mcp-app"] } },
  };

  it("uses the Pipelex connector's own name, and never opens with the package name", async () => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      expect(client.getServerVersion()?.name).toBe("pipelex");
      expect(client.getInstructions()?.startsWith("pipelex-mcp is")).toBe(false);
    } finally {
      await close();
    }
  });

  it("open with the order of the steps, in both variants", async () => {
    for (const instructions of [await instructionsFor(), await instructionsFor(VIEWS_HOST)]) {
      // A host that cuts keeps the head, so every step is named, in order, early.
      const head = instructions.slice(0, FLOW_HEAD_LENGTH);
      const positions = FLOW_ORDER.map((tool) => head.indexOf(`\`${tool}\``));

      expect(positions, "every step is named in the head").not.toContain(-1);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("defer to the Pipelex plugin's tools wherever they are present", async () => {
    const instructions = await instructionsFor();

    expect(instructions).toContain("Pipelex plugin's `mthds_*` tools");
    expect(instructions).toContain("different organization");
  });

  it("name no workshop tool, only the plugin's family", async () => {
    for (const instructions of [await instructionsFor(), await instructionsFor(VIEWS_HOST)]) {
      // The one `mthds_` the console says is the plugin's family as a whole.
      expect(instructions.replaceAll("`mthds_*`", "")).not.toContain("mthds_");
    }
  });

  it("say that showing a picture is permanent", async () => {
    const instructions = await instructionsFor();

    expect(instructions).toContain("pipelex_show_images");
    expect(instructions).toContain("stays in the");
  });

  it("name both method references for the tools that take one", async () => {
    const instructions = await instructionsFor();

    for (const tool of ["pipelex_show_method", "pipelex_run"]) {
      const sentences = sentencesAbout(instructions, tool);

      expect(sentences, `the ${tool} sentences must name method_ref`).toContain("method_ref");
      expect(sentences, `the ${tool} sentences must name method_id`).toContain("method_id");
    }
  });

  it("trigger a catalog search proactively as well as reactively", async () => {
    const catalog = sentencesAbout(await instructionsFor(), "pipelex_list_methods");

    // The reactive triggers, which the workshop shares: the user asked, or
    // named a saved method without its id.
    expect(catalog).toContain("asks what saved methods exist");
    expect(catalog).toContain("without its mt_ id");
    // The proactive one is the console's alone: on a chatbot, discovery is
    // the point.
    expect(catalog).toContain("may fit the task");
  });

  it("tell a client declaring nothing that it shows no form", async () => {
    // The default, and the variant the contract snapshot pins: a model told of
    // a form on a host with none would wait for a user with nothing to fill.
    const instructions = await instructionsFor();

    expect(instructions).toBe(HOSTED_SERVER_INSTRUCTIONS_WITHOUT_VIEWS);
    expect(instructions).toContain("shows no views");
    expect(instructions).not.toContain("run twice");
  });

  it("tell a client declaring the MCP Apps extension that the user sees the form", async () => {
    const instructions = await instructionsFor(VIEWS_HOST);

    expect(instructions).toBe(HOSTED_SERVER_INSTRUCTIONS_WITH_VIEWS);
    expect(instructions).toContain("input form with a Run button");
    // The rule on who goes first: the model must not start the run the form
    // is about to start.
    expect(instructions).toContain("run twice");
  });

  it("read the extension's declared types when it lists them", async () => {
    expect(
      await instructionsFor({
        extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ["text/html;profile=other"] } },
      }),
    ).toBe(HOSTED_SERVER_INSTRUCTIONS_WITHOUT_VIEWS);
    expect(await instructionsFor({ extensions: { [MCP_APPS_EXTENSION_ID]: {} } })).toBe(
      HOSTED_SERVER_INSTRUCTIONS_WITH_VIEWS,
    );
  });
});

describe("hostRendersViews", () => {
  it("counts ChatGPT, which renders views without declaring the extension", () => {
    expect(
      hostRendersViews({}, { "user-agent": "openai-mcp/1.0.0 (+https://openai.com/bot)" }),
    ).toBe(true);
  });

  it("counts a client declaring the MCP Apps extension, whatever its user agent", () => {
    expect(
      hostRendersViews(
        { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ["text/html;profile=mcp-app"] } } },
        { "user-agent": "Claude-User" },
      ),
    ).toBe(true);
  });

  it("does not count a client that declares nothing, or declares something malformed", () => {
    expect(hostRendersViews(undefined, undefined)).toBe(false);
    expect(hostRendersViews({}, { "user-agent": "Claude-User" })).toBe(false);
    expect(hostRendersViews({ extensions: null }, undefined)).toBe(false);
    expect(hostRendersViews({ extensions: { [MCP_APPS_EXTENSION_ID]: "yes" } }, undefined)).toBe(
      false,
    );
  });

  it("picks the instructions variant from the answer", () => {
    expect(hostedInstructionsFor(true)).toBe(HOSTED_SERVER_INSTRUCTIONS_WITH_VIEWS);
    expect(hostedInstructionsFor(false)).toBe(HOSTED_SERVER_INSTRUCTIONS_WITHOUT_VIEWS);
    expect(HOSTED_SERVER_INSTRUCTIONS).toBe(HOSTED_SERVER_INSTRUCTIONS_WITHOUT_VIEWS);
  });
});

function isToolDefinition(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === "string" &&
    typeof (value as Record<string, unknown>).handler === "function"
  );
}

/** The console's flow, in the order its instructions must name it. */
const FLOW_ORDER = [
  "pipelex_list_methods",
  "pipelex_show_method",
  "pipelex_upload_attachments",
  "pipelex_run",
  "pipelex_run_status",
  "pipelex_run_results",
  "pipelex_show_images",
] as const;
