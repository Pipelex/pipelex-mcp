import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SDK_VERSION } from "@pipelex/sdk";
import type {
  CodegenResponse,
  MethodPage,
  MthdsFile,
  PipelexValidationReport,
  PipelexValidationResult,
} from "@pipelex/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recordedTsZodReport } from "./capabilities/codegen-fixture.js";
import { CODEGEN_TARGETS } from "./capabilities/codegen.js";
import { GRAPH_PAGE_FILENAME } from "./capabilities/graph-page.js";
import {
  FLOW_HEAD_LENGTH,
  connectClient,
  emittedContract,
  listTools,
  sentencesAbout,
} from "./shell-test-support.js";
import pkg from "../package.json" with { type: "json" };
import { LOGIN_USAGE } from "./login/command.js";
import { LOCAL_SERVER_INFO, createLocalServer } from "./server.js";
import * as localTools from "./tools.js";
import { buildLocalToolContexts, localToolDefinitions } from "./tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("the workshop's emitted contract", () => {
  /**
   * Everything a coding-agent host is shown, pinned byte for byte. The
   * plugin's skills call these tools by name and read these schemas, so a diff
   * to this file is a contract change, never a formality. Update it with
   * `npx vitest run -u` only for a change you meant.
   */
  it("emits the pinned initialize result and tools/list", async () => {
    await expect(await emittedContract(createLocalServer(), pkg.version)).toMatchFileSnapshot(
      "./workshop.contract.json",
    );
  });
});

