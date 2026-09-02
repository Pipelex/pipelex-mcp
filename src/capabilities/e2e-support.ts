/**
 * Shared ground for the live e2e suite (`*.e2e.ts`) — never shipped code.
 *
 * It holds the three things every live suite needs and nothing else: the API
 * coordinates read from the environment, the MTHDS fixtures the suites submit,
 * and the lookup that turns the durable fixture METHOD (seeded once per
 * organization by `make seed-e2e-fixture`) into the catalog id the by-id paths
 * take. Keeping the fixtures here rather than in each suite is what lets the
 * seed script and the suites agree on one bundle: the by-id path then asserts
 * the same template shape as the by-files path, and a drift in either shows up
 * as a disagreement rather than as two independently-stale copies.
 *
 * The module is deliberately import-free of anything Skybridge or MCP: these
 * suites call the capability functions directly, because the shells are already
 * pinned by unit tests and the drift lives at the SDK/wire boundary.
 */

import { PipelexApiClient } from "@pipelex/sdk";

import { buildApiConfig } from "./shared.js";
import type { ApiConfig } from "./shared.js";

/**
 * The API coordinates for a live run, or an instructive throw.
 *
 * A missing key fails rather than skips: a skipped live suite reports green,
 * and a check that has quietly stopped checking is worse than a red one.
 */
export function liveApiConfig(): ApiConfig {
  const config = buildApiConfig(process.env);
  if (config.apiKey === undefined) {
    throw new Error(
      "PIPELEX_API_KEY is not set — every org-scoped call would fail as a config error and this suite would " +
        "be testing the error path only. Put it in .env or export it, then run `make test-e2e`.",
    );
  }
  return config;
}

/** A real, unseamed client — what the suites use for their own setup calls. */
export function liveClient(): PipelexApiClient {
  const config = liveApiConfig();
  return new PipelexApiClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
}

/**
 * The extension names the configured API advertises on `GET /v1/version`.
 *
 * This is the gate the by-selector legs hang on, and it exists because the
 * hardcoded `it.skip("… (gated)")` that preceded it was a gate nobody re-reads:
 * it named a checkpoint in a plan document, so the day an environment started
 * serving the surface the tests stayed dark and said nothing. Asking the API
 * instead means one suite covers every environment — it exercises the legs
 * where they are served and skips them where they are not, and the skip line
 * itself is then a live statement about the deployment rather than a stale
 * comment.
 *
 * `method_ref` is the marker to gate on for the whole three-selector surface:
 * the platform build that forwards an address to the runner is the same one
 * that started accepting selector bodies on the tooling routes, so an API
 * advertising it serves `method_ref` AND `method_id` on validate, build and
 * codegen. (An environment on the previous build advertises `[runs,
 * method_id]` and serves selector bodies on neither.)
 *
 * One `/v1/version` read per suite process, cached — including the negative,
 * so a suite whose legs are all skipped still costs exactly one request.
 */
export async function apiAdvertisesExtension(name: string): Promise<boolean> {
  cachedExtensions ??= readAdvertisedExtensions();
  return (await cachedExtensions).has(name);
}

let cachedExtensions: Promise<Set<string>> | undefined;

/**
 * `extensions` is an implementation extension field on `VersionInfo`, so it
 * arrives through the untyped index signature: narrow what actually came back
 * rather than casting, or a reshaped field would gate the suite silently open
 * or silently shut.
 */
async function readAdvertisedExtensions(): Promise<Set<string>> {
  const info: Record<string, unknown> = await liveClient().version();
  const advertised = info.extensions;
  return new Set(
    Array.isArray(advertised)
      ? advertised.filter((item): item is string => typeof item === "string")
      : [],
  );
}

/**
 * The durable fixture method's name, and the whole reason it is durable: the
 * SDK exposes `createMethod` / `updateMethod` and NO delete of any kind, so a
 * create-per-run suite would leak a method into the organization on every run.
 * One method, seeded once, asserted by name.
 */
export const FIXTURE_METHOD_NAME = "pipelex_mcp_e2e_fixture";

/** The fixture's pipe, qualified — what a by-id inputs template must resolve to. */
export const FIXTURE_PIPE_REF = "mcp_e2e_fixture.name_one_word";

/** The one input the fixture declares — a template that lost it would be empty and pass vacuously. */
export const FIXTURE_INPUT_NAME = "topic";

/**
 * The fixture bundle's top-level description, interpolated into the bundle
 * below rather than repeated. The platform derives a catalog row's
 * `description` from it server-side on every save, so this one constant is what
 * lets the catalog suite assert a real value instead of merely "a string".
 */
export const FIXTURE_DESCRIPTION =
  "pipelex-mcp live e2e fixture — do not delete, the drift suite asserts on it.";

/**
 * The fixture bundle, stored under {@link FIXTURE_METHOD_NAME} and also
 * submitted inline by the by-files suites.
 *
 * Three properties are load-bearing. It VALIDATES (so the by-id validate leg
 * asserts a real verdict), it DECLARES one input (so an inputs template that
 * dropped every field cannot pass), and it is CHEAP to execute — the prompt
 * asks for a single word, because the gated run suite pays real inference for
 * it. The top-level `description` matters too: the catalog row's description is
 * derived from it server-side, so the catalog suite has something to assert.
 */
