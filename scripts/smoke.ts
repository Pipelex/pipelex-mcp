/**
 * `make smoke` — the one check in this repo that talks to the real Pipelex API.
 *
 * Why it exists: every capability reaches `@pipelex/sdk` through a hand-written
 * narrow interface, and every unit test injects a fake satisfying that
 * interface. A *type* change on the SDK side therefore fails `tsc`, while a
 * *wire-shape* change fails nothing at all — `make all` stays green while the
 * shipped client is broken against the live platform. That is not hypothetical:
 * `mthds_list_methods` failed every real call with `wire.map is not a function`
 * (the platform had reshaped `GET /v1/methods` into a page object) and no check
 * in this repo noticed.
 *
 * What it does: spawns the workshop stdio server the way a host does
 * (`tsx src/local/main.ts`), completes the MCP handshake, then calls the
 * read-only tools against the configured API and asserts on their
 * `structuredContent`. Nothing here executes a method, so a run spends no
 * inference credit and is safe to run unattended (a scheduled canary reuses it).
 *
 * Run it through `make smoke`, which resolves the env from `.env`, preflights
 * `/v1/version`, and refuses to start without a key. `npm run smoke` runs the
 * same script without those guards, which is what a keyless local OSS runner
 * needs.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildApiConfig } from "../src/capabilities/shared.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRYPOINT = path.join(REPO_ROOT, "src", "local", "main.ts");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Generous: a cold hosted API can take seconds, and a hang must still end in a verdict. */
const CALL_TIMEOUT_MS = 60_000;

/**
 * The catalog's non-negotiable projection invariant, restated on live data.
 * These are the fields the index projection must never carry into a tool result;
 * `capabilities/catalog.ts` validates what *arrives* rather than trusting the
 * declared type, and this asserts the same thing against the real server.
 */
const FORBIDDEN_CATALOG_KEYS = new Set([
  "mthds",
  "python",
  "input_data",
  "pipe_output",
  "org_id",
  "created_by_user_id",
]);

/** The canonical bundle from `pipelex-sdk-js`'s e2e fixtures: lints clean, validates, runs. */
const VALID_BUNDLE = `domain      = "quick_start"
description = "Discovering Pipelex"
main_pipe   = "hello_world"

[pipe.hello_world]
type = "PipeLLM"
description = "Write text about Hello World."
output = "Text"
prompt = """
Write a haiku about Hello World.
"""
`;

const VALID_BUNDLE_URI = "smoke/quick_start.mthds";

/**
 * A second fixture, for `mthds_inputs_template` only: the canonical bundle above
 * declares no inputs, so its template is `{}` and an assertion on it would pass
 * just as happily if the projection dropped every field. This one declares one,
 * so the template check proves the field actually survives the wire.
 */
const INPUTS_BUNDLE = `domain      = "smoke_inputs"
description = "pipelex-mcp smoke fixture with one declared input"
main_pipe   = "write_about_topic"

[pipe.write_about_topic]
type = "PipeLLM"
description = "Write a short paragraph about a given topic."
inputs = { topic = "Text" }
output = "Text"
prompt = """
Write a short, engaging paragraph about the following topic:

$topic
"""
`;

const INPUTS_BUNDLE_URI = "smoke/smoke_inputs.mthds";

interface ToolCallResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
}

const failures: string[] = [];

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

function section(title: string): void {
  write("");
  write(title);
}

function pass(label: string, note?: string): void {
  write(`  PASS  ${label}${note === undefined ? "" : ` — ${note}`}`);
}

function fail(label: string, detail: string): void {
  failures.push(`${label}: ${detail}`);
  write(`  FAIL  ${label} — ${detail}`);
}

function note(text: string): void {
  write(`        ${text}`);
}

function expect(condition: boolean, label: string, detail: string, passNote?: string): boolean {
  if (condition) {
    pass(label, passNote);
    return true;
  }
  fail(label, detail);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  const rendered = JSON.stringify(value);
  if (rendered === undefined) return String(value);
  return rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered;
}

/** Join every text block of a tool result — the Markdown summary the model reads. */
function summaryText(result: ToolCallResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter(
      (item): item is { type: string; text: string } =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

/**
 * Walk the whole tool result for forbidden *keys*. Keys rather than substrings:
 * a method description may legitimately contain the word "python", and a false
 * positive on a security invariant is how the invariant gets switched off.
 */
function findForbiddenKeys(
  value: unknown,
  forbidden: Set<string>,
  location = "$",
  found: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      findForbiddenKeys(item, forbidden, `${location}[${index}]`, found),
    );
    return found;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childLocation = `${location}.${key}`;
      if (forbidden.has(key)) found.push(childLocation);
      findForbiddenKeys(child, forbidden, childLocation, found);
    }
  }
  return found;
}

