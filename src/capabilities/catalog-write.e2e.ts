/**
 * Live e2e — `mthds_save_method` and `mthds_get_method` against a real Pipelex API.
 *
 * `catalog-write.test.ts` proves both tools against a fake `CatalogWriteClient`,
 * so nothing hermetic has ever sent a byte to `PUT /v1/methods/{id}` or read
 * one back from `GET /v1/methods/{id}`. These two tools shipped with no live
 * coverage at all, which is the exact blind spot that let `mthds_list_methods`
 * fail every real call while the suite stayed green.
 *
 * The contexts come from `buildLocalToolContexts`, not hand-assembled, so what
 * runs here is the wiring a host actually gets — both resolvers, the save root,
 * and the validation context the save runs its bundle through.
 *
 * **This suite writes to the catalog, and only ever UPDATES.** It requires the
 * durable row `make seed-e2e-fixture` creates and fails loudly naming that
 * command when it is absent. It deliberately does not create the row itself:
 * a create is check-then-act across two round trips with no compare-and-swap,
 * so two concurrent first runs in one organization would each read no row and
 * each create one, leaving a duplicate the platform's admin-only delete cannot
 * undo and after which every later run updates whichever row is listed first.
 * The reasoning is written once on `CATALOG_WRITE_FIXTURE_NAME`.
 *
 * Both halves of that are enforced in `beforeAll` rather than trusted: it
 * resolves the fixture, so an unseeded organization aborts the file instead of
 * failing one test and running the rest, and it leaves the shared work root
 * linked — verified rather than assumed — so that BOTH tests submitting no
 * `method_id` meet the duplicate guard whatever else has run or failed. The
 * second of them saves from a directory of its own and arms the guard by
 * copying that link.
 *
 * Consequence to know: `POST /v1/methods` — `mthds_save_method`'s create arm —
 * therefore has no live coverage here. What exercises it live is the seed
 * script, through the SDK rather than through the tool.
 */

import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildLocalToolContexts } from "../local/server.js";
import { LINK_FILE_NAME } from "./catalog-link.js";
import { getMthdsMethod, saveMthdsMethod } from "./catalog-write.js";
import type {
  CatalogWriteContext,
  GetMethodSuccess,
  SaveMethodFailure,
  SaveMethodSuccess,
} from "./catalog-write.js";
import {
  CATALOG_WRITE_BUNDLE,
  CATALOG_WRITE_BUNDLE_FILE,
  CATALOG_WRITE_FIXTURE_NAME,
  INVALID_BUNDLE,
  catalogRowNamed,
  catalogWriteFixtureMethodId,
  liveApiConfig,
} from "./e2e-support.js";

/** A name this suite must never bring into existence. */
const NEVER_CREATED_NAME = `${CATALOG_WRITE_FIXTURE_NAME}_never_created`;

let workRoot: string;
let context: CatalogWriteContext;
let fixtureId: string;

/** Every `mkdtemp` this file makes, removed together in `afterAll`. */
const tempDirs: string[] = [];

/** A temp directory registered for cleanup — `prepare.e2e.ts`'s convention. */
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The whole workshop wiring, rooted at a real temp directory. */
function contextsFor(root: string): CatalogWriteContext {
  const config = liveApiConfig();
  return buildLocalToolContexts(
    { ...process.env, PIPELEX_BASE_URL: config.baseUrl, PIPELEX_API_KEY: config.apiKey },
    root,
  ).catalogWrite;
}

/** The method id the link file in the work root records. */
async function linkedMethodId(): Promise<string> {
  const link = JSON.parse(await readFile(join(workRoot, LINK_FILE_NAME), "utf8")) as {
    method_id: string;
  };
  return link.method_id;
}

function asSaved(result: { structuredContent: unknown }): SaveMethodSuccess {
  const sc = result.structuredContent as SaveMethodSuccess | SaveMethodFailure;
  if (sc.status !== "ok") {
    throw new Error(`expected a produced verdict, got errors: ${JSON.stringify(sc.errors)}`);
  }
  return sc;
}

