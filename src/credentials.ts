/**
 * The workshop's credentials, and the home `.env` that holds a saved key.
 *
 * `pipelex login` saves its key as `PIPELEX_API_KEY` in `~/.pipelex/.env`, or
 * in the `.env` of `PIPELEX_HOME` when that is set, and the workshop reads the
 * same file whenever its host passes no key. This module owns that file: it
 * locates the home directory, reads the file, and decides each tool call's key
 * and base URL, with the notes a failed request's summary closes with: which
 * key a refused credential was, and where the base URL in use came from, the
 * host's environment, the default or the file. The login's writer belongs here too,
 * so that the file is read and written by one module under one set of rules.
 *
 * The rules, and where they part from the pipelex runtime's on purpose:
 *
 * - **The host's key wins.** A non-empty `PIPELEX_API_KEY` from the host is
 *   used as it is, with the environment's `PIPELEX_BASE_URL` or the hosted API,
 *   and the file is not read. A key a user typed into a host's configuration
 *   has to mean what it says, so the file never overrides it, where the
 *   runtime loads the same file with `override=True`.
 * - **The file's base URL comes with the file's key, and with it alone.** When
 *   the key is the file's, the base URL is the environment's when set, else
 *   the file's, else the hosted API, so a development key saved beside a
 *   development base URL is not sent to production. When neither holds a key,
 *   the call goes out keyless to the environment's base URL or the hosted API,
 *   as it did before the file was read.
 * - **An empty value is no value**, for each of `PIPELEX_API_KEY`,
 *   `PIPELEX_BASE_URL` and `PIPELEX_HOME`, in the environment and in the file:
 *   a host's configuration writes empty values, which a shell would not.
 * - **A relative `PIPELEX_HOME` is refused**, where the runtime resolves it
 *   against the working directory. The workshop's working directory is the
 *   project its host spawned it in, so a relative home would read a `.env` a
 *   cloned repository can ship, whose base URL would then decide where the
 *   user's bundles are sent. The working directory's own `.env` is never read
 *   for the same reason.
 *
 * Nothing here logs, and no text it writes quotes the key or the file's
 * contents. The API is named by its origin alone, the file's base URL
 * included, so a base URL carrying credentials or a query never reaches the
 * model.
 */

import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { DEFAULT_API_URL } from "./capabilities/shared.js";
import type { ApiNotes } from "./capabilities/shared.js";

/** The command a user runs to save a key, in the one spelling every text gives it. */
export const LOGIN_COMMAND = "npx -y @pipelex/mcp@latest login";

/** The home directory's name under the user's home, when `PIPELEX_HOME` is not set. */
export const HOME_DIR_NAME = ".pipelex";

/** The file in the home directory that holds the saved key. */
export const HOME_ENV_FILENAME = ".env";

/** The sentence a relative `PIPELEX_HOME` is refused with, by a tool call and by the login alike. */
export const RELATIVE_HOME_SENTENCE = "PIPELEX_HOME must be an absolute path or start with ~/.";

/**
 * The largest home `.env` read. The file is read on every tool call, and one
 * holding a few keys is a few hundred bytes, so a file past this is not the
 * credentials file and counts as unreadable rather than costing every call.
 */
export const MAX_HOME_ENV_BYTES = 1024 * 1024;

/** The variables this module reads from the environment the host started the workshop in. */
export interface CredentialsEnv {
  PIPELEX_API_KEY?: string;
  PIPELEX_BASE_URL?: string;
  PIPELEX_HOME?: string;
}

export interface HomeOptions {
  /**
   * The user's home directory, `os.homedir()` by default. Injected so a test
   * can point the default home anywhere; nothing here reads `HOME` directly.
   */
  homedir?: () => string;
}

/** Where the home directory is, or that `PIPELEX_HOME` names none this module will read. */
export type PipelexHome = { kind: "dir"; dir: string } | { kind: "relative" };

/**
 * The home directory: `PIPELEX_HOME` when it is set and not empty, `~` or a
 * leading `~/` expanded, else `.pipelex` under the user's home directory. A
 * `PIPELEX_HOME` that is neither absolute nor `~`-prefixed is `relative`, and
 * so is `~user/…`, which names another user's home and is not expanded.
 */
