# PR #5 review — deferred notes

Follow-ups from the SWE-agent review triage on [PR #5](https://github.com/Pipelex/pipelex-mcp/pull/5) (`release/v0.2.0`).

## Output image rendering vs the view CSP (`resourceDomains`) — DECIDED, implemented

**Reporter:** greptile (P1), `src/views/run-follow.tsx` `<img>` branch of `CompletedCard`. [Thread](https://github.com/Pipelex/pipelex-mcp/pull/5#discussion_r3588366182).

**Decision (taken on the release branch):** images should render. The `mthds_run` view now declares `view.csp.resourceDomains` naming exactly the hosted platform's per-env storage buckets — `pipelex-app-{dev,staging,prod}.s3.us-west-2.amazonaws.com` — where run-output images are served as presigned URLs (15-min TTL; verified against `pipelex-api-hosted/.pipelex/pipelex_{env}.toml` storage config, `pipelex/pipelex/tools/storage/s3_storage_provider.py`'s URL builder, and `pipelex-api-infra/infra/api/s3_app.tf`; no CDN or custom domain exists). That CSP entry *is* the "compulsory destination policy" the reviewer asked for, enforced at the platform edge; combined with `narrowImageUrl`'s scheme/shape narrowing it contains the reported concern without a proxy or app-level allowlist. A failed image load (expired signature, CSP-blocked third-party host leaking through `main_stuff`) falls back to the text preview. The trust model is recorded in `SPEC.md` → "Output image trust model".

**Residual follow-up:** verify on a live host (ChatGPT and Claude) that a completed run's image actually renders — some hosts proxy images server-side regardless of the declared CSP, and DevTools cannot exercise the host CSP path. If the storage bucket names or region ever change in `pipelex-api-infra`, the allowlist in `server.ts` must follow.
