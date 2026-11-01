/**
 * `npx -y @pipelex/mcp@latest login`: get a Pipelex API key through the
 * browser, or have one pasted, check it, and save it in the home `.env`, where
 * the workshop reads it whenever its host passes no key. A port of
 * `pipelex login` (`pipelex/cli/commands/login/command.py`), so either login
 * serves both: the workshop stays pure Node, since its users have no Python.
 *
 * The browser flow opens the app's `/auth/cli` page with the port of a
 * one-shot loopback listener (`loopback.ts`) and a fresh `state`; once the
 * signed-in user confirms it, the page mints a key and sends the browser back
 * to the listener with the key and the same `state`. `--label <name>` passes
 * the page a key label, and the page then replaces the user's key of that
 * label in the active organization rather than adding one, so repeated logins
 * under one label keep one live key. `--paste` takes a key created in
 * the app instead (`paste.ts`), for a machine whose browser cannot reach the
 * listener. Either way the key must start with `plx_sk_`, is checked with
 * `GET /v1/me` against the base URL the workshop pairs with a saved key, and is
 * saved by `saveApiKeyToHomeEnv` (`../credentials.ts`): refused when the API
 * refuses it, saved with a warning when it could not be checked, and saved
 * with the base URL it was checked against beside it when the file alone would
 * pair it with another API, so a host that does not pass this shell's
 * environment sends the key where it was checked. A base URL the API client
 * refuses is refused before any key is minted.
 *
 * Nothing here prints, logs or puts the key in a message. Output goes through
 * the injected writers, `process.stdout` and `process.stderr` by default, and
 * every seam a test needs (the environment, the home directory, standard input,
 * the browser opener, the listener, the API client and the wait) is injected.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import os from "node:os";

import { ApiResponseError, isProblemError } from "@pipelex/sdk";
import type { UserProfile } from "@pipelex/sdk";

import pkg from "../../package.json" with { type: "json" };
import { mcpAppInfo } from "../capabilities/client-identification.js";
import { DEFAULT_API_URL, createPipelexApiClient } from "../capabilities/shared.js";
import type { ApiConfig } from "../capabilities/shared.js";
import { errorMessage } from "../capabilities/workspace-boundary.js";
import {
  LOGIN_COMMAND,
  PIPELEX_API_KEY_PREFIX,
  RELATIVE_HOME_SENTENCE,
  apiOrigin,
  checkHomeEnvWritable,
  displayPath,
  fileBranchBaseUrl,
  hostOnlyHttpUrl,
  isWellFormedApiKey,
  readHomeEnv,
  saveApiKeyToHomeEnv,
} from "../credentials.js";
import type { CredentialsEnv, HomeEnvRefusal } from "../credentials.js";
import { openLoopbackListener } from "./loopback.js";
import type { CallbackRefusal, LoopbackListener } from "./loopback.js";
import { readHiddenLine } from "./paste.js";
import type { HiddenInput } from "./paste.js";

/** How long the browser flow waits for the key: long enough to create an account on the way. */
export const LOGIN_TIMEOUT_MS = 300_000;

/** The Pipelex app, when `PIPELEX_APP_URL` is not set. */
export const DEFAULT_APP_URL = "https://app.pipelex.com";

/** The app's page that mints a key for a command-line login. */
export const CLI_AUTH_PATH = "/auth/cli";

/** The command for a machine whose browser cannot reach the listener. */
export const PASTE_COMMAND = `${LOGIN_COMMAND} --paste`;

/**
 * The most a key label holds once trimmed: the app's `/auth/cli` takes the
 * label as the platform's key routes and its own Developer page do,
 * `cliKeyLabelSchema` in `pipelex-app/src/lib/cli-login.ts`, counted in
 * Unicode code points, as zod and the platform's Python count it, so a
 * character outside the Basic Multilingual Plane counts once.
 */
export const KEY_LABEL_MAX = 64;

/** The exit codes: saved, nothing saved, the arguments refused, and an interrupted prompt. */
export const EXIT_SAVED = 0;
export const EXIT_NOT_SAVED = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

