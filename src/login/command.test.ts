import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type { UserProfile } from "@pipelex/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ApiConfig } from "../capabilities/shared.js";
import { DEFAULT_API_URL } from "../capabilities/shared.js";
import {
  LOGIN_COMMAND,
  RELATIVE_HOME_SENTENCE,
  resolveWorkshopCredentials,
} from "../credentials.js";
import {
  DEFAULT_APP_URL,
  EXIT_INTERRUPTED,
  EXIT_NOT_SAVED,
  EXIT_SAVED,
  EXIT_USAGE,
  LOGIN_USAGE,
  PASTE_COMMAND,
  browserOpenerCommand,
  checkApiKey,
  cliAuthUrl,
  parseKeyLabel,
  parseLoginArgs,
  platformBrowserOpener,
  resolveAppOrigin,
  runLoginCommand,
} from "./command.js";
import type {
  BrowserOpener,
  LoginDependencies,
  LoginEnv,
  MeClient,
  SpawnFunction,
} from "./command.js";
import { openLoopbackListener } from "./loopback.js";
import type { HiddenInput } from "./paste.js";

const KEY = "plx_sk_minted_by_the_page";
const PROFILE: UserProfile = { email: "ada@example.com", user_id: "user_1", full_name: "Ada" };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeHome(envFile?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-login-"));
  tempDirs.push(dir);
  if (envFile !== undefined) await fs.writeFile(path.join(dir, ".env"), envFile);
  return dir;
}

async function savedFile(home: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(home, ".env"), "utf8");
  } catch {
    return undefined;
  }
}

/** A client whose `getMe` answers `profile`, or throws `error`, recording what it was built with. */
function fakeClient(answer: { profile?: unknown; error?: unknown } = { profile: PROFILE }): {
  createClient: (config: ApiConfig) => MeClient;
  configs: ApiConfig[];
} {
  const configs: ApiConfig[] = [];
  return {
    configs,
    createClient: (config) => {
      configs.push(config);
      return {
        getMe: async () => {
          if (answer.error !== undefined) throw answer.error;
          return answer.profile as UserProfile;
        },
      };
    },
  };
}

/**
 * The browser: it reads the port and state from the link and sends the
 * redirect the page sends, with `key` (or `params` as given), after the
 * opener returns, as a real browser does.
 */
function browserSending(
  key: string,
  options: { opened?: boolean; forgedFirst?: boolean } = {},
): BrowserOpener & { urls: string[] } {
  const urls: string[] = [];
  const opener = async (url: string): Promise<boolean> => {
    urls.push(url);
    const link = new URL(url);
    const port = Number(link.searchParams.get("callback_port"));
    const state = link.searchParams.get("state") ?? "";
    setImmediate(() => {
      void (async () => {
        if (options.forgedFirst) {
          await redirect(port, new URLSearchParams({ api_key: "plx_sk_forged", state: "nope" }));
        }
        await redirect(port, new URLSearchParams({ api_key: key, state }));
      })();
    });
    return options.opened ?? true;
  };
  return Object.assign(opener, { urls });
}

function redirect(port: number, query: URLSearchParams): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: `/callback?${query.toString()}`, agent: false },
        (response) => {
          response.resume();
          response.on("end", () => resolve());
        },
      )
      .on("error", reject);
  });
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function login(args: string[], deps: LoginDependencies): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const code = await runLoginCommand(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    timeoutMs: 5_000,
    ...deps,
  });
  return { code, stdout, stderr };
}

/** No output ever quotes a key, the one received or the one the shell exports. */
function expectNoKeyIn(run: Run, ...keys: string[]): void {
  for (const key of keys) {
    expect(run.stdout).not.toContain(key);
    expect(run.stderr).not.toContain(key);
  }
}

describe("parseLoginArgs", () => {
  it("takes --paste and --help, and nothing else", () => {
    expect(parseLoginArgs([])).toEqual({ kind: "run", paste: false });
    expect(parseLoginArgs(["--paste"])).toEqual({ kind: "run", paste: true });
    expect(parseLoginArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseLoginArgs(["--paste", "--help"])).toEqual({ kind: "help" });
    expect(parseLoginArgs(["--paset"])).toEqual({
      kind: "usage_error",
      message: "Unknown option for login: --paset.",
    });
    expect(parseLoginArgs(["-h"]).kind).toBe("usage_error");
    expect(parseLoginArgs(["--paste", "extra"]).kind).toBe("usage_error");
  });

  it("never echoes an argument that could be a key", () => {
    const parsed = parseLoginArgs([KEY]);

    expect(parsed.kind).toBe("usage_error");
    expect(JSON.stringify(parsed)).not.toContain(KEY);
  });

  it("takes a key label after --label or with =, trimmed", () => {
    expect(parseLoginArgs(["--label", "my-laptop"])).toEqual({
      kind: "run",
      paste: false,
      label: "my-laptop",
    });
    expect(parseLoginArgs(["--label=  proof lab: vibe  "])).toEqual({
      kind: "run",
      paste: false,
      label: "proof lab: vibe",
    });
    expect(parseLoginArgs(["--label=-dashed"])).toEqual({
      kind: "run",
      paste: false,
      label: "-dashed",
    });
    expect(parseLoginArgs(["--label", "ci", "--help"])).toEqual({ kind: "help" });
  });

  it("refuses --label with no label after it, given twice, or beside --paste", () => {
    const missing =
      "--label needs a key label after it, such as --label my-laptop; write --label=<name> for one that starts with -.";
    expect(parseLoginArgs(["--label"])).toEqual({ kind: "usage_error", message: missing });
    expect(parseLoginArgs(["--label", "--paste"])).toEqual({
      kind: "usage_error",
      message: missing,
    });
    expect(parseLoginArgs(["--label", "a", "--label=b"])).toEqual({
      kind: "usage_error",
      message: "--label is given more than once: give one.",
    });
    expect(parseLoginArgs(["--paste", "--label", "ci"])).toEqual({
      kind: "usage_error",
      message:
        "--paste takes no --label: a label names the key a browser login creates or replaces, and a pasted key already exists.",
    });
    // An unknown option that only starts like --label is still unknown.
    expect(parseLoginArgs(["--labels", "ci"])).toEqual({
      kind: "usage_error",
      message: "Unknown option for login: --labels.",
    });
    expect(parseLoginArgs(["--label", "ci", "extra"])).toEqual({
      kind: "usage_error",
      message: "Unexpected argument for login: it takes only --label <name>, --paste or --help.",
    });
  });

  it("lets --help win over a label it would refuse", () => {
    expect(parseLoginArgs(["--help", "--label="])).toEqual({ kind: "help" });
  });
});

