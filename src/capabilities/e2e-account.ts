/**
 * The account the live targets act for, checked before their first live call
 * — never shipped code.
 *
 * The live targets act for a registered test account: the key in
 * `PIPELEX_E2E_API_KEY` belongs to one persona in one organization, and beside
 * it the environment says what the Pipelex team's registry of test accounts
 * expects of it, in `PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID`,
 * `PIPELEX_E2E_API_KEY_EXPECTED_ROLE` and `PIPELEX_E2E_API_KEY_EXPECTED_EMAIL`.
 * On a laptop the workspace's `test-account run` hands over all four; a CI job
 * sets the same variables from the registry. Before anything else, `GET /v1/me`
 * says who the key is, and any difference stops the run once, naming each
 * variable, the value found and the value expected.
 *
 * Why before anything else: the suites look their fixtures up by name in the
 * key's organization, so a key of another organization reads exactly like an
 * unseeded one, and that miss sends the operator to `make seed-e2e-fixture`,
 * which writes durable methods into whichever organization the key acts for.
 * Checking the account first turns "wrong organization" into its own message,
 * and keeps the seed from ever writing into the wrong catalog.
 *
 * Three call sites, one check: the live suite's global setup
 * (`e2e-global-setup.ts`), `scripts/smoke.ts` when it carries a key, and
 * `scripts/seed-e2e-fixture.ts`. The Makefile's `live-preflight` refuses a run
 * with no key or no expectations before any request, then probes
 * `/v1/version`; the comparison itself needs the API client, so it lives here.
 */

import { ApiResponseError, isProblemError } from "@pipelex/sdk";

import { LIVE_API_KEY_ENV, LIVE_RUN_COMMAND, liveApiTarget } from "./e2e-support.js";
import { createPipelexApiClient } from "./shared.js";

/** The route the check asks, as its findings name it. */
const ME_ROUTE = "GET /v1/me";

/** Where a reader learns where the account comes from and how it is checked. */
const ACCOUNT_DOC = 'docs/testing.md, "The live targets\' account"';

/**
 * What the registry expects of a key, each in the variable named after the
 * key's with this suffix, and the member of the `/v1/me` answer it is compared
 * with. The suffixes are the workspace's `test-account run` contract.
 */
export const EXPECTATION_SUFFIXES = {
  orgId: "_EXPECTED_ORG_ID",
  role: "_EXPECTED_ROLE",
  email: "_EXPECTED_EMAIL",
} as const;

type ExpectationName = keyof typeof EXPECTATION_SUFFIXES;

/** The variable holding one expectation of the key in `keyEnv`. */
export function expectationVariable(name: ExpectationName, keyEnv = LIVE_API_KEY_ENV): string {
  return `${keyEnv}${EXPECTATION_SUFFIXES[name]}`;
}

/** What the environment says the key must be. */
export interface ExpectedAccount {
  orgId: string;
  role: string;
  email: string;
}

/** The expectation variables the environment leaves unset or empty, in a fixed order. */
export function missingExpectations(
  env: NodeJS.ProcessEnv = process.env,
  keyEnv = LIVE_API_KEY_ENV,
): string[] {
  return (Object.keys(EXPECTATION_SUFFIXES) as ExpectationName[])
    .map((name) => expectationVariable(name, keyEnv))
    .filter((variable) => !env[variable]);
}

