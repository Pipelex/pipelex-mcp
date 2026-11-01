/**
 * The live suite's global setup (`vitest.e2e.config.ts`): the account check,
 * once, before the first live case — never shipped code.
 *
 * It runs in Vitest's main process before any test file is collected, so a key
 * of another organization, or one handed over without what the registry
 * expects of it, stops the whole run with one message instead of failing case
 * after case on a fixture miss (`e2e-account.ts` says why that matters). It
 * covers `make test-e2e`, `make test-e2e-run` and a bare
 * `npx vitest run --config vitest.e2e.config.ts` alike.
 */

import { requireLiveAccount } from "./e2e-account.js";
import { LIVE_API_KEY_ENV } from "./e2e-support.js";

export default async function setup(): Promise<void> {
  const account = await requireLiveAccount();
  process.stdout.write(`-> ${LIVE_API_KEY_ENV} acts for ${account}, as the registry expects\n`);
}
