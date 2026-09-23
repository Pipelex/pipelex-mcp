import { describe, expect, it } from "vitest";

import { CODEGEN_TARGETS } from "../capabilities/codegen.js";
import {
  FLOW_HEAD_LENGTH,
  TEST_OAUTH,
  connectClient,
  emittedContract,
  listTools,
  sentencesAbout,
} from "../shell-test-support.js";
import { createHostedServer } from "./server.js";

describe("the console's emitted contract", () => {
  /**
   * Everything a remote-connector host is shown, pinned byte for byte. ChatGPT
   * caches a connector's tool list when it is added and never refreshes it, so
   * any change here strands existing installs on the old list until each user
   * re-adds the connector: a diff to this file is a release note, never a
   * formality. Update it with `npx vitest run -u` only for a change you meant.
   */
  it("emits the pinned initialize result and tools/list", async () => {
    await expect(await emittedContract(createHostedServer(TEST_OAUTH))).toMatchFileSnapshot(
      "./console.contract.json",
    );
  });
});

describe("the console's tool table", () => {
  it("registers mthds_show_images", async () => {
    // Named rather than derived: the image tool's whole point is that it is a
    // deliberate gesture available wherever a run is, so dropping it out of the
    // table must fail here and not just change a derived list.
    const names = (await listTools(createHostedServer(TEST_OAUTH))).map((tool) => tool.name);

    expect(names).toContain("mthds_show_images");
  });

  it("does NOT register the tools that need a working directory", async () => {
    const names = (await listTools(createHostedServer(TEST_OAUTH))).map((tool) => tool.name);

    // Absent on the console, not merely inert: it has no working directory to
    // save into or read a bundle from, so these tools could never fire there —
    // advertising them would spend every console user's tokens on every
    // tools/list for nothing.
    for (const name of ["mthds_download_artifacts", "mthds_save_method", "mthds_get_method"]) {
      expect(names).not.toContain(name);
    }
  });

  it("registers catalog invocation messages without a view", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const tool = tools.find((candidate) => candidate.name === "mthds_list_methods");

    expect(tool?._meta).toMatchObject({
      "openai/toolInvocation/invoking": "Listing registered methods...",
      "openai/toolInvocation/invoked": "Registered methods listed.",
    });
    expect(tool?._meta).not.toHaveProperty("ui/resourceUri");
  });

  it("registers mthds_codegen with the target enum, no view, and no default", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const tool = tools.find((candidate) => candidate.name === "mthds_codegen");
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: { target?: { enum?: string[]; default?: unknown } };
    };

    // `target` is the one required field and carries no default: choosing the
    // language is the tool's whole point, and a default would pick one silently.
    expect(schema.required).toEqual(["target"]);
    expect(schema.properties?.target?.enum).toEqual([...CODEGEN_TARGETS]);
    expect(schema.properties?.target).not.toHaveProperty("default");
    // The console advertises output_dir and refuses it instructively rather
    // than silently ignoring it.
    expect(Object.keys(schema.properties ?? {})).toContain("output_dir");
    expect(tool?.description).toContain("output_dir");
    // A plain tool: invocation strings, no view.
    expect(tool?._meta).toMatchObject({
      "openai/toolInvocation/invoking": "Generating typed code for the method...",
      "openai/toolInvocation/invoked": "Typed code generated.",
    });
    expect(tool?._meta).not.toHaveProperty("ui/resourceUri");
    // Destructive although the console cannot write: an annotation says what a
    // tool MAY do, and the name is shared with the workshop's tool that does.
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("names `attachments` in openai/fileParams — the substitution mechanism itself", async () => {
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const uploadTool = tools.find((tool) => tool.name === "mthds_upload_attachments");

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
    const tools = await listTools(createHostedServer(TEST_OAUTH));
    const uploadTool = tools.find((tool) => tool.name === "mthds_upload_attachments");
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

describe("the console's instructions", () => {
  it("open with the order of the steps", async () => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      // A host that cuts keeps the head, so every step is named, in order, early.
      const head = (client.getInstructions() ?? "").slice(0, FLOW_HEAD_LENGTH);
      const positions = FLOW_ORDER.map((tool) => head.indexOf(`\`${tool}\``));

      expect(positions, "every step is named in the head").not.toContain(-1);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    } finally {
      await close();
    }
  });

  it("say that showing a picture is permanent", async () => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      expect(client.getInstructions()).toContain("mthds_show_images");
      expect(client.getInstructions()).toContain("stays in the");
    } finally {
      await close();
    }
  });

  it("name the attachment channel and codegen, and not the workshop's download tool", async () => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      expect(client.getInstructions()).toContain("mthds_upload_attachments");
      expect(client.getInstructions()).toContain("mthds_codegen");
      expect(client.getInstructions()).not.toContain("mthds_download_artifacts");
    } finally {
      await close();
    }
  });

  it("name every source form each selector-taking tool accepts", async () => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      const instructions = client.getInstructions() ?? "";

      for (const tool of SELECTOR_TOOLS) {
        const sentences = sentencesAbout(instructions, tool);

        expect(sentences, `no instruction sentence mentions ${tool}`).not.toEqual("");
        // A sentence that named method_id and left out method_ref told the
        // model a published method could not be validated, templated,
        // prepared or run — so the by-address flow was never offered,
        // although every one of these tools resolves an address server-side.
        expect(sentences, `the ${tool} sentence must name method_ref`).toContain("method_ref");
        expect(sentences, `the ${tool} sentence must name method_id`).toContain("method_id");
      }
    } finally {
      await close();
    }
  });

  it("trigger a catalog search proactively as well as reactively", async () => {
    const { client, close } = await connectClient(createHostedServer(TEST_OAUTH));

    try {
      const catalog = sentencesAbout(client.getInstructions() ?? "", "mthds_list_methods");

      // The reactive triggers, which the workshop shares: the user asked, or
      // named a saved method without its id.
      expect(catalog).toContain("asks what saved methods exist");
      expect(catalog).toContain("without its mt_ id");
      // The proactive one is the console's alone: on a chatbot, discovery is
      // the point.
      expect(catalog).toContain("may fit the task");
    } finally {
      await close();
    }
  });
});

/** The console's flow, in the order its instructions must name it. */
const FLOW_ORDER = [
  "mthds_list_methods",
  "mthds_validate",
  "mthds_inputs_template",
  "mthds_prepare_inputs",
  "mthds_run",
  "mthds_run_status",
  "mthds_run_results",
  "mthds_show_images",
] as const;

/**
 * The console's tools that take a method selector, and whose instruction
 * sentences must therefore name every form they accept — the one-of `files` /
 * `method_ref` / `method_id`.
 */
const SELECTOR_TOOLS = [
  "mthds_validate",
  "mthds_inputs_template",
  "mthds_codegen",
  "mthds_prepare_inputs",
  "mthds_run",
] as const;