describe("parseKeyLabel", () => {
  it.each([
    ["", "The key label is empty once trimmed: a label is 1 to 64 characters."],
    ["   ", "The key label is empty once trimmed: a label is 1 to 64 characters."],
    ["a".repeat(65), "The key label is longer than 64 characters: a label is 1 to 64 characters."],
    // Characters outside the Basic Multilingual Plane count once, as the app counts them.
    ["🔑".repeat(65), "The key label is longer than 64 characters: a label is 1 to 64 characters."],
    [
      "a\tb",
      "The key label holds a control character, such as a tab or a line break, which a key label cannot hold.",
    ],
    [
      "a\nb",
      "The key label holds a control character, such as a tab or a line break, which a key label cannot hold.",
    ],
    [
      "bell\u0007",
      "The key label holds a control character, such as a tab or a line break, which a key label cannot hold.",
    ],
    [
      "del\u007f",
      "The key label holds a control character, such as a tab or a line break, which a key label cannot hold.",
    ],
    [
      "c1\u009b31m",
      "The key label holds a control character, such as a tab or a line break, which a key label cannot hold.",
    ],
    // The platform trims a trailing NEL that the app keeps, so the key would carry another label.
    [
      "ci\u0085",
      "The key label holds a control character, such as a tab or a line break, which a key label cannot hold.",
    ],
    [
      KEY,
      "The key label starts with plx_sk_, as a Pipelex API key does: give --label a name for the key, never the key itself.",
    ],
  ])("refuses %j, without quoting it", (raw, message) => {
    const check = parseKeyLabel(raw);

    expect(check).toEqual({ ok: false, message });
    if (raw.trim() !== "") expect(message).not.toContain(raw.trim());
  });

  it.each([
    ["ci", "ci"],
    ["  Proof lab vibe  ", "Proof lab vibe"],
    ["a".repeat(64), "a".repeat(64)],
    [` ${"a".repeat(64)}\n`, "a".repeat(64)],
    ["🔑".repeat(64), "🔑".repeat(64)],
    ["Clé de l'équipe / CI #2", "Clé de l'équipe / CI #2"],
  ])("takes %j as %j", (raw, label) => {
    expect(parseKeyLabel(raw)).toEqual({ ok: true, label });
  });

  it("takes exactly the labels the app takes, short of a control character or a key's prefix", () => {
    // The app's rule, `cliKeyLabelSchema` in pipelex-app/src/lib/cli-login.ts.
    const appSchema = z.string().trim().min(1).max(64);
    const samples = [
      "",
      " ",
      "x",
      " x ",
      "a".repeat(64),
      "a".repeat(65),
      ` ${"a".repeat(64)} `,
      "🔑".repeat(64),
      "🔑".repeat(65),
      " nbsp ",
      "﻿bom",
      "Pipelex CLI",
    ];
    for (const raw of samples) {
      const app = appSchema.safeParse(raw);
      const cli = parseKeyLabel(raw);
      expect(cli.ok, JSON.stringify(raw)).toBe(app.success);
      if (cli.ok && app.success) expect(cli.label).toBe(app.data);
    }
  });
});

describe("runLoginCommand's arguments", () => {
  it("prints the usage on standard output for --help, and saves nothing", async () => {
    const home = await makeHome();
    const run = await login(["--help"], { env: { PIPELEX_HOME: home } });

    expect(run).toEqual({ code: EXIT_SAVED, stdout: LOGIN_USAGE, stderr: "" });
    expect(LOGIN_USAGE).toContain(LOGIN_COMMAND);
    expect(await savedFile(home)).toBeUndefined();
  });

  it("refuses a mistyped option with the usage and a non-zero exit, opening nothing", async () => {
    const openListener = vi.fn(openLoopbackListener);
    const run = await login(["--paset"], { openListener });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`Unknown option for login: --paset.\n\n${LOGIN_USAGE}`);
    expect(openListener).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty", ["--label", "  "]],
    ["a too long", ["--label", "a".repeat(65)]],
    ["a control character's", ["--label=a\tb"]],
    ["a key-shaped", ["--label", KEY]],
  ])("refuses %s label with the usage before listening or opening a browser", async (_, args) => {
    const home = await makeHome();
    const openListener = vi.fn(openLoopbackListener);
    const openBrowser = vi.fn(async () => true);

    const run = await login(args, { env: { PIPELEX_HOME: home }, openListener, openBrowser });

    expect(run.code).toBe(EXIT_USAGE);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^The key label .*\n\n/);
    expect(run.stderr.endsWith(LOGIN_USAGE)).toBe(true);
    expect(openListener).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(await savedFile(home)).toBeUndefined();
    expectNoKeyIn(run, KEY);
  });
});

