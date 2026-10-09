/**
 * `npm run check:bundle` — refuse a built `dist/main.js` that an installed
 * copy could not load. Runs after `build` in `npm run check`; the reasoning is
 * on {@link unloadableImports}.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleImportSpecifiers, unloadableImports } from "./bundle-imports.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const source = await readFile(path.join(REPO_ROOT, "dist", "main.js"), "utf8");
const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const specifiers = bundleImportSpecifiers(source);
const unloadable = unloadableImports(specifiers, Object.keys(manifest.dependencies ?? {}));
if (specifiers.length === 0) {
  process.stderr.write(
    "check:bundle: dist/main.js imports nothing this check can read, so it proves nothing.\n",
  );
  process.exitCode = 1;
} else if (unloadable.length > 0) {
  process.stderr.write(
    `check:bundle: dist/main.js imports ${unloadable.map((specifier) => `"${specifier}"`).join(", ")}, which an installed copy cannot load: neither a Node built-in under that name nor a declared dependency.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `check:bundle: every import of dist/main.js is a Node built-in or a declared dependency (${specifiers.length} read).\n`,
  );
}
