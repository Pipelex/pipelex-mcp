---
paths:
  - "Makefile"
  - "vitest.e2e.config.ts"
  - "scripts/smoke.ts"
  - "scripts/seed-e2e-fixture.ts"
  - "packages/core/src/capabilities/e2e-support.ts"
  - "packages/*/src/**/*.e2e.ts"
  - "tests/make-*.test.ts"
---

# The live suite and the Makefile's live targets

The hermetic suite fakes every API client, so a wire-shape change on the API side fails nothing in it; the live targets (`smoke`, `test-e2e`, `test-e2e-run`, `seed-e2e-fixture`, `test-all`) are the only detector, and the only targets that touch the network. `docs/testing.md` is the full account, "Detecting API drift" above all.

- **The live targets read their own pair, `PIPELEX_E2E_BASE_URL` / `PIPELEX_E2E_API_KEY`, and never `PIPELEX_BASE_URL` / `PIPELEX_API_KEY`**, which they refuse on the make command line. A shell profile exporting the production pair for other tools once sent `make test-e2e` to production. Resolution is make command line, then `.env`, then the shell, then the default, `https://api-dev.pipelex.com`; `tests/make-live-recipe.test.ts` pins it.
- **Keep them out of `make all` and `make check`**, which stay hermetic. `make test-e2e` writes (storage uploads, updates to the seeded write fixture) but never creates a catalog row and never starts a run; the run family executes only under `PIPELEX_E2E_RUN=1` (`make test-e2e-run`).
- **Gate a by-selector leg on the live API, never on a date or a hardcoded skip.** `apiAdvertisesExtension` asks `/v1/version`, and the probe asserts its own inputs: on a hosted deployment an absent or malformed `extensions` throws, so a skip always means the deployment does not serve the surface, never that the wire drifted.
- **Resolve a fixture's catalog id by name at run time, following the cursor.** `catalogRowNamed` in `e2e-support.ts` is the one helper; a one-page read reports a seeded fixture as missing once its organization grows, and that message sends the operator to seed a duplicate the platform only lets an admin delete.
- **The catalog-write suite only updates `pipelex_mcp_e2e_catalog_write`, never creates it**: a create is check-then-act with no compare-and-swap, and a duplicate is permanent. Seeding stays the separate, hand-run `make seed-e2e-fixture`.
- **A live failure means the shipped client disagrees with the live API.** The fix belongs in `../pipelex-sdk/js`, then a bump here through the `bump-sdks` skill, never a local patch. A live result that contradicts a unit fake is folded into the fake in the same change.
- **Makefile logic that reads configuration is tested by `tests/make-live-recipe.test.ts`, and the break-glass publish guard by `tests/make-release-guard.test.ts`.** Change the recipe and its test together.
