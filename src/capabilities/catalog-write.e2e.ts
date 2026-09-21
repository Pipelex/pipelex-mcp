/**
 * Live e2e — `mthds_save_method` and `mthds_get_method` against a real Pipelex API.
 *
 * `catalog-write.test.ts` proves both tools against a fake `CatalogWriteClient`,
 * so nothing hermetic has ever sent a byte to `POST`/`PUT /v1/methods` or read
 * one back from `GET /v1/methods/{id}`. These two tools shipped with no live
 * coverage at all, which is the exact blind spot that let `mthds_list_methods`
 * fail every real call while the suite stayed green.
 *
 * The contexts come from `buildLocalToolContexts`, not hand-assembled, so what
 * runs here is the wiring a host actually gets — both resolvers, the save root,
 * and the validation context the save runs its bundle through.
 *
 * **This suite writes to the catalog**, and the platform's delete is admin-only,
 * so it reuses ONE method by name across runs: it creates only when the name is
 * absent and updates it every time after. A create per run would mint an
 * undeletable duplicate on every invocation.
 */

import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { buildLocalToolContexts } from "../local/server.js";
import { getMthdsMethod, saveMthdsMethod } from "./catalog-write.js";
import type {
  CatalogWriteContext,
  GetMethodSuccess,
  SaveMethodFailure,
  SaveMethodSuccess,
} from "./catalog-write.js";
import { FIXTURE_BUNDLE, INVALID_BUNDLE, liveApiConfig, liveClient } from "./e2e-support.js";

/** The one catalog row this suite owns. Distinct from the run fixture's. */
const WRITE_FIXTURE_NAME = "pipelex_mcp_e2e_catalog_write";

const BUNDLE_FILE = "mcp_e2e_catalog_write.mthds";

/** The fixture bundle, re-domained so it cannot collide with the run fixture. */
const BUNDLE = FIXTURE_BUNDLE.replace(/mcp_e2e_fixture/g, "mcp_e2e_catalog_write");

let workRoot: string;
let context: CatalogWriteContext;

/** The whole workshop wiring, rooted at a real temp directory. */
function contextsFor(root: string): CatalogWriteContext {
  const config = liveApiConfig();
  return buildLocalToolContexts(
    { ...process.env, PIPELEX_BASE_URL: config.baseUrl, PIPELEX_API_KEY: config.apiKey },
    root,
  ).catalogWrite;
}

/** The existing row for this suite's name, or undefined on a first run. */
async function existingMethodId(): Promise<string | undefined> {
  const page = await liveClient().listMethods({ q: WRITE_FIXTURE_NAME, limit: 50 });
  return page.items.find((item) => item.name === WRITE_FIXTURE_NAME)?.method_id;
}

/** The method id the link file in the work root records. */
async function linkedMethodId(): Promise<string> {
  const link = JSON.parse(await readFile(join(workRoot, "pipelex-method.json"), "utf8")) as {
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

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "pipelex-mcp-catalog-write-"));
  context = contextsFor(workRoot);
  await writeFile(join(workRoot, BUNDLE_FILE), BUNDLE, "utf8");
});

describe("mthds_save_method (live)", () => {
  /**
   * Create-or-update, in that order, is what keeps the suite re-runnable: the
   * first ever run exercises `POST /v1/methods`, every run after it exercises
   * `PUT`. Both are asserted the same way, on `saved`.
   */
  it("saves the bundle to the catalog and links the directory", async () => {
    const priorId = await existingMethodId();

    const result = await saveMthdsMethod(
      {
        files: [{ path: BUNDLE_FILE }],
        name: WRITE_FIXTURE_NAME,
        ...(priorId === undefined ? {} : { method_id: priorId }),
      },
      context,
    );

    const saved = asSaved(result);
    expect(saved.is_valid).toBe(true);
    expect(saved.method_id).toMatch(/^mt_/);
    expect(saved.name).toBe(WRITE_FIXTURE_NAME);
    expect(saved.saved).toBe(priorId === undefined ? "created" : "updated");
    expect(typeof saved.updated_at).toBe("string");

    // The link file is what makes the NEXT save an update rather than a
    // duplicate, so a save that reported success without writing it would
    // leave the directory able to mint a second method.
    const link = JSON.parse(
      await readFile(join(workRoot, "pipelex-method.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(link.method_id).toBe(saved.method_id);
    expect(typeof link.api_host).toBe("string");
  });

  it("updates the method it just saved, through PUT", async () => {
    // The id comes from the link file the save before this one wrote, which is
    // how a real caller gets it. Omitting it is refused as a would-be
    // duplicate, and that refusal has a case of its own below.
    const methodId = await linkedMethodId();

    const result = await saveMthdsMethod(
      { files: [{ path: BUNDLE_FILE }], name: WRITE_FIXTURE_NAME, method_id: methodId },
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
      { files: [{ path: BUNDLE_FILE }], name: WRITE_FIXTURE_NAME },
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
        files: [{ path: BUNDLE_FILE }],
        name: WRITE_FIXTURE_NAME,
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
   */
  it("reports an invalid bundle as a verdict and writes nothing to the catalog", async () => {
    const brokenRoot = await mkdtemp(join(tmpdir(), "pipelex-mcp-catalog-write-broken-"));
    const brokenContext = contextsFor(brokenRoot);
    await writeFile(join(brokenRoot, "broken.mthds"), INVALID_BUNDLE, "utf8");

    const before = await existingMethodId();

    const result = await saveMthdsMethod(
      { files: [{ path: "broken.mthds" }], name: `${WRITE_FIXTURE_NAME}_never_created` },
      brokenContext,
    );

    const saved = asSaved(result);
    expect(saved.is_valid).toBe(false);
    expect(saved.method_id).toBeUndefined();
    expect(Array.isArray(saved.validation_errors)).toBe(true);

    // No link file, so the directory was left unlinked...
    await expect(readFile(join(brokenRoot, "pipelex-method.json"), "utf8")).rejects.toThrow();
    // ...and the catalog is exactly where it was.
    expect(await existingMethodId()).toBe(before);

    const page = await liveClient().listMethods({
      q: `${WRITE_FIXTURE_NAME}_never_created`,
      limit: 50,
    });
    expect(
      page.items.find((item) => item.name === `${WRITE_FIXTURE_NAME}_never_created`),
    ).toBeUndefined();
  });
});

describe("mthds_get_method (live)", () => {
  it("brings the saved method's files to disk, and the bytes are the ones saved", async () => {
    const methodId = await existingMethodId();
    expect(methodId).toBeDefined();

    const pullRoot = await mkdtemp(join(tmpdir(), "pipelex-mcp-catalog-pull-"));
    const pullContext = contextsFor(pullRoot);

    const result = await getMthdsMethod(
      { method_id: methodId as string, output_dir: "." },
      pullContext,
    );

    const sc = result.structuredContent as GetMethodSuccess;
    expect(sc.status).toBe("ok");
    expect(sc.method_id).toBe(methodId);
    expect(sc.name).toBe(WRITE_FIXTURE_NAME);
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
    expect(roundTripped.trim()).toBe(BUNDLE.trim());
  });

  it("returns the source inline when no output_dir is given", async () => {
    const methodId = await existingMethodId();
    const inlineRoot = await mkdtemp(join(tmpdir(), "pipelex-mcp-catalog-inline-"));

    const result = await getMthdsMethod({ method_id: methodId as string }, contextsFor(inlineRoot));

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
    ).toBe(BUNDLE.trim());

    // The inline arm is read-only: it must not have written into the directory.
    expect(await readdir(inlineRoot)).toEqual([]);
  });
});