export function resolvePipelexHome(env: CredentialsEnv, options: HomeOptions = {}): PipelexHome {
  const homedir = options.homedir ?? os.homedir;
  const configured = env.PIPELEX_HOME;
  if (!configured) return { kind: "dir", dir: path.join(homedir(), HOME_DIR_NAME) };
  if (configured === "~") return { kind: "dir", dir: path.normalize(homedir()) };
  if (configured.startsWith("~/") || (path.sep === "\\" && configured.startsWith("~\\"))) {
    return { kind: "dir", dir: path.join(homedir(), configured.slice(2)) };
  }
  if (path.isAbsolute(configured)) return { kind: "dir", dir: path.normalize(configured) };
  return { kind: "relative" };
}

/**
 * What reading the home `.env` found. `missing` is a file that does not exist;
 * `unreadable` is one that exists and could not be read as a credentials file
 * (no permission, a directory in its place, a home that is not a directory, a
 * file past {@link MAX_HOME_ENV_BYTES}). `file` is the path that was read,
 * absolute unless the user has no home directory to resolve it against.
 */
export type HomeEnvRead =
  | { status: "read"; file: string; values: NodeJS.Dict<string> }
  | { status: "missing"; file: string }
  | { status: "unreadable"; file: string }
  | { status: "relative_home" };

/** Read the home `.env`. Never throws: every failure is a status. */
export async function readHomeEnv(
  env: CredentialsEnv,
  options: HomeOptions = {},
): Promise<HomeEnvRead> {
  let home: PipelexHome;
  try {
    home = resolvePipelexHome(env, options);
  } catch {
    // `os.homedir()` throws only when the user has no home directory at all,
    // which leaves no file to read.
    return { status: "unreadable", file: path.join("~", HOME_DIR_NAME, HOME_ENV_FILENAME) };
  }
  if (home.kind === "relative") return { status: "relative_home" };

  const file = path.join(home.dir, HOME_ENV_FILENAME);
  const read = await readEnvFileBytes(file);
  if (read.status !== "read") return { status: read.status, file };
  // A leading byte-order mark would otherwise become part of the first name.
  return { status: "read", file, values: parseEnv(stripBom(read.bytes.toString("utf8"))) };
}

/**
 * The bytes of a `.env` file, under the reader's rules: a regular file of at
 * most {@link MAX_HOME_ENV_BYTES}, checked on `stat` before it is opened, so a
 * directory, a device or an oversized file is refused without being opened.
 * `stat` follows a symlinked `.env` to its target, as a dotfiles setup makes it.
 */
async function readEnvFileBytes(
  file: string,
): Promise<{ status: "read"; bytes: Buffer } | { status: "missing" | "unreadable" }> {
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile() || stats.size > MAX_HOME_ENV_BYTES) return { status: "unreadable" };
    return { status: "read", bytes: await fs.readFile(file) };
  } catch (err) {
    return { status: isNotFound(err) ? "missing" : "unreadable" };
  }
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

/** Where a call's key came from: the host's environment, the home `.env`, or nowhere. */
export type KeySource = "host" | "file" | "none";

/**
 * One tool call's API coordinates, and the notes that say where they came
 * from when a request fails: `notes.apiKey`, which key a refused credential
 * was and how to change it, and `notes.baseUrl`, which API the call used and
 * where its base URL was read, the host's environment, the default or the
 * home `.env` beside the saved key, which a note naming the variable alone
 * would hide.
 */
export interface WorkshopCredentials {
  baseUrl: string;
  apiKey?: string;
  source: KeySource;
  notes: Required<ApiNotes>;
}

/** Resolves one tool call's credentials. The workshop calls it at the start of every call. */
export type CredentialsResolver = () => Promise<WorkshopCredentials>;

/**
 * The base URL a key saved in the home `.env` is paired with: the
 * environment's `PIPELEX_BASE_URL` when set, else the file's, else the hosted
 * API. It is the base URL a tool call uses whenever its key is the file's.
 */
export function fileBranchBaseUrl(
  env: CredentialsEnv,
  fileValues: NodeJS.Dict<string> | undefined,
): string {
  return env.PIPELEX_BASE_URL || fileValues?.PIPELEX_BASE_URL || DEFAULT_API_URL;
}

/**
 * Decide one tool call's key and base URL, and the notes its failed requests
 * carry. Never throws. The rules are this module's header.
 */
