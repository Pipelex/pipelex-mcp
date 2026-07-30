# TODOS — ChatGPT file inputs: let the hosted console take the user's uploaded files

Build plan recorded 2026-07-30. Four phases, verification first: **(0) verify the channel against a live ChatGPT connection** → **(1) SPEC.md design pass + sign-off** → **(2) implement** → **(3) docs, gates, release**. The research this rests on — what each host actually supports, the vendor contract, the standards trajectory, and a sizing sketch — is in `wip/console-attachments-landscape.html` (recorded the same day, primary sources verified). The previous build plan (SDK 0.6.0 adoption → `mthds_prepare_inputs` → run cost) shipped as **0.8.0** and is archived at `wip/archive/TODOS-sdk-0.6-adoption-2026-07-24.md`.

**The one-line problem.** Since 0.8.0 the local workshop uploads file-bearing inputs; the hosted console is pass-through only. But on chatgpt.com and claude.ai the console is *all a user has*, and both let people drop a PDF into the chat. ChatGPT — and only ChatGPT — exposes those attachments to an MCP tool call. This plan takes that channel.

**Cold-start for a new session**: read the **STATUS** banner below, then `wip/console-attachments-landscape.html` (the why and the host facts), then `SPEC.md` → Deployments + Prepare Inputs Scope + Non-Goals, then `CLAUDE.md`. Invoke the `skybridge` skill per `AGENTS.md` before touching code. Nothing here is implemented.

## STATUS (2026-07-30) — PHASE 0 COMPLETE, CHECKPOINT 0 = GO. Next session starts at Phase 1 (the SPEC design pass).

Branch **`probe/openai-fileparams-phase0`** (throwaway, never merged). Current release is **0.8.0**; `main`/`dev` carry an `## [Unreleased]` Skybridge-1.3.2 entry only. No SPEC change yet, and none until CHECKPOINT 0 clears.

The channel works on ChatGPT desktop web **and** iOS. Five captures, three Azure regions, 140 KB to 19.6 MB, all fetched and byte-verified. The findings are recorded below as **A1–A11** (live observations) and **F1–F5** (rig self-test); read A1, A2, A9, A10 and A11 first — those four changed the design. Two non-blocking items are carried into Phase 1: an image on mobile, and an end-to-end ingest timing against the hosted request timeout.

**Before anything else in Phase 1**, tear the rig down per CHECKPOINT 0 — it logs request `_meta` containing user location and stable account identifiers (A4), so it is delete-on-sight, not something to graduate.

**Why Phase 0 is not optional.** The entire plan rests on a *vendor* behavior that is documented but has open defects (mobile sends placeholder strings instead of file objects; duplicate invocations; undocumented URL TTL and size limits). We have read the contract; we have not watched it fire against our own deployed console. Design decisions in Phase 1 — chiefly ingest-vs-pass-through — are *decided by* Phase 0's measurements. Do not skip ahead.

## Cross-cutting constraints — read before any phase

- **The capability core must stay Skybridge-free.** Verified 2026-07-30: `src/tools.ts` and everything under `src/capabilities/` import zero Skybridge symbols (only `hosted/`, `views/`, `helpers.ts` do). So **do not** import `FileRef` from `skybridge/server` into the shared schema — it would drag Skybridge into the tsup-bundled workshop bin. Declare an equivalent Zod object in the capability layer instead, and keep it byte-compatible with what ChatGPT sends.
- **The four-field rule is enforced by app review.** Any field named in `_meta["openai/fileParams"]` must declare **exactly** `download_url` (required), `file_id` (required), `mime_type` (optional), `file_name` (optional). A fifth property, a missing one, or a wrongly-required optional fails OpenAI's "Scan Tools" step. This is why the binding between an attachment and an input slot cannot live on the file object — see D1.
- **Bytes must never enter the model's context.** This is the invariant that made the original console-upload deferral correct, and the only reason this increment is now allowed. Nothing in this plan may return base64 to the model or accept it as an argument.
- **The console still never reads a filesystem.** Fetching a host-supplied URL is a *network* read; the `readLocalPath` LFI/DoS/existence-oracle refusal (SPEC "Prepare Inputs Scope" blockquote) stays exactly as it is. Do not relax `allowUpload`.
- **A server-side fetcher on a public endpoint is an SSRF surface.** The host allowlist, size cap, timeout, and redirect policy ship *with* the first fetch, not after it. Treat this as a release blocker, not a hardening follow-up.
- **Branch + gate hygiene.** Work branch prefixed per `guard-branches.yml` (`feature/…`); `make check && make test` green before any checkpoint is called reached; release only via the `/release` skill.

## Premise — confirmed from primary sources (2026-07-30), and what remains unknown

**Confirmed (vendor docs, changelog, and the installed `skybridge@1.3.2` types):**

