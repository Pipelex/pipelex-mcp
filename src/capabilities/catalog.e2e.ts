/**
 * Live e2e — `mthds_list_methods` against a real Pipelex API.
 *
 * `catalog.test.ts` proves the projection against a hand-written wire fixture.
 * This proves the wire fixture is still what the platform sends: the exact
 * class of break that made every real `mthds_list_methods` call fail with
 * `wire.map is not a function` while the unit suite stayed green.
 */

import { describe, expect, it } from "vitest";

import { listMthdsMethods } from "./catalog.js";
import type { CatalogContext, CatalogSuccess } from "./catalog.js";
import {
  FIXTURE_DESCRIPTION,
  FIXTURE_METHOD_NAME,
  FORBIDDEN_CATALOG_KEYS,
  findForbiddenKeys,
  liveApiConfig,
} from "./e2e-support.js";

// No `client` seam: this is the real PipelexApiClient talking to the real API.
const context: CatalogContext = liveApiConfig();

describe("mthds_list_methods (live)", () => {
  it("returns a page whose rows carry every projected field", async () => {
    const result = await listMthdsMethods({ limit: 5 }, context);

    expect(result.structuredContent.status).toBe("ok");
    const page = result.structuredContent as CatalogSuccess;
    expect(Array.isArray(page.methods)).toBe(true);
    expect(page.returned_count).toBe(page.methods.length);
    expect(page.next_cursor === null || typeof page.next_cursor === "string").toBe(true);

    // The seeded fixture guarantees the catalog is never empty, so this loop
    // always runs — an empty page would pass every assertion below vacuously.
    expect(page.methods.length).toBeGreaterThan(0);
    for (const row of page.methods) {
      expect(typeof row.method_id).toBe("string");
      expect(row.method_id).not.toBe("");
      expect(typeof row.name).toBe("string");
      expect(row.description === null || typeof row.description === "string").toBe(true);
      expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
      expect(typeof row.name_truncated).toBe("boolean");
      expect(typeof row.description_truncated).toBe("boolean");
    }
  });

  it("never leaks method source or org fields into any part of the result", async () => {
    const result = await listMthdsMethods({ limit: 5 }, context);

    // The whole result, not just the rows: the invariant covers structuredContent,
    // the summary payload, and anything the projection might start carrying.
    expect(findForbiddenKeys(result, FORBIDDEN_CATALOG_KEYS)).toEqual([]);
  });

  it("finds the seeded fixture by name, with the description the server derived", async () => {
    const result = await listMthdsMethods({ query: FIXTURE_METHOD_NAME }, context);

    expect(result.structuredContent.status).toBe("ok");
    const page = result.structuredContent as CatalogSuccess;
    const fixture = page.methods.find((row) => row.name === FIXTURE_METHOD_NAME);

    expect(
      fixture,
      `the server-side query for "${FIXTURE_METHOD_NAME}" returned no such row — seed it with \`make seed-e2e-fixture\`, ` +
        "and check the API key belongs to the organization holding it (the catalog is org-scoped)",
    ).toBeDefined();

    // Not merely "a string": the platform recomputes `description` from the
    // bundle's top-level key on every save, so this asserts that derivation
    // still happens and still reaches the row.
    expect(fixture?.description).toBe(FIXTURE_DESCRIPTION);
    expect(fixture?.description_truncated).toBe(false);
  });

  it("treats a query that matches nothing as an empty page, not an error", async () => {
    const result = await listMthdsMethods(
      { query: "no-method-answers-to-this-name-pipelex-mcp-e2e" },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    const page = result.structuredContent as CatalogSuccess;
    expect(page.methods).toEqual([]);
    expect(page.returned_count).toBe(0);
  });

  it("honours the server-side limit and its cursor", async () => {
    const first = await listMthdsMethods({ limit: 1 }, context);
    expect(first.structuredContent.status).toBe("ok");
    const firstPage = first.structuredContent as CatalogSuccess;

    // Paging is the server's job — a limit the API ignored would show up here
    // as a full page, and no client-side slicing exists to hide it.
    expect(firstPage.methods).toHaveLength(1);

    // Following the cursor needs a catalog holding more than the fixture, which
    // is not guaranteed on a freshly-seeded organization. The assertions above
    // always run; this one fires whenever there is a second page to prove.
    if (typeof firstPage.next_cursor === "string") {
      const second = await listMthdsMethods({ limit: 1, cursor: firstPage.next_cursor }, context);
      expect(second.structuredContent.status).toBe("ok");
      const secondPage = second.structuredContent as CatalogSuccess;
      expect(secondPage.methods).toHaveLength(1);
      expect(secondPage.methods[0]?.method_id).not.toBe(firstPage.methods[0]?.method_id);
    }
  });
});