export async function resolveWorkshopCredentials(
  env: CredentialsEnv,
  options: HomeOptions = {},
): Promise<WorkshopCredentials> {
  const hostKey = env.PIPELEX_API_KEY || undefined;
  if (hostKey !== undefined) {
    const baseUrl = env.PIPELEX_BASE_URL || DEFAULT_API_URL;
    return {
      baseUrl,
      apiKey: hostKey,
      source: "host",
      notes: { apiKey: hostKeyNote(baseUrl), baseUrl: environmentBaseUrlNote(env, baseUrl) },
    };
  }

  const read = await readHomeEnv(env, options);
  const homedir = options.homedir ?? os.homedir;
  const fileKey = read.status === "read" ? read.values.PIPELEX_API_KEY || undefined : undefined;
  if (read.status === "read" && fileKey !== undefined) {
    const baseUrl = fileBranchBaseUrl(env, read.values);
    const file = displayPath(read.file, homedir);
    // The file's base URL is the one in use exactly when the environment sets
    // none and the file sets one, as `fileBranchBaseUrl` decides it.
    const baseUrlFromFile = !env.PIPELEX_BASE_URL && Boolean(read.values.PIPELEX_BASE_URL);
    return {
      baseUrl,
      apiKey: fileKey,
      source: "file",
      notes: {
        apiKey: fileKeyNote(file, baseUrl),
        baseUrl: baseUrlFromFile
          ? fileBaseUrlNote(file, baseUrl)
          : environmentBaseUrlNote(env, baseUrl),
      },
    };
  }

  const baseUrl = env.PIPELEX_BASE_URL || DEFAULT_API_URL;
  return {
    baseUrl,
    source: "none",
    notes: { apiKey: noKeyNote(read, homedir), baseUrl: environmentBaseUrlNote(env, baseUrl) },
  };
}

/**
 * The workshop's resolver: the host's environment, read at each call, and the
 * home `.env`, read afresh at each call, so a key saved mid-session is used
 * from the next call with no restart.
 */
export function credentialsResolver(
  env: CredentialsEnv = process.env,
  options: HomeOptions = {},
): CredentialsResolver {
  return () => resolveWorkshopCredentials(env, options);
}

// ── the notes ───────────────────────────────────────────────────────

const LOGIN_CLAUSE = `run \`${LOGIN_COMMAND}\` in a terminal`;

const HOST_CONFIG_CLAUSE = "set PIPELEX_API_KEY in the host's configuration";

function hostKeyNote(baseUrl: string): string {
  return `The PIPELEX_API_KEY the host passes was refused by ${apiOrigin(baseUrl)}. Replace it in the host's configuration, or remove it there and ${LOGIN_CLAUSE} to use a saved key instead.`;
}

function fileKeyNote(file: string, baseUrl: string): string {
  return `The key saved in \`${file}\` was refused by ${apiOrigin(baseUrl)}. Run \`${LOGIN_COMMAND}\` again in a terminal to save a new one, or ${HOST_CONFIG_CLAUSE}.`;
}

/**
 * The note on the base URL when the file's is the one in use: where it was
 * read, and that the host's configuration overrides it. The base URL is named
 * by its origin alone, or not at all when it has none.
 */
function fileBaseUrlNote(file: string, baseUrl: string): string {
  const origin = httpOrigin(baseUrl);
  const subject =
    origin === undefined
      ? "The PIPELEX_BASE_URL in use"
      : `The PIPELEX_BASE_URL in use, ${origin},`;
  return `${subject} was read from \`${file}\` beside the saved key: fix it there, or set PIPELEX_BASE_URL in the host's configuration, which overrides the file's.`;
}

/**
 * The note on the base URL when the environment decides it: the host's
 * `PIPELEX_BASE_URL`, or the hosted API when the host sets none. The API is
 * named by its origin alone.
 */
function environmentBaseUrlNote(env: CredentialsEnv, baseUrl: string): string {
  return env.PIPELEX_BASE_URL
    ? `The Pipelex API in use, ${apiOrigin(baseUrl)}, is the PIPELEX_BASE_URL the host passes: fix it in the host's configuration.`
    : `The Pipelex API in use is the hosted one, ${apiOrigin(baseUrl)}, since the host passes no PIPELEX_BASE_URL: set one in the host's configuration to use another.`;
}

