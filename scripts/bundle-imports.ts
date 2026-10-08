import { isBuiltin } from "node:module";

/**
 * What `dist/main.js` imports, and which of those imports an installed copy
 * could not load.
 *
 * The tests run the workshop from source, so nothing in them loads the file
 * npm ships. That is how a bundle whose build stripped `node:` from
 * `node:sqlite` passed every gate: `sqlite` is not a module, and the shipped
 * file failed at load. An external import of the bundle must be a Node
 * built-in under the very name the bundle uses, or a package `package.json`
 * declares among its `dependencies` — the only packages an `npx @pipelex/mcp`
 * install provides.
 */

/** Every module specifier the bundle imports, statically or with a literal dynamic import. */
export function bundleImportSpecifiers(source: string): string[] {
  const patterns = [
    /^\s*import\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/gm,
    /^\s*export\s+[^'";]*?\sfrom\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const specifiers = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers].sort();
}

/** The specifiers an installed copy could not load: neither a built-in under that name nor a declared dependency. */
export function unloadableImports(
  specifiers: readonly string[],
  dependencies: readonly string[],
): string[] {
  return specifiers.filter((specifier) => {
    if (isBuiltin(specifier)) return false;
    // A single-file bundle has nothing beside it to import relatively.
    if (specifier.startsWith(".") || specifier.startsWith("/")) return true;
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    return !dependencies.includes(name);
  });
}
