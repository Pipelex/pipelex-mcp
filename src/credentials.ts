/**
 * The workshop's credentials, and the home `.env` that holds a saved key.
 *
 * `pipelex login` saves its key as `PIPELEX_API_KEY` in `~/.pipelex/.env`, or
 * in the `.env` of `PIPELEX_HOME` when that is set, and the workshop reads the
 * same file whenever its host passes no key. This module owns that file: it
 * locates the home directory, reads the file, and decides each tool call's key,
 * base URL and auth-failure texture. The login's writer belongs here too, so
 * that the file is read and written by one module under one set of rules.
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
 * contents. The API is named by its origin alone, so a base URL carrying
 * credentials or a query never reaches the model.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { DEFAULT_API_URL } from "./capabilities/shared.js";
import type { AuthErrorTexture } from "./capabilities/shared.js";

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
  try {
    // Checked before the read, so a directory, a device or an oversized file
    // is refused without being opened. `stat` follows a symlinked `.env` to
    // its target, as a dotfiles setup makes it.
    const stats = await fs.stat(file);
    if (!stats.isFile() || stats.size > MAX_HOME_ENV_BYTES) return { status: "unreadable", file };
    const content = await fs.readFile(file, "utf8");
    // A leading byte-order mark would otherwise become part of the first name.
    return { status: "read", file, values: parseEnv(content.replace(/^\uFEFF/, "")) };
  } catch (err) {
    return isNotFound(err) ? { status: "missing", file } : { status: "unreadable", file };
  }
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

/** Where a call's key came from: the host's environment, the home `.env`, or nowhere. */
export type KeySource = "host" | "file" | "none";

/** One tool call's API coordinates, and the auth-failure texture that says which key failed. */
export interface WorkshopCredentials {
  baseUrl: string;
  apiKey?: string;
  source: KeySource;
  authError: AuthErrorTexture;
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
 * Decide one tool call's key and base URL, and the texture its auth failures
 * carry. Never throws. The rules are this module's header.
 */
export async function resolveWorkshopCredentials(
  env: CredentialsEnv,
  options: HomeOptions = {},
): Promise<WorkshopCredentials> {
  const hostKey = env.PIPELEX_API_KEY || undefined;
  if (hostKey !== undefined) {
    const baseUrl = env.PIPELEX_BASE_URL || DEFAULT_API_URL;
    return { baseUrl, apiKey: hostKey, source: "host", authError: hostKeyTexture(baseUrl) };
  }

  const read = await readHomeEnv(env, options);
  const homedir = options.homedir ?? os.homedir;
  const fileKey = read.status === "read" ? read.values.PIPELEX_API_KEY || undefined : undefined;
  if (read.status === "read" && fileKey !== undefined) {
    const baseUrl = fileBranchBaseUrl(env, read.values);
    return {
      baseUrl,
      apiKey: fileKey,
      source: "file",
      authError: fileKeyTexture(displayPath(read.file, homedir), baseUrl),
    };
  }

  return {
    baseUrl: env.PIPELEX_BASE_URL || DEFAULT_API_URL,
    source: "none",
    authError: noKeyTexture(read, homedir),
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

// ── the auth texture ────────────────────────────────────────────────

/** Where every auth failure locates: the key's variable, wherever its value came from. */
const AUTH_LOCATION = "PIPELEX_API_KEY";

const LOGIN_CLAUSE = `run \`${LOGIN_COMMAND}\` in a terminal`;

const HOST_CONFIG_CLAUSE = "set PIPELEX_API_KEY in the host's configuration";

function hostKeyTexture(baseUrl: string): AuthErrorTexture {
  return {
    location: AUTH_LOCATION,
    hint: `The PIPELEX_API_KEY the host passes was refused by ${apiOrigin(baseUrl)}. Replace it in the host's configuration, or remove it there and ${LOGIN_CLAUSE} to use a saved key instead.`,
  };
}

function fileKeyTexture(file: string, baseUrl: string): AuthErrorTexture {
  return {
    location: AUTH_LOCATION,
    hint: `The key saved in \`${file}\` was refused by ${apiOrigin(baseUrl)}. Run \`${LOGIN_COMMAND}\` again in a terminal to save a new one, or ${HOST_CONFIG_CLAUSE}.`,
  };
}

function noKeyTexture(read: HomeEnvRead, homedir: () => string): AuthErrorTexture {
  const hint =
    read.status === "relative_home"
      ? `No Pipelex API key is set: the host passes none, and no saved key is read, because ${RELATIVE_HOME_SENTENCE} Fix PIPELEX_HOME and ${LOGIN_CLAUSE}, or ${HOST_CONFIG_CLAUSE}.`
      : read.status === "unreadable"
        ? `No Pipelex API key is set: the host passes none, and \`${displayPath(read.file, homedir)}\` could not be read. Make it a file you can read and ${LOGIN_CLAUSE}, or ${HOST_CONFIG_CLAUSE}.`
        : `No Pipelex API key is set: the host passes none, and none is saved in \`${displayPath(read.file, homedir)}\`. To save one there, ${LOGIN_CLAUSE}, or ${HOST_CONFIG_CLAUSE}.`;
  return { location: AUTH_LOCATION, hint };
}

/**
 * The API as a hint names it: its origin, `scheme://host[:port]`, never a
 * path, credentials or a query. A value that is not an http(s) URL is not
 * shown at all.
 */
export function apiOrigin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // Not a URL: named generically below.
  }
  return "the configured Pipelex API";
}

/** A path as a hint shows it: `~/…` under the user's home directory, absolute otherwise. */
function displayPath(file: string, homedir: () => string): string {
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
