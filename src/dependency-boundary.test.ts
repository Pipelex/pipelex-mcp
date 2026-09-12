/**
 * A hermetic test of the package's dependency boundary.
 *
 * This repo publishes two surfaces from one `package.json`, and only one of
 * them is installed by users: `npx @pipelex/mcp` gets the tarball, whose
 * `files` list is `dist/local` alone, and pays for every entry in
 * `dependencies` (plus every non-optional peer of one). The console's React
 * views, its component library and the Vite toolchain are needed to *build*
 * that console and never to run either server, so declaring them as runtime
 * dependencies made every workshop user download React, Vite and the whole
 * view tree before a single tool call.
 *
 * Both directions of that boundary are load-bearing and neither is visible to
 * `tsc`, ESLint or any other gate:
 *
 *   - a package the shipped entrypoints import at runtime that is NOT in
 *     `dependencies` is a production crash in an `--omit=dev` install, and
 *     every local check passes (tsup silently *bundles* a devDependency
 *     instead of leaving it external, so even the build stays green);
 *   - a package in `dependencies` that the entrypoints never import is dead
 *     install weight paid by every user, which is the bug this test was
 *     written for.
 *
 * So the test walks the source import graph from the two real entrypoints —
 * tsup's (`src/local/main.ts`, the workshop bin) and Skybridge's
 * (`src/server.ts`, the hosted console) — and pins `dependencies` to exactly
 * the packages that graph reaches. The views (`src/views/*.tsx`) are reached
 * only by Skybridge's view scanner and bundled into client assets by Vite, so
 * they are deliberately outside the graph: that is why their libraries belong
 * in `devDependencies`.
 *
 * It lives at the top of `src/` for the same reason `make-dev-recipe.test.ts`
 * does: the hermetic suite's `include` and the TypeScript root are both
 * `src/`, and it is about the package, not a module.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The two entrypoints that ship. `src/local/main.ts` is tsup's entry (the npm
 * bin); `src/server.ts` is what Skybridge compiles into `dist/server.js` and
 * `dist/__entry.js` imports. A third entrypoint would have to be added here —
 * the tsup assertion below is what makes the workshop half of that visible.
 */
const ENTRYPOINTS = ["src/local/main.ts", "src/server.ts"] as const;

/** Matches `from "x"`, `import "x"` and `import("x")`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

/**
 * `import type … from "x"` / `export type … from "x"` — elided at runtime, so
 * they are removed before the value pass below.
 *
 * The clause between `type` and `from` is spelled out — a namespace, a brace
 * list, or a single identifier — rather than left as an unbounded `[\s\S]*?`.
 * An unbounded match is this file's own vacuity hole, because a bare type
 * *alias* (`export type Foo = …;`) and a local re-export (`export type
 * { Foo };`) carry no `from` of their own: the lazy match then runs on to the
 * next `from "…"` anywhere in the file and deletes every value import in
 * between, which hides exactly the missing runtime dependency the first check
 * below exists to catch.
 *
 * That was live, not hypothetical. `export type AttachmentFetchResult` at
 * `src/capabilities/attachment-fetch.ts:113` matched forward to the prose
 * `attachments from "${url.hostname}"` at :232 and deleted 120 lines of
 * runtime code from the scan, so a runtime `import { toast } from "sonner"`
 * anywhere in that span left every assertion here green while being
 * `ERR_MODULE_NOT_FOUND` in the pruned image. `src/server.ts` ends with such
 * an alias too, and was one added import away from the same blindness.
 */
const TYPE_ONLY =
  /\b(?:import|export)\s+type\s*(?:\*(?:\s+as\s+\w+)?|\{[^{}]*\}|\w+)\s*\bfrom\s*["'][^"']+["']/g;

/**
 * An interpolation can never be an import specifier, and prose can put one
 * behind the word `from` (`` `…attachments from "${url.hostname}".` ``), so
 * anything carrying one is neither a package nor a file.
 */
function isInterpolated(specifier: string): boolean {
  return specifier.includes("${");
}

