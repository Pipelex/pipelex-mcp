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
 * So publishing refuses, naming the package, a spec in any of these forms:
 *
 * - a **sprint prerelease**, `X.Y.Z-sprint.g<sha>`, the form `wt pin` writes
 *   for a package built in a member directory of its upstream, such as
 *   `@pipelex/sdk` in `pipelex-sdk/js`;
 * - a **git source**, `github:<org>/<repo>#<sha>` (the form `wt pin` writes for
 *   a package at its repository's root), `git+https://…`, `git+ssh://…`, the
 *   other hosted shorthands, or the bare `<org>/<repo>` GitHub shorthand;
 * - a **URL**, a tarball or a repository served over HTTP;
 * - a **local source**, `file:`, `link:`, `portal:`, `workspace:` or a path,
 *   which `make use-local-sdk` and `make use-local-ui` write for development.
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
 * it. `scripts/check-publishable.ts` reads the manifest and reports; the
 * classification lives here so the hermetic suite covers it.
 */

/** The dependency blocks of a manifest, each read by the guard. */
export const DEPENDENCY_BLOCKS = [
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
const LOCAL_SOURCE = /^(file:|link:|portal:|workspace:|\.{1,2}\/|\/|~\/)/;
const URL_SOURCE = /^https?:\/\//;
const GIT_SOURCE = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:|ssh:)/;
// npm reads a spec holding a slash, and no scheme, as `<org>/<repo>` on GitHub.
// A registry range never holds one; an `npm:` alias does, in its scoped name.
const GITHUB_SHORTHAND = /^[^:]+\/[^:]+$/;

/** Why a spec may not be published, or undefined when it is a registry range or tag. */
export function unpublishableReason(spec: string): string | undefined {
  const trimmed = spec.trim();
  if (SPRINT_PRERELEASE.test(trimmed)) return "a sprint prerelease";
  if (LOCAL_SOURCE.test(trimmed)) return "a local source";
  if (URL_SOURCE.test(trimmed)) return "a URL";
  if (GIT_SOURCE.test(trimmed)) return "a git source";
  if (!trimmed.startsWith("npm:") && GITHUB_SHORTHAND.test(trimmed)) return "a git source";
  return undefined;
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