export const LOGIN_USAGE = [
  `Usage: ${LOGIN_COMMAND} [--label <name> | --paste]`,
  "",
  "Get a Pipelex API key and save it as PIPELEX_API_KEY in ~/.pipelex/.env, or in the .env",
  "of PIPELEX_HOME when that is set, where the workshop reads it whenever its host passes",
  "no key, and where the pipelex CLI reads it too.",
  "",
  "  (no option)     Sign in through the browser and confirm the key on the page, which",
  "                  creates a new key and hands it back to this command.",
  "  --label <name>  Sign in through the browser for the key of that label: the page",
  "                  replaces your key of that label in the active organization, which",
  "                  stops working, or creates one when you hold none, so repeated logins",
  `                  keep one key. Trimmed, 1 to ${KEY_LABEL_MAX} characters, no control characters;`,
  "                  write --label=<name> for one that starts with -.",
  "  --paste         Paste a key created in the Pipelex app instead, for a machine whose",
  "                  browser cannot reach this one (over SSH, in a container).",
  "  --help          Show this help.",
  "",
  "The key is checked against PIPELEX_BASE_URL, else the one saved in the same file, else",
  `${DEFAULT_API_URL}. A PIPELEX_BASE_URL set here that the file does not already give is`,
  "saved beside the key, so a host that does not pass this shell's environment sends the",
  `key to the same API. PIPELEX_APP_URL names another Pipelex app, ${DEFAULT_APP_URL}`,
  "by default.",
  "",
].join("\n");

/** The variables that say a graphical session is running, which `xdg-open` needs to open a browser. */
export interface DisplayEnv {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
}

/** The environment the login reads: the workshop's credentials, the app's origin, and the display. */
export interface LoginEnv extends CredentialsEnv, DisplayEnv {
  PIPELEX_APP_URL?: string;
}

/** The one API call the login makes. */
export interface MeClient {
  getMe(): Promise<UserProfile>;
}

/** Opens the browser on a URL; resolves whether a browser could be launched. */
export type BrowserOpener = (url: string) => Promise<boolean>;

export interface LoginDependencies {
  env?: LoginEnv;
  /** The user's home directory, `os.homedir()` by default. */
  homedir?: () => string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Where `--paste` reads the key, `process.stdin` by default. */
  stdin?: HiddenInput;
  openBrowser?: BrowserOpener;
  openListener?: () => Promise<LoopbackListener>;
  /** Builds the client that checks the key, `createPipelexApiClient` by default. */
  createClient?: (config: ApiConfig) => MeClient;
  /** How long the browser flow waits, {@link LOGIN_TIMEOUT_MS} by default. */
  timeoutMs?: number;
}

/** What the arguments after `login` ask for. */
export type LoginArgs =
  | { kind: "run"; paste: boolean; label?: string }
  | { kind: "help" }
  | { kind: "usage_error"; message: string };

const LABEL_OPTION = "--label";

/**
 * Read the arguments after `login`: `--label <name>` (or `--label=<name>`),
 * `--paste` and `--help`, nothing else. An unknown argument is never echoed
 * unless it is shaped like an option, and a label never is, since a user may
 * have pasted the key itself on the command line. `--help` wins over a label
 * {@link parseKeyLabel} refuses; a pasted key takes no label, since it exists
 * already and nothing can replace it.
 */
export function parseLoginArgs(args: readonly string[]): LoginArgs {
  let paste = false;
  let help = false;
  let rawLabel: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--paste") paste = true;
    else if (arg === "--help") help = true;
    else if (arg === LABEL_OPTION || arg.startsWith(`${LABEL_OPTION}=`)) {
      if (rawLabel !== undefined) {
        return { kind: "usage_error", message: "--label is given more than once: give one." };
      }
      if (arg === LABEL_OPTION) {
        // The next argument is the label, unless there is none or it reads
        // as an option, which is far likelier a forgotten label than a label.
        const next = args[index + 1];
        if (next === undefined || next.startsWith("-")) {
          return {
            kind: "usage_error",
            message:
              "--label needs a key label after it, such as --label my-laptop; write --label=<name> for one that starts with -.",
          };
        }
        rawLabel = next;
        index += 1;
      } else rawLabel = arg.slice(LABEL_OPTION.length + 1);
    } else {
      const message = /^--?[a-z][a-z-]*$/.test(arg)
        ? `Unknown option for login: ${arg}.`
        : "Unexpected argument for login: it takes only --label <name>, --paste or --help.";
      return { kind: "usage_error", message };
    }
  }
  if (help) return { kind: "help" };
  if (rawLabel === undefined) return { kind: "run", paste };
  if (paste) {
    return {
      kind: "usage_error",
      message:
        "--paste takes no --label: a label names the key a browser login creates or replaces, and a pasted key already exists.",
    };
  }
  const label = parseKeyLabel(rawLabel);
  return label.ok
    ? { kind: "run", paste, label: label.label }
    : { kind: "usage_error", message: label.message };
}