describe("the browser login", () => {
  it("prints the link, opens the browser, checks the key and saves it, never quoting it", async () => {
    const home = await makeHome();
    const browser = browserSending(KEY);
    let printedBeforeOpening = "";
    const openBrowser: BrowserOpener = async (url) => {
      printedBeforeOpening = run.stdout;
      return browser(url);
    };
    const client = fakeClient();
    const run: Run = { code: -1, stdout: "", stderr: "" };

    run.code = await runLoginCommand([], {
      env: { PIPELEX_HOME: home },
      stdout: (text) => (run.stdout += text),
      stderr: (text) => (run.stderr += text),
      openBrowser,
      createClient: client.createClient,
    });

    const [url] = browser.urls;
    const link = new URL(url);
    expect(`${link.origin}${link.pathname}`).toBe(`${DEFAULT_APP_URL}/auth/cli`);
    expect([...link.searchParams.keys()]).toEqual(["callback_port", "state"]);
    expect(link.searchParams.get("state")).toMatch(/^[A-Za-z0-9._~-]{1,256}$/);
    expect(printedBeforeOpening).toContain(`If it does not open, visit: ${url}`);
    expect(run.code).toBe(EXIT_SAVED);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("Waiting up to 300 seconds for the key…");
    expect(run.stdout).toContain(`Checking the key with ${DEFAULT_API_URL}…`);
    expect(run.stdout).toContain(
      `Logged in as ada@example.com. Your Pipelex API key is saved in \`${path.join(home, ".env")}\` as PIPELEX_API_KEY.`,
    );
    expect(run.stdout).toContain(
      "The workshop uses it whenever its host passes no PIPELEX_API_KEY, from its next tool call, with no restart.",
    );
    expect(await savedFile(home)).toBe(`PIPELEX_API_KEY=${KEY}\n`);
    expect(client.configs).toHaveLength(1);
    expect(client.configs[0]).toMatchObject({ baseUrl: DEFAULT_API_URL, apiKey: KEY });
    expect(client.configs[0].appInfo?.()).toMatchObject({
      name: "pipelex-mcp",
      details: ["workshop"],
    });
    expect(run.stdout).toContain(
      'Once signed in, click "Create the key" on the page to hand this login a new key.',
    );
    expectNoKeyIn(run, KEY);
  });

  it("passes the page its key label, trimmed, and says the page replaces that key", async () => {
    const home = await makeHome();
    const browser = browserSending(KEY);

    const run = await login(["--label", "  proof-lab vibe/topic-1  "], {
      env: { PIPELEX_HOME: home },
      openBrowser: browser,
      createClient: fakeClient().createClient,
    });

    const link = new URL(browser.urls[0]);
    expect(`${link.origin}${link.pathname}`).toBe(`${DEFAULT_APP_URL}/auth/cli`);
    expect([...link.searchParams.keys()]).toEqual(["callback_port", "state", "label"]);
    expect(link.searchParams.get("label")).toBe("proof-lab vibe/topic-1");
    expect(run.stdout).toContain(
      'Once signed in, click "Replace the key" on the page to replace your key labelled "proof-lab vibe/topic-1" in the organization it names, which then stops working, or "Create the key" when you hold none.',
    );
    expect(run.code).toBe(EXIT_SAVED);
    expect(run.stderr).toBe("");
    expect(await savedFile(home)).toBe(`PIPELEX_API_KEY=${KEY}\n`);
    expectNoKeyIn(run, KEY);
  });

  it("tells a labelled login whose key went unused that the next login under the label replaces it", async () => {
    const timedOut = await login(["--label=ci"], {
      env: { PIPELEX_HOME: await makeHome() },
      openBrowser: async () => true,
      createClient: fakeClient().createClient,
      timeoutMs: 30,
    });

    expect(timedOut.code).toBe(EXIT_NOT_SAVED);
    expect(timedOut.stderr).toContain(
      `If you signed in and confirmed the key, the page may have created or replaced one that never reached this login: the next login with the same \`--label\` replaces it, or revoke it on the Developer page of the Pipelex app (${DEFAULT_APP_URL}).`,
    );
    expect(timedOut.stderr).toContain(
      `Run \`${LOGIN_COMMAND}\` again with the same \`--label\`, or create a key on the Developer page of the Pipelex app (${DEFAULT_APP_URL}) and run \`${PASTE_COMMAND}\`.`,
    );

    const refusedHome = await makeHome();
    const refused = await login(["--label=ci"], {
      env: { PIPELEX_HOME: refusedHome },
      openBrowser: browserSending(KEY),
      createClient: fakeClient({
        error: new ApiResponseError("HTTP 401", `${DEFAULT_API_URL}/v1/me`, 401, "refused", "{}"),
      }).createClient,
    });

    expect(refused.code).toBe(EXIT_NOT_SAVED);
    expect(refused.stderr).toContain(
      `The key this login received went unused: the next login with the same \`--label\` replaces it, or revoke it on the Developer page of the Pipelex app (${DEFAULT_APP_URL}).`,
    );
    expect(refused.stderr).toContain(
      `then run \`${LOGIN_COMMAND}\` again with the same \`--label\`.`,
    );
    expect(await savedFile(refusedHome)).toBeUndefined();
    expectNoKeyIn(refused, KEY);
  });

  it("says when a sign-in from another page is refused, and goes on waiting", async () => {
    const home = await makeHome();

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openBrowser: browserSending(KEY, { forgedFirst: true }),
      createClient: fakeClient().createClient,
    });

    expect(run.code).toBe(EXIT_SAVED);
    expect(run.stderr).toContain(
      "Refused a sign-in that did not come from the page this login opened; still waiting.",
    );
    expect(await savedFile(home)).toBe(`PIPELEX_API_KEY=${KEY}\n`);
    expectNoKeyIn(run, KEY, "plx_sk_forged");
  });

  it("reports a sign-in refused before the browser opener returns", async () => {
    const home = await makeHome();
    // The forged callback is answered before the opener resolves, and the
    // real one is sent after it, as a slow opener would let happen.
    const openBrowser: BrowserOpener = async (url) => {
      const link = new URL(url);
      const port = Number(link.searchParams.get("callback_port"));
      const state = link.searchParams.get("state") ?? "";
      await redirect(port, new URLSearchParams({ api_key: "plx_sk_forged", state: "nope" }));
      setImmediate(() => void redirect(port, new URLSearchParams({ api_key: KEY, state })));
      return true;
    };

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openBrowser,
      createClient: fakeClient().createClient,
    });

    expect(run.code).toBe(EXIT_SAVED);
    expect(run.stderr).toBe(
      "Refused a sign-in that did not come from the page this login opened; still waiting.\n",
    );
    expect(await savedFile(home)).toBe(`PIPELEX_API_KEY=${KEY}\n`);
    expectNoKeyIn(run, KEY, "plx_sk_forged");
  });

  it("takes an opener that throws as no browser, and still waits for the key", async () => {
    const home = await makeHome();
    const browser = browserSending(KEY);

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openBrowser: async (url) => {
        await browser(url);
        throw new Error("no opener");
      },
      createClient: fakeClient().createClient,
    });

    expect(run.code).toBe(EXIT_SAVED);
    expect(run.stderr).toContain("No browser could be opened here.");
  });

  it("says no browser could be opened, keeps the printed link, and still takes the key", async () => {
    const home = await makeHome();
    const browser = browserSending(KEY, { opened: false });

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openBrowser: browser,
      createClient: fakeClient().createClient,
    });

    expect(run.stdout).toContain(
      `If it does not open, visit: ${browser.urls[0]} (over SSH or in a container, run \`${PASTE_COMMAND}\` instead)`,
    );
    expect(run.stderr).toContain(
      `No browser could be opened here. Open the link above in a browser on this machine, or press Ctrl-C and run \`${PASTE_COMMAND}\`.`,
    );
    expect(run.code).toBe(EXIT_SAVED);
  });

  it("gives up after the wait, names the paste, and saves nothing", async () => {
    const home = await makeHome();

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openBrowser: async () => true,
      createClient: fakeClient().createClient,
      timeoutMs: 30,
    });

    expect(run.code).toBe(EXIT_NOT_SAVED);
    expect(run.stderr).toContain("No key arrived within 1 seconds. Nothing was saved.");
    // The page may have minted a key whose redirect never reached the listener.
    expect(run.stderr).toContain(
      `If you signed in and confirmed the key, the page may have created one that never reached this login: it went unused, so revoke it on the Developer page of the Pipelex app (${DEFAULT_APP_URL}).`,
    );
    expect(run.stderr).toContain(`\`${PASTE_COMMAND}\``);
    expect(await savedFile(home)).toBeUndefined();
  });

  it("refuses a key that is not a Pipelex API key without asking the API", async () => {
    const home = await makeHome();
    const client = fakeClient();

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openBrowser: browserSending("sk-live-not-pipelex"),
      createClient: client.createClient,
    });

    expect(run.code).toBe(EXIT_NOT_SAVED);
    expect(run.stderr).toContain("That is not a Pipelex API key");
    expect(client.configs).toEqual([]);
    expect(await savedFile(home)).toBeUndefined();
    expectNoKeyIn(run, "sk-live-not-pipelex");
  });

  it.each([401, 403])("saves nothing when the API refuses the key with %i", async (status) => {
    const home = await makeHome("A=1\n");

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openBrowser: browserSending(KEY),
      createClient: fakeClient({
        error: new ApiResponseError(
          `HTTP ${status}`,
          `${DEFAULT_API_URL}/v1/me`,
          status,
          "refused",
          "{}",
        ),
      }).createClient,
    });

    expect(run.code).toBe(EXIT_NOT_SAVED);
    expect(run.stderr).toContain(
      `${DEFAULT_API_URL} refused the key (HTTP ${status}). Nothing was saved.`,
    );
    // The page minted the key before the API refused it, so it sits unused in the organization.
    expect(run.stderr).toContain(
      `The key this login received went unused: revoke it on the Developer page of the Pipelex app (${DEFAULT_APP_URL}).`,
    );
    expect(run.stderr).toContain(
      `belongs to the hosted API, ${DEFAULT_API_URL}, used when PIPELEX_BASE_URL is not set`,
    );
    expect(await savedFile(home)).toBe("A=1\n");
    expectNoKeyIn(run, KEY);
  });

  it("saves a key it could not check, with a warning saying why", async () => {
    const unreachable = new ApiUnreachableError("down", DEFAULT_API_URL, "ECONNREFUSED");
    const serverError = new ApiResponseError(
      "HTTP 500",
      `${DEFAULT_API_URL}/v1/me`,
      500,
      "error",
      "{}",
    );
    const cases: [{ profile?: unknown; error?: unknown }, string][] = [
      [{ error: unreachable }, `${DEFAULT_API_URL} could not be reached`],
      [{ error: serverError }, `${DEFAULT_API_URL} answered HTTP 500 (runtime.unexpected)`],
      [{ profile: { nothing: "here" } }, `${DEFAULT_API_URL} did not answer with an account`],
      [{ error: new TypeError("bad body") }, `${DEFAULT_API_URL} did not answer with an account`],
    ];

    for (const [answer, reason] of cases) {
      const home = await makeHome();

      const run = await login([], {
        env: { PIPELEX_HOME: home },
        openBrowser: browserSending(KEY),
        createClient: fakeClient(answer).createClient,
      });

      expect(run.code, reason).toBe(EXIT_SAVED);
      expect(run.stderr, reason).toContain(`Could not check the key: ${reason}.`);
      expect(run.stderr, reason).toContain("It is saved anyway, in");
      expect(await savedFile(home), reason).toBe(`PIPELEX_API_KEY=${KEY}\n`);
      expectNoKeyIn(run, KEY);
    }
  });

  it("checks against the file's base URL even when the shell exports a key, and warns of the shadowing", async () => {
    const home = await makeHome("PIPELEX_BASE_URL=https://api-dev.pipelex.com\n");
    const client = fakeClient();
    const shellKey = "plx_sk_exported_by_the_shell";

    const run = await login([], {
      env: { PIPELEX_HOME: home, PIPELEX_API_KEY: shellKey },
      openBrowser: browserSending(KEY),
      createClient: client.createClient,
    });

    expect(run.code).toBe(EXIT_SAVED);
    expect(client.configs[0]).toMatchObject({
      baseUrl: "https://api-dev.pipelex.com",
      apiKey: KEY,
    });
    expect(run.stdout).toContain(
      `Checking the key with https://api-dev.pipelex.com (the PIPELEX_BASE_URL saved in \`${path.join(home, ".env")}\`)…`,
    );
    expect(run.stderr).toContain(
      "This shell sets PIPELEX_API_KEY, so a workshop started from it uses that value instead of the saved key for as long as it is set.",
    );
    expect(await savedFile(home)).toBe(
      `PIPELEX_BASE_URL=https://api-dev.pipelex.com\nPIPELEX_API_KEY=${KEY}\n`,
    );
    expectNoKeyIn(run, KEY, shellKey);
  });

  it("lets the environment's base URL beat the file's, and names it when the key is refused", async () => {
    const home = await makeHome("PIPELEX_BASE_URL=https://api-dev.pipelex.com\n");
    const client = fakeClient({
      error: new ApiResponseError("HTTP 401", "http://127.0.0.1:8081/v1/me", 401, "refused", "{}"),
    });

    const run = await login([], {
      env: { PIPELEX_HOME: home, PIPELEX_BASE_URL: "http://127.0.0.1:8081" },
      openBrowser: browserSending(KEY),
      createClient: client.createClient,
    });

    expect(client.configs[0].baseUrl).toBe("http://127.0.0.1:8081");
    expect(run.stderr).toContain(
      "belongs to the API PIPELEX_BASE_URL names, http://127.0.0.1:8081",
    );
  });

  describe("the base URL the key was checked against", () => {
    const LOCAL = "http://127.0.0.1:8081";

    it("is saved beside the key when the file has none, so a host without this shell's environment pairs them", async () => {
      const home = await makeHome();
      const client = fakeClient();

      const run = await login([], {
        env: { PIPELEX_HOME: home, PIPELEX_BASE_URL: `${LOCAL}/` },
        openBrowser: browserSending(KEY),
        createClient: client.createClient,
      });

      expect(run.code).toBe(EXIT_SAVED);
      expect(client.configs[0].baseUrl).toBe(`${LOCAL}/`);
      expect(await savedFile(home)).toBe(`PIPELEX_API_KEY=${KEY}\nPIPELEX_BASE_URL=${LOCAL}/\n`);
      expect(run.stdout).toContain(
        `Your Pipelex API key is saved in \`${path.join(home, ".env")}\` as PIPELEX_API_KEY, beside PIPELEX_BASE_URL for ${LOCAL}.`,
      );
      expect(run.stdout).toContain(`Checking the key with ${LOCAL}…`);
      expect(run.stdout).toContain(
        `PIPELEX_BASE_URL is saved with the key, so a host that does not pass this shell's environment, and the pipelex CLI, which loads that file over its environment, now send the key to ${LOCAL} in every shell.`,
      );
      // A host such as Claude Desktop passes neither variable, and reads the pair from the file.
      const credentials = await resolveWorkshopCredentials({ PIPELEX_HOME: home });
      expect(credentials).toMatchObject({ apiKey: KEY, baseUrl: `${LOCAL}/`, source: "file" });
      expectNoKeyIn(run, KEY);
    });

    it("replaces the file's base URL when this shell names another, and says so on an unchecked key too", async () => {
      const home = await makeHome(`PIPELEX_BASE_URL=https://api-dev.pipelex.com\n`);
      const unreachable = new ApiUnreachableError("down", LOCAL, "ECONNREFUSED");

      const run = await login([], {
        env: { PIPELEX_HOME: home, PIPELEX_BASE_URL: LOCAL },
        openBrowser: browserSending(KEY),
        createClient: fakeClient({ error: unreachable }).createClient,
      });

      expect(run.code).toBe(EXIT_SAVED);
      expect(await savedFile(home)).toBe(`PIPELEX_BASE_URL=${LOCAL}\nPIPELEX_API_KEY=${KEY}\n`);
      expect(run.stderr).toContain(
        `It is saved anyway, in \`${path.join(home, ".env")}\` as PIPELEX_API_KEY, beside PIPELEX_BASE_URL for ${LOCAL}:`,
      );
      // No API checked this key, so the sentence must not say one did.
      expect(run.stdout).toContain(
        `PIPELEX_BASE_URL is saved with the key, so a host that does not pass this shell's environment, and the pipelex CLI, which loads that file over its environment, now send the key to ${LOCAL} in every shell.`,
      );
      expect(run.stdout).not.toContain("checked it");
    });

    it("is left alone when this shell sets none, and the file's own line is kept", async () => {
      const home = await makeHome(`PIPELEX_BASE_URL=${LOCAL}\n`);

      const run = await login([], {
        env: { PIPELEX_HOME: home },
        openBrowser: browserSending(KEY),
        createClient: fakeClient().createClient,
      });

      expect(run.code).toBe(EXIT_SAVED);
      expect(await savedFile(home)).toBe(`PIPELEX_BASE_URL=${LOCAL}\nPIPELEX_API_KEY=${KEY}\n`);
      expect(run.stdout).not.toContain("beside PIPELEX_BASE_URL");
      expect(run.stdout).not.toContain("PIPELEX_BASE_URL is saved with the key");
    });

    it("is not written when this shell sets the one the file already yields", async () => {
      const withLine = await makeHome(`PIPELEX_BASE_URL=${LOCAL}\n`);
      const withNone = await makeHome();

      const same = await login([], {
        env: { PIPELEX_HOME: withLine, PIPELEX_BASE_URL: LOCAL },
        openBrowser: browserSending(KEY),
        createClient: fakeClient().createClient,
      });
      const hosted = await login([], {
        env: { PIPELEX_HOME: withNone, PIPELEX_BASE_URL: DEFAULT_API_URL },
        openBrowser: browserSending(KEY),
        createClient: fakeClient().createClient,
      });

      expect(same.code).toBe(EXIT_SAVED);
      expect(await savedFile(withLine)).toBe(`PIPELEX_BASE_URL=${LOCAL}\nPIPELEX_API_KEY=${KEY}\n`);
      expect(hosted.code).toBe(EXIT_SAVED);
      expect(await savedFile(withNone)).toBe(`PIPELEX_API_KEY=${KEY}\n`);
      for (const run of [same, hosted]) {
        expect(run.stdout).not.toContain("PIPELEX_BASE_URL is saved with the key");
      }
    });

    it("is refused before any key is minted when a .env file cannot hold it unquoted", async () => {
      const home = await makeHome("A=1\n");
      const openListener = vi.fn(openLoopbackListener);

      const run = await login([], {
        env: { PIPELEX_HOME: home, PIPELEX_BASE_URL: "https://api-dev.pipelex.com#" },
        openListener,
      });

      expect(run.code).toBe(EXIT_NOT_SAVED);
      expect(run.stderr).toBe(
        `This shell's PIPELEX_BASE_URL would have to be saved beside the key in \`${path.join(home, ".env")}\`, and a .env file cannot hold it unquoted: it holds a #, a line break, enclosing quotes or a space at either end. Nothing was saved.\nFix or unset PIPELEX_BASE_URL in this shell, then run \`${LOGIN_COMMAND}\` again.\n`,
      );
      expect(openListener).not.toHaveBeenCalled();
      expect(await savedFile(home)).toBe("A=1\n");
    });

    it("is refused before any key is minted when the API client would refuse it", async () => {
      for (const baseUrl of ["https://api.pipelex.com/v1", "api.pipelex.com"]) {
        const home = await makeHome();
        const openListener = vi.fn(openLoopbackListener);

        const run = await login([], {
          env: { PIPELEX_HOME: home, PIPELEX_BASE_URL: baseUrl },
          openListener,
        });

        expect(run.code, baseUrl).toBe(EXIT_NOT_SAVED);
        expect(run.stderr, baseUrl).toBe(
          `This shell's PIPELEX_BASE_URL is not a host-only http or https URL, such as ${DEFAULT_API_URL}, with no path, credentials, query or fragment, so the workshop could not use a key saved for it. Nothing was saved.\nFix or unset PIPELEX_BASE_URL in this shell, then run \`${LOGIN_COMMAND}\` again.\n`,
        );
        expect(openListener, baseUrl).not.toHaveBeenCalled();
        expect(await savedFile(home), baseUrl).toBeUndefined();
      }
    });

    it("is refused before any key is minted when the file holds one the client refuses, set in this shell too or not", async () => {
      const secret = "https://user:secret@api-dev.pipelex.com";
      for (const env of [{ PIPELEX_BASE_URL: secret }, {}]) {
        const home = await makeHome(`PIPELEX_BASE_URL=${secret}\n`);
        const openListener = vi.fn(openLoopbackListener);

        const run = await login(["--paste"], {
          env: { PIPELEX_HOME: home, ...env },
          stdin: new FakeTerminal(true, [KEY, "\r"]),
          openListener,
        });

        expect(run.code).toBe(EXIT_NOT_SAVED);
        expect(run.stderr).toContain(
          "PIPELEX_BASE_URL" in env
            ? "This shell's PIPELEX_BASE_URL is not a host-only http or https URL"
            : `The PIPELEX_BASE_URL saved in \`${path.join(home, ".env")}\` is not a host-only http or https URL`,
        );
        expect(run.stderr).toContain(
          "PIPELEX_BASE_URL" in env
            ? `Fix or unset PIPELEX_BASE_URL in this shell, then run \`${PASTE_COMMAND}\` again.`
            : `Fix or remove PIPELEX_BASE_URL in that file, then run \`${PASTE_COMMAND}\` again.`,
        );
        expect(run.stdout).not.toContain("Paste a Pipelex API key");
        expect(openListener).not.toHaveBeenCalled();
        expect(await savedFile(home)).toBe(`PIPELEX_BASE_URL=${secret}\n`);
        expectNoKeyIn(run, KEY, secret, "secret");
      }
    });

    it("is the one the key was checked against, even when the file changed during the check", async () => {
      // No PIPELEX_BASE_URL in this shell: the key is checked against the
      // file's, or the hosted API, and another program writes the file's
      // PIPELEX_BASE_URL while the check runs.
      for (const before of [`PIPELEX_BASE_URL=${LOCAL}\n`, ""]) {
        const home = await makeHome(before);
        const configs: ApiConfig[] = [];
        const createClient = (config: ApiConfig): MeClient => {
          configs.push(config);
          return {
            getMe: async () => {
              await fs.writeFile(
                path.join(home, ".env"),
                "PIPELEX_BASE_URL=https://api-elsewhere.example.com\n",
              );
              return PROFILE;
            },
          };
        };

        const run = await login([], {
          env: { PIPELEX_HOME: home },
          openBrowser: browserSending(KEY),
          createClient,
        });

        expect(run.code, before).toBe(EXIT_SAVED);
        expect(configs, before).toHaveLength(1);
        const credentials = await resolveWorkshopCredentials({ PIPELEX_HOME: home });
        expect(credentials, before).toMatchObject({ apiKey: KEY, baseUrl: configs[0].baseUrl });
        expect(run.stdout, before).toContain("PIPELEX_BASE_URL is saved with the key");
        expectNoKeyIn(run, KEY);
      }
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says the key went unused and should be revoked when it cannot be saved, and exits non-zero",
    async () => {
      const home = await makeHome();
      // The home is writable when the login starts, and stops being so while
      // the key is checked, after the browser has minted it.
      const lockHomeWhileChecking = (): MeClient => ({
        getMe: async () => {
          await fs.chmod(home, 0o500);
          return PROFILE;
        },
      });
      let run: Run;
      try {
        run = await login([], {
          env: { PIPELEX_HOME: home },
          openBrowser: browserSending(KEY),
          createClient: lockHomeWhileChecking,
        });
      } finally {
        await fs.chmod(home, 0o700);
      }

      expect(run.code).toBe(EXIT_NOT_SAVED);
      expect(run.stderr).toContain(
        `The key could not be saved in \`${path.join(home, ".env")}\`: permission denied. Nothing was saved.`,
      );
      expect(run.stderr).toContain(
        `The key this login received went unused: revoke it on the Developer page of the Pipelex app (${DEFAULT_APP_URL}). Fix that file, then run \`${LOGIN_COMMAND}\` again.`,
      );
      expect(run.stdout).not.toContain("Logged in");
      expect(await savedFile(home)).toBeUndefined();
      expect(await fs.readdir(home)).toEqual([]);
      expectNoKeyIn(run, KEY);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a home it cannot write in before any key is minted",
    async () => {
      const home = await makeHome();
      await fs.chmod(home, 0o500);
      const openListener = vi.fn(openLoopbackListener);
      let run: Run;
      try {
        run = await login([], { env: { PIPELEX_HOME: home }, openListener });
      } finally {
        await fs.chmod(home, 0o700);
      }

      expect(run.code).toBe(EXIT_NOT_SAVED);
      expect(run.stderr).toBe(
        `A key cannot be saved in \`${path.join(home, ".env")}\`: permission denied. Nothing was saved.\nFix that file, then run \`${LOGIN_COMMAND}\` again.\n`,
      );
      expect(openListener).not.toHaveBeenCalled();
    },
  );

  it("refuses a relative PIPELEX_HOME before any key is minted", async () => {
    const openListener = vi.fn(openLoopbackListener);
    const openBrowser = vi.fn(async () => true);

    const run = await login([], {
      env: { PIPELEX_HOME: "relative/home" },
      openListener,
      openBrowser,
    });

    expect(run.code).toBe(EXIT_NOT_SAVED);
    expect(run.stderr).toBe(`${RELATIVE_HOME_SENTENCE} Nothing was saved.\n`);
    expect(openListener).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("refuses a home .env it could not keep the other lines of, before any key is minted", async () => {
    const home = await makeHome();
    await fs.mkdir(path.join(home, ".env"));
    const openListener = vi.fn(openLoopbackListener);

    const run = await login([], { env: { PIPELEX_HOME: home }, openListener });

    expect(run.code).toBe(EXIT_NOT_SAVED);
    expect(run.stderr).toContain(`\`${path.join(home, ".env")}\` could not be read`);
    expect(openListener).not.toHaveBeenCalled();
  });

  it("says when the listener cannot be opened, and names the paste", async () => {
    const home = await makeHome();

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openListener: async () => {
        throw new Error("EACCES");
      },
    });

    expect(run.code).toBe(EXIT_NOT_SAVED);
    expect(run.stderr).toContain("could not listen on 127.0.0.1");
    expect(run.stderr).toContain(`\`${PASTE_COMMAND}\``);
  });
});

describe("the app's origin", () => {
  it("is PIPELEX_APP_URL from the environment, else from the home .env, else the hosted app", async () => {
    expect(resolveAppOrigin({}, undefined)).toEqual({ ok: true, origin: DEFAULT_APP_URL });
    expect(resolveAppOrigin({ PIPELEX_APP_URL: "" }, {})).toEqual({
      ok: true,
      origin: DEFAULT_APP_URL,
    });
    expect(resolveAppOrigin({}, { PIPELEX_APP_URL: "https://app-dev.pipelex.com" })).toEqual({
      ok: true,
      origin: "https://app-dev.pipelex.com",
    });
    expect(
      resolveAppOrigin(
        { PIPELEX_APP_URL: "http://localhost:3000/" },
        { PIPELEX_APP_URL: "https://app-dev.pipelex.com" },
      ),
    ).toEqual({ ok: true, origin: "http://localhost:3000" });
  });

  it("refuses a value that is not scheme://host[:port], without quoting it", () => {
    for (const value of [
      "app.pipelex.com",
      "ftp://app.pipelex.com",
      "https://app.pipelex.com/auth",
      "https://user:secret@app.pipelex.com",
      "https://app.pipelex.com?x=1",
      "https://app.pipelex.com#top",
      // Stricter than a base URL: the parser drops an empty query or fragment.
      "https://app.pipelex.com?",
      "https://app.pipelex.com#",
    ]) {
      const resolved = resolveAppOrigin({ PIPELEX_APP_URL: value }, undefined);

      expect(resolved.ok, value).toBe(false);
      const message = resolved.ok ? "" : resolved.message("~/.pipelex/.env");
      expect(message, value).toContain("PIPELEX_APP_URL is not an origin");
      expect(message, value).not.toContain("secret");
    }
    const fromFile = resolveAppOrigin({}, { PIPELEX_APP_URL: "nope" });
    expect(fromFile.ok ? "" : fromFile.message("~/.pipelex/.env")).toContain(
      "PIPELEX_APP_URL in `~/.pipelex/.env` is not an origin",
    );
  });

  it("sends the browser to the app the home .env names, and refuses a bad one before listening", async () => {
    const home = await makeHome("PIPELEX_APP_URL=https://app-dev.pipelex.com\n");
    const browser = browserSending(KEY);

    const run = await login([], {
      env: { PIPELEX_HOME: home },
      openBrowser: browser,
      createClient: fakeClient().createClient,
    });

    expect(run.code).toBe(EXIT_SAVED);
    expect(browser.urls[0]).toMatch(/^https:\/\/app-dev\.pipelex\.com\/auth\/cli\?/);

    const openListener = vi.fn(openLoopbackListener);
    const refused = await login([], {
      env: { PIPELEX_HOME: home, PIPELEX_APP_URL: "https://app.pipelex.com/auth" },
      openListener,
    });
    expect(refused.code).toBe(EXIT_NOT_SAVED);
    expect(openListener).not.toHaveBeenCalled();
  });

  it("builds the link the page reads: its port and its state", () => {
    expect(cliAuthUrl("https://app.pipelex.com", 54321, "abc-_.~")).toBe(
      "https://app.pipelex.com/auth/cli?callback_port=54321&state=abc-_.%7E",
    );
  });

  it("adds the key label when the login names one, encoded so the page reads it back whole", () => {
    const label = "Proof lab: vibe/1 & co #2 ?é";
    const url = cliAuthUrl("https://app.pipelex.com", 54321, "abc", label);

    expect(url).toBe(
      "https://app.pipelex.com/auth/cli?callback_port=54321&state=abc&label=Proof+lab%3A+vibe%2F1+%26+co+%232+%3F%C3%A9",
    );
    expect(new URL(url).searchParams.get("label")).toBe(label);
  });
});

describe("checkApiKey", () => {
  it("leaves a key unchecked when the client refuses its base URL", async () => {
    const check = await checkApiKey(
      () => {
        throw new Error("Invalid API base URL");
      },
      "https://api.pipelex.com/v1",
      KEY,
    );

    expect(check).toMatchObject({ verdict: "unchecked" });
  });

  it("names the API by its origin alone", async () => {
    const check = await checkApiKey(
      fakeClient({ error: new ApiUnreachableError("down", "x", undefined) }).createClient,
      "https://user:secret@api.example.com",
      KEY,
    );

    expect(check).toEqual({
      verdict: "unchecked",
      reason: "https://api.example.com could not be reached",
    });
  });
});

/** Standard input as a terminal a test types into. */
class FakeTerminal extends EventEmitter implements HiddenInput {
  readonly modes: boolean[] = [];

  constructor(
    readonly isTTY: boolean,
    private readonly typed: string[] = [],
  ) {
    super();
  }

  setRawMode(mode: boolean): this {
    this.modes.push(mode);
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    setImmediate(() => {
      for (const chunk of this.typed) this.emit("data", chunk);
    });
    return this;
  }

  pause(): this {
    return this;
  }
}

describe("the pasted login", () => {
  it("refuses a standard input that is not a terminal, as under Claude Code's !", async () => {
    const home = await makeHome();
    const openListener = vi.fn(openLoopbackListener);

    const run = await login(["--paste"], {
      env: { PIPELEX_HOME: home },
      stdin: new FakeTerminal(false),
      openListener,
    });

    expect(run.code).toBe(EXIT_NOT_SAVED);
    expect(run.stderr).toContain("needs a terminal");
    expect(run.stderr).toContain(`\`${LOGIN_COMMAND}\``);
    expect(openListener).not.toHaveBeenCalled();
    expect(await savedFile(home)).toBeUndefined();
  });

  it("checks and saves a pasted key without showing it, and never opens the browser", async () => {
    const home = await makeHome();
    const terminal = new FakeTerminal(true, [`  ${KEY}  `, "\r"]);
    const openBrowser = vi.fn(async () => true);
    const openListener = vi.fn(openLoopbackListener);

    const run = await login(["--paste"], {
      env: { PIPELEX_HOME: home },
      stdin: terminal,
      openBrowser,
      openListener,
      createClient: fakeClient().createClient,
    });

    expect(run.code).toBe(EXIT_SAVED);
    expect(run.stdout).toContain("It is not shown as you type.");
    expect(run.stdout).toContain("Pipelex API key: \n");
    expect(run.stdout).toContain("Logged in as ada@example.com.");
    expect(terminal.modes).toEqual([true, false]);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(openListener).not.toHaveBeenCalled();
    expect(await savedFile(home)).toBe(`PIPELEX_API_KEY=${KEY}\n`);
    expectNoKeyIn(run, KEY);
  });

  it("saves nothing when the API refuses a pasted key, and does not call it a key the login received", async () => {
    const home = await makeHome();

    const run = await login(["--paste"], {
      env: { PIPELEX_HOME: home },
      stdin: new FakeTerminal(true, [KEY, "\r"]),
      createClient: fakeClient({
        error: new ApiResponseError("HTTP 401", `${DEFAULT_API_URL}/v1/me`, 401, "refused", "{}"),
      }).createClient,
    });

    expect(run.code).toBe(EXIT_NOT_SAVED);
    expect(run.stderr).toContain(
      `${DEFAULT_API_URL} refused the key (HTTP 401). Nothing was saved.`,
    );
    expect(run.stderr).not.toContain("went unused");
    expect(run.stderr).toContain(`then run \`${PASTE_COMMAND}\` again.`);
    expect(await savedFile(home)).toBeUndefined();
    expectNoKeyIn(run, KEY);
  });

  it("saves nothing when the prompt is interrupted or left empty", async () => {
    const home = await makeHome();

    const interrupted = await login(["--paste"], {
      env: { PIPELEX_HOME: home },
      stdin: new FakeTerminal(true, ["plx_sk_half", "\u0003"]),
    });
    const empty = await login(["--paste"], {
      env: { PIPELEX_HOME: home },
      stdin: new FakeTerminal(true, ["   \r"]),
    });

    expect(interrupted.code).toBe(EXIT_INTERRUPTED);
    expect(interrupted.stderr).toContain("Interrupted. Nothing was saved.");
    expect(empty.code).toBe(EXIT_NOT_SAVED);
    expect(empty.stderr).toContain("No key was entered. Nothing was saved.");
    expect(await savedFile(home)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "tells the user the pasted key was not saved when the file cannot be written",
    async () => {
      const home = await makeHome();
      let run: Run;
      try {
        run = await login(["--paste"], {
          env: { PIPELEX_HOME: home },
          stdin: new FakeTerminal(true, [KEY, "\r"]),
          createClient: () => ({
            getMe: async () => {
              await fs.chmod(home, 0o500);
              return PROFILE;
            },
          }),
        });
      } finally {
        await fs.chmod(home, 0o700);
      }

      expect(run.code).toBe(EXIT_NOT_SAVED);
      expect(run.stderr).toContain(
        `The key you pasted was not saved: fix that file, then run \`${PASTE_COMMAND}\` again.`,
      );
      expectNoKeyIn(run, KEY);
    },
  );
});

describe("the browser opener", () => {
  it("uses the platform's own opener", () => {
    const url = "https://app.pipelex.com/auth/cli?callback_port=1&state=a";

    expect(browserOpenerCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(browserOpenerCommand(url, "win32")).toEqual({ command: "explorer.exe", args: [url] });
    expect(browserOpenerCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });

  /** A `spawn` that records each launch and reports it launched, unreferenced. */
  function recordingSpawn(): {
    spawn: SpawnFunction;
    calls: { command: string; args: readonly string[]; options: SpawnOptions }[];
    unreferenced: () => boolean;
  } {
    const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
    let unreferenced = false;
    const spawn: SpawnFunction = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as ChildProcess;
      child.unref = () => {
        unreferenced = true;
      };
      setImmediate(() => child.emit("spawn"));
      return child;
    };
    return { spawn, calls, unreferenced: () => unreferenced };
  }

  it("launches it detached and unreferenced, and reports it launched", async () => {
    const { spawn, calls, unreferenced } = recordingSpawn();

    const opened = await platformBrowserOpener({
      platform: "linux",
      env: { DISPLAY: ":0" },
      spawn,
    })("https://x.test");

    expect(opened).toBe(true);
    expect(calls).toEqual([
      {
        command: "xdg-open",
        args: ["https://x.test"],
        options: { detached: true, stdio: "ignore", windowsHide: true },
      },
    ]);
    expect(unreferenced()).toBe(true);
  });

  it("launches xdg-open only in a graphical session, as over SSH there is no browser to open", async () => {
    const headless = recordingSpawn();
    for (const env of [{}, { DISPLAY: "", WAYLAND_DISPLAY: "" }]) {
      const opened = await platformBrowserOpener({ platform: "linux", env, spawn: headless.spawn })(
        "https://x.test",
      );
      expect(opened, JSON.stringify(env)).toBe(false);
    }
    expect(headless.calls).toEqual([]);

    for (const env of [{ DISPLAY: ":0" }, { WAYLAND_DISPLAY: "wayland-0" }]) {
      const graphical = recordingSpawn();
      const opened = await platformBrowserOpener({
        platform: "linux",
        env,
        spawn: graphical.spawn,
      })("https://x.test");
      expect(opened, JSON.stringify(env)).toBe(true);
      expect(graphical.calls.map((call) => call.command)).toEqual(["xdg-open"]);
    }

    // macOS and Windows open a browser without either variable.
    for (const platform of ["darwin", "win32"] as const) {
      const native = recordingSpawn();
      const opened = await platformBrowserOpener({ platform, env: {}, spawn: native.spawn })(
        "https://x.test",
      );
      expect(opened, platform).toBe(true);
      expect(native.calls, platform).toHaveLength(1);
    }
  });

  it("reports a missing opener as no browser, without crashing the login", async () => {
    const spawn = (_command: string, args: readonly string[], options: SpawnOptions) =>
      nodeSpawn("pipelex-mcp-test-no-such-opener", args, options);

    const opened = await platformBrowserOpener({ platform: "darwin", spawn })("https://x.test");

    expect(opened).toBe(false);
  });

  it("reports a spawn that throws as no browser", async () => {
    const opened = await platformBrowserOpener({
      platform: "darwin",
      spawn: () => {
        throw new Error("spawn refused");
      },
    })("https://x.test");

    expect(opened).toBe(false);
  });
});

/** Keeps the injected environment's type honest: the login reads these and no other variable. */
const _env: LoginEnv = {
  PIPELEX_API_KEY: "",
  PIPELEX_BASE_URL: "",
  PIPELEX_HOME: "",
  PIPELEX_APP_URL: "",
  DISPLAY: "",
  WAYLAND_DISPLAY: "",
};
void _env;