- A tool declaring `_meta["openai/fileParams"]: ["<field>"]` receives the user's conversation attachment as `{ download_url, file_id, mime_type?, file_name? }` in its arguments, behind a user permission dialog. Model-generated files (`/mnt/data/…`) route through the same substitution. Arrays are supported via `items`.
- The server fetches the bytes itself from a signed HTTPS URL (observed host `files.oaiusercontent.com`). No base64, no inline binary.
- Skybridge ships both halves already: `FileRef` (server Zod schema) and `useFiles()` (`upload` / `selectFiles` / `getDownloadUrl`) for views. We are on 1.3.2.
- **claude.ai has no equivalent** — no file id, no signed URL, no host-injected reference reaches a connector. It will simply leave the field absent. MCP has nothing in-spec either (through `2026-07-28`); SEP-2631 is an open draft.
- `@pipelex/sdk`'s `uploadFile(client, asset, { filename, contentType })` accepts `Uint8Array` and returns `{ uri }` — no filesystem involvement, so the ingest path needs no new SDK surface.

**Unknown — Phase 0 must measure:**

- `download_url` TTL (undocumented; the docs imply expiry by offering a "mint a fresh URL" call). **This decides D2.**
- Maximum file size and which MIME types the host will hand over.
- Whether the documented payload matches reality on our deployment, on desktop web.
- The exact malformed shape mobile sends, so we can classify it instead of crashing on it.

---

## Phase 0 — verify the channel against a live ChatGPT connection

Cheapest possible probe, on a throwaway branch: add `openai/fileParams` to scratch tools that do nothing but echo what they received, connect ChatGPT to the dev server (or a scratch Alpic deploy), and watch.

### Attempt 1 (2026-07-30, ChatGPT desktop web) — NULL RESULT, self-inflicted. Rig reworked.

ChatGPT called `_probe_files` with **only** `note` — `attachments` absent, zero candidate URLs:

```json
{"tool":"_probe_files","arguments_json":"{\n  \"note\": \"Probe the PDF attached by the user: Job-Offer(1).pdf\"\n}",
 "attachment_shape":"absent","candidate_url_count":0,"url_probes":[]}
```

**This measured our own tool description, not ChatGPT.** The v1 description said *"Do NOT invent values for `attachments` — the host fills that field in… If the host does not fill it in, call the tool anyway with it absent"*, and `attachments` was optional. The model complied exactly. But the substitution is not spontaneous injection into an untouched field: the model references the file and the host **rewrites** that reference into the signed-URL object. v1 forbade the one action that triggers the mechanism and supplied an explicit escape hatch. Nothing was learned about the vendor.

Two things changed as a result:

- `attachments` is now **required** on `_probe_files`, and both descriptions push the opposite way: *always* pass the attached file, an omitted/empty field is a failed test rather than a safe default, and if the strict shape can't be built put whatever reference exists (id, name, URL, placeholder) into the permissive variant.
- The rig no longer depends on a probe tool being called *correctly* to learn anything — see the protocol recorder below.

### Attempt 2 (2026-07-30, ChatGPT desktop web) — CHANNEL CONFIRMED. The substitution fires.

With `attachments` required and the description inverted, ChatGPT rewrote the model's file reference into the full four-field object and our server fetched the bytes:

```json
{"file_id":"sediment://file_000000007170820b8e06c722f24cc48a",
 "download_url":"https://oaisdmntprnznorth.blob.core.windows.net/files/00000000-7170-820b-8e06-c722f24cc48a/raw?se=2026-07-30T15%3A47%3A24Z&sp=r&sv=2026-02-06&sr=b&scid=…&sig=…",
 "mime_type":"application/pdf","file_name":"Job-Offer(2).pdf"}
```

Fetch: `206 Partial Content`, `content-type: application/pdf`, `content-range: bytes 0-4095/140830`, magic `%PDF-1.4`, 751 ms. `attachment_shape: array(1)<object{download_url,file_id,file_name,mime_type}>` — the documented shape exactly, array form included.

**The two calls in that session are the whole lesson.** Call #7 (model improvising) sent only `note`. Call #9 — after the user said *"pass the PDF in the attachments field"* — carried the full object. The host substitutes **only where the model puts a reference**; it never injects into a field the model left alone.

**A1 — the storage host is Azure Blob, it is region-scoped, and it VARIES BETWEEN CALLS.** Two samples, same user, same session, minutes apart:

| # | host | file |
|---|---|---|
| 1 | `oaisdmntpr**nznorth**.blob.core.windows.net` | 140 KB PDF |
| 2 | `oaisdmntpr**koreacentral**.blob.core.windows.net` | 19.6 MB PDF |
| 3 | `oaisdmntpr**koreacentral**.blob.core.windows.net` | 140 KB PDF (iOS) |
| 4 | `oaisdmntpr**westus**.blob.core.windows.net` | 298 KB PDF |

`server: Windows-Azure-Blob/1.0`, `x-ms-*` headers throughout. The pattern is `oaisdmntpr<azure-region>.blob.core.windows.net` — the suffix is Azure's, the `oaisdmntpr` prefix is OpenAI's, the middle is an Azure region name (`newzealandnorth`, `koreacentral`, `westus`). Four samples, **three distinct regions, one user, one afternoon** — and the region bears no relation to the user's location (Bangkok throughout), so it is assigned per upload.

**A literal host allowlist is dead.** It would not merely break for users in other regions — it broke *inside a single session for a single user*. D3 must match a pattern.