function noKeyNote(read: HomeEnvRead, homedir: () => string): string {
  return read.status === "relative_home"
    ? `No Pipelex API key is set: the host passes none, and no saved key is read, because ${RELATIVE_HOME_SENTENCE} Fix PIPELEX_HOME and ${LOGIN_CLAUSE}, or ${HOST_CONFIG_CLAUSE}.`
    : read.status === "unreadable"
      ? `No Pipelex API key is set: the host passes none, and \`${displayPath(read.file, homedir)}\` could not be read. Make it a file you can read and ${LOGIN_CLAUSE}, or ${HOST_CONFIG_CLAUSE}.`
      : `No Pipelex API key is set: the host passes none, and none is saved in \`${displayPath(read.file, homedir)}\`. To save one there, ${LOGIN_CLAUSE}, or ${HOST_CONFIG_CLAUSE}.`;
}

/**
 * The API as a note names it: its origin, `scheme://host[:port]`, never a
 * path, credentials or a query. A value that is not an http(s) URL is not
 * shown at all.
 */
export function apiOrigin(baseUrl: string): string {
  return httpOrigin(baseUrl) ?? "the configured Pipelex API";
}

/**
 * The URL a host-only http(s) URL parses to, or `undefined` for any other
 * value. The rule is the one the `@pipelex/sdk` client holds its base URL to,
 * refusing to be built on any other: trailing slashes dropped, then an http or
 * https URL whose path is `/`, with no credentials, query or fragment, since
 * endpoints compose as `{base}/v1/{endpoint}` and a path would double the
 * prefix. The login refuses a `PIPELEX_BASE_URL` that fails it before any key
 * is minted, since every tool call would fail on it, and holds
 * `PIPELEX_APP_URL` to it with stricter refusals of its own.
 */
export function hostOnlyHttpUrl(value: string): URL | undefined {
  const url = URL.parse(value.replace(/\/+$/, ""));
  if (url === null) return undefined;
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  return url;
}

/** The origin of an http(s) URL, or `undefined` for any other value. */
function httpOrigin(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // Not a URL: it has no origin to show.
  }
  return undefined;
}

/** A path as a note shows it: `~/…` under the user's home directory, absolute otherwise. */
export function displayPath(file: string, homedir: () => string = os.homedir): string {
  try {
    const relative = path.relative(homedir(), file);
    const outside = relative === ".." || relative.startsWith(`..${path.sep}`);
    if (relative !== "" && !outside && !path.isAbsolute(relative)) {
      return `~${path.sep}${relative}`;
    }
  } catch {
    // No home directory to abbreviate against.
  }
  return file;
}

// ── the writer ──────────────────────────────────────────────────────

/** Every Pipelex API key starts with this. */
export const PIPELEX_API_KEY_PREFIX = "plx_sk_";

/**
 * The prefix, then URL-safe characters only. The key is written unquoted, as
 * `pipelex login` writes it, so a character a `.env` parser reads as a quote,
 * a comment or a separator must never be part of one.
 */
const PIPELEX_API_KEY_PATTERN = /^plx_sk_[A-Za-z0-9._~-]+$/;

/** The variable the login saves its key under, in the home `.env`. */
const API_KEY_NAME = "PIPELEX_API_KEY";

/** The variable the login saves beside the key when the file alone would pair it with another API. */
const BASE_URL_NAME = "PIPELEX_BASE_URL";

/** Whether a value has the shape of a Pipelex API key: `plx_sk_`, then URL-safe characters. */
export function isWellFormedApiKey(value: string): boolean {
  return PIPELEX_API_KEY_PATTERN.test(value);
}

/**
 * Where the base URL a key is checked against was set: this shell's
 * environment, or the home `.env` itself, which a refusal names so the user
 * fixes the right one.
 */
export type BaseUrlOrigin = "environment" | "file";

/**
 * What saving a key in the home `.env` did. `file` is the home `.env` itself,
 * the path a user knows, even when it is a symlink and the write went to its
 * target. `saved` carries `baseUrl` when the base URL the key was checked
 * against was written beside it. `unreadable` is a file that exists and could
 * not be read under the reader's rules, whose other lines the writer therefore
 * cannot keep; `unwritable_value` is a variable, named, that the save had to
 * write beside the key and that a `.env` file cannot hold unquoted;
 * `invalid_base_url` is a checked base URL the API client refuses, so that no
 * tool call could use a key saved for it; `failed` carries a reason that never
 * quotes the key, a value or the file's contents.
 */
export type HomeEnvSave =
  | { status: "saved"; file: string; baseUrl?: string }
  | { status: "relative_home" }
  | { status: "unreadable"; file: string }
  | { status: "unwritable_value"; file: string; name: string; from: BaseUrlOrigin }
  | { status: "invalid_base_url"; file: string; from: BaseUrlOrigin }
  | { status: "failed"; file: string; reason: string };