/** A key label as the login sends it, or why the app would refuse it. */
export type KeyLabelCheck = { ok: true; label: string } | { ok: false; message: string };

/**
 * Hold a key label to the app's rule before the browser opens: trimmed as
 * JavaScript trims, then 1 to {@link KEY_LABEL_MAX} characters, since a link
 * whose label the app refuses mints nothing and only the page would say why.
 * Two refusals go further than the app and the platform, each for the reason
 * stated beside it. No message quotes the label.
 */
export function parseKeyLabel(raw: string): KeyLabelCheck {
  const label = raw.trim();
  if (label === "") {
    return {
      ok: false,
      message: `The key label is empty once trimmed: a label is 1 to ${KEY_LABEL_MAX} characters.`,
    };
  }
  if ([...label].length > KEY_LABEL_MAX) {
    return {
      ok: false,
      message: `The key label is longer than ${KEY_LABEL_MAX} characters: a label is 1 to ${KEY_LABEL_MAX} characters.`,
    };
  }
  // Stricter than the app: the platform trims U+0085, a control character
  // the app's trim keeps, so a label ending in one would be stored as
  // another label than the one this login names, and the next login under
  // it could not find the key to replace it; and the terminal line naming
  // the label would hand any other, such as an escape, to the terminal.
  if (/\p{Cc}/u.test(label)) {
    return {
      ok: false,
      message:
        "The key label holds a control character, such as a tab or a line break, which a key label cannot hold.",
    };
  }
  // Stricter than the app: a pasted key is not a label, and as one it would
  // travel in plain text in the printed link and the browser's history and
  // stay on show in the app's key list.
  if (label.startsWith(PIPELEX_API_KEY_PREFIX)) {
    return {
      ok: false,
      message: `The key label starts with ${PIPELEX_API_KEY_PREFIX}, as a Pipelex API key does: give --label a name for the key, never the key itself.`,
    };
  }
  return { ok: true, label };
}

