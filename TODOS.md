# TODOS — ChatGPT file inputs: let the hosted console take the user's uploaded files

Build plan recorded 2026-07-30. Four phases, verification first: **(0) verify the channel against a live ChatGPT connection** → **(1) SPEC.md design pass + sign-off** → **(2) implement** → **(3) docs, gates, release**. The research this rests on — what each host actually supports, the vendor contract, the standards trajectory, and a sizing sketch — is in `wip/console-attachments-landscape.html` (recorded the same day, primary sources verified). The previous build plan (SDK 0.6.0 adoption → `mthds_prepare_inputs` → run cost) shipped as **0.8.0** and is archived at `wip/archive/TODOS-sdk-0.6-adoption-2026-07-24.md`.

**The one-line problem.** Since 0.8.0 the local workshop uploads file-bearing inputs; the hosted console is pass-through only. But on chatgpt.com and claude.ai the console is *all a user has*, and both let people drop a PDF into the chat. ChatGPT — and only ChatGPT — exposes those attachments to an MCP tool call. This plan takes that channel.

## COLD START — read this first (updated 2026-07-31)

**You are finishing Phase 3 (docs + release). The code is written, the gates are green, and the live ChatGPT smoke PASSED** — Phases 0, 1 and 2 are complete, and Phase 3's release blocker (the smoke) is cleared. What remains is docs, a deploy, and the release itself.

**The three things that are actually left**, in order:

1. **Docs** — `README.md`, `CHANGELOG.md` `## [Unreleased]`, `CLAUDE.md`. `SPEC.md` is already done *and* reconciled against what shipped; don't redo it.
2. **Deploy to the production console** (`make deploy` → Alpic). The smoke ran through a **local tunnel**, not the deployed console — see S1. The deploy has NOT happened.
3. **Release** via the `/release` skill, with the two mandatory release-note lines (re-add the connector; 7 MiB cap).

Reading order:

1. The **STATUS** banner and **S1** (the smoke result) immediately below.
2. **Phase 3** — the remaining checklist, with what the smoke did and did not cover.
3. **Phase 2's "What landed" + "Contract drift"** — what exists in `src/` now, and the three places the implementation refined the Phase 1 contract. Read this before touching code; you probably won't need to.
4. **M1** — the 7.5 MiB transport ceiling, if you touch anything upload-related.
5. **`SPEC.md` → "Attachment Ingest Scope (`mthds_upload_attachments`)"** — the contract. Also the Deployments subsection "The tool table is shared except for one console-only tool", and the Tools and Views entry.
6. `CLAUDE.md` (repo conventions) and, only if you want the vendor background, `wip/console-attachments-landscape.html`.

**Invoke the `skybridge` skill before touching code** (`AGENTS.md` mandates it).

**Do not re-derive D1–D7.** They are settled, signed off, and recorded in the Phase 1 table below with pointers into SPEC. If implementation reveals a contract problem, change SPEC *and* the Phase 1 table in the same breath — don't quietly diverge.

**Everything under "Phase 0" below is a historical record, not instructions.** The probe rig it describes has been deleted (branch, files, and hooks). Its runbook will not run. Read it for the A*/F* findings only; those are cited throughout Phase 2 and Phase 3.

**Git state**: branch `feature/Console-upload`, working tree clean, pushed to origin. Three commits ahead of `dev`: `7fc3a47 plans` (the Phase 0 record), `2081a24` (the Phase 1 design pass), and the Phase 2 implementation commit. No PR is open yet. `dev` and `main` are untouched by this workstream.

## STATUS (2026-07-31) — PHASE 2 COMPLETE + LIVE SMOKE PASSED. Next session finishes Phase 3 (docs → deploy → release).

Branch **`feature/Console-upload`**. Current release is **0.8.0**; `main`/`dev` carry an `## [Unreleased]` Skybridge-1.3.2 entry only — **this work is not yet in the changelog**, which is the next task. `SPEC.md` carries the full contract *and* has been reconciled against what actually shipped (three drift points, recorded under Phase 2). `README.md` and `CLAUDE.md` have **not** been updated yet.

**The feature works against real ChatGPT** — see S1 below. That was the release blocker, and it is cleared. The production console has **not** been redeployed; the smoke ran through a local tunnel.

Phase 0's rig is **already torn down** — branch `probe/openai-fileparams-phase0` deleted, no `src/probe/`, no `scripts/probe-url-ttl.mjs`, no server hooks. Verified 2026-07-31.

Phase 1 closed the last blocking measurement and it **changed the plan**: see M1 below.

### S1 (2026-07-31) — THE LIVE SMOKE PASSED ON REAL CHATGPT

Run against a **local tunnel** (`npm run dev:tunnel`, added to ChatGPT as a developer-mode connector at `<tunnel-url>/mcp`), with `.env` supplying `PIPELEX_BASE_URL=https://api-dev.pipelex.com` and a `PIPELEX_API_KEY`. Because the dev server held a key, BYOK's `?api_key=` channel was not exercised — uploads spent against that key's org. A fresh tunnel URL means a fresh connector, so the A10 tool-list cache was never in the way.

