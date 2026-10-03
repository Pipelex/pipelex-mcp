---
paths:
  - "packages/core/src/capabilities/workspace-boundary.ts"
  - "packages/core/src/capabilities/artifacts.ts"
  - "packages/core/src/capabilities/codegen.ts"
  - "packages/core/src/capabilities/codegen-writer.ts"
  - "packages/core/src/capabilities/graph-page.ts"
  - "packages/core/src/capabilities/catalog-write.ts"
  - "packages/core/src/capabilities/catalog-link.ts"
  - "packages/workshop/src/files.ts"
---

# The workshop's filesystem boundaries

The workshop reads `.mthds` files from the user's workspace and writes into it: a saved run, a generated code tree, the method graph page, a pulled method and its link file. Each of those paths is a security boundary. The contract is SPEC.md's "The files union and the path trust boundaries" (read side and write side); the module accounts are in `docs/architecture.md`.

## Containment is shared, policy never is

`workspace-boundary.ts` holds the whole of what the writers have in common: `isInsideRoot` and `containedPath` (containment without creation), `resolveSaveDir` (containment plus the one `mkdir` of the target directory) and `createContainedSubdirectory` (the same for a destination's parent). Containment code a writer needs goes there, never into a writer. The directory is real-path-checked on its deepest *existing* ancestor **before** `mkdir` — a check only afterwards lets a symlinked ancestor create directories outside the workspace — and again after. Only the resulting real directory is handed on. **Containment only — never policy.**

Above that the rules are **inverted, deliberately**, so never write one shared "write a file" helper: it would either suffix a regeneration or let a download clobber.

- `mthds_download_artifacts` (`artifacts.ts`) **never overwrites** (`wx`, a numeric suffix on collision — its own `main_stuff.json` and the SDK's files alike), because a collision there means two different files. The SDK's `downloadArtifacts` owns the filename rule and the exclusive create; this repo owns the containment and the plain-http rule. The download link comes from our own API, so the fetch is not an SSRF surface, but the cap, the timeout and the no-redirect rule hold on their own regardless of who named the URL. That opt-in is derived, never defaulted on: `allowHttp` is true only when `PIPELEX_BASE_URL` is itself `http:` or `PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP` says so, and an unrecognized value refuses.
- `mthds_codegen` (`codegen-writer.ts`) **must overwrite its own previous output and only that**, because its paths come from the engine and the lock hashes them, so regeneration has to land on the same names.
- `mthds_validate`'s method graph page (`graph-page.ts`) takes codegen's side, since every validation regenerates it under the same name: create with `wx`, replace only a file carrying `GRAPH_PAGE_MARK`, leave a foreign file, a symlink or a directory untouched.

## The codegen writer

- **Inspect destinations with `lstat`**, so a symlink is foreign by construction: an overwrite through one writes wherever it points. The download tool never had this exposure, because `wx` refuses an existing path outright.
- **Contain every destination and the lock before writing any**, with `containedPath` alone, creating nothing, so a refusal leaves the tree as it was but for the target directory `resolveSaveDir` may have made. Missing parents are created only at write time, through `createContainedSubdirectory`. A symlink, a directory or an unstamped file at a destination refuses the WHOLE write as `input_domain`@`output_dir`.
- **`hasCodegenStamp` is a one-function mirror** of the SDK's internal `hasStamp` (source of truth `pipelex/pipelex/codegen/stamp.py`), kept to one function so the swap is one line once the SDK exports it.
- **The lock's ownership test pins the `# codegen.lock` prefix, not the engine's full header sentence.** The SDK's lock parser ignores the trailing prose (`LOCK_KEYS` is `lock_version`, `crate_fingerprint`, `engine_version`, `artifacts`), so nothing fails if someone rewords it, while a verbatim match would turn every regeneration into a "foreign file" refusal on a file this tool wrote itself.
- **`lock_filename` must be exactly `codegen.lock`.** That keeps the lock where `pipelex codegen check` looks for it, stops it aliasing an artifact path (the preflight never learns the lock's filename, so it cannot see that), and keeps a `../../…` name from reaching a model on the inline arm, which has no containment of its own. The writer still contains the lock itself.

## A codegen response is preflighted before either arm hands its bytes anywhere

`runCodegenCheck` runs in memory over the response on both arms, not only on the write path, because without `output_dir` the bytes go to a model that will write them, and a report the write arm would refuse is one the inline arm must not hand over either. One notion of a valid report keeps the arms from diverging. So a hand-written artifact stub can no longer stand in for a valid arm anywhere `generateMthdsCode` runs, since the check verifies content hashes: use the recorded engine response (`codegen-fixture.ts` over `__fixtures__/codegen-ts-zod/`, stored as real `.recorded` files so byte-exactness is self-evident). Synthetic reports stay only in the pure projection tests, which never preflight.

## The read side

`packages/workshop/src/files.ts` rejects any path whose extension the argument is not contracted to **before touching the filesystem**, so a prompt-injected `.env`, `.git/config` or key path is never opened; it enforces real-path containment, and it reports every failure as a `FileResolution` value, never a throw. Keep all three gates on the submitted items, ahead of any read.

The writers have no injected write seam on purpose: a real `mkdtemp` directory is the better test double, so their tests run against real temp trees.