/** The `login` subcommand, from its arguments to its exit code. */
export async function runLoginCommand(
  args: readonly string[],
  deps: LoginDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const parsed = parseLoginArgs(args);
  if (parsed.kind === "usage_error") {
    stderr(`${parsed.message}\n\n${LOGIN_USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.kind === "help") {
    stdout(LOGIN_USAGE);
    return EXIT_SAVED;
  }
  return runLogin({ paste: parsed.paste, label: parsed.label }, deps, stdout, stderr);
}

/** How the key reached the login, which decides what a failed save tells the user to do with it. */
type KeySourceKind = "browser" | "paste";

interface LoginContext {
  env: LoginEnv;
  homedir: () => string;
  /** The key label a browser login passes the page, trimmed; never set with `--paste`. */
  label: string | undefined;
  out: (line: string) => void;
  err: (line: string) => void;
  write: (text: string) => void;
}

/**
 * The login itself, once its arguments are read, writing through the writers
 * its one caller resolved. Resolves the exit code.
 */
async function runLogin(
  options: { paste: boolean; label: string | undefined },
  deps: LoginDependencies,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  const context: LoginContext = {
    env: deps.env ?? process.env,
    homedir: deps.homedir ?? os.homedir,
    label: options.label,
    out: (line) => stdout(`${line}\n`),
    err: (line) => stderr(`${line}\n`),
    write: stdout,
  };

  // Refused before any key exists: a key minted for a file that cannot be
  // written would be left unused in the user's organization.
  const writable = await checkHomeEnvWritable(context.env, { homedir: context.homedir });
  if (writable.status !== "writable") {
    reportUnwritable(context, writable, options.paste ? "paste" : "browser");
    return EXIT_NOT_SAVED;
  }
  const homeFile = displayPath(writable.file, context.homedir);
  const home = await readHomeEnv(context.env, { homedir: context.homedir });
  const app = resolveAppOrigin(context.env, home.status === "read" ? home.values : undefined);
  if (!app.ok) {
    context.err(app.message(homeFile));
    return EXIT_NOT_SAVED;
  }

  const received = options.paste
    ? await pasteKey(context, deps.stdin ?? process.stdin, app.origin)
    : await browserKey(context, deps, app.origin);
  if (received.status !== "key") return received.exitCode;
  return checkAndSave(context, deps, received.key, options.paste ? "paste" : "browser", app.origin);
}

type ReceivedKey = { status: "key"; key: string } | { status: "none"; exitCode: number };

async function browserKey(
  context: LoginContext,
  deps: LoginDependencies,
  appOrigin: string,
): Promise<ReceivedKey> {
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const seconds = Math.ceil(timeoutMs / 1000);
  let listener: LoopbackListener;
  try {
    listener = await (deps.openListener ?? openLoopbackListener)();
  } catch (err) {
    context.err(
      `The login could not listen on 127.0.0.1 for the browser: ${errorMessage(err)}. Run \`${PASTE_COMMAND}\` instead. Nothing was saved.`,
    );
    return { status: "none", exitCode: EXIT_NOT_SAVED };
  }

  let key: string | undefined;
  try {
    const url = cliAuthUrl(appOrigin, listener.port, listener.state, context.label);
    // The wait starts before the browser is opened, so a callback refused
    // while the opener is still running is reported rather than lost.
    const waiting = listener.waitForApiKey({
      timeoutMs,
      onRefusal: (refusal) => context.err(refusalSentence(refusal)),
    });
    context.out("Opening your browser to sign in to Pipelex…");
    // The link comes first, so a machine where nothing opens still has a way through.
    context.out(
      `If it does not open, visit: ${url} (over SSH or in a container, run \`${PASTE_COMMAND}\` instead)`,
    );
    // The page mints nothing until the user clicks, so a login that seems
    // stuck on the page says what it waits for.
    context.out(
      context.label === undefined
        ? 'Once signed in, click "Create the key" on the page to hand this login a new key.'
        : `Once signed in, click "Replace the key" on the page to replace your key labelled "${context.label}" in the organization it names, which then stops working, or "Create the key" when you hold none.`,
    );
    let opened: boolean;
    try {
      opened = await (deps.openBrowser ?? platformBrowserOpener({ env: context.env }))(url);
    } catch {
      // An opener that throws opened nothing, and the wait already runs.
      opened = false;
    }
    if (!opened) {
      context.err(
        `No browser could be opened here. Open the link above in a browser on this machine, or press Ctrl-C and run \`${PASTE_COMMAND}\`.`,
      );
    }
    context.out(`Waiting up to ${seconds} seconds for the key…`);
    key = await waiting;
  } finally {
    await listener.close();
  }

  if (key === undefined) {
    context.err(`No key arrived within ${seconds} seconds. Nothing was saved.`);
    // The page mints the key before its redirect, which may never reach this
    // listener, over SSH for instance.
    context.err(
      context.label === undefined
        ? `If you signed in and confirmed the key, the page may have created one that never reached this login: it went unused, so revoke it on the Developer page of the Pipelex app (${appOrigin}).`
        : `If you signed in and confirmed the key, the page may have created or replaced one that never reached this login: the next login with the same \`--label\` replaces it, or revoke it on the Developer page of the Pipelex app (${appOrigin}).`,
    );
    context.err(
      `${capitalized(runAgainClause(context, "browser"))}, or create a key on the Developer page of the Pipelex app (${appOrigin}) and run \`${PASTE_COMMAND}\`.`,
    );
    return { status: "none", exitCode: EXIT_NOT_SAVED };
  }
  return { status: "key", key };
}

function refusalSentence(refusal: CallbackRefusal): string {
  switch (refusal) {
    case "state_mismatch":
      return "Refused a sign-in that did not come from the page this login opened; still waiting.";
    case "no_api_key":
      return "A sign-in came back without an API key; still waiting.";
  }
}