/**
 * Resolve the fixture and leave the shared work root LINKED, before any test
 * runs. Both halves are safety rather than convenience, and both belong here
 * rather than in a test.
 *
 * Resolving here means an unseeded organization fails `beforeAll`, which
 * vitest treats as fatal to the whole file — a failing `it` does not stop the
 * ones after it, and the suite carries no `bail`. Linking here means the
 * tool's own duplicate guard is armed for every later test whatever runs and
 * whatever passes: the two tests that deliberately submit no `method_id` rely
 * on that guard to be refused, and an unlinked root sends them down the
 * CREATE arm instead, minting a row under the fixture's own name that the
 * platform's admin-only delete cannot remove. That is reachable three ways —
 * an unseeded organization, a `-t` filter that skips the earlier tests, and a
 * seeded organization where the first test merely FAILS, which includes the
 * wire drift this suite exists to detect.
 *
 * The linking save names `method_id`, so it takes the update arm and cannot
 * create. It is why the "links the directory" test below uses a directory of
 * its own: proving that a save writes the link needs a root that has none.
 */
beforeAll(async () => {
  fixtureId = await catalogWriteFixtureMethodId();

  workRoot = await makeTempDir("pipelex-mcp-catalog-write-");
  context = contextsFor(workRoot);
  await writeFile(join(workRoot, CATALOG_WRITE_BUNDLE_FILE), CATALOG_WRITE_BUNDLE, "utf8");

  const seeded = asSaved(
    await saveMthdsMethod(
      {
        files: [{ path: CATALOG_WRITE_BUNDLE_FILE }],
        name: CATALOG_WRITE_FIXTURE_NAME,
        method_id: fixtureId,
      },
      context,
    ),
  );

  // Arming the guard is this hook's whole job, so the link is VERIFIED and not
  // inferred from the save. `saveMthdsMethod` answers `status: "ok"` with
  // `link_file.written: false` whenever the link write declines — an unusable
  // `saveRoot`, a refused `resolveSaveDir`, a foreign entry, any `writeFile`
  // failure — because a stored method with an unwritten link is still a
  // successful save. A hook that checked only the status could therefore pass
  // having armed nothing, and vitest does not bail, so a later test failing on
  // the missing link would not stop the no-`method_id` tests from running.
  if (seeded.link_file?.written !== true) {
    throw new Error(
      `the shared work root was not linked (${seeded.link_file?.reason ?? "the save reported no link_file"}) — ` +
        "aborting the whole file rather than running the no-`method_id` tests against an unlinked " +
        "directory, where they would reach the CREATE arm and mint a row under the fixture's own name " +
        "that the platform's admin-only delete cannot remove",
    );
  }
  // Read it back off disk: `written: true` is the tool's report, and the file
  // itself is what the later tests actually depend on.
  expect(await linkedMethodId()).toBe(fixtureId);
});

