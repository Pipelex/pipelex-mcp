/**
 * `make seed-e2e-fixture` — put the live e2e suite's durable fixture methods
 * into the organization the configured API key belongs to.
 *
 * Why durable fixtures at all: the by-id legs (`fetchMethodFiles`, by-id
 * validate, by-id run) need a registered method, and the platform makes delete
 * admin-only. A suite that created its own method could never clean up, so it
 * would leak one method per run into the org. Methods seeded once, asserted by
 * name instead.
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
 * UPDATES, because a create is check-then-act across two round trips with no
 * compare-and-swap, so two concurrent first runs would each read no row and
 * each create one — an undeletable duplicate, after which every later run
 * updates whichever row the server lists first. Creating here, once and by
 * hand, is what takes that race out of the suite.
 *
 * Running it twice is safe. It looks each fixture up by name and updates the
 * stored bundle in place, so re-running after editing {@link FIXTURE_BUNDLE}
 * or {@link CATALOG_WRITE_BUNDLE} is how the stored copies are kept in step
 * with the inline ones.
 */

import {
  CATALOG_WRITE_BUNDLE,
  CATALOG_WRITE_FIXTURE_NAME,
  FIXTURE_BUNDLE,
  FIXTURE_METHOD_NAME,
  catalogRowNamed,
  liveApiConfig,
  liveClient,
} from "@pipelex/mcp-core/capabilities/e2e-support.js";

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * Create-or-update one fixture row by name, and report which it was.
 *
 * The lookup is {@link catalogRowNamed}, which follows the cursor, and using it
 * here rather than a one-page read is what keeps re-running this script safe.
 * A lookup that stops at the first page answers "no such row" for a fixture
 * that is really there once the organization holds enough newer methods, and
 * the very next line of this function would then CREATE a second one — which
 * the platform makes admin-only to delete, after which every later run updates
 * whichever of the two the server lists first.
 *
 * The update arm READS the method first and forwards `input_data`, which is
 * what makes re-running this script the no-op its header advertises. The
 * platform's PUT rewrites the whole row and preserves only `python` on
 * omission, so an update that simply sent `{ name, mthds }` would write
 * `input_data: null` and erase any form inputs saved against the fixture from
 * the webapp. `mthds_save_method` defends the same way and for the same
 * reason — see the note above its own `updateMethod` call in
 * `packages/core/src/capabilities/catalog-write.ts`.
 */
async function seed(name: string, mthds: string): Promise<void> {
  const client = liveClient();
  const existing = await catalogRowNamed(name);

  const method =
    existing === undefined
      ? await client.createMethod({ name, mthds })
      : await client.updateMethod(existing, {
          name,
          mthds,
          input_data: (await client.getMethod(existing)).input_data,
        });

  write(existing === undefined ? `Created \`${name}\`.` : `Updated the existing \`${name}\`.`);
  write(`  method_id:   ${method.method_id}`);
  write(`  description: ${method.description ?? "(none)"}`);
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