async function pasteKey(
  context: LoginContext,
  stdin: HiddenInput,
  appOrigin: string,
): Promise<ReceivedKey> {
  const notATerminal = (): ReceivedKey => {
    context.err(
      `--paste reads the key without showing it, which needs a terminal, and standard input is not one here, as under Claude Code's \`!\`. Run \`${PASTE_COMMAND}\` in a terminal, or run \`${LOGIN_COMMAND}\` to sign in through the browser. Nothing was saved.`,
    );
    return { status: "none", exitCode: EXIT_NOT_SAVED };
  };
  if (stdin.isTTY !== true) return notATerminal();

  context.out(
    `Paste a Pipelex API key (${PIPELEX_API_KEY_PREFIX}…) created on the Developer page of the Pipelex app (${appOrigin}). It is not shown as you type.`,
  );
  const line = await readHiddenLine(stdin, context.write, "Pipelex API key: ");
  switch (line.status) {
    case "not_a_terminal":
      return notATerminal();
    case "interrupted":
      context.err("Interrupted. Nothing was saved.");
      return { status: "none", exitCode: EXIT_INTERRUPTED };
    case "failed":
      context.err(`The key could not be read: ${line.reason}. Nothing was saved.`);
      return { status: "none", exitCode: EXIT_NOT_SAVED };
    case "ended":
      context.err("No key was entered. Nothing was saved.");
      return { status: "none", exitCode: EXIT_NOT_SAVED };
    case "entered":
      if (line.value.trim() === "") {
        context.err("No key was entered. Nothing was saved.");
        return { status: "none", exitCode: EXIT_NOT_SAVED };
      }
      return { status: "key", key: line.value };
  }
}

/** What the API said of a key. */
export type ApiKeyCheck =
  | { verdict: "accepted"; email: string }
  | { verdict: "refused"; status: number }
  | { verdict: "unchecked"; reason: string };

/** The codes of an answer refusing the key the check sent: a credential missing, refused or expired. */
const REFUSED_KEY_CODES: ReadonlySet<string> = new Set([
  "auth.missing_credential",
  "auth.invalid_credential",
  "auth.credential_expired",
]);

/** The codes of a check that never had its answer: the API unreachable, or silent past the time limit. */
const UNREACHED_CODES: ReadonlySet<string> = new Set(["client.unreachable", "client.timeout"]);

/** The identity the check's request carries: the workshop's, with no host, since none drives a login. */
const LOGIN_APP_INFO = mcpAppInfo({ mode: "workshop", version: pkg.version }, undefined);

/**
 * Ask the API whose key this is, with `GET /v1/me`. Only an answer whose
 * problem is a missing, refused or expired credential refuses the key; any
 * other failure (a base URL the client refuses, the network, another problem,
 * an answer that is not a profile) leaves it unchecked, with a reason naming
 * the API by its origin alone.
 */
export async function checkApiKey(
  createClient: (config: ApiConfig) => MeClient,
  baseUrl: string,
  apiKey: string,
): Promise<ApiKeyCheck> {
  const api = apiOrigin(baseUrl);
  let client: MeClient;
  try {
    client = createClient({ baseUrl, apiKey, appInfo: () => LOGIN_APP_INFO });
  } catch {
    return {
      verdict: "unchecked",
      reason: `the base URL is not a host-only http or https URL, such as ${DEFAULT_API_URL}`,
    };
  }
  let profile: unknown;
  try {
    profile = await client.getMe();
  } catch (err) {
    // Read by the problem's code, never the status: a refused or missing
    // credential is the key's fault, and anything else leaves the key unchecked.
    if (err instanceof ApiResponseError) {
      if (REFUSED_KEY_CODES.has(err.code)) {
        return { verdict: "refused", status: err.status };
      }
      return { verdict: "unchecked", reason: `${api} answered HTTP ${err.status} (${err.code})` };
    }
    if (isProblemError(err) && UNREACHED_CODES.has(err.code)) {
      return { verdict: "unchecked", reason: `${api} could not be reached` };
    }
    return { verdict: "unchecked", reason: `${api} did not answer with an account` };
  }
  const email = (profile as { email?: unknown } | null)?.email;
  if (typeof email !== "string" || email === "") {
    return { verdict: "unchecked", reason: `${api} did not answer with an account` };
  }
  return { verdict: "accepted", email };
}

