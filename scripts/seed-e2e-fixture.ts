/**
 * `make seed-e2e-fixture` — put the live e2e suite's durable fixture methods
 * into the organization the configured API key belongs to.
 *
 * Why durable fixtures at all: the by-id legs (the inputs template, validate,
 * the show and the run, each by id) need a registered method, and the platform
 * makes delete admin-only. A suite that created its own method could never
 * clean up, so it would leak one method per run into the org. Methods seeded
 * once, asserted by name instead.
 *
 * Why it is a separate, hand-invoked target rather than a step of
 * `make test-e2e`: seeding writes durable METHODS into whichever organization
 * the key selects — rows in the user's catalog, and ones the suites cannot
 * delete. `make test-e2e` writes too (`prepare.e2e.ts` uploads a 1x1 PNG), but
 * a storage blob nobody browses is a different order of intrusion from a
 * catalog entry, so the catalog write stays behind its own hand-invoked target.
 *
 * TWO rows are seeded. The second belongs to `catalog-write.e2e.ts`, which
 * exercises `mthds_save_method` against the real catalog: that suite only ever
 * writes the draft of an existing row, because a create is check-then-act
 * across two round trips with nothing unique to collide on, so two concurrent
 * first runs would each read no row and each create one — an undeletable
 * duplicate, after which every later run writes whichever row the server lists
 * first. Creating here, once and by hand, is what takes that race out of the
 * suite.
 *
 * Each fixture is also PUBLISHED. On a platform that resolves version
 * selectors, a bare `mt_…` names the latest published version, and a method
 * never published answers 409 `method_not_published` to every by-id leg that
 * sends one. On a platform that does not yet, the publish routes are there
 * all the same, and the bare id keeps naming the draft, which this script
 * writes first, so both platforms run the bytes in {@link FIXTURE_BUNDLE}.
 *
 * Running it twice is safe. It looks each fixture up by name, writes the
 * bundle as its draft under the token it just read, and publishes under the
 * token the write returned; an unchanged bundle publishes nothing new, since
 * the platform answers `unchanged` when the draft equals the latest version.
 * Re-running after editing {@link FIXTURE_BUNDLE} or
 * {@link CATALOG_WRITE_BUNDLE} is how the stored copies are kept in step with
 * the inline ones.
 */

import {
  CATALOG_WRITE_BUNDLE,
  CATALOG_WRITE_FIXTURE_NAME,
  FIXTURE_BUNDLE,
  FIXTURE_METHOD_NAME,
  catalogRowNamed,
  liveApiConfig,
  liveClient,
} from "../src/capabilities/e2e-support.js";

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * Create-or-write one fixture row by name, publish it, and report both.
 *
 * The lookup is {@link catalogRowNamed}, which follows the cursor, and using it
 * here rather than a one-page read is what keeps re-running this script safe.
 * A lookup that stops at the first page answers "no such row" for a fixture
 * that is really there once the organization holds enough newer methods, and
 * the very next line of this function would then CREATE a second one — which
 * the platform makes admin-only to delete, after which every later run writes
 * whichever of the two the server lists first.
 *
 * The write arm sends the draft's `mthds` alone. `PUT /v1/methods/{id}/draft`
 * keeps `python` and `input_data` on omission, so form inputs saved against
 * the fixture from the webapp survive a re-seed, and it is a compare-and-swap
 * on the token just read, so a concurrent edit is refused rather than
 * overwritten.
 */
async function seed(name: string, mthds: string): Promise<void> {
  const client = liveClient();
  const existing = await catalogRowNamed(name);

  const method =
    existing === undefined
      ? await client.createMethod({ name, mthds })
      : await client.writeDraft(existing, {
          mthds,
          expected_updated_at: (await client.getMethod(existing)).updated_at,
        });

  write(
    existing === undefined
      ? `Created \`${name}\`.`
      : `Wrote the draft of the existing \`${name}\`.`,
  );
  write(`  method_id:   ${method.method_id}`);
  write(`  description: ${method.description ?? "(none)"}`);

  const published = await client.publishMethod(method.method_id, {
    expected_draft_updated_at: method.updated_at,
  });
  if (published.outcome === "refused") {
    throw new Error(
      `The platform refused to publish \`${name}\` (${published.reason}): ${published.message}`,
    );
  }
  write(
    published.outcome === "published"
      ? `  published:   version ${published.version.version}`
      : `  published:   unchanged, still version ${published.version.version}`,
  );
  write("");
}

async function main(): Promise<void> {
  const config = liveApiConfig();
  write("pipelex-mcp — seeding the live e2e fixture methods");
  write(`  target: ${config.baseUrl}`);
  write(`  names:  ${FIXTURE_METHOD_NAME}, ${CATALOG_WRITE_FIXTURE_NAME}`);
  write("");

  await seed(FIXTURE_METHOD_NAME, FIXTURE_BUNDLE);
  await seed(CATALOG_WRITE_FIXTURE_NAME, CATALOG_WRITE_BUNDLE);

  write(
    "The suites resolve these ids by name at run time, so nothing needs recording — but the key you " +
      "run `make test-e2e` with must belong to the same organization, since the catalog is org-scoped.",
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