describe("the workshop's tool table", () => {
  it("registers its own table, in order, and nothing else", async () => {
    const tools = await listTools(createLocalServer());

    expect(tools.map((tool) => tool.name)).toEqual(
      localToolDefinitions.map((definition) => definition.name),
    );
  });

  it("lists every tool definition its module exports", () => {
    // The server registers `localToolDefinitions` in a loop, so a definition
    // exported from `tools.ts` and left out of that array would pass the check
    // above and the snapshot alike. Reading the module's exports, as the
    // console's test does, leaves nothing else to forget.
    const defined = Object.values(localTools as Record<string, unknown>)
      .filter(isToolDefinition)
      .map((tool) => tool.name);

    expect(localToolDefinitions.map((definition) => definition.name).sort()).toEqual(
      [...defined].sort(),
    );
  });

  it("registers the tools that need a working directory: download, save and get", async () => {
    const names = (await listTools(createLocalServer())).map((tool) => tool.name);

    // The console has none of these; each writes under, or reads from, the
    // directory this server was started in.
    for (const name of ["mthds_download_artifacts", "mthds_save_method", "mthds_get_method"]) {
      expect(names).toContain(name);
    }
  });

  it("gives the artifact download tool its write annotations and its two arguments", async () => {
    const tools = await listTools(createLocalServer());
    const downloadTool = tools.find((tool) => tool.name === "mthds_download_artifacts");

    // It writes files, so it is not read-only; it only talks to the configured API.
    expect(downloadTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    const schema = downloadTool?.inputSchema as { required?: string[]; properties?: object };
    expect(schema.required).toEqual(["run_id"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["dir", "run_id"]);
  });

  it("registers mthds_publish_method as a catalog write that takes the draft token", async () => {
    const tools = await listTools(createLocalServer());
    const tool = tools.find((candidate) => candidate.name === "mthds_publish_method");

    // It changes what every caller of the method's bare id runs, which cannot
    // be taken back (a version is never removed), so it is destructive; it only
    // talks to the configured API.
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    const schema = tool?.inputSchema as { required?: string[]; properties?: object };
    expect(schema.required?.sort()).toEqual(["expected_draft_updated_at", "method_id"]);
    expect(tool?.description).toMatch(/only when the user asks/i);
  });

  it("registers mthds_show_images as a read that writes nothing", async () => {
    const tools = await listTools(createLocalServer());

    // Named rather than derived: the image tool's whole point is that it is a
    // deliberate gesture available wherever a run is, so dropping it out of the
    // table must fail here and not just change a derived list.
    const tool = tools.find((candidate) => candidate.name === "mthds_show_images");

    // It writes nothing anywhere; what it changes is the conversation, which
    // is what the description says. The link it fetches is the configured
    // API's own answer, so the world stays closed.
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    const schema = tool?.inputSchema as { required?: string[]; properties?: object };
    expect(schema.required).toEqual(["run_id"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["images", "indices", "run_id"]);
  });

  it("does NOT register the console's attachment tool", async () => {
    const names = (await listTools(createLocalServer())).map((tool) => tool.name);

    // Absent, not merely inert: the host gates the attachment substitution on
    // the declared schema and no stdio host performs it, so on the workshop the
    // tool is structurally unreachable. Advertising it would spend every
    // workshop user's tokens on every tools/list for a capability that cannot
    // fire, and would invite the model to attempt it.
    expect(names).not.toContain("mthds_upload_attachments");
  });

  it("does NOT register the console's upload grant tool", async () => {
    const names = (await listTools(createLocalServer())).map((tool) => tool.name);

    // The run form that calls it is a console view, and the workshop has no
    // views: it uploads a local file through the SDK in mthds_prepare_inputs.
    expect(names).not.toContain("pipelex_request_upload");
  });

  it("registers mthds_codegen with the target enum, no default, and the write annotations", async () => {
    const tools = await listTools(createLocalServer());
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
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "files",
      "method_id",
      "method_ref",
      "output_dir",
      "target",
    ]);
    expect(tool?.description).toContain("output_dir");
    // Destructive: regeneration overwrites the stamped files it wrote before,
    // discarding hand-edits below the stamp, and this is the hint a host reads
    // to decide whether to confirm first.
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });
});

describe("the workshop's instructions", () => {
  it("open with the order of the steps", async () => {
    const { client, close } = await connectClient(createLocalServer());

    try {
      // A host that cuts keeps the head. When the workshop's instructions
      // outgrew Claude Code's cut, the step order was what the model lost,
      // so it is the first thing said: every step named, in order, early.
      const head = (client.getInstructions() ?? "").slice(0, FLOW_HEAD_LENGTH);
      const positions = FLOW_ORDER.map((tool) => head.indexOf(`\`${tool}\``));

      expect(positions, "every step is named in the head").not.toContain(-1);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    } finally {
      await close();
    }
  });

  it("say that showing a picture is permanent", async () => {
    const { client, close } = await connectClient(createLocalServer());

    try {
      expect(client.getInstructions()).toContain("mthds_show_images");
      expect(client.getInstructions()).toContain("stays in the");
    } finally {
      await close();
    }
  });

  it("say what a method leaves to whatever calls it", async () => {
    const { client, close } = await connectClient(createLocalServer());

    try {
      // An agent that goes straight to the tools reads no skill, so this is
      // where it learns that "read my mail every morning and post the digest"
      // is a method plus the mail read, the schedule and the post around it.
      const instructions = client.getInstructions() ?? "";

      expect(instructions).toContain("only turns the inputs it is given into results");
      for (const reach of ["mail, drives or business systems", "on a schedule", "writing back"]) {
        expect(instructions).toContain(reach);
      }
    } finally {
      await close();
    }
  });

  it("name the tools only the workshop has, and not the console's", async () => {
    const { client, close } = await connectClient(createLocalServer());

    try {
      expect(client.getInstructions()).toContain("mthds_download_artifacts");
      expect(client.getInstructions()).toContain("mthds_codegen");
      expect(client.getInstructions()).not.toContain("mthds_upload_attachments");
    } finally {
      await close();
    }
  });

  it("name every source form each selector-taking tool accepts", async () => {
    const { client, close } = await connectClient(createLocalServer());

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

  it("trigger a catalog search reactively, never proactively", async () => {
    const { client, close } = await connectClient(createLocalServer());

    try {
      const catalog = sentencesAbout(client.getInstructions() ?? "", "mthds_list_methods");

      // The reactive triggers: the user asked, or named a saved method
      // without its id.
      expect(catalog).toContain("asks what saved methods exist");
      expect(catalog).toContain("without its mt_ id");
      // Not the proactive one, which the console has. A workshop session is
      // driven by skills, and that clause had it leaving unrelated work to
      // search the catalog because a saved method might have fit.
      expect(catalog).not.toContain("may fit the task");
    } finally {
      await close();
    }
  });
});

describe("the workshop's contexts and dispatch", () => {
  it("binds both write roots and the results nudge to the workshop's working directory", async () => {
    const rootDir = await makeTempDir();

    const contexts = buildLocalToolContexts({ PIPELEX_BASE_URL: "http://127.0.0.1:8081" }, rootDir);

    // One validation base — not a second context built from the same parts.
    // Two hand-synced copies diverge the moment a field is added to one, so
    // `mthds_save_method`'s validation leg would quietly stop agreeing with
    // `mthds_validate`. The two differ by `saveRoot` alone, which is what
    // writes the method's graph page: the save's result never reports one.
    const { saveRoot: validationSaveRoot, ...validationBase } = contexts.validation;
    expect(validationBase).toEqual(contexts.catalogWrite.validation);
    expect(contexts.validation.resolver).toBe(contexts.catalogWrite.validation.resolver);
    expect(validationSaveRoot).toBe(rootDir);
    expect(contexts.catalogWrite.validation.saveRoot).toBeUndefined();

    // One working directory, every consumer — the download tool's save root,
    // codegen's `output_dir` root, the catalog pull's write root and the graph
    // page's root (above).
    expect(contexts.artifacts.saveRoot).toBe(rootDir);
    expect(contexts.codegen.saveRoot).toBe(rootDir);
    expect(contexts.catalogWrite.saveRoot).toBe(rootDir);
  });

  it("registers mthds_list_methods first with its read-only schema and dispatches it", async () => {
    const contexts = buildLocalToolContexts({ PIPELEX_API_KEY: "plx_sk_test" });
    let calls = 0;
    contexts.catalog.client = {
      async listMethods(): Promise<MethodPage> {
        calls += 1;
        return { items: [catalogMethod], nextCursor: null };
      },
    };

    const { client, close } = await connectClient(createLocalServer({ contexts }));
    try {
      const listed = await client.listTools();
      const tool = listed.tools[0];
      const inputSchema = tool?.inputSchema as {
        properties?: { limit?: { maximum?: number }; cursor?: { minLength?: number } };
      };

      expect(tool?.name).toBe("mthds_list_methods");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(inputSchema.properties?.limit?.maximum).toBe(50);
      expect(inputSchema.properties?.cursor?.minLength).toBe(1);

      const result = await client.callTool({
        name: "mthds_list_methods",
        arguments: { query: "invoice" },
      });

      expect(calls).toBe(1);
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        returned_count: 1,
        next_cursor: null,
        methods: [{ method_id: "mt_invoice", name: "Invoice extractor" }],
      });
      expect(result._meta).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("registers mthds_models as a read with two optional arguments and dispatches a check to the runner", async () => {
    const contexts = buildLocalToolContexts({ PIPELEX_API_KEY: "plx_sk_test" });
    const listed: Array<string | undefined> = [];
    const checked: Array<{ reference: string; category: string | undefined }> = [];
    contexts.models.client = {
      async models(category) {
        listed.push(category);
        return { models: [{ name: "writing-factual", type: "llm" }], aliases: {}, waterfalls: {} };
      },
      async checkModelReference(reference, category) {
        checked.push({ reference, category });
        return {
          reference: "$writing-factul",
          kind: "preset",
          name: "writing-factul",
          category: "llm",
          resolution: "not_found",
          matches: [],
          suggestions: ["$writing-factual"],
          other_kinds: [],
          other_categories: [],
        };
      },
    };

    const { client, close } = await connectClient(createLocalServer({ contexts }));
    try {
      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === "mthds_models",
      );
      const schema = tool?.inputSchema as { required?: string[]; properties?: object };

      // It reads the deck or asks the runner, and only the configured API.
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(schema.required ?? []).toEqual([]);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["category", "reference"]);
      // The account caveat is the one thing a model reading the deck would
      // otherwise take for granted.
      expect(tool?.description).toContain("not what this account may use");

      const result = await client.callTool({
        name: "mthds_models",
        arguments: { reference: "$writing-factul", category: "llm" },
      });

      expect(checked).toEqual([{ reference: "$writing-factul", category: "llm" }]);
      expect(listed).toEqual([]);
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        category: "llm",
        reference: "$writing-factul",
        kind: "preset",
        name: "writing-factul",
        resolution: "not_found",
        suggestions: ["$writing-factual"],
      });
      expect(result.isError).toBeFalsy();
      expect(result._meta).toBeUndefined();
    } finally {
      await close();
    }
  });

  it("dispatches mthds_codegen with the artifacts on content and nothing on _meta", async () => {
    const contexts = buildLocalToolContexts({ PIPELEX_API_KEY: "plx_sk_test" });
    contexts.codegen.client = {
      async codegen(): Promise<CodegenResponse> {
        return codegenReport;
      },
    };

    const { client, close } = await connectClient(createLocalServer({ contexts }));
    try {
      const result = await client.callTool({
        name: "mthds_codegen",
        arguments: { files: [{ content: 'domain = "demo"' }], target: "ts-zod" },
      });

      const valid = codegenReport as Extract<CodegenResponse, { is_valid: true }>;
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        is_valid: true,
        target: "ts-zod",
        truncated: false,
      });
      const artifacts = (result.structuredContent as { artifacts: { path: string }[] }).artifacts;
      expect(artifacts.map((artifact) => artifact.path)).toEqual(
        valid.artifacts.map((artifact) => artifact.path),
      );
      expect(result._meta).toBeUndefined();
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      expect(text).toContain("```ts\n" + valid.artifacts[0]!.content);
      expect(text).toContain("```toml\n" + valid.lock);
    } finally {
      await close();
    }
  });

  it("advertises paths as the headline and makes the local resolver available to files tools", async () => {
    const rootDir = await makeTempDir();
    await fs.writeFile(path.join(rootDir, "bundle.mthds"), 'domain = "demo"', "utf8");

    const contexts = buildLocalToolContexts({ PIPELEX_BASE_URL: "http://127.0.0.1:8081" }, rootDir);

    // Every method-taking tool reads the bundle's template files through one
    // resolver; the save reads `.mthds` alone, since the catalog stores no
    // template file.
    for (const resolver of [
      contexts.inputs.resolver,
      contexts.codegen.resolver,
      contexts.prepare.resolver,
      contexts.run.resolver,
    ]) {
      expect(resolver).toBe(contexts.validation.resolver);
    }
    expect(contexts.validation.resolver?.resolveTemplates).toBeDefined();
    expect(contexts.catalogWrite.resolver?.resolveTemplates).toBeUndefined();
    await expect(contexts.validation.resolver?.resolve("bundle.mthds")).resolves.toEqual({
      ok: true,
      content: 'domain = "demo"',
    });
    await expect(contexts.catalogWrite.resolver?.resolve("bundle.mthds")).resolves.toEqual({
      ok: true,
      content: 'domain = "demo"',
    });
    await expect(contexts.catalogWrite.resolver?.resolve("invoice.xlsx")).resolves.toMatchObject({
      ok: false,
      message: "Path is not a .mthds file: invoice.xlsx",
    });

    const { client, close } = await connectClient(createLocalServer({ contexts }));
    try {
      expect(client.getInstructions()).toContain("Prefer `{ path: string }` files");
      expect(client.getInstructions()).toContain("files to inline content");
      expect(client.getInstructions()).toContain("has no views");
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
      async validate(): Promise<PipelexValidationResult> {
        throw new Error("validate (selector leg) must not be called in this test");
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
        graph_page: { path: GRAPH_PAGE_FILENAME, written: true },
      });
      expect(result._meta?.graph_spec).toBeUndefined();
      // The signature DOES ride the workshop — it is deliberately not on the
      // views branch, since this is the shell an integrating agent uses — so
      // the summary carries its `## Main pipe` section and no `## Views` note.
      // That contrast is what this asserts: no view advert, but the signature,
      // and the flowchart as a page on disk in place of the view.
      const [block] = result.content as { type: string; text: string }[];
      expect(block?.text).toMatch(
        /^# Valid\n\n## Main pipe\n\n`demo\.main\(\) -> native\.Text`\n\n## Method graph\n\nWrote the method's flowchart to `method-graph\.html`/,
      );
      expect(result._meta?.pipe_io_contracts).toBeUndefined();
      expect(result._meta?.input_form).toBeUndefined();
      const page = await fs.readFile(path.join(rootDir, GRAPH_PAGE_FILENAME), "utf8");
      expect(page).toContain('{"name":"bundle.mthds","content":"domain = \\"demo\\""}');
    } finally {
      await close();
    }
  });

  // `login` is the one subcommand; any other argument list, a stray argument
  // a host registration passes included, starts the server as it always did.
  it.each([[[]], [["--stray", "serve"]]])(
    "handshakes through the actual stdio entry point without diagnostic output, with arguments %j",
    async (extraArgs: string[]) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          fileURLToPath(new URL("./main.ts", import.meta.url)),
          ...extraArgs,
        ],
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
          localToolDefinitions.map((definition) => definition.name),
        );
        expect(client.getInstructions()).toContain("Prefer `{ path: string }` files");
      } finally {
        await client.close();
      }

      expect(stderrText).toBe("");
    },
    10_000,
  );
});