function readExpectedAccount(env: NodeJS.ProcessEnv, keyEnv: string): ExpectedAccount {
  return {
    orgId: env[expectationVariable("orgId", keyEnv)] ?? "",
    role: env[expectationVariable("role", keyEnv)] ?? "",
    email: env[expectationVariable("email", keyEnv)] ?? "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An organization as a finding names it: its name and its id, or its id alone. */
function organizationLabel(organization: Record<string, unknown>): string {
  const { name, org_id: orgId } = organization;
  return typeof name === "string" && name !== ""
    ? `${name} (${String(orgId)})`
    : JSON.stringify(orgId);
}

/** The outcome of comparing one `/v1/me` answer with what the registry expects. */
export interface AccountReading {
  /** Every difference, each naming the variable, the value found and the value expected. */
  findings: string[];
  /** The organization and role the key was confirmed to act with, for a line of output. */
  confirmed: string;
}

/**
 * Compare the body of a `/v1/me` answer with what the registry expects of the
 * key in `keyEnv`.
 *
 * An answer without the `organization` member comes from a platform that
 * predates it. That is reported as such, never as a pass, since nothing but the
 * email can then be compared, and it still stops the run.
 */
export function readAccount(
  body: unknown,
  expected: ExpectedAccount,
  keyEnv = LIVE_API_KEY_ENV,
): AccountReading {
  const orgVar = expectationVariable("orgId", keyEnv);
  const roleVar = expectationVariable("role", keyEnv);
  const emailVar = expectationVariable("email", keyEnv);
  if (!isRecord(body)) {
    return {
      findings: [`${keyEnv}: ${ME_ROUTE} answered ${JSON.stringify(body)}, not a profile`],
      confirmed: "",
    };
  }

  const findings: string[] = [];
  const { email } = body;
  if (typeof email !== "string" || email.toLowerCase() !== expected.email.toLowerCase()) {
    findings.push(
      `${keyEnv}: ${ME_ROUTE} states the account ${JSON.stringify(email)}, where ${emailVar} expects ${JSON.stringify(expected.email)}`,
    );
  }

  if (!("organization" in body)) {
    findings.push(
      `${keyEnv}: the platform does not state the key's organization yet, so its organization and role cannot be compared with ${orgVar} and ${roleVar}`,
    );
    return { findings, confirmed: "" };
  }
  const { organization } = body;
  if (!isRecord(organization)) {
    findings.push(
      `${keyEnv}: ${ME_ROUTE} states the key acts for no organization, where ${orgVar} expects ${JSON.stringify(expected.orgId)}`,
    );
    return { findings, confirmed: "" };
  }

  const label = organizationLabel(organization);
  if (organization.org_id !== expected.orgId) {
    findings.push(
      `${keyEnv}: ${ME_ROUTE} states the organization ${label}, where ${orgVar} expects ${JSON.stringify(expected.orgId)}`,
    );
  }
  const role = organization.role_in_org;
  if (role !== expected.role) {
    findings.push(
      `${keyEnv}: ${ME_ROUTE} states the role ${JSON.stringify(role ?? null)} in ${label}, where ${roleVar} expects ${JSON.stringify(expected.role)}`,
    );
  }
  return { findings, confirmed: `${label}, as ${String(role)}` };
}

/** Reads `/v1/me` with the live key; injected by the unit tests. */
export type MeReader = () => Promise<unknown>;

export interface LiveAccountOptions {
  env?: NodeJS.ProcessEnv;
  readMe?: MeReader;
}

/** The check's verdict: the account confirmed, or the one message the run stops with. */
export type LiveAccountVerdict =
  | { status: "confirmed"; account: string }
  | { status: "refused"; message: string };

function missingKeyMessage(): string {
  return (
    `The live targets did not start: ${LIVE_API_KEY_ENV} is not set, so no request was sent. ` +
    `Run them through the workspace's \`${LIVE_RUN_COMMAND}\`, which hands over the key of the ` +
    `test account they act for beside what the registry expects of it (${ACCOUNT_DOC}).`
  );
}

function missingExpectationsMessage(missing: string[]): string {
  const listed =
    missing.length === 1
      ? `${missing[0]} is`
      : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)} are`;
  return (
    `The live targets did not start: ${listed} not set, so nothing says which account ` +
    `${LIVE_API_KEY_ENV} must act for, and no request was sent. Run them through the workspace's ` +
    `\`${LIVE_RUN_COMMAND}\`, which hands over the key beside what the registry of test accounts ` +
    `expects of it; a CI job sets the same variables from the registry (${ACCOUNT_DOC}).`
  );
}

/** The one message a run stops with when its account is not what the registry expects. */
export function accountStopMessage(findings: readonly string[]): string {
  return [
    `The live targets did not start: the account ${LIVE_API_KEY_ENV} acts for could not be ` +
      "confirmed as the one the registry of test accounts expects.",
    ...findings.map((finding) => `- ${finding}`),
    "The registry's owner restores the account; never change the key or its expectations to get " +
      `past this. On a laptop the live targets run through the workspace's \`${LIVE_RUN_COMMAND}\` ` +
      `(${ACCOUNT_DOC}).`,
  ].join("\n");
}

/** Why `/v1/me` gave no answer to compare, as a finding. */
function refusalFinding(err: unknown): string | undefined {
  if (err instanceof ApiResponseError) {
    return `${LIVE_API_KEY_ENV}: ${ME_ROUTE} refused the key: HTTP ${err.status} (${err.code})`;
  }
  if (isProblemError(err)) {
    return `${LIVE_API_KEY_ENV}: ${ME_ROUTE} gave no answer: ${err.code}`;
  }
  return undefined;
}

/**
 * Check the live key's account against the expectations the environment
 * carries. A missing key or a missing expectation refuses before any request.
 */
export async function checkLiveAccount(
  options: LiveAccountOptions = {},
): Promise<LiveAccountVerdict> {
  const env = options.env ?? process.env;
  const { baseUrl, apiKey } = liveApiTarget(env);
  if (apiKey === undefined) {
    return { status: "refused", message: missingKeyMessage() };
  }
  const missing = missingExpectations(env);
  if (missing.length > 0) {
    return { status: "refused", message: missingExpectationsMessage(missing) };
  }

  const readMe =
    options.readMe ??
    (() => createPipelexApiClient({ baseUrl, apiKey }).getMe() as Promise<unknown>);
  let body: unknown;
  try {
    body = await readMe();
  } catch (err) {
    const finding = refusalFinding(err);
    if (finding === undefined) throw err;
    return { status: "refused", message: accountStopMessage([finding]) };
  }

  const reading = readAccount(body, readExpectedAccount(env, LIVE_API_KEY_ENV));
  return reading.findings.length === 0
    ? { status: "confirmed", account: reading.confirmed }
    : { status: "refused", message: accountStopMessage(reading.findings) };
}

/**
 * Raised when the live account is not the one the registry expects. Its
 * message is the whole report, so its stack is that message alone: the frames
 * of the check say nothing the message does not.
 */
export class LiveAccountError extends Error {
  override name = "LiveAccountError";

  constructor(message: string) {
    super(message);
    this.stack = `${this.name}: ${message}`;
  }
}

/**
 * {@link checkLiveAccount}, throwing its message when the account is refused.
 * Returns the organization and role the key was confirmed to act with.
 */
export async function requireLiveAccount(options: LiveAccountOptions = {}): Promise<string> {
  const verdict = await checkLiveAccount(options);
  if (verdict.status === "refused") {
    throw new LiveAccountError(verdict.message);
  }
  return verdict.account;
}