export const FIXTURE_BUNDLE = `domain      = "mcp_e2e_fixture"
description = "${FIXTURE_DESCRIPTION}"
main_pipe   = "name_one_word"

[pipe.name_one_word]
type = "PipeLLM"
description = "Answer with a single word about a topic."
inputs = { topic = "Text" }
output = "Text"
prompt = """
Reply with exactly one single word related to this topic, and nothing else.

$topic
"""
`;

/** Provenance label for the inline form of the fixture — diagnostics locate to it. */
export const FIXTURE_BUNDLE_URI = "e2e/mcp_e2e_fixture.mthds";

/**
 * A bundle that must NOT validate — it names a pipe type that does not exist,
 * which is a blueprint-schema violation rather than a judgment call.
 *
 * The verdict it drives is the point: an invalid bundle is a PRODUCED verdict
 * (`status: "ok"`, `is_valid: false`, `validation_errors[]`), not an error.
 * That discipline is the first thing wire drift corrupts, and no unit test can
 * prove the live API still honours it.
 */
export const INVALID_BUNDLE = `domain      = "mcp_e2e_broken"
description = "pipelex-mcp live e2e fixture that must NOT validate."
main_pipe   = "write_it"

[pipe.write_it]
type = "PipeThatDoesNotExist"
description = "Declares a pipe type the language does not define."
output = "Text"
`;

export const INVALID_BUNDLE_URI = "e2e/mcp_e2e_broken.mthds";

/**
 * A bundle declaring one Image input — the only way to reach the file positions
 * `mthds_prepare_inputs` walks. Submitted inline only; never stored.
 */
export const IMAGE_BUNDLE = `domain      = "mcp_e2e_image"
description = "pipelex-mcp live e2e fixture with one Image input."
main_pipe   = "describe_picture"

[pipe.describe_picture]
type = "PipeLLM"
description = "Describe a picture in a single word."
inputs = { picture = "Image" }
output = "Text"
prompt = """
Reply with exactly one single word describing this picture, and nothing else.

@picture
"""
`;

export const IMAGE_BUNDLE_URI = "e2e/mcp_e2e_image.mthds";

/** The Image input's name — the key the prepare walk must rewrite. */
export const IMAGE_INPUT_NAME = "picture";

/** The image fixture's pipe, qualified. */
export const IMAGE_PIPE_REF = "mcp_e2e_image.describe_picture";

/**
 * A 1x1 transparent PNG. Real bytes rather than a placeholder string, because
 * the workshop arm uploads it for real — and tiny, because the point is to
 * exercise the upload walk, not to move data.
 */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** An http(s) reference the console arm must pass through untouched. */
export const PASS_THROUGH_URL = "https://example.com/pipelex-mcp-e2e.png";

const MISSING_FIXTURE_HINT =
  `No registered method named "${FIXTURE_METHOD_NAME}" is visible to this API key. The by-id legs need ` +
  "one durable fixture method per organization (the SDK has no delete, so the suites cannot create one per run). " +
  "Seed it with `make seed-e2e-fixture`, then re-run. If the key is right but the org is not, mint a key in the " +
  "organization that holds the fixture — the catalog is org-scoped, so another org's method reads exactly like a miss.";

let cachedFixtureId: Promise<string> | undefined;

/**
 * The catalog id of the durable fixture, resolved BY NAME at run time.
 *
 * Resolving rather than hardcoding is deliberate: a `mt_…` id belongs to one
 * organization, this repo is public, and a scheduled canary would run under a
 * different key from a developer's. A name lookup makes the suites portable
 * across every org that has been seeded, and turns "wrong org" into the same
 * instructive failure as "not seeded".
 */
export function fixtureMethodId(): Promise<string> {
  cachedFixtureId ??= lookupFixtureMethodId();
  return cachedFixtureId;
}

async function lookupFixtureMethodId(): Promise<string> {
  const page = await liveClient().listMethods({ q: FIXTURE_METHOD_NAME, limit: 50 });
  const row = page.items.find((item) => item.name === FIXTURE_METHOD_NAME);
  if (row === undefined) {
    throw new Error(MISSING_FIXTURE_HINT);
  }
  return row.method_id;
}

/**
 * The fields the catalog's index projection must never carry into a tool
 * result — the same set `scripts/smoke.ts` walks for, restated here so the
 * capability-level suite proves it too.
 */
export const FORBIDDEN_CATALOG_KEYS = [
  "mthds",
  "python",
  "input_data",
  "pipe_output",
  "org_id",
  "created_by_user_id",
];

/**
 * Walk a whole result for forbidden *keys*, returning a JSON path per hit.
 * Keys rather than substrings: a method description may legitimately contain
 * the word "python", and a false positive on a security invariant is how the
 * invariant gets switched off.
 */
export function findForbiddenKeys(value: unknown, forbidden: string[], location = "$"): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        const childAt = `${at}.${key}`;
        if (forbidden.includes(key)) found.push(childAt);
        walk(child, childAt);
      }
    }
  };
  walk(value, location);
  return found;
}