/** Report a no-verdict result the way the agent would read it, then bail out of that check. */
function reportToolFailure(label: string, result: ToolCallResult): void {
  fail(label, "the tool returned an error result");
  const text = summaryText(result);
  if (text !== "") {
    for (const line of text.split("\n")) note(line);
  } else {
    note(describe(result.structuredContent));
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  })) as ToolCallResult;
}

async function checkListMethods(client: Client): Promise<void> {
  section("mthds_list_methods");

  let result: ToolCallResult;
  try {
    result = await callTool(client, "mthds_list_methods", { limit: 3 });
  } catch (err) {
    fail("mthds_list_methods call", errorMessage(err));
    return;
  }

  if (result.isError === true) {
    reportToolFailure("mthds_list_methods verdict", result);
    return;
  }

  const structured = result.structuredContent;
  if (!isRecord(structured)) {
    fail("structuredContent", `expected an object, got ${describe(structured)}`);
    return;
  }

  if (
    !expect(
      structured.status === "ok",
      "status",
      `expected "ok", got ${describe(structured.status)}`,
    )
  ) {
    return;
  }

  const methods = structured.methods;
  if (!expect(Array.isArray(methods), "methods", `expected an array, got ${describe(methods)}`)) {
    return;
  }
  const rows = methods as unknown[];

  expect(
    structured.returned_count === rows.length,
    "returned_count",
    `expected ${rows.length}, got ${describe(structured.returned_count)}`,
    `${rows.length} method(s) returned`,
  );

  expect(
    structured.next_cursor === null || typeof structured.next_cursor === "string",
    "next_cursor",
    `expected a string or null, got ${describe(structured.next_cursor)}`,
    structured.next_cursor === null ? "end of catalog" : "more pages available",
  );

  // The empty page is a real, passing state — it is also the state that made the
  // previous live probe vacuous, so say so out loud rather than reporting green.
  if (rows.length === 0) {
    note("catalog is EMPTY — row projection was not exercised by this run.");
  }

  let rowsValid = true;
  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      fail(`methods[${index}]`, `expected an object, got ${describe(row)}`);
      rowsValid = false;
      return;
    }
    for (const field of ["method_id", "name", "created_at"] as const) {
      if (typeof row[field] !== "string" || (row[field] as string) === "") {
        fail(
          `methods[${index}].${field}`,
          `expected a non-empty string, got ${describe(row[field])}`,
        );
        rowsValid = false;
      }
    }
    if (row.description !== null && typeof row.description !== "string") {
      fail(
        `methods[${index}].description`,
        `expected a string or null, got ${describe(row.description)}`,
      );
      rowsValid = false;
    }
  });
  if (rowsValid && rows.length > 0) {
    pass("row shape", "every row carries method_id, name, created_at, description");
  }

  const leaked = findForbiddenKeys(result, FORBIDDEN_CATALOG_KEYS);
  expect(
    leaked.length === 0,
    "projection invariant",
    `method source or org fields leaked at ${leaked.join(", ")}`,
    "no source, stored inputs/outputs, or org fields anywhere in the result",
  );
}

async function checkValidate(client: Client): Promise<void> {
  section("mthds_validate");

  let result: ToolCallResult;
  try {
    result = await callTool(client, "mthds_validate", {
      files: [{ content: VALID_BUNDLE, uri: VALID_BUNDLE_URI }],
    });
  } catch (err) {
    fail("mthds_validate call", errorMessage(err));
    return;
  }

  if (result.isError === true) {
    reportToolFailure("mthds_validate verdict", result);
    return;
  }

  const structured = result.structuredContent;
  if (!isRecord(structured)) {
    fail("structuredContent", `expected an object, got ${describe(structured)}`);
    return;
  }

  expect(structured.status === "ok", "status", `expected "ok", got ${describe(structured.status)}`);
  expect(
    structured.is_valid === true,
    "is_valid",
    `the canonical bundle did not validate: ${describe(structured.validation_errors)}`,
    "the canonical bundle validates",
  );
  expect(
    structured.is_runnable === true,
    "is_runnable",
    `expected true, got ${describe(structured.is_runnable)} (pending: ${describe(structured.pending_signatures)})`,
  );

  const summary = summaryText(result);
  expect(
    summary.trim() !== "",
    "markdown summary",
    "the API report carried no rendered_markdown",
    `${summary.length} characters`,
  );
}