async function checkAndSave(
  context: LoginContext,
  deps: LoginDependencies,
  received: string,
  source: KeySourceKind,
  appOrigin: string,
): Promise<number> {
  const key = received.trim();
  if (!isWellFormedApiKey(key)) {
    context.err(
      `That is not a Pipelex API key: a Pipelex API key starts with ${PIPELEX_API_KEY_PREFIX} and holds only letters, digits and the characters . _ ~ -. Nothing was saved.`,
    );
    return EXIT_NOT_SAVED;
  }

  // The base URL a tool call pairs with a key read from the file, read afresh
  // after the wait: never the one this shell's own PIPELEX_API_KEY would
  // resolve, since the key is bound for the file.
  const home = await readHomeEnv(context.env, { homedir: context.homedir });
  const fileValues = home.status === "read" ? home.values : undefined;
  const homeFile =
    home.status === "relative_home" ? undefined : displayPath(home.file, context.homedir);
  const baseUrl = fileBranchBaseUrl(context.env, fileValues);
  const api = apiOrigin(baseUrl);
  // A base URL the file set is named as the file's, since nothing in this
  // shell says where it came from.
  const fromFile = !context.env.PIPELEX_BASE_URL && Boolean(fileValues?.PIPELEX_BASE_URL);
  context.out(
    fromFile
      ? `Checking the key with ${api} (the PIPELEX_BASE_URL saved in \`${homeFile ?? "the home .env"}\`)…`
      : `Checking the key with ${api}…`,
  );
  const check = await checkApiKey(
    deps.createClient ?? ((config) => createPipelexApiClient(config)),
    baseUrl,
    key,
  );

  if (check.verdict === "refused") {
    context.err(`${api} refused the key (HTTP ${check.status}). Nothing was saved.`);
    // A browser login has already minted the key in the user's organization.
    if (source === "browser") context.err(`${unusedKeySentence(context, appOrigin)}.`);
    context.err(
      `Check that the key is current and belongs to ${expectedApi(context.env, fileValues, homeFile)}, then ${runAgainClause(context, source)}.`,
    );
    return EXIT_NOT_SAVED;
  }

  // The save writes the base URL just asked beside the key when the file
  // alone would pair the key with another API, deciding on the file as it
  // reads it again: one another writer changed during the check included.
  const saved = await saveApiKeyToHomeEnv(context.env, key, {
    homedir: context.homedir,
    checkedBaseUrl: baseUrl,
  });
  if (saved.status !== "saved") {
    reportFailedSave(context, saved, source, appOrigin);
    return EXIT_NOT_SAVED;
  }

  const file = displayPath(saved.file, context.homedir);
  const savedAs =
    saved.baseUrl === undefined
      ? "as PIPELEX_API_KEY"
      : `as PIPELEX_API_KEY, beside PIPELEX_BASE_URL for ${apiOrigin(saved.baseUrl)}`;
  if (check.verdict === "accepted") {
    context.out(
      `Logged in as ${check.email}. Your Pipelex API key is saved in \`${file}\` ${savedAs}.`,
    );
  } else {
    context.err(
      `Could not check the key: ${check.reason}. It is saved anyway, in \`${file}\` ${savedAs}: ${runAgainClause(context, source)} if a tool call refuses it.`,
    );
  }
  if (saved.baseUrl !== undefined) {
    context.out(
      `PIPELEX_BASE_URL is saved with the key, so a host that does not pass this shell's environment, and the pipelex CLI, which loads that file over its environment, now send the key to ${apiOrigin(saved.baseUrl)} in every shell.`,
    );
  }
  context.out(
    "The workshop uses it whenever its host passes no PIPELEX_API_KEY, from its next tool call, with no restart.",
  );
  if (context.env.PIPELEX_API_KEY) {
    context.err(
      "This shell sets PIPELEX_API_KEY, so a workshop started from it uses that value instead of the saved key for as long as it is set.",
    );
  }
  return EXIT_SAVED;
}

/** Which API a refused key must belong to, saying where its base URL was set. */
function expectedApi(
  env: LoginEnv,
  fileValues: NodeJS.Dict<string> | undefined,
  homeFile: string | undefined,
): string {
  if (env.PIPELEX_BASE_URL) {
    return `the API PIPELEX_BASE_URL names, ${apiOrigin(env.PIPELEX_BASE_URL)}`;
  }
  if (fileValues?.PIPELEX_BASE_URL) {
    return `the API the PIPELEX_BASE_URL in \`${homeFile ?? "the home .env"}\` names, ${apiOrigin(fileValues.PIPELEX_BASE_URL)}`;
  }
  return `the hosted API, ${DEFAULT_API_URL}, used when PIPELEX_BASE_URL is not set`;
}

/**
 * Why a key cannot be saved in the home `.env`, in one sentence that never
 * quotes it: `before` any key exists, from the pre-flight, or `after` one
 * arrived, from the save.
 */