/** A specifier is a package unless it is relative, aliased, or a Node builtin. */
function isPackage(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/"))
    return false;
  return !specifier.startsWith("node:");
}

/** A published `files` entry under `dist/` — so `distribution.md` is not one. */
const UNDER_DIST = /^dist(?![\w-])/;

/** `@scope/name/deep/path` -> `@scope/name`; `name/deep` -> `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Resolve a relative (or `@/`-aliased) specifier to a file on disk. The source
 * uses ESM `.js` specifiers for TypeScript files, which is why `.js` is
 * rewritten before the extension candidates are tried.
 */
function resolveLocal(fromFile: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? path.resolve(REPO_ROOT, "src", specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  const candidates = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"]
    : [base + ".ts", base + ".tsx"];
  candidates.push(
    // A directory has to resolve to its index rather than to itself, so the
    // index candidates come before bare `base`. With `base` first, and with a
    // guard that never fired, an extensionless directory specifier resolved to
    // the directory, failed the `\.tsx?$` test in the walk and took its whole
    // subtree out of the graph with no error — the vacuous pass the first test
    // in this file is written to prevent.
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    // `resolveJsonModule` is on, so a `.json` specifier is a real import; it
    // carries no imports of its own and is only resolved to prove it exists.
    base,
  );
  // `isFile`, not merely `existsSync`: the previous `!endsWith(path.sep)` test
  // was dead code, because neither `path.resolve` nor `path.join` ever emits a
  // trailing separator, so it excluded nothing a directory could match.
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

interface Graph {
  /** Files reached from the entrypoints, repo-relative. */
  files: string[];
  /** Packages imported for their values — needed in an `--omit=dev` install. */
  valuePackages: Map<string, string[]>;
  /** Every package imported, type-only imports included. */
  allPackages: Map<string, string[]>;
}

function walkFromEntrypoints(): Graph {
  const seen = new Set<string>();
  const valuePackages = new Map<string, string[]>();
  const allPackages = new Map<string, string[]>();
  const queue = ENTRYPOINTS.map((entry) => path.resolve(REPO_ROOT, entry));

  const record = (into: Map<string, string[]>, pkg: string, file: string) => {
    const importers = into.get(pkg) ?? [];
    if (!importers.includes(file)) importers.push(file);
    into.set(pkg, importers);
  };

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    // An entrypoint that does not exist is a renamed file the list did not
    // follow, which would make the whole walk pass vacuously.
    expect(existsSync(file), `${path.relative(REPO_ROOT, file)} should exist`).toBe(true);

    const source = readFileSync(file, "utf8");
    const relative = path.relative(REPO_ROOT, file);
    const valueSource = source.replace(TYPE_ONLY, "");

    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (isInterpolated(specifier)) continue;
      if (isPackage(specifier)) {
        record(allPackages, packageOf(specifier), relative);
        continue;
      }
      if (specifier.startsWith("node:")) continue;
      const target = resolveLocal(file, specifier);
      expect(target, `${relative} imports ${specifier}, which should resolve`).toBeDefined();
      if (target !== undefined && /\.tsx?$/.test(target)) queue.push(target);
    }

    for (const [, specifier] of valueSource.matchAll(SPECIFIER)) {
      if (!isInterpolated(specifier) && isPackage(specifier)) {
        record(valuePackages, packageOf(specifier), relative);
      }
    }
  }

  return {
    files: [...seen].map((file) => path.relative(REPO_ROOT, file)).sort(),
    valuePackages,
    allPackages,
  };
}

const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  files: string[];
};
const graph = walkFromEntrypoints();

