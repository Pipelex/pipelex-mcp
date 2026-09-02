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
 * Cached per module instance, the negative included, so repeated asks inside
 * one file cost one request. Vitest isolates test files, so a full
 * `make test-e2e` issues one `/v1/version` read per suite file that asks —
 * not one for the whole run.
 */
export async function apiAdvertisesExtension(name: string): Promise<boolean> {
  cachedExtensions ??= readAdvertisedExtensions();
  return (await cachedExtensions).has(name);
}

let cachedExtensions: Promise<Set<string>> | undefined;

/** What `implementation` a hosted deployment calls itself — see the note below. */
const HOSTED_IMPLEMENTATION = "pipelex-hosted";

/**
 * The extension every hosted deployment has advertised since before the
 * addressing campaign, and therefore the one safe to treat as a postcondition
 * rather than as a capability under test.
 */
const BASELINE_EXTENSION = "runs";

/**
 * `extensions` is an implementation extension field on `VersionInfo`, so it
 * arrives through the untyped index signature and nothing types it anywhere:
 * a rename breaks no build in any repo. That makes the shape a thing to ASSERT,
 * not merely to narrow — because every unexpected shape reduces to "advertises
 * nothing", which is indistinguishable from a deployment that legitimately
 * serves no selectors, and the suite would skip its way to green through the
 * exact wire drift it exists to catch.
 *
 * So the deployment says which rules apply. A hosted platform declares
 * `extensions` unconditionally (it is a `list[str]` with a list default, and it
 * always contains `runs`), so on a hosted `implementation` an absent, non-array
 * or `runs`-less value is drift and throws. A bare runner declares no
 * `extensions` at all — the protocol's documented "protocol only" answer — so
 * there its absence is a fact about the runner and yields an empty set, while a
 * malformed value still throws.
 */
async function readAdvertisedExtensions(): Promise<Set<string>> {
  const info: Record<string, unknown> = await liveClient().version();
  const advertised = info.extensions;
  const isHosted = info.implementation === HOSTED_IMPLEMENTATION;

  if (advertised === undefined) {
    if (isHosted) {
      throw new Error(
        `${HOSTED_IMPLEMENTATION} answered GET /v1/version with no \`extensions\` field. A hosted ` +
          "deployment always declares one, so the field has been renamed or dropped — the probe cannot " +
          "tell a deployment that serves the selectors from one that does not, and every by-selector leg " +
          "would skip silently. Fix the probe against the new shape rather than letting the suite go green.",
      );
    }
    return new Set();
  }

  if (!Array.isArray(advertised) || advertised.some((item) => typeof item !== "string")) {
    throw new Error(
      "GET /v1/version answered with an `extensions` field that is not an array of strings " +
        `(got ${JSON.stringify(advertised)}). The wire shape changed; the by-selector legs would skip ` +
        "silently rather than report it.",
    );
  }

  const parsed = new Set(advertised as string[]);
  if (isHosted && !parsed.has(BASELINE_EXTENSION)) {
    throw new Error(
      `${HOSTED_IMPLEMENTATION} advertises ${JSON.stringify(advertised)}, which omits the baseline ` +
        `\`${BASELINE_EXTENSION}\` extension. The contents of the list have drifted, so an absent ` +
        "`method_ref` means nothing — a skip here would be a statement about the probe, not the deployment.",
    );
  }
  return parsed;
}

/**
 * The published package the by-address legs use, pinned at a tag.
 *
 * One address, shared, because three suites submit it and a tag bump that
 * reached two of them would be worse than no pin at all. A tag rather than a
 * branch because the address grammar accepts nothing else, and a package
 * whose BUNDLE declares `main_pipe` so a template-by-address leg exercises the
 * projection rather than the deployment (a package declaring it only in
 * `METHODS.toml` — `documents@v0.1.0` — is refused a template by a deployment
 * whose pin predates `pipelex-api` 26c4eee, the commit that taught the build
 * routes to read the manifest; `L-260902-3b8971` moves that pin).
 *
 * NOT usable from `validate.e2e.ts`: this package ships `text_stats_funcs.py`,
 * and `/v1/validate`'s address path applies the execution-locus gate, so a
 * fetched package carrying Python is a 403 there on any deployment that is not
 * sandbox-hosted. That leg keeps its own Python-free address on purpose.
 */
export const PUBLISHED_METHOD_REF = "github.com/Pipelex/methods/text_stats@v0.1.1";

/** The commit `v0.1.1` points at — a tag resolves to it, and a run says so. */
export const PUBLISHED_METHOD_COMMIT = "af0da07ac83e30e58443c88ec9ed4174131800a1";

/** The pipe this package's bundle declares, qualified. */
export const PUBLISHED_METHOD_PIPE_REF = "text_stats.analyze_text";

/** The one input that pipe declares. */
export const PUBLISHED_METHOD_INPUT_NAME = "text";

/** Long enough that the report has something to count. */
export const PUBLISHED_METHOD_INPUT =
  "A method is a set of pipes declared in plain text files. Some pipes call a language model, and some run deterministic Python functions in a sandbox. How many sentences is that?";

/**
 * What the package's PipeFunc counts in {@link PUBLISHED_METHOD_INPUT}.
 *
 * The pipe is a pure function, so these are constants rather than a range —
 * which is what lets a by-address run assert that the RIGHT pipe ran on the
 * RIGHT input, instead of merely that something terminal came back. Change the
 * input and these change with it; that they must be edited together is the
 * point, not an inconvenience.
 */
export const PUBLISHED_METHOD_EXPECTED_WORDS = 32;
export const PUBLISHED_METHOD_EXPECTED_SENTENCES = 3;

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