function refusalOf(
  context: LoginContext,
  refusal: HomeEnvRefusal,
  when: "before" | "after",
): string {
  switch (refusal.status) {
    case "relative_home":
      return RELATIVE_HOME_SENTENCE;
    case "unreadable":
      return `\`${displayPath(refusal.file, context.homedir)}\` could not be read, so its other lines could not be kept: it must be a regular file you can read, of at most 1 MiB, in UTF-8.`;
    case "unwritable_value": {
      const file = displayPath(refusal.file, context.homedir);
      // The file's own value is written back only when another program
      // changed it during the check, so only the save can meet this one.
      const subject =
        refusal.from === "environment"
          ? `This shell's ${refusal.name} would have to be saved beside the key in \`${file}\``
          : `The ${refusal.name} the key was checked against, which another program changed in \`${file}\` during the check, would have to be saved back beside the key`;
      return `${subject}, and a .env file cannot hold it unquoted: it holds a #, a line break, enclosing quotes or a space at either end.`;
    }
    case "invalid_base_url": {
      const subject =
        refusal.from === "environment"
          ? "This shell's PIPELEX_BASE_URL"
          : `The PIPELEX_BASE_URL saved in \`${displayPath(refusal.file, context.homedir)}\``;
      return `${subject} is not a host-only http or https URL, such as ${DEFAULT_API_URL}, with no path, credentials, query or fragment, so the workshop could not use a key saved for it.`;
    }
    case "failed":
      return `${when === "before" ? "A key cannot be saved" : "The key could not be saved"} in \`${displayPath(refusal.file, context.homedir)}\`: ${refusal.reason}.`;
  }
}

/** What the user must fix before running the login again, as a clause. */
function fixOf(refusal: HomeEnvRefusal): string {
  switch (refusal.status) {
    case "relative_home":
      return "fix PIPELEX_HOME";
    case "unwritable_value":
      return refusal.from === "environment"
        ? `fix or unset ${refusal.name} in this shell`
        : `check ${refusal.name} in that file`;
    case "invalid_base_url":
      return refusal.from === "environment"
        ? "fix or unset PIPELEX_BASE_URL in this shell"
        : "fix or remove PIPELEX_BASE_URL in that file";
    case "unreadable":
    case "failed":
      return "fix that file";
  }
}

/** The pre-flight's refusal, before any key exists. */
function reportUnwritable(
  context: LoginContext,
  refusal: HomeEnvRefusal,
  source: KeySourceKind,
): void {
  context.err(`${refusalOf(context, refusal, "before")} Nothing was saved.`);
  // The relative home's sentence already says what to do.
  if (refusal.status !== "relative_home") {
    context.err(`${capitalized(fixOf(refusal))}, then ${runAgainClause(context, source)}.`);
  }
}

/**
 * "run … again" as a clause, naming the command that gets a key the same
 * way: a browser login that named a label keeps it, so the next login
 * replaces the key this one may have left, without quoting the label, which
 * no one shell could take unquoted.
 */
function runAgainClause(context: LoginContext, source: KeySourceKind): string {
  if (source === "paste") return `run \`${PASTE_COMMAND}\` again`;
  return context.label === undefined
    ? `run \`${LOGIN_COMMAND}\` again`
    : `run \`${LOGIN_COMMAND}\` again with the same \`--label\``;
}

function capitalized(clause: string): string {
  return `${clause[0].toUpperCase()}${clause.slice(1)}`;
}

/**
 * The sentence a browser login gives a key it received and did not save,
 * since the page already minted it: a labelled one is replaced by the next
 * login under its label, so it need not be revoked by hand.
 */
function unusedKeySentence(context: LoginContext, appOrigin: string): string {
  return context.label === undefined
    ? `The key this login received went unused: revoke it on the Developer page of the Pipelex app (${appOrigin})`
    : `The key this login received went unused: the next login with the same \`--label\` replaces it, or revoke it on the Developer page of the Pipelex app (${appOrigin})`;
}

/** A save that failed after the key arrived, which the pre-flight could not foresee. */
function reportFailedSave(
  context: LoginContext,
  saved: HomeEnvRefusal,
  source: KeySourceKind,
  appOrigin: string,
): void {
  context.err(`${refusalOf(context, saved, "after")} Nothing was saved.`);
  const fix = fixOf(saved);
  // A browser login has already minted the key in the user's organization.
  context.err(
    source === "browser"
      ? `${unusedKeySentence(context, appOrigin)}. ${capitalized(fix)}, then ${runAgainClause(context, source)}.`
      : `The key you pasted was not saved: ${fix}, then ${runAgainClause(context, source)}.`,
  );
}