describe("the dependency boundary", () => {
  it("walks a graph that actually reaches the capabilities", () => {
    // Guards the walk itself: a broken resolver would reach two files and then
    // report a boundary that holds because it saw nothing.
    expect(graph.files).toContain("src/local/main.ts");
    expect(graph.files).toContain("src/server.ts");
    expect(graph.files).toContain("src/tools.ts");
    expect(graph.files).toContain("src/capabilities/validate.ts");
    expect(graph.files.length).toBeGreaterThan(15);
  });

  it("elides a type-only import without swallowing the value imports after it", () => {
    // The vacuity guard for the crash direction, and the reason `TYPE_ONLY`
    // spells its clause out. A bare type alias and a local re-export carry no
    // `from`, so an unbounded elision ran forward to the next `from "…"` in
    // the file and deleted the value imports in between — leaving a runtime
    // package that is only a devDependency invisible here and absent in the
    // pruned image. Both shapes below are real: `src/server.ts` ends with the
    // alias, `src/capabilities/attachment-fetch.ts` has one mid-file.
    const valuesOf = (source: string) =>
      [...source.replace(TYPE_ONLY, "").matchAll(SPECIFIER)].map(([, specifier]) => specifier);

    expect(
      valuesOf(`export type AppType = typeof server;\nimport { toast } from "sonner";`),
    ).toEqual(["sonner"]);
    expect(valuesOf(`export type { Foo };\nimport { toast } from "sonner";`)).toEqual(["sonner"]);
    expect(
      valuesOf(`export type R =\n  | { ok: true }\n  | { ok: false };\nimport "sonner";`),
    ).toEqual(["sonner"]);

    // …while every genuine type-only form is still elided.
    expect(valuesOf(`import type { A } from "types-only";\nimport "sonner";`)).toEqual(["sonner"]);
    expect(valuesOf(`import type A from "types-only";\nimport "sonner";`)).toEqual(["sonner"]);
    expect(valuesOf(`import type * as A from "types-only";\nimport "sonner";`)).toEqual(["sonner"]);
    expect(valuesOf(`import type {\n  A,\n} from "types-only";\nimport "sonner";`)).toEqual([
      "sonner",
    ]);
    expect(valuesOf(`export type { A } from "types-only";\nimport "sonner";`)).toEqual(["sonner"]);
    // An inline `type` specifier keeps the statement, so the package is a value import.
    expect(valuesOf(`import { type A, b } from "sonner";`)).toEqual(["sonner"]);
  });

  it("never resolves a specifier to a directory, so no subtree can leave the walk unnoticed", () => {
    // `src/capabilities` is a real directory with no index, so the honest
    // answer is "unresolved". Returning the directory instead satisfied the
    // walk's `toBeDefined` check, then failed its `\.tsx?$` test, and dropped
    // the subtree silently — 22 files became 10.
    expect(resolveLocal(path.join(REPO_ROOT, "src", "tools.ts"), "./capabilities")).toBeUndefined();
    // A file specifier still resolves, extensionless and via the ESM `.js` form.
    expect(resolveLocal(path.join(REPO_ROOT, "src", "server.ts"), "./tools.js")).toBe(
      path.join(REPO_ROOT, "src", "tools.ts"),
    );
    expect(resolveLocal(path.join(REPO_ROOT, "src", "server.ts"), "./tools")).toBe(
      path.join(REPO_ROOT, "src", "tools.ts"),
    );
  });

  it("refuses a published dist entry other than the workshop bundle", () => {
    // The premise the whole devDependency argument rests on. The refused set
    // has to be structural: a single refused literal let `dist/assets`,
    // `dist/server.js`, `dist/` and `dist/**` through, each of which ships the
    // console and makes its runtime imports the tarball's problem.
    for (const entry of ["dist", "dist/", "dist/**", "dist/assets", "dist/server.js"])
      expect(UNDER_DIST.test(entry), `${entry} should count as a dist entry`).toBe(true);
    for (const entry of ["README.md", "LICENSE", "distribution.md", "dist-info.txt"])
      expect(UNDER_DIST.test(entry), `${entry} should not count as a dist entry`).toBe(false);
  });

  it("declares every package the shipped entrypoints import at runtime", () => {
    // The production-crash direction: an `--omit=dev` install (what `npx` does
    // for the workshop, and what the console's Dockerfile prunes to) has only
    // `dependencies` and their peers on disk.
    const undeclared = [...graph.valuePackages]
      .filter(([pkg]) => !(pkg in manifest.dependencies))
      .map(([pkg, importers]) => `${pkg} (imported by ${importers.join(", ")})`);
    expect(undeclared).toEqual([]);
  });

  it("declares nothing in dependencies that the entrypoints never import", () => {
    // The install-weight direction: anything here is downloaded by every
    // `npx @pipelex/mcp` user, whose tarball ships `dist/local` alone.
    // `valuePackages`, not `allPackages`: a package the graph reaches only
    // through `import type` is erased at compile time, and `tsup.config.ts`
    // sets no `dts`, so the tarball publishes no declarations that could need
    // it either. Such an entry is pure install weight — the very bug this file
    // was written for — and must not be able to justify itself with a type.
    const unreachable = Object.keys(manifest.dependencies).filter(
      (pkg) => !graph.valuePackages.has(pkg),
    );
    expect(unreachable).toEqual([]);
  });

  it("keeps the console's view and build-only packages out of dependencies", () => {
    // Named explicitly so the regression reads as itself rather than as a set
    // difference. React and Vite build the console's views into client assets;
    // the component libraries are imported by `src/views/*.tsx`, which no
    // server entrypoint reaches.
    for (const pkg of [
      "@alpic-ai/ui",
      "@pipelex/mthds-form",
      "@pipelex/mthds-ui",
      "lucide-react",
      "react",
      "react-dom",
      "sonner",
      "tw-animate-css",
      "vite",
    ]) {
      // Only absence from `dependencies` is the invariant. Where such a
      // package lives otherwise is not: one that stops being used altogether
      // should be deleted, and asserting its presence in `devDependencies`
      // would fail that legitimate removal with a message blaming this
      // boundary for it.
      expect(manifest.dependencies, `${pkg} should not be a runtime dependency`).not.toHaveProperty(
        pkg,
      );
    }
  });

  it("keeps skybridge a runtime dependency, because the console imports it at runtime", () => {
    // `dist/__entry.js` and `dist/server.js` import `skybridge/server`, and the
    // Dockerfile's runtime stage carries only the pruned tree — so this one
    // cannot follow the views into devDependencies, however console-only it
    // looks. Its own non-optional peers (react, react-dom, vite, nodemon,
    // @skybridge/devtools) are therefore still installed transitively by a
    // production install; that is the remaining weight, and it needs the two
    // surfaces to be separately published rather than a manifest edit.
    expect(manifest.dependencies).toHaveProperty("skybridge");
    expect(graph.valuePackages.get("skybridge")).toContain("src/server.ts");
  });

  it("walks the entrypoint tsup actually bundles", () => {
    // ENTRYPOINTS is hand-written, so pin the workshop half to the build
    // config: a changed tsup entry would otherwise leave the bundle unwalked.
    const tsupConfig = readFileSync(path.join(REPO_ROOT, "tsup.config.ts"), "utf8");
    const entry = /entry:\s*\[([^\]]*)\]/.exec(tsupConfig)?.[1] ?? "";
    const entries = [...entry.matchAll(/["']([^"']+)["']/g)].map(([, value]) => value);
    expect(entries).toEqual(["src/local/main.ts"]);
    expect(ENTRYPOINTS).toContain(entries[0]);
  });

  it("publishes only the workshop bundle, which is why the console's deps are dev", () => {
    // The argument above rests on the tarball shipping `dist/local` alone: if
    // the console's `dist/` were published too, its runtime imports would
    // become the tarball's problem and this boundary would have to move.
    expect(manifest.files).toContain("dist/local");
    // Structural rather than one refused literal: `not.toContain("dist")` let
    // `dist/assets`, `dist/server.js`, `dist/` and `dist/**` through, any of
    // which ships the console and collapses the argument this assertion
    // exists to protect.
    const underDist = manifest.files.filter((entry) => UNDER_DIST.test(entry));
    expect(underDist).toEqual(["dist/local"]);
  });
});