> **Security note for D3, worth stating explicitly:** a suffix-only rule (`*.blob.core.windows.net`) is **not safe**. Any Azure customer can create a storage account under that suffix, so a suffix-only allowlist would happily fetch an attacker-controlled blob. The `oaisdmntpr` prefix is the only OpenAI-specific part and must be **required**, not optional. And since that prefix is undocumented vendor infrastructure that can change without notice, the byte cap, the timeout and the no-cross-host-redirect rule must hold on their own — the host check is a filter, not the defence.

**A2 — the URL is an Azure SAS with a ~5-minute life *from the tool call*. D2 IS DECIDED: INGEST, NOT FORWARD.** Both samples agree closely:

| # | tool call | SAS `se` | window |
|---|---|---|---|
| 1 | 15:42:17.6Z | 15:47:24Z | **306 s** |
| 2 | 15:55:14.2Z | 16:00:19Z | **305 s** |
| 4 | 16:29:11.0Z | 16:34:17Z | **306 s** |

**Confirmed empirically, not just read off the URL**: sample 1 re-fetched `206` at +288 s and `403` at +328 s, bracketing its declared expiry exactly.

*Correction to an earlier note in this file*: the window was first recorded as 374 s by anchoring on the blob's `last-modified`. The operationally relevant anchor is **when the URL reaches us**, which gives ~305 s. Design against 5 minutes, not 6. A durable run's workers fetch minutes to hours after the tool call, so forwarding the raw `download_url` into a run would routinely hand them a dead URL. The bytes must be fetched and uploaded to Pipelex storage during the tool call, and the run must receive a `pipelex-storage://` reference. This also settles the D1 tension in favour of **Option B** (a dedicated ingest tool returning storage URIs): with a 6-minute source URL there is no viable pass-through design to weigh it against.

**A3 — the Apps runtime is engaged, and it identifies itself on `tools/call`, not `initialize`.** ChatGPT's `initialize` is plain (`clientInfo: {"name":"openai-mcp","version":"1.0.0"}`, UA `openai-mcp/1.0.0`, `_meta: null`). Every `tools/call` then carries `openai/userAgent`, `openai/locale`, `openai/userLocation`, `openai/subject`, `openai/session`, `openai/organization`, and `io.modelcontextprotocol/clientCapabilities` (`openai/visibility`, plus the MCP-UI `text/html;profile=mcp-app` extension). So "are we talking to the Apps runtime?" must be answered from a tool call, never from the handshake.

**A4 — ChatGPT sends user location and stable identifiers on every tool call.** `openai/userLocation` includes city, region, country, timezone and **latitude/longitude**; `openai/subject` / `openai/session` / `openai/organization` are stable opaque ids. This is PII arriving on a surface we did not ask for. **Production must not log request `_meta`.** The probe rig does log it — that is another reason the rig is delete-on-sight rather than something to graduate. Note it in SPEC when the tool is specified.

**A5 — `file_id` is not an opaque token but a scheme-prefixed URI**: `sediment://file_00000000…`. Do not assume `^file[-_]` when validating.

**A11 — THE DESCRIPTION FIX IS VALIDATED. With a refreshed tool list the model populates `attachments` unprompted, first try.** Connector removed and re-added → ChatGPT issued `tools/list` (twice, plus `resources/read`) at 16:27 → at 16:29 a **single** `tools/call` with `attachments` **present**. No coaching, no absent-field first attempt, no retry.

Contrast the whole session: under the stale v1 text, *every* run either started with an absent field or needed the user to say "pass the PDF in the attachments field". Under v2, zero prompting.

**This closes F5 as proven, not merely suspected:** the tool description *is* the mechanism. Ship-quality wording is not polish; it is the difference between a working feature and a silently inert one. Combined with A10 (descriptions are cached and un-hotfixable), this is the single most important operational constraint Phase 0 produced — carry both into D4 and Phase 3.

**A10 — ChatGPT CACHES THE TOOL LIST PER CONNECTOR AND NEVER REFRESHES IT. Every measurement in this session ran against the v1 tool description.** The model refused to populate the image, quoting *"Do NOT invent values for attachments"* — a phrase **deleted in the rework**. The current server serves the opposite text (*"ALWAYS pass the user's attached file(s)"*), verified directly against `/mcp`. The log settles it: since this server started, ChatGPT has issued `initialize` four times and `tools/call` five times, and **`tools/list` exactly zero times.** It re-handshakes per conversation but never re-reads the tools.

Two consequences, and the second is the important one:

- **Immediate:** the description rework was never actually tested. Every successful capture in this session came from the user manually overriding a *stale* instruction, not from the new one. Whether a good description makes the model populate `attachments` unprompted is **still unknown**. To find out, remove and re-add the connector in ChatGPT, then retry without coaching.
- **For Phase 3 / release:** *a tool-description change does not reach existing users.* Their connector keeps serving whatever it cached at add-time. Combined with F5 — the description is load-bearing *mechanism*, not documentation — this means **a description defect is not hot-fixable**: shipping a fix leaves every existing installation broken until each user re-adds the connector. The initial wording therefore needs the same review rigour as the schema, and the release notes need to say "re-add the connector" out loud. Record this in SPEC alongside the tool contract.