async function checkInputsTemplate(client: Client): Promise<void> {
  section("mthds_inputs_template");

  let result: ToolCallResult;
  try {
    result = await callTool(client, "mthds_inputs_template", {
      files: [{ content: INPUTS_BUNDLE, uri: INPUTS_BUNDLE_URI }],
    });
  } catch (err) {
    fail("mthds_inputs_template call", errorMessage(err));
    return;
  }

  if (result.isError === true) {
    reportToolFailure("mthds_inputs_template verdict", result);
    return;
  }

  const structured = result.structuredContent;
  if (!isRecord(structured)) {
    fail("structuredContent", `expected an object, got ${describe(structured)}`);
    return;
  }

  expect(structured.status === "ok", "status", `expected "ok", got ${describe(structured.status)}`);
  expect(
    structured.is_valid === true,
    "is_valid",
    `the canonical bundle produced no template: ${describe(structured.validation_errors)}`,
  );
  expect(
    structured.pipe_ref === "smoke_inputs.write_about_topic",
    "pipe_ref",
    `expected the resolved main_pipe, got ${describe(structured.pipe_ref)}`,
  );
  const template = structured.inputs;
  if (
    expect(
      isRecord(template),
      "inputs",
      `the json template field is missing: ${describe(template)}`,
      `keys: ${isRecord(template) ? describe(Object.keys(template)) : "n/a"}`,
    )
  ) {
    expect(
      Object.prototype.hasOwnProperty.call(template, "topic"),
      "inputs.topic",
      `the declared input did not survive into the template: ${describe(template)}`,
      describe((template as Record<string, unknown>).topic),
    );
  }
  expect(
    structured.inputs_toml === undefined,
    "inputs_toml",
    `the unselected format field must be absent, got ${describe(structured.inputs_toml)}`,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const config = buildApiConfig(process.env);

  write("pipelex-mcp smoke — the workshop stdio server against a live Pipelex API");
  write(`  target: ${config.baseUrl}`);
  write(`  key:    ${config.apiKey === undefined ? "NOT SET" : "set"}`);
  if (config.apiKey === undefined) {
    note("Without PIPELEX_API_KEY every org-scoped call will fail as a config error.");
  }

  if (!existsSync(TSX_BIN)) {
    write("");
    write(`Cannot start the workshop server: ${TSX_BIN} is missing. Run 'npm install' first.`);
    process.exitCode = 1;
    return;
  }

  // The child gets the SDK's safe base environment plus this repo's two knobs, so
  // the server resolves exactly the API this script just reported.
  const childEnv: Record<string, string> = { ...getDefaultEnvironment() };
  if (process.env.PIPELEX_BASE_URL !== undefined) {
    childEnv.PIPELEX_BASE_URL = process.env.PIPELEX_BASE_URL;
  }
  if (process.env.PIPELEX_API_KEY !== undefined) {
    childEnv.PIPELEX_API_KEY = process.env.PIPELEX_API_KEY;
  }

  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [SERVER_ENTRYPOINT],
    cwd: REPO_ROOT,
    env: childEnv,
    stderr: "inherit",
  });
  const client = new Client({ name: "pipelex-mcp-smoke", version: "1" }, { capabilities: {} });

  section("handshake");
  try {
    await client.connect(transport);
  } catch (err) {
    fail("connect", `the workshop server did not start: ${errorMessage(err)}`);
    await transport.close().catch(() => undefined);
    finish();
    return;
  }

  try {
    const info = client.getServerVersion();
    pass("initialize", `${info?.name ?? "unknown"} ${info?.version ?? "?"}`);

    const advertised = (await client.listTools()).tools.map((tool) => tool.name);
    const required = ["mthds_list_methods", "mthds_validate", "mthds_inputs_template"];
    const missing = required.filter((name) => !advertised.includes(name));
    expect(
      missing.length === 0,
      "tools/list",
      `the workshop did not advertise ${missing.join(", ")}`,
      `${advertised.length} tools advertised`,
    );

    if (missing.length === 0) {
      await checkListMethods(client);
      await checkValidate(client);
      await checkInputsTemplate(client);
    }
  } catch (err) {
    fail("smoke run", errorMessage(err));
  } finally {
    await client.close().catch(() => undefined);
  }

  finish();
}

function finish(): void {
  write("");
  if (failures.length === 0) {
    write("SMOKE PASSED — the shipped client agrees with the live API.");
    return;
  }
  write(`SMOKE FAILED — ${failures.length} check(s) failed:`);
  for (const failure of failures) write(`  - ${failure}`);
  write("");
  write(
    "A failure here is the real client disagreeing with the real API — the class of break " +
      "`make all` cannot see. If the API moved, the fix belongs in ../pipelex-sdk-js, then a bump here.",
  );
  process.exitCode = 1;
}

await main();
