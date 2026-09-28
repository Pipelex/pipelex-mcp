---
paths:
  - "packages/core/src/capabilities/attachment-fetch.ts"
  - "packages/core/src/capabilities/attachment-fetch.test.ts"
  - "packages/core/src/capabilities/attachments.ts"
  - "packages/core/src/capabilities/attachments.test.ts"
---

# The attachment fetch boundary

**`attachment-fetch.ts` is a security boundary: treat it like `packages/workshop/src/files.ts`, not like plumbing.** It is the one place this server fetches a URL it did not configure, which makes a public endpoint an SSRF surface. Its contract is SPEC.md's "Attachment fetch boundary (console)"; its tests are `attachment-fetch.test.ts`, and `attachments.ts` reaches it only through the `AttachmentFetcher` seam.

It denies by default: `https:` only; the hostname must be `oaiusercontent.com` (apex or **any** subdomain) or match `oaisdmntpr<azure-region>.blob.core.windows.net`; no credentials in the URL; no non-default port; redirects refused outright; the 7 MiB cap enforced from `content-length` **before the body is read** *and* again mid-stream; a bounded total budget; no headers sent; non-2xx refused. Failures are returned as values, never thrown.

- **The two host rules are asymmetric on purpose — don't "harmonize" them.** The `oaisdmntpr` prefix is required, never optional, *only* because `blob.core.windows.net` is multi-tenant: any Azure customer can register under it, and a literal list is dead, since one user produced three different Azure regions in one afternoon. `oaiusercontent.com` is OpenAI's own locked domain, so there is no "any customer" hazard for a prefix to filter, and narrowing it just queues up the next outage: the boundary once allowed only `files.oaiusercontent.com` and refused every attachment the day serving moved to `sdmntpr<region>.oaiusercontent.com`.
- **Fetch the already-parsed `URL` object, never re-parse the raw string.** Re-parsing at the fetch is how an allowlist gets walked past.
- **The host check is a filter, not the defence.** These hosts are undocumented vendor infrastructure that changes without notice, so the cap, the timeout and the no-redirect rule must each hold on their own.
- **The host's `file_name` is user-supplied**, so `attachments.ts` reduces it to a bare printable basename before it names a stored asset, and partial success stays a produced verdict: a successful upload is never discarded because a sibling failed.

The `pipelex_upload_attachments` tool description and its four-field schema are mechanism, not documentation: see `.claude/rules/console-contract.md`.