/** Run the real entry point to its exit, as a person runs it in a terminal. */
function runEntryPoint(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./main.ts", import.meta.url)), ...args],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the entry point's login dispatch", () => {
  it("runs login --help and exits 0, starting no server", async () => {
    const run = await runEntryPoint(["login", "--help"]);

    expect(run).toEqual({ code: 0, stdout: LOGIN_USAGE, stderr: "" });
  }, 10_000);

  it("refuses a mistyped login option with the usage and a non-zero exit, instead of waiting on stdin", async () => {
    const run = await runEntryPoint(["login", "--paset"]);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`Unknown option for login: --paset.\n\n${LOGIN_USAGE}`);
  }, 10_000);
});

// Carries both per-pipe artifacts (typed since sdk 0.15.0) so the workshop
// test above proves the shell advertises nothing even on a report that has
// everything a form needs.
//
// The blueprint states its `domain` so the SIGNATURE projects. The artifacts
// are keyed `demo.main`, so a domainless blueprint derives the bare ref `main`,
// misses the contract map, and emits no `main_pipe` — which the summary
// assertion above reads as a missing `## Main pipe` section. Measured rather
// than argued: drop the domain and leave the shell gate alone, and that is the
// assertion that fails, on `"# Valid"` against the expected
// `"# Valid\n\n## Main pipe\n\n..."`.
//
// The domain is NOT what makes this test non-vacuous, and must not be read that
// way: the GRAPH advert alone does that, since `dry_run_graph` rides on the
// shell gate and on nothing else. A shell that registered views turns
// `available_view_specs` into `["dry_run_graph"]` — the very first assertion —
// with the domain or without it.
const validReport: PipelexValidationReport = {
  is_valid: true,
  bundle_blueprint: { domain: "demo", main_pipe: "main" },
  pipe_io_contracts: {
    "demo.main": {
      inputs: {},
      output: {
        concept_ref: "native.Text",
        multiplicity: "single",
        item_count: null,
        optional: false,
        json_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    },
  },
  input_form: { "demo.main": { fields: [] } },
  graph_spec: { nodes: [{ id: "demo.main" }] },
  validated_pipes: [],
  pending_signatures: [],
  liftable_pipes: [],
  warnings: [],
  is_runnable: true,
  message: "ok",
  rendered_markdown: "# Valid",
};

// A REAL recorded engine response: the capability preflights every valid arm
// through the SDK's own hash-verifying check before relaying or writing it, so
// a hand-written stub is refused as a malformed report.
const codegenReport: CodegenResponse = await recordedTsZodReport();

const catalogMethod: MethodPage["items"][number] = {
  method_id: "mt_invoice",
  name: "Invoice extractor",
  description: "Extract invoice data",
  created_at: "2026-01-01T00:00:00Z",
};

/** The workshop's flow, in the order its instructions must name it. */
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
 * The workshop's tools that take a method selector, and whose instruction
 * sentences must therefore name every form they accept. `mthds_list_methods`
 * is not one: it takes no method, it answers with ids. Nor is a tool that
 * takes an id to write or read one stored method, which accepts no address — a
 * new tool joins this list only when it takes the one-of `files` /
 * `method_ref` / `method_id`.
 */
const SELECTOR_TOOLS = [
  "mthds_validate",
  "mthds_inputs_template",
  "mthds_codegen",
  "mthds_prepare_inputs",
  "mthds_run",
] as const;

describe("the workshop's User-Agent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Drive a real tool call through the real shell, with a real SDK client and
   * a stubbed `fetch`, and read back the header the API would have seen. The
   * host name is what the MCP client declared on `initialize` — which happens
   * after the contexts were built, so this also proves the host is read late.
   */
  async function userAgentSeenBy(clientInfo: { name: string; version: string }) {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: { headers?: HeadersInit }) => {
      seen.push(new Headers(init?.headers).get("user-agent") ?? "");
      return Promise.resolve(
        new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }),
      );
    });
    const server = createLocalServer({
      env: { PIPELEX_BASE_URL: "https://api.pipelex.test", PIPELEX_API_KEY: "plx_sk_test" },
    });
    const { client, close } = await connectClient(server, clientInfo);
    try {
      await client.callTool({ name: "mthds_list_methods", arguments: {} });
    } finally {
      await close();
    }
    return seen;
  }

  it("names the workshop and the host from the handshake's clientInfo", async () => {
    const seen = await userAgentSeenBy({ name: "claude-code", version: "2.1.4" });

    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) {
      expect(value).toBe(
        `pipelex-mcp/${LOCAL_SERVER_INFO.version} (workshop; host=claude-code/2.1.4) ` +
          `pipelex-sdk-js/${SDK_VERSION} node/${process.versions.node} (${process.platform}; ${process.arch})`,
      );
    }
  });

  it("sanitises a host name MCP allows but the header does not", async () => {
    const seen = await userAgentSeenBy({
      name: "Visual Studio Code",
      version: "1.99.0 (Universal)",
    });

    expect(seen[0]).toContain("(workshop; host=visual-studio-code/1.99.0-universal)");
  });

  it("leaves the host out, never the call, when the host name has nothing usable", async () => {
    const seen = await userAgentSeenBy({ name: "@@@", version: "1.0.0" });

    expect(seen[0]).toMatch(/^pipelex-mcp\/\S+ \(workshop\) pipelex-sdk-js\//);
  });
});

