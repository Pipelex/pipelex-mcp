import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PipelexStartOptions, PrepareInputsRequest, PreparedInputs } from "@pipelex/sdk";

import { buildPrepareContext, prepareMthdsInputs } from "./capabilities/prepare.js";
import type { PrepareContext } from "./capabilities/prepare.js";
import { buildRunContext, startMthdsRun } from "./capabilities/run.js";
import type { RunContext } from "./capabilities/run.js";
import { MAX_INPUTS_FILE_BYTES } from "./capabilities/shared.js";
import type { ToolError } from "./capabilities/shared.js";
import { buildLocalToolContexts } from "./tools.js";

/**
 * `inputs_path` end to end on the workshop: the contexts `buildLocalToolContexts`
 * builds, with their real `.json` resolver over a temporary working directory,
 * and fake API clients that record what would have crossed the wire.
 */

const FILES = [{ content: 'domain = "demo"' }];
const RUN_ID = "01JRUN0000000000000000TEST";
const INPUTS = { question: "why?", facts: { weeks: [1, 2, 3] } };

describe("inputs_path on the workshop", () => {
  let rootDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-inputs-root-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-inputs-outside-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  /** The workshop's run context over `rootDir`, its client recording the start options. */
  function runContext(): { context: RunContext; seen: PipelexStartOptions[] } {
    const seen: PipelexStartOptions[] = [];
    const base = buildLocalToolContexts({ PIPELEX_API_KEY: "plx_sk_test" }, rootDir).run;
    const context: RunContext = {
      ...base,
      client: {
        start: (options: PipelexStartOptions) => {
          seen.push(options);
          return Promise.resolve({ pipeline_run_id: RUN_ID, state: "STARTED" });
        },
        getRunStatus: () => Promise.reject(new Error("getRunStatus must not be called")),
        getRunResult: () => Promise.reject(new Error("getRunResult must not be called")),
      },
    };
    return { context, seen };
  }

  /** The workshop's prepare context over `rootDir`, its client recording the request. */
  function prepareContext(): { context: PrepareContext; seen: PrepareInputsRequest[] } {
    const seen: PrepareInputsRequest[] = [];
    const base = buildLocalToolContexts({ PIPELEX_API_KEY: "plx_sk_test" }, rootDir).prepare;
    const context: PrepareContext = {
      ...base,
      client: {
        prepareInputs: (request: PrepareInputsRequest): Promise<PreparedInputs> => {
          seen.push(request);
          return Promise.resolve({ inputs: request.inputs, uploads: [] });
        },
      },
    };
    return { context, seen };
  }

  async function writeInputs(name: string, body: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(rootDir, name)), { recursive: true });
    await fs.writeFile(path.join(rootDir, name), body);
  }

  function onlyError(errors: ToolError[] | undefined): ToolError {
    expect(errors).toHaveLength(1);
    return (errors ?? [])[0];
  }

  describe("mthds_run", () => {
    it("starts the run with the inputs read from the file", async () => {
      await writeInputs("data/inputs.json", JSON.stringify(INPUTS));
      const { context, seen } = runContext();

      const result = await startMthdsRun(
        { files: FILES, inputs_path: "data/inputs.json" },
        context,
      );

      expect(result.structuredContent.status).toBe("ok");
      expect(seen).toEqual([{ mthds_contents: ['domain = "demo"'], inputs: INPUTS }]);
    });

    it("reads an extension in any case", async () => {
      await writeInputs("inputs.JSON", JSON.stringify(INPUTS));
      const { context, seen } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: "inputs.JSON" }, context);

      expect(result.structuredContent.status).toBe("ok");
      expect(seen[0]?.inputs).toEqual(INPUTS);
    });

    it("reads a file written with a UTF-8 byte-order mark", async () => {
      await writeInputs("inputs.json", `\uFEFF${JSON.stringify(INPUTS)}`);
      const { context, seen } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: "inputs.json" }, context);

      expect(result.structuredContent.status).toBe("ok");
      expect(seen[0]?.inputs).toEqual(INPUTS);
    });

    it("refuses inputs and inputs_path together, at inputs_path, before any read", async () => {
      const { context, seen } = runContext();

      const result = await startMthdsRun(
        { files: FILES, inputs: INPUTS, inputs_path: "missing.json" },
        context,
      );

      const error = onlyError(result.structuredContent.errors);
      expect(error).toMatchObject({ class: "input_domain", location: "inputs_path" });
      expect(error.message).toContain("not both");
      expect(seen).toEqual([]);
    });

    it("refuses a file that is not .json without opening it", async () => {
      await writeInputs(".env", "SECRET=1");
      const { context, seen } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: ".env" }, context);

      const error = onlyError(result.structuredContent.errors);
      expect(error).toMatchObject({ class: "input_domain", location: "inputs_path" });
      expect(error.message).toBe("Path is not a .json file: .env");
      expect(error.hint).toContain("pass the inputs inline as inputs");
      expect(seen).toEqual([]);
    });

    it("refuses a relative path escaping the working directory", async () => {
      await fs.writeFile(path.join(outsideDir, "inputs.json"), JSON.stringify(INPUTS));
      const { context } = runContext();

      const result = await startMthdsRun(
        { files: FILES, inputs_path: `../${path.basename(outsideDir)}/inputs.json` },
        context,
      );

      const error = onlyError(result.structuredContent.errors);
      expect(error).toMatchObject({ class: "input_domain", location: "inputs_path" });
      expect(error.message).toContain("outside the server's working directory");
    });

    it("refuses an absolute path outside the working directory", async () => {
      const outside = path.join(outsideDir, "inputs.json");
      await fs.writeFile(outside, JSON.stringify(INPUTS));
      const { context } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: outside }, context);

      expect(onlyError(result.structuredContent.errors).message).toContain(
        "outside the server's working directory",
      );
    });

    it("refuses a symlink inside the working directory pointing out of it", async () => {
      const outside = path.join(outsideDir, "inputs.json");
      await fs.writeFile(outside, JSON.stringify(INPUTS));
      await fs.symlink(outside, path.join(rootDir, "inputs.json"));
      const { context } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: "inputs.json" }, context);

      expect(onlyError(result.structuredContent.errors).message).toContain(
        "outside the server's working directory",
      );
    });

    it("refuses a directory named like a .json file", async () => {
      await fs.mkdir(path.join(rootDir, "inputs.json"));
      const { context } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: "inputs.json" }, context);

      expect(onlyError(result.structuredContent.errors).message).toBe(
        "Path is not a regular file: inputs.json",
      );
    });

    it("refuses a missing file", async () => {
      const { context } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: "missing.json" }, context);

      expect(onlyError(result.structuredContent.errors)).toMatchObject({
        location: "inputs_path",
        message: "File not found: missing.json",
      });
    });

    it("refuses a file over the size cap", async () => {
      await writeInputs("big.json", JSON.stringify({ blob: "x".repeat(MAX_INPUTS_FILE_BYTES) }));
      const { context, seen } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: "big.json" }, context);

      const error = onlyError(result.structuredContent.errors);
      expect(error).toMatchObject({ class: "input_domain", location: "inputs_path" });
      expect(error.message).toContain("too large");
      expect(seen).toEqual([]);
    });

    it("refuses a file that is not valid JSON", async () => {
      await writeInputs("inputs.json", "{ question: why }");
      const { context, seen } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: "inputs.json" }, context);

      const error = onlyError(result.structuredContent.errors);
      expect(error).toMatchObject({ class: "input_domain", location: "inputs_path" });
      expect(error.message).toContain("not valid JSON");
      expect(seen).toEqual([]);
    });

    it.each([
      ["an array", "[1, 2]"],
      ["null", "null"],
      ["string", '"inputs"'],
      ["number", "42"],
    ])("refuses a file holding %s rather than an object", async (found, body) => {
      await writeInputs("inputs.json", body);
      const { context } = runContext();

      const result = await startMthdsRun({ files: FILES, inputs_path: "inputs.json" }, context);

      const error = onlyError(result.structuredContent.errors);
      expect(error).toMatchObject({ class: "input_domain", location: "inputs_path" });
      expect(error.message).toContain(`holds ${found}`);
    });

    it("reports a files error and an inputs_path error in the same refusal", async () => {
      const { context } = runContext();

      const result = await startMthdsRun(
        { files: [{ path: "missing.mthds" }], inputs_path: "missing.json" },
        context,
      );

      expect(result.structuredContent.errors?.map((error) => error.location)).toEqual([
        "files[0].path",
        "inputs_path",
      ]);
    });
  });

  describe("mthds_prepare_inputs", () => {
    it("prepares the inputs read from the file, handing a local path inside them to the SDK as inline inputs would", async () => {
      const loaded = { photo: "assets/photo.png", question: "why?" };
      await writeInputs("inputs.json", JSON.stringify(loaded));
      const { context, seen } = prepareContext();

      const result = await prepareMthdsInputs(
        { files: FILES, inputs_path: "inputs.json" },
        context,
      );

      expect(result.structuredContent.status).toBe("ok");
      expect(result.structuredContent.inputs).toEqual(loaded);
      // The loaded object reaches the SDK's walk untouched, so a relative local
      // path inside it is read exactly as the same path given inline would be.
      expect(seen).toEqual([{ files: [{ content: 'domain = "demo"' }], inputs: loaded }]);
    });

    it("refuses neither inputs nor inputs_path, at inputs", async () => {
      const { context, seen } = prepareContext();

      const result = await prepareMthdsInputs({ files: FILES }, context);

      expect(onlyError(result.structuredContent.errors)).toMatchObject({
        class: "input_domain",
        location: "inputs",
      });
      expect(seen).toEqual([]);
    });

    it("refuses inputs and inputs_path together, at inputs_path", async () => {
      await writeInputs("inputs.json", JSON.stringify(INPUTS));
      const { context, seen } = prepareContext();

      const result = await prepareMthdsInputs(
        { files: FILES, inputs: INPUTS, inputs_path: "inputs.json" },
        context,
      );

      expect(onlyError(result.structuredContent.errors)).toMatchObject({
        class: "input_domain",
        location: "inputs_path",
      });
      expect(seen).toEqual([]);
    });

    it("refuses a file that is not .json, a file outside the working directory and a non-object", async () => {
      await fs.writeFile(path.join(outsideDir, "inputs.json"), JSON.stringify(INPUTS));
      await writeInputs("list.json", "[]");
      const { context } = prepareContext();

      const wrongExtension = await prepareMthdsInputs(
        { files: FILES, inputs_path: "inputs.toml" },
        context,
      );
      const escape = await prepareMthdsInputs(
        { files: FILES, inputs_path: `../${path.basename(outsideDir)}/inputs.json` },
        context,
      );
      const notObject = await prepareMthdsInputs(
        { files: FILES, inputs_path: "list.json" },
        context,
      );

      expect(onlyError(wrongExtension.structuredContent.errors).message).toBe(
        "Path is not a .json file: inputs.toml",
      );
      expect(onlyError(escape.structuredContent.errors).message).toContain(
        "outside the server's working directory",
      );
      expect(onlyError(notObject.structuredContent.errors).message).toContain("holds an array");
    });
  });

  // The core's own contexts carry no resolver: a deployment that builds them
  // without the workshop's — the hosted console, the live suite — cannot read
  // the disk, so `inputs_path` is refused as a `{ path }` item is.
  describe("without the workshop's resolver", () => {
    it("mthds_run refuses inputs_path at inputs_path and starts nothing", async () => {
      await writeInputs("inputs.json", JSON.stringify(INPUTS));
      const seen: PipelexStartOptions[] = [];
      const context: RunContext = {
        ...buildRunContext({}),
        client: {
          start: (options: PipelexStartOptions) => {
            seen.push(options);
            return Promise.resolve({ pipeline_run_id: RUN_ID });
          },
          getRunStatus: () => Promise.reject(new Error("getRunStatus must not be called")),
          getRunResult: () => Promise.reject(new Error("getRunResult must not be called")),
        },
      };

      const result = await startMthdsRun(
        { files: FILES, inputs_path: path.join(rootDir, "inputs.json") },
        context,
      );

      const error = onlyError(result.structuredContent.errors);
      expect(error).toMatchObject({ class: "input_domain", location: "inputs_path" });
      expect(error.message).toContain("cannot read files from disk");
      expect(seen).toEqual([]);
    });

    it("mthds_prepare_inputs refuses inputs_path at inputs_path", async () => {
      const context: PrepareContext = {
        ...buildPrepareContext({}),
        client: {
          prepareInputs: () => Promise.reject(new Error("prepareInputs must not be called")),
        },
      };

      const result = await prepareMthdsInputs(
        { files: FILES, inputs_path: "inputs.json" },
        context,
      );

      expect(onlyError(result.structuredContent.errors)).toMatchObject({
        class: "input_domain",
        location: "inputs_path",
      });
    });
  });
});