describe("mthds_save_method (live)", () => {
  // A directory of its own, holding no link file, because that is the state
  // this test is about — `beforeAll` leaves the shared root already linked so
  // that no OTHER test can reach the create arm. Naming `method_id` keeps this
  // an update, so an unlinked root is safe here and only here.
  it("saves the bundle to the catalog and links the directory", async () => {
    const freshRoot = await makeTempDir("pipelex-mcp-catalog-write-fresh-");
    const freshContext = contextsFor(freshRoot);
    await writeFile(join(freshRoot, CATALOG_WRITE_BUNDLE_FILE), CATALOG_WRITE_BUNDLE, "utf8");

    const result = await saveMthdsMethod(
      {
        files: [{ path: CATALOG_WRITE_BUNDLE_FILE }],
        name: CATALOG_WRITE_FIXTURE_NAME,
        method_id: fixtureId,
      },
      freshContext,
    );

    const saved = asSaved(result);
    expect(saved.is_valid).toBe(true);
    expect(saved.method_id).toBe(fixtureId);
    expect(saved.name).toBe(CATALOG_WRITE_FIXTURE_NAME);
    expect(saved.saved).toBe("updated");
    expect(typeof saved.updated_at).toBe("string");

    // The link file is what makes a LATER save an update rather than a
    // duplicate, so a save that reported success without writing it would
    // leave the directory able to mint a second method.
    const link = JSON.parse(await readFile(join(freshRoot, LINK_FILE_NAME), "utf8")) as Record<
      string,
      unknown
    >;
    expect(link.method_id).toBe(saved.method_id);
    expect(typeof link.api_host).toBe("string");
  });

  it("updates the method it just saved, through PUT", async () => {
    // The id comes from the link file rather than from `fixtureId`, which is
    // how a real caller gets it — a save links the directory, and the next one
    // reads that link back. Omitting it is refused as a would-be duplicate,
    // and that refusal has a case of its own below.
    const methodId = await linkedMethodId();

    const result = await saveMthdsMethod(
      {
        files: [{ path: CATALOG_WRITE_BUNDLE_FILE }],
        name: CATALOG_WRITE_FIXTURE_NAME,
        method_id: methodId,
      },
      context,
    );

    const saved = asSaved(result);
    expect(saved.is_valid).toBe(true);
    expect(saved.saved).toBe("updated");
    expect(saved.method_id).toBe(methodId);
  });

  /**
   * The link guard, live: a linked directory whose save names no `method_id`
   * is refused BEFORE the catalog is touched, because a duplicate cannot be
   * undone — the platform's delete is admin-only.
   */
  it("refuses a second create for a directory already linked", async () => {
    const result = await saveMthdsMethod(
      { files: [{ path: CATALOG_WRITE_BUNDLE_FILE }], name: CATALOG_WRITE_FIXTURE_NAME },
      context,
    );

    const sc = result.structuredContent as SaveMethodSuccess | SaveMethodFailure;
    expect(sc.status).toBe("error");
    const failure = sc as SaveMethodFailure;
    expect(failure.errors[0].class).toBe("input_domain");
    expect(failure.errors[0].location).toBe("method_id");
    expect(failure.errors[0].retryable).toBe(false);
    expect(failure.errors[0].hint).toContain(await linkedMethodId());
  });

  /**
   * The `expected_updated_at` precondition. Best-effort and check-then-act —
   * the platform offers no compare-and-swap — so what is proven here is that a
   * stale stamp is REFUSED, not that the refusal is atomic.
   */
  it("refuses an update whose expected_updated_at is stale", async () => {
    const result = await saveMthdsMethod(
      {
        files: [{ path: CATALOG_WRITE_BUNDLE_FILE }],
        name: CATALOG_WRITE_FIXTURE_NAME,
        method_id: await linkedMethodId(),
        expected_updated_at: "2020-01-01T00:00:00Z",
      },
      context,
    );

    const sc = result.structuredContent as SaveMethodSuccess | SaveMethodFailure;
    expect(sc.status).toBe("error");
    const failure = sc as SaveMethodFailure;
    expect(failure.errors.length).toBeGreaterThan(0);
    expect(failure.errors[0].class).toBe("input_domain");
    expect(failure.errors[0].location).toContain("expected_updated_at");
    expect(failure.errors[0].retryable).toBe(false);
  });

  /**
   * An invalid bundle is a VERDICT, not an error — and nothing is written
   * anywhere, which is the half a mocked client cannot prove about the catalog.
   *
   * This is the SECOND of the two cases that submit no `method_id`, and it is
   * safe on two counts rather than one, because one is not enough.
   *
   * The bundle cannot validate, so the refusal lands before the catalog is
   * reached — `saveMthdsMethod` validates first and returns the invalid verdict
   * before it ever reads the link claim. But that barrier is the LIVE API's
   * judgement, and a deployment that started accepting a bundle naming a pipe
   * type that does not exist is exactly the drift this suite exists to detect,
   * so it is the one barrier that cannot be trusted to hold in the failure this
   * file is written for. Left alone, such a run would mint a permanent row
   * under `NEVER_CREATED_NAME`.
   *
   * So the directory is LINKED first, which arms the tool's own duplicate
   * guard: if validation ever stops refusing, the save is refused locally as a
   * would-be duplicate instead of creating. The server verdict stays the
   * assertion; the local guard is what makes the test safe to run.
   */
  it("reports an invalid bundle as a verdict and writes nothing to the catalog", async () => {
    const brokenRoot = await makeTempDir("pipelex-mcp-catalog-write-broken-");
    const brokenContext = contextsFor(brokenRoot);
    await writeFile(join(brokenRoot, "broken.mthds"), INVALID_BUNDLE, "utf8");
    // Arm the local guard by copying the shared root's link, so this directory
    // is already claimed. Copying rather than saving keeps the arming free of a
    // catalog write, which is what this suite is trying to stay sparing with.
    await copyFile(join(workRoot, LINK_FILE_NAME), join(brokenRoot, LINK_FILE_NAME));

    const before = await catalogRowNamed(CATALOG_WRITE_FIXTURE_NAME);

    const result = await saveMthdsMethod(
      { files: [{ path: "broken.mthds" }], name: NEVER_CREATED_NAME },
      brokenContext,
    );

    const saved = asSaved(result);
    expect(saved.is_valid).toBe(false);
    expect(saved.method_id).toBeUndefined();
    expect(Array.isArray(saved.validation_errors)).toBe(true);

    // The link this test armed is untouched — an invalid bundle re-points
    // nothing, so the directory still claims the fixture and not a new row...
    const brokenLink = JSON.parse(await readFile(join(brokenRoot, LINK_FILE_NAME), "utf8")) as {
      method_id: string;
    };
    expect(brokenLink.method_id).toBe(fixtureId);
    // ...the fixture row is exactly where it was...
    expect(await catalogRowNamed(CATALOG_WRITE_FIXTURE_NAME)).toBe(before);
    // ...and no row was minted under the name it tried to save.
    expect(await catalogRowNamed(NEVER_CREATED_NAME)).toBeUndefined();
  });
});