describe("the workshop's key, read on every call", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** One request as the stubbed API saw it. */
  interface SeenRequest {
    host: string;
    path: string;
    authorization: string | null;
  }

  /**
   * Stub the API: `/v1/version` answers per host from `versions`, any other
   * route answers `body`, and a request carrying no key is refused with a 401,
   * as the hosted API refuses it.
   */
  function stubApi(body: unknown, versions: Record<string, string[]> = {}): SeenRequest[] {
    const seen: SeenRequest[] = [];
    vi.stubGlobal("fetch", (input: string, init?: { headers?: HeadersInit }) => {
      const url = new URL(input);
      const authorization = new Headers(init?.headers).get("authorization");
      seen.push({ host: url.host, path: url.pathname, authorization });
      if (url.pathname === "/v1/version") {
        const extensions = versions[url.host] ?? [];
        return Promise.resolve(Response.json({ version: "1.0.0", extensions }));
      }
      if (authorization === null) {
        return Promise.resolve(
          Response.json(
            { type: "about:blank", title: "Unauthorized", status: 401, detail: "Missing API key" },
            { status: 401, headers: { "content-type": "application/problem+json" } },
          ),
        );
      }
      return Promise.resolve(Response.json(body));
    });
    return seen;
  }

  const emptyPage = { items: [], next_cursor: null };

  it("reads the suite's pinned, empty PIPELEX_HOME when built from the real environment", async () => {
    // `vitest.config.ts` pins PIPELEX_HOME to an empty temporary directory, so
    // no test sends the developer's own saved key anywhere.
    const pinned = process.env.PIPELEX_HOME ?? "";
    expect(path.isAbsolute(pinned)).toBe(true);
    expect(pinned).not.toBe(path.join(os.homedir(), ".pipelex"));
    await expect(fs.access(path.join(pinned, ".env"))).rejects.toThrow();

    // An empty value is no value, so the host's key here counts as unset.
    vi.stubEnv("PIPELEX_API_KEY", "");
    vi.stubEnv("PIPELEX_BASE_URL", "https://api.pipelex.test");
    const seen = stubApi(emptyPage);
    const { client, close } = await connectClient(createLocalServer());
    let result;
    try {
      result = await client.callTool({ name: "mthds_list_methods", arguments: {} });
    } finally {
      await close();
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((request) => request.authorization === null)).toBe(true);
    const [error] = (result.structuredContent as { errors: { hint: string }[] }).errors;
    expect(error?.hint).toContain(`\`${path.join(pinned, ".env")}\``);
  });

  it("succeeds on the next call once a key is saved, with no restart", async () => {
    const home = await makeTempDir();
    const seen = stubApi(emptyPage);
    const server = createLocalServer({
      env: { PIPELEX_HOME: home, PIPELEX_BASE_URL: "https://api.pipelex.test" },
      rootDir: await makeTempDir(),
    });
    const { client, close } = await connectClient(server);

    try {
      const keyless = await client.callTool({ name: "mthds_list_methods", arguments: {} });

      // No key anywhere: the call went out without one, and its error names
      // the login rather than calling the API unreachable.
      expect(keyless.isError).toBe(true);
      expect(seen.map((request) => request.authorization)).toEqual([null]);
      expect(keyless.structuredContent).toMatchObject({
        status: "error",
        errors: [{ class: "config", location: "PIPELEX_API_KEY" }],
      });
      const [text] = keyless.content as { type: string; text: string }[];
      expect(text?.text).toContain("`npx -y @pipelex/mcp@latest login`");

      await fs.writeFile(path.join(home, ".env"), "PIPELEX_API_KEY=plx_sk_saved\n");
      const keyed = await client.callTool({ name: "mthds_list_methods", arguments: {} });

      expect(keyed.isError).toBeFalsy();
      expect(keyed.structuredContent).toMatchObject({ status: "ok", returned_count: 0 });
      expect(seen.at(-1)).toMatchObject({
        host: "api.pipelex.test",
        authorization: "Bearer plx_sk_saved",
      });
    } finally {
      await close();
    }
  });

  it("headlines a keyless call as the missing key, with the login in its content", async () => {
    // The 401 a keyless call meets is `config`, as an unreachable API is; the
    // headline, which a host may show alone, must say which (L-260924-a58ae1).
    stubApi(emptyPage);
    const server = createLocalServer({
      env: { PIPELEX_HOME: await makeTempDir(), PIPELEX_BASE_URL: "https://api.pipelex.test" },
      rootDir: await makeTempDir(),
    });
    const { client, close } = await connectClient(server);

    try {
      const calls = [
        {
          name: "mthds_list_methods",
          arguments: {},
          headline:
            "Method catalog could not be listed: the Pipelex API key is missing or was refused.",
        },
        {
          name: "mthds_run_status",
          arguments: { run_id: "run_keyless" },
          headline: "Run status could not be read: the Pipelex API key is missing or was refused.",
        },
      ];
      for (const call of calls) {
        const result = await client.callTool({ name: call.name, arguments: call.arguments });

        expect(result.isError, call.name).toBe(true);
        expect(result.structuredContent, call.name).toMatchObject({
          status: "error",
          errors: [{ class: "config", kind: "auth", location: "PIPELEX_API_KEY" }],
        });
        const [text] = result.content as { type: string; text: string }[];
        expect(text?.text.split("\n")[0], call.name).toBe(call.headline);
        expect(text?.text, call.name).toContain("No Pipelex API key is set");
        expect(text?.text, call.name).toContain("`npx -y @pipelex/mcp@latest login`");
        expect(text?.text, call.name).not.toMatch(/unreachable|misconfigured/);
      }
    } finally {
      await close();
    }
  });

  it("keeps the host's key when the host passes one, whatever the file holds", async () => {
    const home = await makeTempDir();
    await fs.writeFile(
      path.join(home, ".env"),
      "PIPELEX_API_KEY=plx_sk_saved\nPIPELEX_BASE_URL=https://saved.pipelex.test\n",
    );
    const seen = stubApi(emptyPage);
    const server = createLocalServer({
      env: {
        PIPELEX_HOME: home,
        PIPELEX_API_KEY: "plx_sk_host",
        PIPELEX_BASE_URL: "https://api.pipelex.test",
      },
    });
    const { client, close } = await connectClient(server);

    try {
      await client.callTool({ name: "mthds_list_methods", arguments: {} });
    } finally {
      await close();
    }

    expect(seen).toEqual([
      { host: "api.pipelex.test", path: "/v1/methods", authorization: "Bearer plx_sk_host" },
    ]);
  });

  it("asks a new API afresh whether it resolves versions when the saved base URL moves", async () => {
    // The memory of the platform's answer is keyed by base URL: `supported`
    // remembered for the first API must not label the second's bare id read,
    // since the second does not resolve versions and reads the draft.
    const home = await makeTempDir();
    const saveBaseUrl = (baseUrl: string) =>
      fs.writeFile(
        path.join(home, ".env"),
        `PIPELEX_API_KEY=plx_sk_saved\nPIPELEX_BASE_URL=${baseUrl}\n`,
      );
    const seen = stubApi(validReport, {
      "one.pipelex.test": ["runs", "method_versions"],
      "two.pipelex.test": ["runs"],
    });
    const server = createLocalServer({ env: { PIPELEX_HOME: home }, rootDir: await makeTempDir() });
    const { client, close } = await connectClient(server);
    const versionAsks = (host: string) =>
      seen.filter((request) => request.host === host && request.path === "/v1/version").length;

    try {
      await saveBaseUrl("https://one.pipelex.test");
      const first = await client.callTool({
        name: "mthds_validate",
        arguments: { method_id: "mt_demo" },
      });
      expect(first.structuredContent).toMatchObject({ status: "ok", method_version: "latest" });
      expect(versionAsks("one.pipelex.test")).toBe(1);

      await saveBaseUrl("https://two.pipelex.test");
      const sentBefore = seen.length;
      const second = await client.callTool({
        name: "mthds_validate",
        arguments: { method_id: "mt_demo" },
      });

      expect(seen.slice(sentBefore).every((request) => request.host === "two.pipelex.test")).toBe(
        true,
      );
      expect(versionAsks("two.pipelex.test")).toBe(1);
      expect(second.structuredContent).toMatchObject({ status: "ok", method_version: "draft" });
    } finally {
      await close();
    }
  });

  it("names the saved file in a base URL failure only when the base URL is the file's", async () => {
    const home = await makeTempDir();
    await fs.writeFile(
      path.join(home, ".env"),
      "PIPELEX_API_KEY=plx_sk_saved\nPIPELEX_BASE_URL=https://saved.pipelex.test\n",
    );
    vi.stubGlobal("fetch", () =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
        }),
      ),
    );
    const note = `The PIPELEX_BASE_URL in use, https://saved.pipelex.test, was read from \`${path.join(home, ".env")}\` beside the saved key`;

    /** The first error of each call, by a server whose environment is `env`. */
    async function errorsOf(env: Record<string, string>) {
      const server = createLocalServer({ env, rootDir: await makeTempDir() });
      const { client, close } = await connectClient(server);
      try {
        const calls = [
          client.callTool({ name: "mthds_list_methods", arguments: {} }),
          client.callTool({ name: "mthds_validate", arguments: { method_id: "mt_demo" } }),
        ];
        return (await Promise.all(calls)).map(
          (result) =>
            (result.structuredContent as { errors: { location?: string; hint?: string }[] })
              .errors[0],
        );
      } finally {
        await close();
      }
    }

    for (const error of await errorsOf({ PIPELEX_HOME: home })) {
      expect(error).toMatchObject({ location: "PIPELEX_BASE_URL" });
      expect(error?.hint).toContain(note);
      expect(error?.hint).not.toContain("plx_sk_saved");
    }
    for (const error of await errorsOf({
      PIPELEX_HOME: home,
      PIPELEX_BASE_URL: "https://env.pipelex.test",
    })) {
      expect(error).toMatchObject({ location: "PIPELEX_BASE_URL" });
      expect(error?.hint).not.toContain(".env");
    }
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

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-local-server-"));
  tempDirs.push(dir);
  return dir;
}