export interface SaveOptions extends HomeOptions {
  /**
   * The base URL the key was checked against. Absent, it is the one a check
   * made now would use, `fileBranchBaseUrl` over the very content being
   * rewritten, which is what the pre-flight plans with. The login passes the
   * one it checked, so a file another writer changed during the check cannot
   * pair the key with an API that never saw it.
   */
  checkedBaseUrl?: string;
}

/**
 * Save `PIPELEX_API_KEY=<key>` in the home `.env`, the file the workshop and
 * the pipelex CLI both read, under the rules pipelex's `set_env_file_entry`
 * follows: every assignment of the key, an `export` one included, is replaced
 * where it stands, so no later line can shadow it; every other line is kept as
 * it is, comments, quoting and line endings included; the value is written
 * unquoted; the directory is created when missing. Then rules of its own: an
 * `export` assignment keeps its `export`, so a file a shell sources still
 * exports the key; a missing directory is created at `0700`; and:
 *
 * - **The key keeps the base URL it was checked against.** When that base URL
 *   (`options.checkedBaseUrl`, `fileBranchBaseUrl` by default) differs from
 *   the one the file alone yields (its own, else the hosted API), it is
 *   written beside the key, under the same rules and in the same write, since
 *   a host that does not pass this shell's environment reads the file alone.
 *   The comparison is made with the checked base URL, never the environment's,
 *   so a `PIPELEX_BASE_URL` another writer changed in the file while the key
 *   was checked is put back to the one that accepted the key. With no
 *   `PIPELEX_BASE_URL` in the environment and no such change, the file alone
 *   yields the checked base URL and nothing about it is written.
 * - **A checked base URL the API client refuses is refused**
 *   ({@link hostOnlyHttpUrl}), whether or not it would be written: every tool
 *   call would fail on it, and the pipelex CLI's hosted commands too.
 * - A symlinked `.env` is resolved with `realpath` first, so the link stays a
 *   link and its target is what is rewritten.
 * - The new content goes to a temporary file at mode `0600` in the target's
 *   directory, which is renamed over the target, so the file is never readable
 *   by others and a workshop reading it mid-write never sees half of it.
 * - The new content is parsed before anything is written, and the write is
 *   refused unless it gives each value it writes exactly and every other
 *   variable the value it had: a line this module would misread is never
 *   rewritten, and a value a `.env` file cannot hold unquoted is never written.
 *
 * A file that exists and cannot be read, or is over {@link MAX_HOME_ENV_BYTES},
 * or is not UTF-8, is refused rather than replaced, since its other lines could
 * not be kept. Never throws: every failure is a status.
 */