describe("mthds_get_method (live)", () => {
  it("brings the saved method's files to disk, and the bytes are the ones saved", async () => {
    const methodId = await catalogWriteFixtureMethodId();

    const pullRoot = await makeTempDir("pipelex-mcp-catalog-pull-");
    const pullContext = contextsFor(pullRoot);

    const result = await getMthdsMethod({ method_id: methodId, output_dir: "." }, pullContext);

    const sc = result.structuredContent as GetMethodSuccess;
    expect(sc.status).toBe("ok");
    expect(sc.method_id).toBe(methodId);
    expect(sc.name).toBe(CATALOG_WRITE_FIXTURE_NAME);
    expect(sc.files.length).toBeGreaterThan(0);

    // The written arm withholds content from the streams and says where it landed.
    for (const file of sc.files) {
      expect(file.written_to).toBeDefined();
      expect(file.content).toBeUndefined();
    }

    // The round trip is the point: what came back is what was saved.
    const written = await readdir(pullRoot);
    const mthds = written.filter((name) => name.endsWith(".mthds"));
    expect(mthds.length).toBeGreaterThan(0);
    const roundTripped = await readFile(join(pullRoot, mthds[0]), "utf8");
    expect(roundTripped.trim()).toBe(CATALOG_WRITE_BUNDLE.trim());
  });

  it("returns the source inline when no output_dir is given", async () => {
    const methodId = await catalogWriteFixtureMethodId();
    const inlineRoot = await makeTempDir("pipelex-mcp-catalog-inline-");

    const result = await getMthdsMethod({ method_id: methodId }, contextsFor(inlineRoot));

    const sc = result.structuredContent as GetMethodSuccess;
    expect(sc.status).toBe("ok");
    expect(sc.output_dir).toBeUndefined();
    expect(sc.files.length).toBeGreaterThan(0);
    for (const file of sc.files) {
      expect(typeof file.content).toBe("string");
      expect(file.written_to).toBeUndefined();
    }
    expect(
      sc.files
        .map((f) => f.content)
        .join("")
        .trim(),
    ).toBe(CATALOG_WRITE_BUNDLE.trim());

    // The inline arm is read-only: it must not have written into the directory.
    expect(await readdir(inlineRoot)).toEqual([]);
  });
});