Three of the four watch items were covered, and **all three passed**:

| Watched | Result |
|---|---|
| **Unprompted fill + happy path** | The model populated `attachments` with **no coaching**, the PDF ingested to a `pipelex-storage://` uri, and it ran end to end through `mthds_run`. This is the F5/A11 property re-confirmed against the *shipped* description, not the probe's. |
| **Oversize refusal (>7 MiB)** | Fired correctly. The ordinary case (M1) behaves as designed. |
| **Image on iOS** | **Worked — this closes the last untested Phase 0 cell** (A7's open corner, and the exact case the original vendor defect reports describe: `chat_upload://image_0`). No mobile arm was needed, confirming D6/A8/A9. |

**Not covered, and still open:** the **claude.ai** sanity check (tool present, model fabricates a URL, fetch boundary refuses it instructively). Non-blocking for release — the refusal is unit-tested and the failure is contained — but it is the one wording nobody has read in situ.

### M1 (2026-07-31) — THE INGEST CEILING IS ~7.5 MiB, AND IT IS FORCED BY THE TRANSPORT

Measured live against `api-dev.pipelex.com` with a real key, uploading synthetic byte assets through the SDK client method **`client.uploadFile(bytes, { filename, contentType })`** (note: *not* a top-level `uploadFile` export — there isn't one). Reproducible in ~20 lines against any `.env` key; the throwaway script was not kept.

| decoded size | result |
|---|---|
| 1, 5, 7, 7.3, 7.4 MiB | OK — ~2.9 s at the top end, ~2.5 MB/s |
| 7.5, 7.6, 7.8, 8, 12, 20 MiB | `413` → `RejectedAssetError`, fails fast (~250 ms) |

The wall is **exactly 7.5 MiB decoded** = AWS API Gateway's 10 MiB request limit ÷ base64's 4/3 inflation. `POST /v1/upload` is a base64 JSON body behind an `aws_apigatewayv2_integration` HTTP_PROXY (`pipelex-api-infra/infra/api/apigateway_http.tf`), and 10 MiB is a hard AWS quota. **The documented 50 MiB `MAX_UPLOAD_MIB` is unreachable through the public gateway** — do not quote it. One 503 seen at 8 MiB did not reproduce (two clean 413s on retry), so no boundary arm is needed; the existing `RejectedAssetError` → `input_domain` mapping covers it.

Three consequences, all folded into SPEC:

- **Synchronous ingest is feasible — the open Phase-0 timing item closes GO.** At the cap: ~2.3 s fetch (A6's 3.2 MB/s) + ~2.9 s upload ≈ **6 s**, against a 305 s SAS window. Timeout was never the constraint; payload size is. No async/job design is needed.
- **The byte cap is not a product decision after all.** A6 left it open as "pick it deliberately"; the transport picked it. Console cap = **7 MiB**, with headroom for the JSON envelope. And since ChatGPT hands over 19.6 MB PDFs happily (A6), oversize is an **ordinary** case — the refusal fires before any bytes are fetched, names the limit, and gets a release note.
- **A pre-existing bug in the shipped workshop.** `mthds_prepare_inputs` claims to upload local files; a >7.5 MiB asset fails there too, and only *after* the whole file is read and base64-encoded. Recorded in SPEC → Prepare Inputs Scope; the pre-flight size check is owed in Phase 2.

## Cross-cutting constraints — read before any phase

- **The capability core must stay Skybridge-free.** Verified 2026-07-30: `src/tools.ts` and everything under `src/capabilities/` import zero Skybridge symbols (only `hosted/`, `views/`, `helpers.ts` do). So **do not** import `FileRef` from `skybridge/server` into the shared schema — it would drag Skybridge into the tsup-bundled workshop bin. Declare an equivalent Zod object in the capability layer instead, and keep it byte-compatible with what ChatGPT sends.
- **The four-field rule is enforced by app review.** Any field named in `_meta["openai/fileParams"]` must declare **exactly** `download_url` (required), `file_id` (required), `mime_type` (optional), `file_name` (optional). A fifth property, a missing one, or a wrongly-required optional fails OpenAI's "Scan Tools" step. This is why the binding between an attachment and an input slot cannot live on the file object — see D1.
- **Bytes must never enter the model's context.** This is the invariant that made the original console-upload deferral correct, and the only reason this increment is now allowed. Nothing in this plan may return base64 to the model or accept it as an argument.
- **The console still never reads a filesystem.** Fetching a host-supplied URL is a *network* read; the `readLocalPath` LFI/DoS/existence-oracle refusal (SPEC "Prepare Inputs Scope" blockquote) stays exactly as it is. Do not relax `allowUpload`.
- **A server-side fetcher on a public endpoint is an SSRF surface.** The host allowlist, size cap, timeout, and redirect policy ship *with* the first fetch, not after it. Treat this as a release blocker, not a hardening follow-up.
- **Branch + gate hygiene.** Work branch prefixed per `guard-branches.yml` (`feature/…`); `make check && make test` green before any checkpoint is called reached; release only via the `/release` skill.

## Premise — confirmed from primary sources (2026-07-30); every open question since answered

**Confirmed (vendor docs, changelog, and the installed `skybridge@1.3.2` types):**

- A tool declaring `_meta["openai/fileParams"]: ["<field>"]` receives the user's conversation attachment as `{ download_url, file_id, mime_type?, file_name? }` in its arguments, behind a user permission dialog. Model-generated files (`/mnt/data/…`) route through the same substitution. Arrays are supported via `items`.
- The server fetches the bytes itself from a signed HTTPS URL. No base64, no inline binary. ⚠️ *This line originally read "observed host `files.oaiusercontent.com`" — that was the vendor **documentation's** host. Live traffic uses `oaisdmntpr<azure-region>.blob.core.windows.net` instead (A1). D3's allowlist covers both; do not treat the documented host as authoritative.*
- Skybridge ships both halves already: `FileRef` (server Zod schema) and `useFiles()` (`upload` / `selectFiles` / `getDownloadUrl`) for views. We are on 1.3.2.
- **claude.ai has no equivalent** — no file id, no signed URL, no host-injected reference reaches a connector. It will simply leave the field absent. MCP has nothing in-spec either (through `2026-07-28`); SEP-2631 is an open draft.
- The SDK's upload accepts `Uint8Array` and returns an `UploadRecord` (`{ uri, filename, contentType, size }`) with no filesystem involvement, so the ingest path needs no new SDK surface. ⚠️ **Call it as a client method — `client.uploadFile(asset, { filename, contentType })`.** There is no top-level `uploadFile` export from `@pipelex/sdk` (verified 2026-07-31: importing one fails at module load). The free-function form `uploadFile(client, asset, opts)` exists only inside the SDK's `upload.ts`.

**Formerly unknown — ALL ANSWERED. Kept as a record of what the probe was for:**

| Question | Answer |
|---|---|
| `download_url` TTL — **decides D2** | **~305 s** from the tool call, Azure SAS `se` param, confirmed by an observed `403` (A2). D2 → ingest. |
| Max file size / MIME types the host hands over | Handoff ceiling is **≥ 19.6 MB**, no refusal or truncation (A6). Irrelevant in the end — **our** upload leg caps at 7.5 MiB (M1), far below what the host will give. |
| Does the documented payload match reality on desktop web? | **Yes**, exactly — four-field object, array form included (Attempt 2). |
| The malformed shape mobile sends | **There isn't one.** Did not reproduce on iOS with a PDF (A7) — the real failure was an absent field and the model self-corrected (A8). The remaining *image* + mobile cell was then smoked in Phase 3 and **also works** (S1). No mobile arm was built, and none is needed. |

---

## Phase 0 — verify the channel against a live ChatGPT connection — COMPLETE (2026-07-30), HISTORICAL RECORD

> **Read for findings, not for instructions.** The rig described here — `src/probe/`, `scripts/probe-url-ttl.mjs`, the two server hooks, and branch `probe/openai-fileparams-phase0` — **has been deleted**. The runbook below cannot run. What remains valuable is the evidence: **A1–A11** (live observations) and **F1–F5** (rig self-test), which Phase 2 and Phase 3 cite by name.
>
> **The four findings that shaped the design**, if you read nothing else: **A1** (the storage host varies per upload — a literal allowlist is dead, a suffix-only rule is unsafe), **A2** (~305 s URL life → ingest, never forward), **A9** (the four-field schema is a *runtime* gate, so a lenient schema is invisible to the mechanism), and **A10 + A11/F5** (the tool description is load-bearing mechanism *and* is cached un-hotfixably).

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

**But do not close the mobile question on this.** The defect reports this plan was written against describe **image** payloads — `{"images": ["chat_upload"]}` and `"chat_upload://image_0"`. We tested a **PDF**. The untested cell is therefore *image + mobile*, and that is exactly where the reported breakage lives. On current evidence, mobile-with-documents is a working path. *(This paragraph originally said to probe the image against `_probe_files_raw`. A9 later killed that: the host never populates a permissive schema. The probe now belongs on the real tool during Phase 3's live smoke, and D6 ships **no** mobile arm — A8 showed the failure is self-correcting.)*

**A8 — a schema rejection surfaces as an `isError` tool result on the hosted shell, and the model recovers from it unaided.** The failed mobile call came back as `{"content":[{"type":"text","text":"MCP error -32602: Input validation error… expected array, received undefined"}],"isError":true}` — note skybridge converts the thrown `McpError` into an `isError` result, unlike the local stdio shell which surfaces a raw JSON-RPC `-32602`. **This softens F2 considerably.** We still cannot classify such a failure in the capability layer, but the raw Zod text reached the model and the model self-corrected on the very next call. D6's mobile arm may not need to be implementable at all — the failure is self-correcting in practice. A description hint is likely sufficient; do not build machinery for it.

**A6 — 19.6 MB passes the handoff, and the SAS window is not the binding constraint.** ChatGPT handed over a 19,631,193-byte PDF (`%PDF-1.6`) with no refusal, no truncation, `206` with `content-range: bytes 0-4095/19631193`. Pulling the **whole** file took **6.2 s at 3.2 MB/s — 2 % of the 305 s window**. Extrapolated, the window would allow roughly a gigabyte, so the SAS expiry will not be what stops us; **our own byte cap and the platform's request timeout will be**. Two consequences:

- ~~The D3 byte cap is a *product* decision (what is a sane MTHDS input?). Pick it deliberately.~~ **Superseded by M1**: the transport picked it. The upload leg refuses anything over 7.5 MiB, so there was no product judgment left to make. Cap is 7 MiB.
- ~~The real risk moved to the **hosted request budget** — check the request timeout before assuming a synchronous ingest fits in one call.~~ **Superseded by M1**: it fits easily (~6 s at the cap). The binding constraint is payload size, not time. No async/job design is needed.

> **Caveat on what A6 does and does not show.** The probe reads only the first 4 KB by design; the 19.6 MB figure is `content-range`, and the full-file timing above was a separate manual fetch. So the *handoff* ceiling is ≥ 19.6 MB and the *fetch* is fast — but an end-to-end ingest (fetch → `uploadFile` → `pipelex-storage://`) at that size has still never been run. Do not treat "19 MB works" as covering the upload leg.

### The rig — DELETED. Description kept only to explain how the findings were produced.

> Nothing in this subsection or the runbook that follows exists any more. Skip both unless you are rebuilding a probe from scratch, in which case the design notes here are a reasonable starting point.

Everything lived under `src/probe/` plus `scripts/probe-url-ttl.mjs`, and was **gated behind `PIPELEX_PROBE_ATTACHMENTS=1`** (verified: flag unset or `0` → 6 tools, `1` → 8). `src/tools.ts` and `src/capabilities/` are untouched.

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
- [x] **Measure the TTL.** Answered from the URL itself, exactly as F4 predicted — though via the Azure-SAS `se` parameter, not SigV4. **~305 seconds** measured from the tool call, across three samples, confirmed by an observed `403`. D2 is settled: ingest. *(An earlier revision of this line said 374 s — that anchored on the blob's `last-modified` instead of when the URL reaches us. See A2; design against 5 minutes.)*
- [x] **Probe the size ceiling — handoff leg.** 19.6 MB passes untruncated; full fetch 6.2 s (A6). The true host-side ceiling is still unfound, but it is above any plausible MTHDS input, so this is no longer blocking. What replaced it: *the upload leg and the hosted request budget*, below.
- [x] **Collect more host samples** for D3. Two samples, two different regions, one session — enough to settle that the host is a pattern, not a list (A1).
- [x] **Time an end-to-end ingest** and check it against the request timeout. **Done 2026-07-31 — see M1.** The question turned out to be moot at 20 MB (the upload leg refuses anything over 7.5 MiB), and at the real ceiling the whole ingest costs ~6 s. Synchronous ingest confirmed feasible; the binding constraint is payload size, not time.
- [x] **Reproduce the mobile defect — with a PDF.** Did **not** reproduce; iOS works (A7). The failure mode was an absent field, not a placeholder, and the model self-corrected (A8).
- [x] **Re-add the connector in ChatGPT (A10).** Done; `tools/list` fired, confirming the refresh path.
- [x] **Retest without coaching.** Done — populated first try, unprompted (A11). F5 proven.
- [x] **Probe an IMAGE on mobile.** **DONE 2026-07-31 in Phase 3's live smoke (S1) — it works.** The last untested cell is closed, and it was the exact case the original vendor defect reports describe (`chat_upload://image_0`). D6's "no mobile arm" stands, confirmed rather than assumed.
- [→] **Confirm graceful absence elsewhere.** **Split.** The workshop half is done and *pinned by a test* — D5 changed the question from "is the field absent?" to "is the **tool** absent?", and `local/server.test.ts` asserts exactly that. The claude.ai half is still open and carried to Phase 3 as non-blocking: the tool **is** present there with a required `attachments`, so the model must fabricate a URL or decline, and the fetch boundary refuses the fabrication — confirming that wording reads well in situ is the remaining check.
- [x] **Record findings** in this file. Recorded as A1–A11 / F1–F5 below, and M1 above. *Still owed:* folding them back into `wip/console-attachments-landscape.html` (its "known defects" fold and open questions, replacing the undocumented-TTL caveat with the measured ~305 s and adding the M1 ceiling) — carried to Phase 3, where the doc stops describing a proposal.
- [x] **Tear down.** Confirmed done 2026-07-31: branch `probe/openai-fileparams-phase0` gone, no `src/probe/`, no `scripts/probe-url-ttl.mjs`, no hooks in `hosted/server.ts` / `local/server.ts`, no `.gitignore` entry.

### Runbook for the live session — DEAD. The branch and files below no longer exist.

> ⚠️ **Do not run these.** `probe/openai-fileparams-phase0` was deleted at teardown; `git checkout` of it will fail, and there is no `/probe` endpoint on any current build. Kept verbatim only as a record of how Phase 0 was operated. Phase 3's live smoke uses the *real* tool on a deployed console, not this rig.

```bash
git checkout probe/openai-fileparams-phase0        # ✗ branch deleted
PIPELEX_PROBE_ATTACHMENTS=1 npm run dev:tunnel     # ✗ flag no longer exists
curl -s "http://localhost:3000/probe?clear=1"      # ✗ endpoint no longer exists
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

**What remained open at CHECKPOINT 0, and where each landed:**

- An **image on mobile** — **closed in Phase 3's live smoke (S1): it works.**
- **End-to-end ingest timing** — **closed in Phase 1 (M1)**, with a different answer than expected: 20 MB is unreachable, and at the real 7.5 MiB ceiling the whole ingest costs ~6 s. Synchronous ingest confirmed.
- More host samples would sharpen D3's pattern — not pursued; three regions already proved the shape, and D3 ships a required-prefix pattern rather than a list.

**Teardown: DONE** (verified 2026-07-31). `src/probe/`, `scripts/probe-url-ttl.mjs`, the `.gitignore` entry, the two `hosted/server.ts` + `local/server.ts` hooks, and branch `probe/openai-fileparams-phase0` are all gone. Nothing in `src/capabilities/` or `src/tools.ts` was ever touched. `_probe_files_raw` proved a dead end (A9) — do not carry the idea forward.

<details><summary>Original gate wording</summary>

*Gate: if the field does not populate reliably on desktop web, stop here and close the workstream* — everything downstream is void and claude.ai users were never served by it anyway. Record: the verbatim payload, the measured TTL, the size ceiling, the mobile shape, and a go/no-go. Delete the scratch tool and branch. Natural handoff point — Phase 1 is a design session that consumes these numbers.

</details>

---

## Phase 1 — SPEC.md design pass — COMPLETE (2026-07-31)

All of D1–D7 are settled and written into `SPEC.md`. **Phase 2 implements the SPEC; it does not re-open these.** The rationale for each lives in SPEC (that is the durable home); what follows is the decision record and where to find it.

| | Decision | Where in SPEC |
|---|---|---|
| **D1** | **Option B — a dedicated ingest tool.** Forced by D2: with a ~305 s source URL there is no pass-through design left to weigh against it. No binding convention, zero change to `prepare.ts`'s walk, composes with `mthds_run` for free. | Attachment Ingest Scope → "Where it sits in the flow" |
| **D2** | **Ingest, not forward.** ~305 s SAS window, three consistent samples, confirmed by an observed `403` at +328 s bracketing a `206` at +288 s. | Attachment Ingest Scope → "Why ingest rather than forward the URL" |
| **D3** | **Named policy: the attachment fetch boundary.** https-only; host must match `oaisdmntpr<region>.blob.core.windows.net` or `files.oaiusercontent.com` — the `oaisdmntpr` prefix **required** (a suffix-only rule lets any Azure customer in, a literal list broke inside one session across three regions); redirects refused outright; **7 MiB** cap enforced *before* the body is read, and again mid-stream; bounded timeout; no credentials forwarded; non-2xx refused. The host check is a filter, not the defence. | Attachment Ingest Scope → "Attachment fetch boundary (console)" |
| **D4** | **`mthds_upload_attachments`.** Signed off. Keeps the uniform `mthds_` family the model sees; the brand tension is acknowledged and resolved by widening the naming rule to "operations on MTHDS-language artifacts, *and on the assets that feed an MTHDS run*" — the tool is named for the workflow it serves, not the storage it writes to. | Naming Conventions; Tools and Views |
| **D5** | **Console-only. Signed off — this reverses the plan's earlier "register on both" recommendation.** A9 proved the host gates substitution on the declared schema, so on the workshop the tool is *structurally unreachable*, not merely unused. Registering it there would spend every workshop user's tokens on every `tools/list` for a capability that cannot fire. Documented as an explicit exception; the invariant that survives is **no tool name means different things on the two shells**. | Deployments → "The tool table is shared except for one console-only tool" |
| **D6** | **Per-item error classes, and partial success is a produced verdict.** `is_valid` is true iff every attachment ingested; failures ride `attachments[i].error`; successful uploads are never discarded because a sibling failed. Expired `403` → `input_domain`, retryable *by re-attaching*. **No mobile-placeholder arm** — A8/A9 killed it: a malformed payload never reaches the capability layer, and the model self-corrects from the SDK's own `isError`. | Attachment Ingest Scope → "Structured output" |
| **D7** | `readOnlyHint: false`, `destructiveHint: false`, and **`openWorldHint: true`** — the first tool here to set it, because it fetches an arbitrary host-supplied URL rather than only the configured Pipelex API. | Tools and Views |

Two things Phase 0/1 forced that were not on the original decision list:

- **The size cap stopped being a product decision** (M1). The transport picked 7.5 MiB; we cap at 7 MiB. Oversize is an *ordinary* case because ChatGPT hands over 19.6 MB files, so the refusal is a designed surface, not an edge case.
- **The tool description is un-hotfixable** (A10 + F5/A11). ChatGPT caches the tool list per connector and never refreshes it; the description is load-bearing *mechanism*. Both the review rigour and the "re-add the connector" release note are recorded in SPEC as release blockers.

- [x] Settle D1–D7; record the full contract in `SPEC.md` (new scope section + Tools and Views + a UX Flow + the Deployments note).
- [x] Retire the matching Non-Goals sentence carefully. Rewritten as a five-bullet residual: the condition is met **on ChatGPT only**; `mthds_prepare_inputs` stays pass-through; inline bytes in arguments stay out everywhere; claude.ai stays unserved; the console still never reads a filesystem; `http(s)`→storage ingest stays parked with its asymmetry explained.

**CHECKPOINT 1 — REACHED AND SIGNED OFF (2026-07-31).** SPEC-only pass, no code — `src/` is untouched. Decisions, rationale, and the two forced changes are recorded above and in SPEC. Natural handoff: Phase 2 is mechanical now that the contract is fixed.

---

## Phase 2 — implement — COMPLETE (2026-07-31)

The contract is fixed in SPEC → Attachment Ingest Scope. Build to it; don't re-derive it.

- [x] **The attachment schema** — a Zod object with exactly the four fields (`download_url`, `file_id` required; `mime_type`, `file_name` optional), in the capability layer, **not** imported from `skybridge/server` (F1 verified a local mirror emits a byte-identical JSON Schema, so this costs nothing). Exported for tests. `attachments` is **required**.
- [x] **The fetch boundary module** (`capabilities/attachment-fetch.ts` or similar) — its own small module, its own tests, deny by default: https-only, the `oaisdmntpr<region>` / `files.oaiusercontent.com` host patterns, `redirect: "error"`, the 7 MiB cap enforced from `content-range`/`content-length` *before* reading the body **and** again mid-stream, a bounded timeout, no credentials. This is a release blocker shipping *with* the first fetch, not after it.
- [x] **The ingest capability** (`capabilities/attachments.ts`) — per attachment: fetch within the boundary, hand the bytes to `@pipelex/sdk`'s `uploadFile` with `filename`/`contentType` from the attachment metadata, return the `pipelex-storage://` URI alongside `file_id`/`file_name` so the model can match them up. Per-item errors; partial success is `status: "ok"`, `is_valid: false`. Never touches the filesystem.
- [x] **Registration — hosted shell only** (D5). Do **not** add it to the shared ordered table in `src/tools.ts` the way the other six are; it needs a console-only registration path that keeps `local/server.ts` untouched. Decide the cleanest shape for that (a second exported table, or a `consoleOnly` marker the workshop filters) — whichever keeps "one definition, one registration site" rather than duplicating the tool definition. Add `_meta["openai/fileParams"]: ["attachments"]` plus the `openai/toolInvocation` strings, and extend `HOSTED_SERVER_INSTRUCTIONS` only.
- [x] **The context seam** — a capability context alongside the existing four, threaded through `buildToolContexts` and `byok.ts`'s `contextsForRequest` so the caller's BYOK key funds the upload.
- [x] **The tool description** — treat as schema, not prose (A10/F5). It must *instruct* the model to always pass the user's attached file, state ChatGPT-only, and name the 7 MiB limit. Review it as deliberately as the schema; it cannot be hot-fixed after users add the connector.
- [x] **Fix the pre-existing workshop bug** (M1) — a pre-flight size check in `mthds_prepare_inputs`'s upload path that refuses over the real ceiling before reading and base64-encoding the whole asset, naming the true limit rather than letting a late `413` speak for it. Independent of the attachment channel; SPEC → Prepare Inputs Scope records it.
- [x] **Tests** (fake client + fake fetch, following the established injection seams): happy path; multiple attachments; partial success (one item fails, siblings still return their URIs); allowlist rejection incl. the suffix-only attack (`evil.blob.core.windows.net`); oversize refused pre-fetch; a lying `content-length`; redirect refused; timeout; expired-URL 403; upload auth failure; and a workshop `tools/list` assertion that the tool is **absent**.

### What landed

New modules, all Skybridge-free (verified: the tsup workshop bundle contains no Skybridge code, only the inlined `package.json` script names it already carried):

| File | Role |
|---|---|
| `src/capabilities/attachment-fetch.ts` | The fetch boundary. Deny-by-default: https only, the `oaisdmntpr<region>` / `files.oaiusercontent.com` host patterns, no credentials in the URL, no non-default port, `redirect: "manual"` with 3xx refused explicitly, the 7 MiB cap from `content-length` *and* mid-stream, a 30 s total budget, no headers sent. Reports failures as values, never throws. |
| `src/capabilities/attachments.ts` | The ingest capability + the mandated four-field Zod schema. Per-attachment fetch → `uploadFile` → `pipelex-storage://`. Sequential walk; per-item errors; partial success is a produced verdict. |
| `src/capabilities/upload-ceiling.ts` | `MAX_UPLOAD_BYTES` (derived from the gateway quota, not hardcoded) and `SizeGuardedPipelexApiClient` — the M1 fix, shared by both upload paths. |

Wiring: `mthdsUploadAttachmentsTool` is defined in `src/tools.ts` alongside the other six but exported through a **second table, `consoleOnlyToolDefinitions`** — the hosted shell registers it explicitly (it already registers each tool one by one, for views and `_meta`), and `local/server.ts` is untouched because it loops over `toolDefinitions` only. One definition, one registration site per shell, no duplicated tool. `ToolContexts` gained `attachments`, built by `buildToolContexts` on both shells and overridden by `contextsForRequest` so the caller's BYOK key funds the upload.

Three deliberate choices worth knowing:

- **The `oaisdmntpr` prefix is required, never optional**, and the fetch runs against the **already-parsed `URL` object** rather than the raw string — re-parsing at the fetch is how an allowlist gets walked past.
- **A `403` carries `retryable: false`**, with the recovery ("ask the user to attach the file again") in the hint. See the drift note below.
- **The workshop bundle grew 17.9 KB, +23%** (76,942 → 94,877 bytes; measured by stashing the change and re-running tsup, not estimated). `tools.ts` imports the attachment capability for the console-only table, so the code is linked into the workshop bin even though the tool is never registered there, and esbuild cannot tree-shake it (module-scope Zod schema construction is not provably pure). **Accepted deliberately, and here is why it is not worth chasing:** eliminating it means `tools.ts` must stop importing `capabilities/attachments.js` *at all* — including `buildAttachmentsContext`, which `buildToolContexts` calls. That forces the console-only tool's context out of the shared `ToolContexts` bag, which in turn forces a second context type, a second override path in `byok.ts`'s `contextsForRequest`, and a second registration mechanism. Trading a coherent single context plumbing for 18 KB of dead code in a bundle that is already under 100 KB is the wrong direction. Revisit only if the console-only surface grows well beyond one tool.

**Gates: green.** `make check` (lint + format + Skybridge build + tsup build + typecheck) and `make test` (all suites) both pass. New tests cover the happy path, multiple attachments, partial success, the suffix-only allowlist attack, oversize refused pre-body-read, a lying `content-length`, a refused redirect, timeout, expired-URL 403, upload auth/route/unreachable failures, the size guard on both upload paths, and — pinned deliberately, because it is un-hotfixable — **the emitted four-field JSON Schema** plus the workshop's absence of the tool.

### Contract drift from Phase 1 — three points, SPEC updated in the same breath

1. **The `403` `retryable` verdict.** D6 said "retryable *by re-attaching*", which reads as `retryable: true`. But the field is contractually "retrying **this same call** may succeed", and the link is permanently dead — a new attachment is a different call with a different URL. Shipped as `retryable: false` with the fix in the hint; `true` would only invite a pointless identical retry. SPEC → Structured output now says this precisely.
2. **No ranged GET.** SPEC described revealing the size via a ranged GET's `content-range`. Unnecessary: `fetch` resolves on headers, so a plain GET already gives `content-length` before a byte of body is pulled, and the body is cancelled on refusal — one request instead of two. Same observable contract (refused before the body is read, mid-stream bound as backstop). SPEC → Attachment fetch boundary updated.
3. **The M1 fix stops one step short of the plan's wording, on purpose.** The guard sits on `upload` (the wire call), which kills the wasted 10 MiB round-trip and lets the message name the real limit — but it does **not** skip reading and base64-encoding a local asset first, because the SDK owns that step inside `uploadFile`/`readLocalPath`. Refusing before the read needs a pre-flight in `@pipelex/sdk`; recorded in SPEC → Prepare Inputs Scope as a cross-repo item next to the presigned direct-upload redesign. `upload` was the only seam available without forking the SDK's `prepareInputs` walk or paying a second `buildInputs` round-trip.

One small shared-surface addition: `ClassifyErrorOptions` gained `asset?: { location?, hint? }` so a route can locate an asset rejection at its own field (`attachments[i]`, not `inputs`) and name its own ceiling. Follows the existing per-route `badRequest` / `notFound` / `auth` pattern.

**CHECKPOINT 2 — REACHED (2026-07-31).** Contract implemented, gates green, drift reconciled into SPEC. Natural handoff: Phase 3 is docs + a live ChatGPT smoke + release, and the smoke is the part that cannot be done from here.

---

## Phase 3 — docs, gates, release — IN PROGRESS (the smoke is done; docs, deploy and release are not)

- [x] **Live-smoke on ChatGPT.** **PASSED 2026-07-31 — see S1.** Unprompted fill, happy path to `mthds_run`, the oversize refusal, and an image on iOS. Ran through a tunnel; the deploy is a separate step, still owed below.
- [x] **Probe an image on iOS.** **PASSED** — the last untested Phase 0 cell is closed. No mobile arm needed; D6 stands.
- [x] `SPEC.md` — written in Phase 1 and reconciled in Phase 2 against what actually shipped. **Do not redo it.**
- [ ] **`CHANGELOG.md`** — add the feature under `## [Unreleased]`, beside the existing Skybridge-1.3.2 entry. Cover: the new console-only `mthds_upload_attachments` tool, the 7 MiB attachment cap, the **breaking-ish operational note that existing console users must re-add the connector**, and the `mthds_prepare_inputs` upload-ceiling fix (a separate user-visible improvement — it names the real limit and no longer wastes a 10 MiB round-trip).
- [ ] **`README.md`** — tool table row + a section for the attachment flow + the ChatGPT-only note + the 7 MiB limit.
- [ ] **`CLAUDE.md`** — the architecture file list gains `capabilities/attachment-fetch.ts`, `capabilities/attachments.ts`, `capabilities/upload-ceiling.ts`; a Conventions line for the fetch boundary; and a note on the console-only registration table (`consoleOnlyToolDefinitions`) since it breaks the "both shells register the same table" property the file currently states without exception.
- [ ] Full gate: `make check && make test`. (Was green at the Phase 2 commit; re-run after the doc edits.)
- [ ] **Deploy the production console**: `make deploy` (Alpic; CLI-only, no git integration). This is what puts the tool in front of real users at `https://pipelex-mcp-a3c6a115.alpic.live/mcp` — the smoke did **not** do this.
- [ ] **Release notes must say two things out loud**: existing users have to **re-add the connector** for the new tool and its description to reach them (A10 — a cached tool list never refreshes, so the tool is simply invisible until they do), and attachments are capped at **7 MiB** (M1 — users will hit this, since ChatGPT hands over 19 MB files happily).
- [ ] Release via the `/release` skill. **npm publish needs Louis in-session** (auth lapses between sessions; `npm publish` hits an `EOTP` browser gate — the agent cannot do it). Consider whether `pipelex-plugins` skills need a line about the new console capability — the last release had exactly this coordination footgun.
- [ ] Fold the verified behavior back into `wip/console-attachments-landscape.html`: replace the undocumented-TTL caveat with the measured ~305 s, add the M1 ceiling and the S1 smoke result, and stop describing the channel as a proposal.
- [ ] *Non-blocking, do it whenever:* sanity-check **claude.ai** — the tool is present there with a required `attachments`, so the model must fabricate a URL or decline; confirm the fetch boundary's refusal reads instructively in situ. The workshop side needs no manual check: the tool's **absence** is pinned by a test (D5).

**CHECKPOINT 3 — PENDING.** Record the shipped version, the Alpic deploy, and whether the claude.ai wording held up.

---

## Parked / explicitly out of scope

- **claude.ai attachments.** No channel exists. The sandbox-curl workaround is allowlist-gated (Team/Enterprise only), prompt-injection-adjacent per Anthropic's own warning, and rests on undocumented sandbox behavior. Users keep pasting URLs.
- **A view-side attach flow** via `useFiles()` / `selectFiles()`. The `imageIds` round-trip back to the model is a known-broken path, and the console's views are ChatGPT/Cowork-only. Tools-first.
- **SEP-2631 / `x-mcp-file`.** The standard is an open draft that already replaced one predecessor; it landed in no host. Adopt when a host ships it — our `pipelex-storage://` design is already its shape, so it will be an additional intake, not a rewrite.
- **Opt-in `http(s)` → storage ingest** for ordinary user-pasted URLs (still an additive SDK feature; unchanged from the 0.8.0 plan). The asymmetry D2 created — this tool ingests ChatGPT URLs while `prepare` still passes user URLs through — is intentional (host URLs expire in minutes, user URLs generally don't) and is now stated in SPEC → Attachment Ingest Scope so it doesn't read as an inconsistency.
- **Lifting the 7.5 MiB upload ceiling** (M1). It is AWS API Gateway's 10 MiB request quota, so raising it means bypassing the gateway for uploads — a presigned direct-upload redesign, sketched in `../pipelex-sdk-js/wip/upload/followup-browser-direct-upload.md`. Cross-repo, owned by the hosted storage owner, out of scope here. This increment ships the honest refusal instead.
- Catalog discovery tools, publish/save from the workshop, console OAuth, methods-as-tools projection — all still parked.
