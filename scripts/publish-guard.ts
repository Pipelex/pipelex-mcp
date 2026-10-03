/**
 * The publish guard: which dependencies the manifest may not carry when it is
 * published to npm as `@pipelex/mcp`.
 *
 * A sprint builds the workshop against an unreleased upstream by pinning it:
 * `wt pin` writes the pin into `package.json`, the site `.worktree.toml`
 * declares, and the release train collapses it onto the shipped version before
 * the sprint branch merges. Nothing but the person running the train enforced
 * that collapse. `package.json` is both where a pin is written and what npm
 * publishes, so a pin that survived would reach every `npx @pipelex/mcp`
 * install: a git source needs git, and credentials for a private repository,
 * on every machine that installs it; a sprint prerelease ships code its
 * upstream never released.
 *
 * So publishing refuses, naming the package, every spec npm would not resolve
 * from the registry. The spec is classified by `npm-package-arg`, the parser
 * npm itself reads a manifest with, and only a version, a range or a tag
 * passes, or an `npm:` alias to one. Everything else is refused, whether or
 * not this module foresaw its spelling:
 *
 * - a **sprint prerelease**, `X.Y.Z-sprint.g<sha>`, the form `wt pin` writes
 *   for a package built in a member directory of its upstream, such as
 *   `@pipelex/sdk` in `pipelex-sdk/js`, is a version npm would resolve, so it
 *   is refused by name, ranged or aliased;
 * - a **git source**, `github:<org>/<repo>#<sha>` (the form `wt pin` writes for
 *   a package at its repository's root), and every other spelling npm reads as
 *   git: `git+https://…`, `git+ssh://…`, the scp form `git@github.com:…`, the
 *   bare `<org>/<repo>` shorthand, a `#semver:` committish;
 * - a **URL**, a tarball or a repository served over HTTP;
 * - a **local source**: a `file:` spec, the form `make use-local-sdk` and
 *   `make use-local-ui` write for development, a path, a bare `*.tgz` name, or
 *   the `link:`, `portal:` and `workspace:` protocols other package managers
 *   write;
 * - anything else npm cannot read at all.
 *
 * Every dependency block is read, `devDependencies` included: tsup inlines what
 * a devDependency provides, such as the graph page's embed serializer from
 * `@pipelex/mthds-ui`, so a pin there ships its code inside `dist/main.js`.
 * The lockfile is not read, because npm does not publish it: what a consumer
 * installs is resolved from the published manifest alone, and a pin cannot
 * reach the lock without first being written into the manifest.
 *
 * The guard runs where a publish happens and nowhere else. `make check` has to
 * stay green with a pin deliberately in place on a sprint branch, so the
 * guard is the manifest's `prepublishOnly` script, which `npm publish` runs
 * before it packs, whether `release.yml`, `make publish` or a person started
 * it. An npm configured with `ignore-scripts` runs no lifecycle script, so
 * `make publish` also runs the guard as a prerequisite and passes
 * `--ignore-scripts=false`. `scripts/check-publishable.ts` reads the manifest
 * and reports; the classification lives here so the hermetic suite covers it.
 */

import npa from "npm-package-arg";

/** The dependency blocks of a manifest, each read by the guard. */
const DEPENDENCY_BLOCKS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
] as const;

export type DependencyBlock = (typeof DEPENDENCY_BLOCKS)[number];

/** The part of a manifest the guard reads. */
export type PublishedManifest = Partial<Record<DependencyBlock, Record<string, string>>>;

/** One dependency the manifest may not be published with. */
export interface UnpublishableDependency {
  block: DependencyBlock;
  name: string;
  spec: string;
  /** What the spec is, in a few words, for the refusal. */
  reason: string;
}

const SPRINT_PRERELEASE = /-sprint\./;
// Protocols other package managers write, which npm refuses to parse at all.
const FOREIGN_LOCAL_PROTOCOL = /^(link:|portal:|workspace:)/;
// The package name only shapes npm's error messages; a spec parses the same under any.
const PROBE_NAME = "probe";

/** Why a spec may not be published, or undefined when it is a registry range or tag. */
export function unpublishableReason(spec: string): string | undefined {
  const trimmed = spec.trim();
  if (FOREIGN_LOCAL_PROTOCOL.test(trimmed)) return "a local source";
  let parsed: npa.Result;
  try {
    parsed = npa.resolve(PROBE_NAME, trimmed);
  } catch {
    return "a spec npm cannot read";
  }
  return reasonOf(parsed);
}

function reasonOf(parsed: npa.Result): string | undefined {
  switch (parsed.type) {
    case "version":
    case "range":
    case "tag":
      return SPRINT_PRERELEASE.test(parsed.rawSpec) ? "a sprint prerelease" : undefined;
    case "alias":
      return reasonOf((parsed as npa.AliasResult).subSpec);
    case "git":
      return "a git source";
    case "file":
    case "directory":
      return "a local source";
    case "remote":
      return "a URL";
    // A type a later npm adds is refused until this module has read it.
    default:
      return "not a registry range or tag";
  }
}

/** Every dependency of the manifest that may not be published, block by block. */
export function unpublishableDependencies(manifest: PublishedManifest): UnpublishableDependency[] {
  return DEPENDENCY_BLOCKS.flatMap((block) =>
    Object.entries(manifest[block] ?? {}).flatMap(([name, spec]) => {
      const reason = unpublishableReason(spec);
      return reason === undefined ? [] : [{ block, name, spec, reason }];
    }),
  );
}