/**
 * The app page that mints a key and sends it back to the listener on `port`
 * with `state`, carrying the key `label` when the login names one, which the
 * page then replaces instead of adding a key.
 */
export function cliAuthUrl(appOrigin: string, port: number, state: string, label?: string): string {
  const query = new URLSearchParams({ callback_port: String(port), state });
  if (label !== undefined) query.set("label", label);
  return `${appOrigin}${CLI_AUTH_PATH}?${query.toString()}`;
}

type AppOrigin =
  | { ok: true; origin: string }
  | { ok: false; message: (homeFile: string) => string };

/**
 * The Pipelex app's origin: `PIPELEX_APP_URL` from the environment, else from
 * the home `.env`, where a developer sets it once beside a development base
 * URL, else {@link DEFAULT_APP_URL}. It must be `scheme://host[:port]`, http
 * or https, with no credentials, path, query or fragment; a trailing `/` is
 * dropped. A refused value is never quoted, since it may carry credentials.
 */
export function resolveAppOrigin(
  env: LoginEnv,
  fileValues: NodeJS.Dict<string> | undefined,
): AppOrigin {
  const fromEnv = env.PIPELEX_APP_URL?.trim() || undefined;
  const configured = fromEnv ?? (fileValues?.PIPELEX_APP_URL?.trim() || undefined);
  if (configured === undefined) return { ok: true, origin: DEFAULT_APP_URL };
  const origin = asOrigin(configured.replace(/\/+$/, ""));
  if (origin !== undefined) return { ok: true, origin };
  return {
    ok: false,
    message: (homeFile) =>
      `PIPELEX_APP_URL${fromEnv === undefined ? ` in \`${homeFile}\`` : ""} is not an origin: give scheme://host[:port], with http or https and no path, such as ${DEFAULT_APP_URL}, or unset it. Nothing was saved.`,
  };
}

/**
 * The origin of a host-only http(s) URL, under the client's rule for a base
 * URL ({@link hostOnlyHttpUrl}) and two refusals of its own: a host the parser
 * left empty, and a `?` or a `#` with nothing after it, which the parser drops
 * without a trace.
 */
function asOrigin(value: string): string | undefined {
  const url = hostOnlyHttpUrl(value);
  if (url === undefined || url.hostname === "" || /[?#]/.test(value)) return undefined;
  return url.origin;
}

// ── the browser opener ─────────────────────────────────────────────

/** The command that opens a URL in the user's browser on a platform. */
export function browserOpenerCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // `explorer.exe` takes the URL whole, where `cmd /c start` would read
      // the `&` between its parameters as a command separator.
      return { command: "explorer.exe", args: [url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

/** The slice of `child_process.spawn` the opener uses. */
export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * The platform's own opener, launched detached and unreferenced so it never
 * holds the command open, its exit code ignored (`explorer.exe` exits 1 when
 * it succeeds). A missing opener, such as a Linux machine without `xdg-open`,
 * makes `spawn` emit `'error'`, which would end the login mid-wait if nothing
 * listened for it, so the opener listens and resolves `false`.
 *
 * Where the opener is `xdg-open`, on Linux and the BSDs, it is not launched at
 * all unless `DISPLAY` or `WAYLAND_DISPLAY` is set, an empty value counting as
 * unset, and the opener resolves `false`: over SSH into a server, `xdg-open`
 * starts and then fails with no browser, which an ignored exit code cannot
 * see, so the login would never say to use `--paste`. Python's `webbrowser`,
 * which `pipelex login` uses, registers `xdg-open` under the same condition.
 */
export function platformBrowserOpener(
  options: { platform?: NodeJS.Platform; env?: DisplayEnv; spawn?: SpawnFunction } = {},
): BrowserOpener {
  const spawn = options.spawn ?? nodeSpawn;
  const env = options.env ?? process.env;
  return (url) => {
    const { command, args } = browserOpenerCommand(url, options.platform);
    if (command === "xdg-open" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      } catch {
        resolve(false);
        return;
      }
      // Kept for the life of the child, so a later error is ignored too.
      child.on("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
      child.unref();
    });
  };
}