export async function saveApiKeyToHomeEnv(
  env: CredentialsEnv,
  apiKey: string,
  options: SaveOptions = {},
): Promise<HomeEnvSave> {
  const plan = await planSave(env, apiKey, options);
  if (plan.status !== "ready") return plan;
  const { file, target, content, baseUrl } = plan;

  const dir = path.dirname(target);
  const temporary = path.join(
    dir,
    `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      // The mode `open` was given is filtered through the umask, so it is set
      // again: the key must never sit in a file another user can read.
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    return { status: "failed", file, reason: writeFailureReason(err) };
  }
  return { status: "saved", file, ...(baseUrl === undefined ? {} : { baseUrl }) };
}

/** A save's refusals, without its success. */
export type HomeEnvRefusal = Exclude<HomeEnvSave, { status: "saved" }>;

/**
 * Whether a key could be saved in the home `.env` now: every check the writer
 * makes before it writes, planned with the base URL a check made now would
 * use, the one it would write beside the key included, and whether the
 * directory it would write in, or the nearest one that exists, is writable.
 * The login runs it before a key is minted, since a key minted for a file it
 * then cannot write, or for a base URL no tool call can use, is left unused in
 * the user's organization. The save checks everything again, so a file that
 * changes in between is still refused. Never throws.
 */
export async function checkHomeEnvWritable(
  env: CredentialsEnv,
  options: HomeOptions = {},
): Promise<{ status: "writable"; file: string } | HomeEnvRefusal> {
  const plan = await planSave(env, PLACEHOLDER_KEY, { homedir: options.homedir });
  if (plan.status !== "ready") return plan;
  const refusal = await directoryRefusal(path.dirname(plan.target));
  return refusal === undefined
    ? { status: "writable", file: plan.file }
    : { status: "failed", file: plan.file, reason: refusal };
}

/** A well-formed key the pre-flight composes the file with, never written anywhere. */
const PLACEHOLDER_KEY = `${PIPELEX_API_KEY_PREFIX}placeholder`;

type SavePlan =
  | { status: "ready"; file: string; target: string; content: string; baseUrl?: string }
  | HomeEnvRefusal;

/** Everything a save decides before it writes: where, and the file's new content. */
async function planSave(
  env: CredentialsEnv,
  apiKey: string,
  options: SaveOptions,
): Promise<SavePlan> {
  let home: PipelexHome;
  try {
    home = resolvePipelexHome(env, options);
  } catch {
    return {
      status: "failed",
      file: path.join("~", HOME_DIR_NAME, HOME_ENV_FILENAME),
      reason: "no home directory could be found for this user",
    };
  }
  if (home.kind === "relative") return { status: "relative_home" };
  const file = path.join(home.dir, HOME_ENV_FILENAME);
  if (!isWellFormedApiKey(apiKey)) {
    return { status: "failed", file, reason: "the value is not a Pipelex API key" };
  }

  let target = file;
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) target = await fs.realpath(file);
  } catch (err) {
    if (!isNotFound(err)) return { status: "unreadable", file };
    // `lstat` found nothing, which the write creates, or `realpath` found a
    // link to nothing, which a rename would replace with a file.
    if (await isSymlink(file)) {
      return {
        status: "failed",
        file,
        reason:
          "it is a symbolic link to a file that does not exist; create that file or remove the link",
      };
    }
  }

  const existing = await readEnvFileBytes(target);
  if (existing.status === "unreadable") return { status: "unreadable", file };
  let content = "";
  if (existing.status === "read") {
    try {
      // `ignoreBOM` keeps a byte-order mark in the text, so it is written back.
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(existing.bytes);
    } catch {
      return { status: "unreadable", file };
    }
  }

  // Every value is decided against the very content being rewritten, so the
  // base URL decision cannot go stale between a read and the write.
  const rewriteRefused = (names: string[]): HomeEnvRefusal => ({
    status: "failed",
    file,
    reason: `it holds lines this login cannot rewrite without changing them; set ${names.join(" and ")} in it by hand`,
  });
  let current: NodeJS.Dict<string>;
  try {
    current = parseEnv(stripBom(content));
  } catch {
    return rewriteRefused([API_KEY_NAME]);
  }
  // The login checks the key against the environment's base URL when it sets
  // one, else the file's; a refusal names whichever that was.
  const from: BaseUrlOrigin = env.PIPELEX_BASE_URL ? "environment" : "file";
  const checkedBaseUrl = options.checkedBaseUrl ?? fileBranchBaseUrl(env, current);
  if (hostOnlyHttpUrl(checkedBaseUrl) === undefined) {
    return { status: "invalid_base_url", file, from };
  }
  const baseUrl = baseUrlToSave(checkedBaseUrl, current);
  const entries = new Map([[API_KEY_NAME, apiKey]]);
  if (baseUrl !== undefined) {
    if (!holdsUnquoted(BASE_URL_NAME, baseUrl)) {
      return { status: "unwritable_value", file, name: BASE_URL_NAME, from };
    }
    entries.set(BASE_URL_NAME, baseUrl);
  }

  let next = content;
  for (const [name, value] of entries) next = withAssignment(next, name, value);
  if (!keepsEveryOtherValue(content, next, entries)) return rewriteRefused([...entries.keys()]);
  return {
    status: "ready",
    file,
    target,
    content: next,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

/**
 * The base URL a save writes beside the key, or `undefined` when it writes
 * none: the checked base URL when the file alone would pair the key with
 * another API, its own `PIPELEX_BASE_URL` or else the hosted one. The two are
 * compared as the client reads a base URL, trailing slashes dropped and an
 * http(s) URL normalized, so `https://API.example.com/` matches
 * `https://api.example.com`.
 */
function baseUrlToSave(
  checkedBaseUrl: string,
  fileValues: NodeJS.Dict<string>,
): string | undefined {
  const fromFileAlone = fileBranchBaseUrl({}, fileValues);
  return comparableBaseUrl(checkedBaseUrl) === comparableBaseUrl(fromFileAlone)
    ? undefined
    : checkedBaseUrl;
}

/** A base URL as the client reads it: trailing slashes dropped, an http(s) URL normalized by the URL parser. */
function comparableBaseUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  const url = URL.parse(trimmed);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return trimmed;
  return url.href.replace(/\/+$/, "");
}

/**
 * Whether `name=value`, written unquoted, reads back as exactly `value`: a
 * `#`, a line break, enclosing quotes or a space at either end would be read
 * otherwise.
 */
function holdsUnquoted(name: string, value: string): boolean {
  try {
    return parseEnv(`${name}=${value}\n`)[name] === value;
  } catch {
    return false;
  }
}

/**
 * Why a file could not be created in `dir`, or `undefined` when it could: the
 * nearest directory that exists must be a directory this user can write in,
 * since the save creates whatever is missing below it.
 */
async function directoryRefusal(dir: string): Promise<string | undefined> {
  for (let current = dir; ; current = path.dirname(current)) {
    try {
      if (!(await fs.stat(current)).isDirectory()) return writeFailureReason({ code: "ENOTDIR" });
      await fs.access(current, fsConstants.W_OK);
      return undefined;
    } catch (err) {
      if (!isNotFound(err) || path.dirname(current) === current) return writeFailureReason(err);
    }
  }
}

async function isSymlink(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A write failure in words that never quote the key: the system's own, by its code when it has a known one. */
function writeFailureReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EROFS":
      return "the file system is read-only";
    case "ENOSPC":
      return "no space is left on the device";
    case "EDQUOT":
      return "the disk quota is exceeded";
    case "ENOTDIR":
    case "EEXIST":
      return "a file stands where a directory should be";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The file with every assignment of `name` replaced by `name=value`, in place
 * and keeping an `export` prefix, or the assignment appended when there is
 * none. A value quoted over several lines is one assignment, as `parseEnv`
 * reads it, so a line inside another variable's value is never taken for an
 * assignment and an old multi-line value of `name` is replaced whole.
 */
function withAssignment(content: string, name: string, value: string): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = content.slice(bom.length);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let replaced = false;
  for (let index = 0; index < lines.length; ) {
    const assignment = readAssignment(lines[index]);
    const span = assignment === undefined ? 1 : assignmentSpan(lines, index, assignment);
    if (assignment?.name === name) {
      out.push(`${assignment.exported ? "export " : ""}${name}=${value}${eol}`);
      replaced = true;
    } else {
      out.push(...lines.slice(index, index + span));
    }
    index += span;
  }
  if (!replaced) {
    if (body !== "" && !body.endsWith("\n")) out.push(eol);
    out.push(`${name}=${value}${eol}`);
  }
  return bom + out.join("");
}

interface Assignment {
  name: string;
  exported: boolean;
  /** The value as written after `=`, up to the end of the line, without its line ending. */
  rawValue: string;
}

const ASSIGNMENT_LINE = /^[ \t]*(export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(.*)$/;

function readAssignment(line: string): Assignment | undefined {
  const match = ASSIGNMENT_LINE.exec(line.replace(/\r?\n$/, ""));
  if (match === null) return undefined;
  return { name: match[2], exported: match[1] !== undefined, rawValue: match[3] };
}

/**
 * How many lines an assignment spans: one, unless its value opens a quote
 * whose closing quote is on a later line, as `parseEnv` searches for it.
 */
function assignmentSpan(lines: string[], index: number, assignment: Assignment): number {
  const quote = assignment.rawValue[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return 1;
  if (assignment.rawValue.indexOf(quote, 1) !== -1) return 1;
  for (let later = index + 1; later < lines.length; later += 1) {
    if (lines[later].includes(quote)) return later - index + 1;
  }
  return 1;
}

/**
 * Whether the rewrite gives each written name exactly its value and every
 * other variable the value it had.
 */
function keepsEveryOtherValue(
  before: string,
  after: string,
  written: ReadonlyMap<string, string>,
): boolean {
  try {
    const old = parseEnv(stripBom(before));
    const next = parseEnv(stripBom(after));
    for (const [name, value] of written) {
      if (next[name] !== value) return false;
    }
    const names = new Set([...Object.keys(old), ...Object.keys(next)]);
    for (const name of written.keys()) names.delete(name);
    return [...names].every((other) => old[other] === next[other]);
  } catch {
    return false;
  }
}
