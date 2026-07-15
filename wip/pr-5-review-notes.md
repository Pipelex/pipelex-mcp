# PR #5 review — deferred notes

Follow-ups from the SWE-agent review triage on [PR #5](https://github.com/Pipelex/pipelex-mcp/pull/5) (`release/v0.2.0`). Items here were verified against the code but deferred because they need a design decision, not a patch.

## Output image rendering vs the view CSP (`resourceDomains` decision)

**Reporter:** greptile (P1), `src/views/run-follow.tsx` `<img>` branch of `CompletedCard`. [Thread](https://github.com/Pipelex/pipelex-mcp/pull/5#discussion_r3588366182) — left open pending this decision.

**The reported security issue is a false positive as filed.** Two containment layers already exist:

- `narrowImageUrl` only accepts `http(s)` URLs that are image-shaped (extension pattern) or carry an `image/*` mime hint — no `javascript:`/`data:`/`file:` vector.
- The Skybridge host CSP is default-deny for external resources: the `mthds_run` view registration (`server.ts`) declares no `view.csp.resourceDomains`, so `img-src` resolves to the server's own origin and an `<img>` pointing at an arbitrary or locally-reachable host never issues a request. Hosts like ChatGPT additionally proxy images server-side.

Building a trusted proxy or an app-level host allowlist for this would be overengineering against a threat the platform already contains.

**The real gap the thread surfaced:** the same default-deny CSP almost certainly blocks *legitimate* run-output images too — Pipelex hosted-storage (`public_url`) URLs are just as external as an attacker's. So the `<img>` branch is likely dead in production, and neither `SPEC.md` nor the docs record a decision about image rendering/trust.

**Decision to make (one declarative choice covers both feature and boundary):**

- **If images should render:** add the specific Pipelex hosted-storage domain(s) to `view.csp.resourceDomains` on the `mthds_run` view in `server.ts` — a tight host allowlist, never a wildcard. That CSP entry *is* the "compulsory destination policy" the reviewer asked for, enforced at the platform edge instead of hand-rolled in app code. Verify against a live host (ChatGPT/Claude), since some hosts proxy images regardless.
- **If image rendering isn't validated yet:** record in `SPEC.md` that `resourceDomains` is intentionally unset (only the server origin loads), and consider dropping the `<img>` branch in favor of the `<pre>` preview until the storage domain is wired.

Either way, note the adjacent SPEC statement that the server "never surfaces `result_url` or other presigned URLs into model context" — image URLs in `_meta.main_stuff` are a view-only surface the SPEC's trust model doesn't discuss yet; the decision above should add that paragraph.
