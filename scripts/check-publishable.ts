/**
 * `npm run check:publishable` — the publish guard, which `npm publish` runs as
 * the manifest's `prepublishOnly` script.
 *
 * `scripts/publish-guard.ts` says what it refuses and why it runs only where a
 * publish happens. This script reads the manifest npm is about to publish, the
 * `package.json` of the directory it runs in, and refuses, naming each
 * dependency, when one may not be published.
 *
 * Exit code: 0 when every dependency is a registry range or tag, 1 otherwise.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { unpublishableDependencies } from "./publish-guard.js";
import type { PublishedManifest } from "./publish-guard.js";

// `no-console` is an error in this repo's eslint config; the report is this
// script's whole output, as in `scripts/check-instructions.ts`.
const say = (text = ""): void => {
  process.stdout.write(`${text}\n`);
};

function main(): void {
  const manifestPath = path.join(process.cwd(), "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PublishedManifest & {
    name?: string;
  };
  const refused = unpublishableDependencies(manifest);
  if (refused.length === 0) {
    say(`Every dependency of ${manifest.name ?? manifestPath} is a registry range or tag.`);
    return;
  }

  say(`ERROR: ${manifest.name ?? manifestPath} may not be published with these dependencies:`);
  for (const { block, name, spec, reason } of refused) {
    say(`  ${name}: "${spec}" in ${block}, ${reason}`);
  }
  say();
  say(
    "Collapse a sprint pin onto the shipped version first (for @pipelex/sdk, " +
      "make use-npm-sdk VERSION=<version>; .worktree.toml names the collapse), and switch a " +
      "local link back with make use-npm. Never publish around this check.",
  );
  process.exitCode = 1;
}

main();