> This also re-opens A9 slightly. The model's "schema must expect a file parameter" explanation is still corroborated by `_probe_files_raw` never being invoked — but that tool was *also* only ever known to ChatGPT through the same stale list. A9's conclusion is probably right and is consistent with the four-field rule's existence; treat it as strong but not airtight until re-tested against a refreshed connector.

**A9 — the four-field schema is a RUNTIME gate, not just an app-review checkbox. The permissive-capture tool cannot work, and does not need to.** Asked to pass an image to `_probe_files_raw`, the model declined, reporting that the platform instructs it to pass uploaded-file references *only to tools whose schema expects a file parameter* — which the permissive tool's schema (`{"description": …}`, no `type`, no properties) does not. The log corroborates it exactly: across the whole session, **`_probe_files_raw` was never invoked once** (5 calls, all `_probe_files`, 3 with attachments populated).

So the host gates substitution on the declared JSON Schema. A field only receives a file if it declares the four-field object shape.

**This kills the remedy proposed in F2 — but the protocol recorder already replaced it.** The recorder runs at the MCP protocol layer and captures `tools/call` params **before** Zod validates them (proven by entry #19: raw params recorded with `attachments` absent, *then* the validation `isError` at #20). So a malformed payload sent to the **strict** tool is captured verbatim anyway. The two-tool design was sound reasoning from the wrong premise; the recorder, added later for an unrelated purpose, subsumes it entirely.

Two consequences for Phase 1:

- **Point the remaining image-on-mobile probe at `_probe_files`, not `_probe_files_raw`.** The strict tool is the only one the host will populate, and the recorder captures whatever arrives.
- **A "lenient" production schema is not an option.** D1/D6 must assume the exact four-field object, because anything looser is invisible to the mechanism. `_probe_files_raw` is dead weight in the rig and should be deleted at teardown.

**A7 — iOS mobile WORKS, and the documented placeholder defect did NOT reproduce.** `ChatGPT/1.2026.202 (iOS 26.5.2; iPhone14,7)`, PDF attachment:

- First call: `attachments` **absent** — the exact same "model didn't fill the field" pattern as desktop attempt 1, *not* a placeholder string.
- After *"call it again and pass the PDF in the attachments field"*: full four-field object, `sediment://file_0000000001ec…`, host `oaisdmntprkoreacentral…`, fetched `206`, 140,830 bytes.

**But do not close the mobile question on this.** The defect reports this plan was written against describe **image** payloads — `{"images": ["chat_upload"]}` and `"chat_upload://image_0"`. We tested a **PDF**. The untested cell is therefore *image + mobile*, and that is exactly where the reported breakage lives. Probe an image on iOS against `_probe_files_raw` before deciding D6's mobile arm. On current evidence, mobile-with-documents is a working path.

**A8 — a schema rejection surfaces as an `isError` tool result on the hosted shell, and the model recovers from it unaided.** The failed mobile call came back as `{"content":[{"type":"text","text":"MCP error -32602: Input validation error… expected array, received undefined"}],"isError":true}` — note skybridge converts the thrown `McpError` into an `isError` result, unlike the local stdio shell which surfaces a raw JSON-RPC `-32602`. **This softens F2 considerably.** We still cannot classify such a failure in the capability layer, but the raw Zod text reached the model and the model self-corrected on the very next call. D6's mobile arm may not need to be implementable at all — the failure is self-correcting in practice. A description hint is likely sufficient; do not build machinery for it.

**A6 — 19.6 MB passes the handoff, and the SAS window is not the binding constraint.** ChatGPT handed over a 19,631,193-byte PDF (`%PDF-1.6`) with no refusal, no truncation, `206` with `content-range: bytes 0-4095/19631193`. Pulling the **whole** file took **6.2 s at 3.2 MB/s — 2 % of the 305 s window**. Extrapolated, the window would allow roughly a gigabyte, so the SAS expiry will not be what stops us; **our own byte cap and the platform's request timeout will be**. Two consequences:

- The D3 byte cap is a *product* decision (what is a sane MTHDS input?), not a safety-driven one forced by the expiry. Pick it deliberately.
- The real risk moved to the **hosted request budget**: a ~5-minute one-shot tool call that must fetch *and* re-upload. Phase 1 must check Alpic's request timeout before assuming a synchronous ingest of a large file fits in one call. That, not the SAS, is the constraint to design against.

> **Caveat on what A6 does and does not show.** The probe reads only the first 4 KB by design; the 19.6 MB figure is `content-range`, and the full-file timing above was a separate manual fetch. So the *handoff* ceiling is ≥ 19.6 MB and the *fetch* is fast — but an end-to-end ingest (fetch → `uploadFile` → `pipelex-storage://`) at that size has still never been run. Do not treat "19 MB works" as covering the upload leg.

### The rig — reworked, self-tested, ready for attempt 2

Everything lives under `src/probe/` plus `scripts/probe-url-ttl.mjs`, and is **gated behind `PIPELEX_PROBE_ATTACHMENTS=1`** (verified: flag unset or `0` → 6 tools, `1` → 8). `src/tools.ts` and `src/capabilities/` are untouched.

**1. A protocol-level recorder (`mcpMiddleware`) — the important addition.** It records *every* MCP request verbatim, not just our tools: `initialize` (with `clientInfo` and any request `_meta`), `tools/list`, and `tools/call` params. This is what answers the question attempt 1 could not — *is ChatGPT engaging its Apps runtime with us at all?* If `openai/*` keys appear in the request `_meta`, the runtime is live and a null `attachments` is a substitution problem; if they never appear, we are being treated as a plain MCP connector and `openai/fileParams` was never going to fire. Verified capturing `clientInfo`, `openai/*` request `_meta`, and verbatim `tools/call` params. Headers pass an **allowlist**, with `authorization`/`cookie` forced to `<redacted>` — the log is HTTP-readable and must never hold a BYOK key.

**2. `GET /probe` — the log over HTTP.** Returns the whole observation buffer as JSON; `?clear=1` empties it between attempts. This replaces the filesystem as the primary channel: it works on a deployed/ephemeral instance, it needs no copy-paste out of the ChatGPT UI, and it's readable by both of us with `curl`. The JSONL append stays as a durable local secondary.

**3. Two tools, not one.** The plan called for a single echo tool; the self-test proved that insufficient (F2 below):

- `_probe_files` — the **exact** four-field shape, faithful to what we would ship, `attachments` required.
- `_probe_files_raw` — an unconstrained `attachments`, so a payload that does *not* match gets captured instead of rejected before we see it. Use this for the mobile run, and whenever the strict one errors.

Both echo the verbatim arguments and fetch every http(s) string they find (ranged GET, 4 KB cap, 15 s timeout), recording status, headers, magic bytes, redirect target, elapsed time and `declared_expiry`.

**4. `scripts/probe-url-ttl.mjs`** re-fetches captured URLs on a widening schedule (0/1/2/5/10/15/20/30/45/60/90/120 min) and prints the last-OK / first-FAIL boundary, reading the JSONL directly so nobody copies a 900-character signed URL by hand.

> **Note on the observation channel.** The JSONL was never broken — `dev:tunnel` runs the MCP server *on the developer's machine*; the tunnel only forwards inbound traffic to it, and our own Node process does the write. ChatGPT never touches the filesystem. The real weakness was different: a filesystem log is invisible remotely and dies on a deployed instance. `GET /probe` fixes that.

- [x] **Build the scratch tools.** Done, and verified against both shells: `tools/list` returns the shipped six plus the two probes, with `_meta["openai/fileParams"]: ["attachments"]` present and the shipped tools unchanged.
- [x] **Connect ChatGPT** (attempt 1, desktop web). The connector works; tools are listed and called. Only the attachment handoff is unresolved.
- [x] **Rework after the null result** — required field, inverted descriptions, protocol recorder, HTTP-readable log.
- [x] **Confirm the happy path on desktop web (attempt 2).** Confirmed — full four-field object, `206`, real PDF bytes. Verbatim payload recorded above.
- [x] **Read the `initialize` capture.** Done — see A3. The answer was neither branch below: `initialize` is plain, and the `openai/*` identification rides on `tools/call` instead.
  - `openai/*` present → the Apps runtime is live; a still-absent `attachments` means the substitution itself is the problem (wrong `_meta` placement, an unregistered/unreviewed connector, or a dev-mode limitation).
  - `openai/*` absent → we are a plain MCP connector to this host and `openai/fileParams` will never fire here. That is a **go/no-go answer**, not a bug: it would mean the channel needs a reviewed ChatGPT app, and CHECKPOINT 0 should record it as such.
- [x] **Measure the TTL.** Answered from the URL itself, exactly as F4 predicted — though via the Azure-SAS `se` parameter, not SigV4. **374 seconds.** D2 is settled: ingest.
- [x] **Probe the size ceiling — handoff leg.** 19.6 MB passes untruncated; full fetch 6.2 s (A6). The true host-side ceiling is still unfound, but it is above any plausible MTHDS input, so this is no longer blocking. What replaced it: *the upload leg and the hosted request budget*, below.
- [x] **Collect more host samples** for D3. Two samples, two different regions, one session — enough to settle that the host is a pattern, not a list (A1).
- [ ] **Time an end-to-end ingest** at ~20 MB: fetch → `uploadFile` → `pipelex-storage://`, and check it against Alpic's request timeout. This is the one measurement A6 leaves open and it now sets the feasibility of a synchronous ingest tool. Can be run without ChatGPT — any 20 MB file and a BYOK key will do.
- [x] **Reproduce the mobile defect — with a PDF.** Did **not** reproduce; iOS works (A7). The failure mode was an absent field, not a placeholder, and the model self-corrected (A8).
- [x] **Re-add the connector in ChatGPT (A10).** Done; `tools/list` fired, confirming the refresh path.
- [x] **Retest without coaching.** Done — populated first try, unprompted (A11). F5 proven.
- [ ] **Probe an IMAGE on mobile** against **`_probe_files`** (the strict tool — the permissive one is never populated, see A9; the protocol recorder captures malformed payloads regardless). Last untested cell, and the one the original defect reports actually describe (`chat_upload://image_0`). Decides whether D6 needs a mobile arm at all.
- [ ] **Confirm graceful absence elsewhere.** Same tools over claude.ai and the local workshop: the field must simply be absent, with no schema or handshake complaint. *Partially pre-verified* — an absent field is already handled cleanly (F3); what remains is confirming claude.ai doesn't complain at the handshake. Note `attachments` is now **required**, so claude.ai will have to fabricate or fail — that outcome is itself worth recording.
- [ ] **Record findings** in this file *and* in `wip/console-attachments-landscape.html` (its "known defects" fold and the open questions), replacing the doc's undocumented-TTL caveat with the measured value.
- [ ] **Tear down**: `git branch -D probe/openai-fileparams-phase0` and confirm `src/probe/` + `scripts/probe-url-ttl.mjs` exist nowhere on `dev`.

### Runbook for the live session

```bash
git checkout probe/openai-fileparams-phase0
PIPELEX_PROBE_ATTACHMENTS=1 npm run dev:tunnel     # public URL for ChatGPT; /mcp is the endpoint
curl -s "http://localhost:3000/probe?clear=1"      # start the attempt clean
```

Add the tunnel URL + `/mcp` as a ChatGPT connector (developer mode). In a chat, attach a PDF and say *"probe the file attachments"* — and if the model calls the tool without the file, say so explicitly: *"call it again and pass the PDF in the attachments field"*. Then read everything back:

```bash
curl -s http://localhost:3000/probe | jq          # every MCP request, verbatim
node scripts/probe-url-ttl.mjs                    # TTL, once a real download_url is captured
```

`GET /probe` is the primary channel and works against the tunnel URL too. `wip/probe/observations.jsonl` is the durable local copy; TTL attempts land in `wip/probe/ttl.jsonl`. All throwaway, all gitignored.

> The `/probe` endpoint is unauthenticated and holds signed download URLs. It is gated behind the env flag and sits behind an unguessable tunnel URL — but do not leave a tunnel running after the session.

### Findings already produced by the self-test (synthetic file host, both shells)

**F1 — our Zod mirror satisfies the four-field rule.** The emitted JSON Schema for `attachments.items` is exactly `{type: "object", properties: {file_id, download_url, mime_type, file_name}, required: ["file_id", "download_url"]}`, with **no** `additionalProperties` key (Zod 4's default `$strip` omits it). Byte-identical on the hosted and workshop shells. So the "declare it in the capability layer instead of importing `FileRef`" constraint costs us nothing.

> **F2 was later superseded — read A9 before acting on it.** Its remedy (a permissive twin tool) cannot work: the host gates substitution on the declared schema, so a permissive field is never populated. The protocol recorder solves the same problem properly. F2's *observation* still stands; only its proposed fix is dead.

**F2 — a non-conforming payload is rejected at the MCP SDK boundary, before our handler runs.** Sending `attachments: "file-service://file-abc123"` to the strict tool returns JSON-RPC `-32602 Input validation error` with a raw Zod dump. **This constrains D6:** if the mobile defect really does send a placeholder string, a production tool carrying the mandated strict schema *cannot* classify it into an instructive `input_domain` no-verdict — the error never reaches the capability layer, so there is nothing there to classify. Loosening the schema to catch it would fail app review. The realistic options are (a) accept an opaque failure on mobile and steer with the tool description, or (b) ship a second lenient field purely as a catch — ugly. Decide this in Phase 1 with the real mobile payload in hand; do not assume D6's "mobile placeholder → instructive `input_domain` error" is implementable as written.

**F3 — an absent field is already graceful.** Calling with `{}` yields `shape=absent` and a normal result, no error. Declaring `attachments` optional is what buys this, and it is what makes the claude.ai / workshop absence case a non-event.

**F5 — the tool description is a load-bearing part of the mechanism, not documentation. PROVEN — see A11.** Attempt 1's null result came entirely from wording. Whatever ships in Phase 2 must *instruct* the model to pass the user's attachment; a neutral or defensive description silently yields empty calls that look like a host failure. Add this to D1/D4: the description text is part of the contract and needs the same review as the schema. A controlled before/after (stale v1 → always coaching needed; refreshed v2 → unprompted first try) confirmed it.

**F4 — a SigV4-style expiry is readable from the URL itself.** The rig parses `X-Amz-Expires` + `X-Amz-Date` (and the `Expires` / `se` / `exp` conventions) out of the query string and reports it as `declared_expiry`. Verified against a synthetic presigned URL. If OpenAI signs this way, D2's decisive measurement is available on the very first tool call instead of after an hour of polling.

**CHECKPOINT 0 — GO. Reached 2026-07-30.**

The gate was: *does the field populate reliably on desktop web?* **Yes** — and also on iOS, and unprompted once the tool list is fresh. Five successful captures across three Azure regions, two devices, 140 KB to 19.6 MB, every one fetched and byte-verified.

**What Phase 1 inherits as settled:**

| | |
|---|---|
| **D2** | **Ingest, not forward.** ~305 s SAS window, three consistent samples, confirmed by observed `403`. |
| **D1** | **Option B (dedicated ingest tool).** A 5-minute source URL leaves no pass-through design to weigh against it. |
| **D3** | **Re-derive.** Host is `oaisdmntpr<azure-region>` and varies per upload; a literal allowlist is dead and a suffix-only rule is unsafe. |
| **D4/D6** | **The description is mechanism** (F5/A11), and it is **cached un-hotfixably** (A10). The schema must be exactly four fields — that is a runtime gate, not just review (A9). |

**What remains open — carried into Phase 1, none blocking:**

- An **image on mobile** (the cell the original defect reports describe). PDFs work everywhere tested.
- **End-to-end ingest timing at ~20 MB** against Alpic's request timeout — decides whether the ingest tool can be synchronous. Needs no ChatGPT.
- More host samples would sharpen D3's pattern, though three regions already prove the shape.

**Teardown:** delete `src/probe/`, `scripts/probe-url-ttl.mjs`, the `.gitignore` entry, the two `hosted/server.ts` + `local/server.ts` hooks, and branch `probe/openai-fileparams-phase0`. Nothing in `src/capabilities/` or `src/tools.ts` was ever touched. `_probe_files_raw` proved a dead end (A9) — do not carry the idea forward.

<details><summary>Original gate wording</summary>

*Gate: if the field does not populate reliably on desktop web, stop here and close the workstream* — everything downstream is void and claude.ai users were never served by it anyway. Record: the verbatim payload, the measured TTL, the size ceiling, the mobile shape, and a go/no-go. Delete the scratch tool and branch. Natural handoff point — Phase 1 is a design session that consumes these numbers.

</details>

---

## Phase 1 — SPEC.md design pass (decisions, then sign-off)

Same discipline as the `mthds_prepare_inputs` design pass that produced 0.8.0: settle the contract in `SPEC.md`, get sign-off on the crux decisions, *then* build. Follow the `skybridge` skill's architecture workflow (UX flow → does it need UI → API shape → SPEC).

**D1 — the surface shape. This is the crux; it needs sign-off.** Two viable designs:

- **Option A — `attachments` on `mthds_prepare_inputs`.** Add a top-level `attachments: FileRef[]`, and bind each attachment to an input slot with a marker value the model writes into `inputs` (e.g. `"attachment:file-abc123"`). One call, but it invents a binding convention the model must get right, and the four-field rule forbids putting the binding on the file object itself.
- **Option B — a dedicated ingest tool (recommended; Phase 0 strengthened this).** With a 374-second source URL (A2) there is no pass-through design left to weigh against it: the tool must fetch and re-host during the call, which is exactly what this option does. A new tool takes `attachments: FileRef[]` and returns `pipelex-storage://` URIs. The model then fills those URIs into the template exactly as it would a user-pasted URL. **No binding convention, no new semantics in `prepare`, and literally zero change to `prepare.ts`'s walk** — storage URIs are already a pass-through value it accepts. It also composes with `mthds_run` for free, and preserves the console's "pass-through only" property as a true statement rather than an exception. Cost: one extra round trip, and the URIs pass through the model's context (small strings — the O1 invariant is about bytes, so this is fine).
- Rejected without discussion: auto-binding a lone attachment to a lone file slot. Magical, and this codebase's input-preparation design is explicitly "explicit, not magical".

**D2 — ingest or forward the URL? — SETTLED BY PHASE 0: INGEST.** The observed SAS window is **374 seconds** (A2). Forwarding it into a durable run would hand the workers a dead URL in the ordinary case, not the edge case. Fetch the bytes during the tool call, upload under the caller's BYOK key, return `pipelex-storage://`. No further discussion needed; record the measurement as the rationale.

**D3 — SSRF policy. MUST BE RE-DERIVED — the assumed allowlist was wrong.** Phase 0 observed `oaisdmntprnznorth.blob.core.windows.net`, not `files.oaiusercontent.com` (A1). The subdomain appears region/tenant-scoped, so pinning literal hosts will break for users elsewhere. Design around a **suffix** rule (`*.blob.core.windows.net`, plus whatever OpenAI-owned prefix pattern holds) and accept that this is a far weaker constraint than a single host — which means the byte cap, the connect/read timeout, and the redirect policy (recommend: refuse cross-host redirects) carry most of the defence, not the host check. Before settling this, collect a few more observed hosts from different accounts/regions if you can; one sample is thin evidence for a pattern. Record it in SPEC as a named policy, the way the path trust boundary is recorded.

**D4 — naming and branding.** If Option B: the tool name. Verb-first per the skill's convention; note the brand boundary — uploading to Pipelex storage is runtime-specific, not an MTHDS-standard concept, so think before reflexively prefixing `mthds_`.

**D5 — the tool-table divergence question.** SPEC's Deployments section states both shells register **the same** tools. A console-only tool would be the first break in that invariant. Either register it on both (the workshop gets a tool no stdio host will ever populate — harmless, keeps the invariant) or accept and document the divergence. **Recommend registering on both**, since the invariant is load-bearing for the plugin and skills story.

**D6 — error taxonomy.** Map onto the existing `input_domain` / `config` / `runtime` classes with `retryable` set where the concrete failure is known (the standing rule): mobile placeholder strings → `input_domain` at the attachments field, naming desktop; expired/403 URL → `input_domain`, retryable by re-attaching; oversize → `input_domain` (mirroring `RejectedAssetError`); fetch timeout / 5xx → `runtime`, retryable; upload auth → `config` with the BYOK texture.

**D7 — annotations.** `readOnlyHint: false` (it uploads). Reconsider `openWorldHint`: unlike every existing tool, this one fetches an arbitrary host-supplied URL.

- [ ] Settle D1–D7; record the full contract in `SPEC.md` (new scope section + Tools and Views + a UX Flow + the Deployments note about which shell populates the field).
- [ ] Retire the matching Non-Goals sentence **carefully**: console byte-upload was deferred *conditionally* ("until a proper out-of-band attachment channel exists"). The condition is now met **on one host**. Rewrite to say that — do not simply delete it, and keep the residual (claude.ai still has no channel; `http(s)`→storage ingest is still parked).

**CHECKPOINT 1 — PENDING.** SPEC-only pass, no code. Record: each decision and its rationale, the sign-off, and any decision Phase 0 forced. Natural handoff — Phase 2 is mechanical once the contract is fixed.

---

## Phase 2 — implement

Shape assumes Option B; adjust if D1 lands on A.

- [ ] **The attachment schema** — a Zod object with exactly the four fields, in the capability layer, **not** imported from `skybridge/server` (see constraints). Exported for tests.
- [ ] **The ingest capability** — fetch the bytes from the allowlisted URL, hand them to `@pipelex/sdk`'s `uploadFile` with `filename`/`contentType` from the attachment metadata, return the `pipelex-storage://` URI plus the original filename so the model can match them up. Never touches the filesystem.
- [ ] **The SSRF guard** — its own small module with its own tests (allowlist, size cap, timeout, redirect policy per D3). Deny by default.
- [ ] **The context seam** — a per-deployment capability flag alongside `resolver` / `allowUpload` / `viewsAvailable`, threaded through `buildToolContexts` and `byok.ts`'s `overrideContexts` so the caller's BYOK key funds the upload.
- [ ] **Registration** — add to the ordered table in `src/tools.ts`; on the hosted shell add `_meta["openai/fileParams"]` plus the `openai/toolInvocation` strings. Update both server `instructions`.
- [ ] **Tests** (fake client + fake fetch, following the established injection seams): happy path; multiple attachments; allowlist rejection; oversize; timeout; expired-URL 403; the mobile placeholder shape from Phase 0; upload auth failure; absent field on non-ChatGPT hosts.

**CHECKPOINT 2 — PENDING.** Record: what landed, the test count, gates, and any contract drift from Phase 1 (with SPEC updated in the same breath, not deferred).

---

## Phase 3 — docs, gates, release

- [ ] `SPEC.md` (done in Phase 1, reconciled against what actually shipped), `README.md` (tool table + section + the ChatGPT-only note), `CHANGELOG.md` `## [Unreleased]`, `CLAUDE.md` (architecture list + the new capability file + the SSRF policy in Conventions).
- [ ] Full gate: `make check && make test`.
- [ ] **Deploy and live-smoke on ChatGPT** before releasing — the real end-to-end (drop a PDF, run a method on it). A tool whose whole value is a vendor integration cannot ship on unit tests alone.
- [ ] Sanity-check claude.ai and the workshop are unaffected (the tool is present and inert).
- [ ] Release via the `/release` skill. Consider whether `pipelex-plugins` skills need a line about the new console capability — the last release had exactly this coordination footgun.

**CHECKPOINT 3 — PENDING.** Record the shipped version and fold the verified behavior back into `wip/console-attachments-landscape.html` so the research doc stops describing it as a proposal.

---

## Parked / explicitly out of scope

- **claude.ai attachments.** No channel exists. The sandbox-curl workaround is allowlist-gated (Team/Enterprise only), prompt-injection-adjacent per Anthropic's own warning, and rests on undocumented sandbox behavior. Users keep pasting URLs.
- **A view-side attach flow** via `useFiles()` / `selectFiles()`. The `imageIds` round-trip back to the model is a known-broken path, and the console's views are ChatGPT/Cowork-only. Tools-first.
- **SEP-2631 / `x-mcp-file`.** The standard is an open draft that already replaced one predecessor; it landed in no host. Adopt when a host ships it — our `pipelex-storage://` design is already its shape, so it will be an additional intake, not a rewrite.
- **Opt-in `http(s)` → storage ingest** for ordinary user-pasted URLs (still an additive SDK feature; unchanged from the 0.8.0 plan). Note the tension: if D2 lands on ingest, this tool ingests ChatGPT URLs while `prepare` still passes user URLs through. That asymmetry is intentional (host URLs expire, user URLs generally don't) and should be stated in SPEC so it doesn't read as an inconsistency.
- Catalog discovery tools, publish/save from the workshop, console OAuth, methods-as-tools projection — all still parked.
