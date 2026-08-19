/**
 * `make seed-e2e-fixture` — put the live e2e suite's durable fixture method
 * into the organization the configured API key belongs to.
 *
 * Why a durable fixture at all: the by-id legs (`fetchMethodFiles`, by-id
 * validate, by-id run) need a registered method, and `@pipelex/sdk` exposes
 * `createMethod` / `updateMethod` and **no delete of any kind**. A suite that
 * created its own method could never clean up, so it would leak one method per
 * run into the org. One method, seeded once, asserted by name instead.
 *
 * Why it is a separate, hand-invoked target rather than a step of
 * `make test-e2e`: seeding writes a durable METHOD into whichever organization
 * the key selects — a row in the user's catalog, and one the SDK cannot delete.
 * `make test-e2e` writes too (`prepare.e2e.ts` uploads a 1x1 PNG), but a storage
 * blob nobody browses is a different order of intrusion from a catalog entry, so
 * the catalog write stays behind its own hand-invoked target.
 *
 * Running it twice is safe. It looks the fixture up by name and updates the
 * stored bundle in place, so re-running after editing {@link FIXTURE_BUNDLE}
 * is how the stored copy is kept in step with the inline one.
 */

import {
  FIXTURE_BUNDLE,
  FIXTURE_METHOD_NAME,
  liveApiConfig,
  liveClient,
} from "../src/capabilities/e2e-support.js";

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  const config = liveApiConfig();
  write("pipelex-mcp — seeding the live e2e fixture method");
  write(`  target: ${config.baseUrl}`);
  write(`  name:   ${FIXTURE_METHOD_NAME}`);
  write("");

  const client = liveClient();
  const page = await client.listMethods({ q: FIXTURE_METHOD_NAME, limit: 50 });
  const existing = page.items.find((item) => item.name === FIXTURE_METHOD_NAME);

  const method =
    existing === undefined
      ? await client.createMethod({ name: FIXTURE_METHOD_NAME, mthds: FIXTURE_BUNDLE })
      : await client.updateMethod(existing.method_id, {
          name: FIXTURE_METHOD_NAME,
          mthds: FIXTURE_BUNDLE,
        });

  write(existing === undefined ? "Created the fixture method." : "Updated the existing fixture.");
  write(`  method_id:   ${method.method_id}`);
  write(`  description: ${method.description ?? "(none)"}`);
  write("");
  write(
    "The suites resolve this id by name at run time, so nothing needs recording — but the key you " +
      "run `make test-e2e` with must belong to the same organization, since the catalog is org-scoped.",
  );
}

try {
  await main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
