# Pipelex MCP

This specification states one contract, the workshop's. The first sections say what the product is and how it stands beside the hosted Pipelex connector, a separate product; "The workshop's contract" then states its tools, shapes and behaviour.

## Value Proposition

Pipelex MCP lets people reach their Pipelex methods from inside an MCP host. It ships as **the workshop**, the Pipelex plugin's local stdio server (server name `pipelex-plugin`, npm `@pipelex/mcp`), for coding agents such as Claude Code, Codex and Cursor. Its tools are `mthds_*`, and besides naming a method by reference it takes a method as files on disk, which is what writing, repairing and integrating one needs.

The target user is a developer, or the coding agent working for them, who is authoring a method, repairing it, integrating it into a codebase or running it from the project it lives in. Before the workshop existed, validating a method meant leaving the assistant flow, knowing the local OSS `pipelex-api` or the SDK, and mapping diagnostics back to file content by hand.

Core actions:

- List the saved methods visible to the API key's organization (`mthds_list_methods`) as bounded, source-free catalog metadata, so an assistant can resolve a user's name or intent to a canonical `method_id` without leaving the conversation.
- Validate a method given as files, a published address or a catalog id (`mthds_validate`), returning valid, invalid, pending-signature and no-verdict failure states in a stable structured result the assistant can use to fix issues.
- Look up the model references a method's pipes can name (`mthds_models`): list the deck's presets, aliases and waterfalls by category, or check one reference before it is written into a method, with the nearest names and the right sigil when it does not resolve. This gives the CLI-free skills in `../pipelex-plugins` what `mthds-agent models` and `mthds-agent check-model` used to.
- Project a pipe's declared inputs as a fill-in template (`mthds_inputs_template`), so an assistant can prepare inputs for a run without leaving the conversation. This unblocks the CLI-free skills in `../pipelex-plugins` (`pipelex-inputs`, `pipelex-design`) that used to shell out to `mthds-agent inputs bundle`.
- Generate typed code for a method (`mthds_codegen`): project its concept set into typed models — TypeScript (`ts-zod`) or Python (`python-pydantic`, `python-structures`), the target chosen from the project's context — stamped and locked by the Pipelex codegen engine, so an assistant working in a project writes the generated files and the lock verbatim and the offline check passes on the tree. Passing `output_dir` writes that tree straight into the project, so the bytes never enter the conversation at all.
- Prepare a pipe's *filled* inputs for a run (`mthds_prepare_inputs`): upload file-bearing values (local paths, `data:` URLs, bytes) to Pipelex storage and rewrite them to `pipelex-storage://`, so the inputs are run-ready, using the user's key. The method is named the same three ways as everywhere else, so a **published** method with a file-bearing input now has a path to a run that does not require every asset to already be a URL.
- Start a durable run of a method on the hosted Pipelex API (`mthds_run`), then check on it (`mthds_run_status`) and report its results (`mthds_run_results`) and show its pictures (`mthds_show_images`) by durable run id — the run outlives any single tool call and even the conversation.
- Save a completed run to disk (`mthds_download_artifacts`): the main output verbatim as `main_stuff.json`, and every `pipelex-storage://` reference in it resolved to a fresh link through the API and saved beside it, under `runs/<run_id>/` in the server's working directory by default. This is the download counterpart of `mthds_prepare_inputs` — the output and a generated image or PDF land where the user is, instead of living in the conversation or behind a presigned link that expires within the hour.
- Carry a bundle between the workspace and the organization's catalog (`mthds_save_method`, `mthds_get_method`): save the files on disk as a method, creating one or updating the one the directory is linked to, and bring a saved method's files back.

## Why LLM?

**Conversational win**: The user can say "validate this method" while the assistant already has the relevant file contents and can immediately iterate on fixes.
**LLM adds**: The assistant can choose the files to submit, explain validation results, modify source content, and repeat validation until the bundle is usable.
**What LLM lacks**: The assistant does not have Pipelex validation semantics, access to local OSS `pipelex-api`, or structured verdicts such as pending signatures, validation errors, and graph specs. It also cannot resolve a pipe's effective input contract (needs of the pipe minus what upstream pipes produce) — that projection is computed by the API from the parsed closure.

## Product Context

- **Existing products**: Pipelex, MTHDS, `@pipelex/sdk`, and the Pipelex API (local OSS `pipelex-api` during development).
- **Server**: `pipelex-mcp` is one package at its root that builds the workshop, a plain MCP-SDK stdio server published on npm as `@pipelex/mcp`, over a capability core. The core (`src/capabilities/`) holds the API calls, the projections, error classification, the run lifecycle and the image walk. The workshop owns its tool table, its schemas and its descriptions (`src/tools.ts`) and its instructions (`src/server.ts`).
- **Runtime API**: the hosted Pipelex API, defaulting to `https://api.pipelex.com` (point `PIPELEX_BASE_URL` at a local OSS `pipelex-api` on `http://localhost:8081` during development).
- **SDK dependency**: the `@pipelex/sdk` npm package (`PipelexApiClient`, published from the `js/` directory of `Pipelex/pipelex-sdk`). It re-exports the `mthds/protocol` surface, so the MCP imports one SDK and still reaches the open protocol routes. `mthds` is also a direct dependency, for `mthds/protocol`'s stored-source helpers and its inputs-template projection.
- **Auth**: the workshop reads a `plx_sk_` platform key from `PIPELEX_API_KEY` in the host-supplied process env; against a local runner started without authentication its files-based validation, inputs template and codegen calls work without one, while the catalog, every `method_id` call and the run family need one, and a missing or invalid key is a `config` no-verdict (see What the workshop registers).
- **Primary environment variable**: `PIPELEX_BASE_URL`, defaulting to `https://api.pipelex.com`.

## The workshop and the Pipelex connector

This document is the contract of the workshop, the MCP server published to npm as `@pipelex/mcp`, which reports the server name `pipelex-plugin`. The hosted Pipelex connector for chat hosts, reached at `https://mcp.pipelex.com/mcp`, whose tools are named `pipelex_*`, is a separate product with its own contract, and nothing in this document specifies it.

A host needs one of the two, not both: a chat host takes the connector, and a coding agent takes the workshop through the Pipelex plugin. A Claude user with the plugin can still find both in one session, since a claude.ai connector syncs into Claude Code. Their tool names do not collide, and the workshop's instructions tell the model to use its `mthds_*` tools for all method work whenever the connector's `pipelex_*` tools are also present, and never to mix the two servers: each can be signed in to a different organization. For the same reason, a method saved from the workshop is visible from the connector only when the workshop's key and the connector's sign-in select the same organization.

## Naming Conventions

Tools are the contract; the `../pipelex-plugins` skills are the manual. The naming follows that split:

- **Server name: `pipelex-plugin`.** The workshop reports `pipelex-plugin` in the `initialize` handshake, following the public words "the Pipelex plugin". The workshop's name is slightly off when it runs outside the plugin, through `npx` in Cursor, and that is accepted; `pipelex-workshop` was rejected because a server name can appear in a host's server list, where "workshop" is not a public word. The flattened tool names a host shows come from the key the server was registered under, not from the handshake name: the plugin registers the workshop as `pipelex`, so Claude Code shows `mcp__plugin_pipelex_pipelex__mthds_validate`, and a hand registration chooses its own key (the snippets in `docs/hosts.md` use `pipelex`, which yields `mcp__pipelex__mthds_validate` on Codex).
- **Tool names: `mthds_<stem>`, snake_case.** The workshop keeps the `mthds_` prefix its tools always had, because the plugin's skills call them verbatim (`allowed-tools` pins included). The workshop's catalog tools (`mthds_list_methods`, `mthds_save_method`, `mthds_get_method`) are Pipelex services rather than MTHDS-language tooling, so a strict reading of the brand rule would rename them; they keep `mthds_*` deliberately, since a `pipelex_*` name would match the connector's tools and put one name on two servers that can be signed in to different organizations. A prefix stays on every tool even where the server's own key could be argued to cover it: some hosts display or match bare tool names, and generic verbs (`validate`, `run`, `upload`) collide across servers in a multi-server session.
- **Lifecycle families share a stem prefix** — `mthds_run`, `mthds_run_status` and `mthds_run_results` sort and display adjacently, so hosts and models see them as one family.
- **Names state what you get** — a noun-only name must name the artifact it returns (`mthds_inputs_template`, renamed from the ambiguous `mthds_inputs`); otherwise lead with the operation (`mthds_validate`).
- **Catalog listing is deliberately `mthds_list_methods`** — the repeated English word is acceptable: the prefix is the stable product-family prefix, while `list_methods` is the clearest operation/resource stem and stays recognizable when a host displays the bare tool name.
- **The file-moving tool leads with its direction** — `mthds_download_artifacts` (a run's produced files come *down* to disk) names the direction and the thing moved, and does not borrow the run family's `_run_` stem even though it is keyed on a `run_id`: a noun-only `mthds_run_artifacts` would read as a listing, and "names state what you get" wins over family adjacency.
- **Parameter names mirror the route each tool wraps.** The same pipe selector is `pipe_ref` on `mthds_inputs_template` and `mthds_prepare_inputs` (`POST /v1/pipe-io` and the SDK's `prepareInputs` say `pipe_ref`) and `pipe_code` on `mthds_run` (`/v1/start` says `pipe_code`); both take the same qualified `domain.pipe_code` value. This is the workspace convention applied — `_code` is the default and may be qualified, `_ref` is reserved for where "always namespaced" genuinely matters — and neither name is wrong under it, so neither is renamed away from its route. What the surface owes the caller is that the two names must not surprise it: each parameter's description names the other tool's parameter as the same value, so an agent copying a pipe selector from the template call into the run call is told it can.
- **Tools are self-sufficient; the dependency on skills is one-way** — tool names, descriptions, and the server `instructions` never reference the plugin skills, because many consumers (hosts that run the workshop without the plugin, and raw MCP hosts) will never see them. The skills reference tool names verbatim, and where a skill is the manual for one tool the two share a stem (`pipelex-inputs` ↔ `mthds_inputs_template`); that side of the convention is recorded in `../pipelex-plugins/docs/decisions.md`.

## The workshop's contract (`pipelex-plugin`, the Pipelex plugin's server)

### What the workshop registers

The workshop is an npm-distributed stdio server (`@pipelex/mcp`, bin `pipelex-mcp`) that the Pipelex plugin spawns via `npx` on Claude Code and Codex, and that coding-agent hosts without the plugin (Cursor, Cowork-as-builder) are registered to spawn by hand. It is built on the plain MCP SDK (`McpServer` + `StdioServerTransport`) over the capability core. Auth is a per-user `plx_sk_` platform key in `PIPELEX_API_KEY`, supplied through the host's MCP server config env — per-user auth for free. The key determines the active organization and therefore the entire visible catalog.

The workshop registers, in this order: `mthds_list_methods`, `mthds_models`, `mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`, `mthds_run`, `mthds_run_status`, `mthds_run_results`, `mthds_show_images`, `mthds_download_artifacts`, `mthds_save_method` and `mthds_get_method`. It is the server for building and integrating a method: every method-taking tool takes `files` beside the two selectors, it reads the working directory the host started it in, and it writes into it. Its instructions say that its `mthds_*` tools are the ones to use for all method work when the connector's `pipelex_*` tools are present too (see The workshop and the Pipelex connector).

**It registers no views.** Tools-first is the empirically verified V1 posture: view-rendering workshop hosts penalize localhost asset origins, and the text summaries carry the flow on their own in text-only hosts. None of its results carries the graph or the form's artifacts on `_meta`, and `available_view_specs` is always empty on every tool that declares it. The text summaries carry the whole flow, and the one picture a builder needs, the method's flowchart, reaches them as a file: `mthds_validate` writes it beside the `{ path }` files it validates, as a standalone HTML page (see The method graph page).

Three of its tools turn on the working directory:

- **`mthds_download_artifacts`.** It saves a run — its main output and its produced files — under the server's working directory (see Artifact Download Scope).
- **`mthds_save_method` and `mthds_get_method`** (see Catalog Write Scope). The filesystem is not optional on either side of these two: the save submits the bundle in the `{ path }` form and finishes by writing the link file that makes the next save an update rather than a duplicate, and the get exists to bring sources to disk.

**Client identification.** Every request the workshop sends to the Pipelex API names this server in its `User-Agent`, so the platform attributes it to the `mcp` surface and records the AI host behind it: `pipelex-mcp/<version> (workshop; host=<name>/<version>) pipelex-sdk-js/<v> node/<v> (<os>; <arch>)`, where the host is the `initialize` handshake's `clientInfo`, sanitised to header-safe characters and read when each tool call builds its client. The server passes this as the SDK's `appInfo` through one client factory, and a lint rule refuses any other way of reaching the API. The header is analytics only and never gates anything. The product token is `pipelex-mcp`, whatever name the server reports in its handshake. `docs/client-identification.md` has the sanitising rule, the guard and what it does not catch.

### Method Selectors (`files` / `method_ref` / `method_id`)

Every method-taking tool selects the method it operates on in one of three forms — the platform's addressing contract, stated once here so the per-tool sections carry only their own mechanics. The method-taking tools (`mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`, `mthds_run`) take all three.

- **`files`** — inline source: the submitted-files shape (`{ content, uri? } | { path }` — see The files union). The method's contents travel in the request.
- **`method_ref`** — a published method's address: `github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0`. Resolved **server-side by the runner**: the repository is fetched at the tag, the package is located by manifest identity, and the resolved commit SHA is recorded — no bundle ever enters the conversation. The registry form (any non-address reference) is reserved and answers `501`.
- **`method_id`** — a registered method's hosted catalog id (`mt_…`), org-scoped, from `mthds_list_methods`. Resolved server-side by the hosted platform wherever the platform supports it; always requires a credential, and always resolves the method's CURRENT stored content (methods are not versioned).

Two uniform rules govern how the selectors combine — there is no per-tool precedence folklore:

1. **Tooling tools (`mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`): exactly one selector.** Give files, an address, or an id — never several. A second selector is an instructive `input_domain` no-verdict (mirroring the API's own 422), located at a fixed field for each pair whichever came second: `method_ref` beside files is refused at `method_ref`, and `method_id` beside either of the others at `method_id`. These operations are stateless: there is no Run row, so "linkage" has no referent, and an extra selector could only be ignored — the worst contract of the three. This retires the old "files win, `method_id` is ignored" behavior, which was exactly the folklore the rule replaces.
2. **`mthds_run`: inline files win, and `method_id` beside them demotes to run-history linkage.** `files` + `method_id` together is legal — the files run and the id is recorded on the platform's Run row (the webapp's "run the editor's unsaved buffer, file it under its method"). `method_ref` is a complete run source of its own and pairs with **nothing**: `files` + `method_ref` and `method_ref` + `method_id` are both rejected — an address run carries its own provenance and needs no linkage id.

Where each selector is accepted, and who resolves it:

| Tool | `files` | `method_ref` | `method_id` |
| --- | --- | --- | --- |
| `mthds_validate` | yes | yes — server pass-through (`POST /v1/validate` resolves it) | yes — server pass-through (the hosted platform resolves it; hosted-only) |
| `mthds_inputs_template` | yes | yes — server pass-through (`POST /v1/pipe-io` resolves it) | yes — server pass-through (the hosted platform resolves it; hosted-only) |
| `mthds_codegen` | yes | yes — server pass-through (`POST /v1/codegen` resolves it) | yes — server pass-through (the hosted platform resolves it; hosted-only) |
| `mthds_prepare_inputs` | yes | yes — server pass-through (`POST /v1/pipe-io` resolves it) | yes — server pass-through (the hosted platform resolves it; hosted-only) |
| `mthds_run` | yes | yes — server pass-through (`POST /v1/start` resolves it; provenance returned) | yes — server pass-through (native on `/v1/start`) |

**Nothing is expanded client-side.** Every selector in the table is resolved by a server. `mthds_inputs_template` and `mthds_prepare_inputs` both read `POST /v1/pipe-io`, which takes all three selectors on the hosted API — the template tool directly, the preparation through `@pipelex/sdk`'s `prepareInputs` — so neither expands a catalog id into files through the SDK's `getMethodClosure` any more, as both did while they read routes that took no `method_id`.

**Verdict discipline on selector resolution.** A selector-resolution failure — an unknown or foreign-org `method_id` (404), a `method_ref` that does not parse or cannot be fetched (422), no package matching the address (404), an ambiguous address (422), either refusal from the execution-locus gate (403 — see below), a registry-form ref (501) — is a **no-verdict** `status: "error"`, never `is_valid: false`, which stays reserved for a verdict about actual MTHDS content. Each failure classifies with its location at the selector that caused it. A 404 is read as the selector's only when it names what was not found, as the runner's `MethodPackageNotFoundError` and the platform's `not_found` code do, which is how `@pipelex/sdk` reads it: a runner too old to serve a route — the case on `POST /v1/pipe-io`, the route of `mthds_inputs_template` and `mthds_prepare_inputs` — answers a bare 404, which is `config` at `PIPELEX_BASE_URL` naming the route.

**The execution-locus gate's two 403s are classified at the method, never at the credential.** The runner decides where caller-supplied Python would execute, and refuses on two grounds: a package declaring `StructuredContent` subclasses is refused on every hosted deployment (`error_type` `MethodStructuresRefusedError`) because structures import into the runner's own process, and a method shipping *any* `.py` is refused by a deployment that is not sandbox-hosted (`CustomCodeRequiresSandbox`). Both are `input_domain` at whatever named the method, a class `classifyError` sets itself rather than reading it from the SDK: the runner tags the sandbox refusal `error_domain: input` but sends the structures refusal with no domain, which the SDK reads as `config` like any bare 403. `classifyError` branches on the declared `error_type` — the runner's stated contract — for that class, locator and hint, ahead of the generic 401/403 arm. Left to that arm they read as `config` at `PIPELEX_API_KEY` and send a caller whose credential is perfectly good to go and mint a new key. The two differ in what the caller can do: a structures refusal is fixed only by expressing the types as MTHDS concepts, while custom Python is legal MTHDS and the same method runs on a sandbox-hosted deployment. The class stays `input_domain` for both by this spec's own test for it — a request the caller can write (a Python-free method) does work around it, which is exactly what the missing-descriptor `config` arm fails.

**Which routes apply the gate, and which do not.** A selector resolved through `POST /v1/validate` or `POST /v1/start` travels `fetched_method_source`, which loads the package's non-`.mthds` files, so the gate applies — `mthds_validate` and `mthds_run`. `POST /v1/codegen` and `POST /v1/pipe-io` resolve an address through `fetch_method_mthds_files`, which takes only the `.mthds` files and loads no Python, so no execution locus is ever decided and the gate cannot fire — `mthds_inputs_template`, `mthds_codegen` and `mthds_prepare_inputs` therefore answer an address that the other tools refuse. `/v1/start` also applies the gate to a submitted bundle and to a stored method's injected source, which is why the locator follows the request shape rather than always naming `method_ref`.

**Availability.** `method_ref` resolution is served by any pipelex-api ≥ 0.21.0 deployment, bare or hosted. On `api.pipelex.com`, hosted `method_ref` support and the tooling-route `method_id` selector land with the platform deploy the addressing campaign tracks as its Checkpoint 3; until that deploy is live, a selector-shaped call there answers a no-verdict error rather than a verdict, and the tools surface it as such.

### Verdicts and errors

A *produced* verdict is always `status: "ok"`, whatever it says about the method: a tool that judges a method discriminates on `is_valid` (and, where it matters, `is_runnable`), the run tools on `state`, and a walk over several items on its own completeness flag. A successful catalog page is `status: "ok"` with no `is_valid` field, since a listing is not a verdict about a method. `status: "error"` is reserved for **no verdict could be produced** — a bad request shape, an unreachable or misconfigured API, a runtime fault — and carries an `errors[]` array. Each entry has a class — `input_domain` (the request is wrong), `config` (the environment, the deployment or the credential is wrong) or `runtime` (an unexpected server-side fault) — a `retryable` flag, and an optional `location`, `hint` and `kind` beside its `message`.

**The class and the retry flag of a failure the SDK raised are the SDK's verdict.** Every error `@pipelex/sdk` throws carries an error domain (`input`, `config` or `runtime`: who can fix it) and `retryable` (whether asking again can succeed), taken from the server's own problem-document members when it sent them and from the SDK's reading of the status otherwise. `classifyError` in `src/capabilities/shared.ts` maps the domain onto the class, `input` being `input_domain`, and takes `retryable` as it comes; what it adds is this server's own, with per-route options for each tool's locators and hints. It overrides the SDK's class only for a reason this server knows and the SDK cannot: a rejected credential (401/403 outside the execution-locus gate) is `config` whatever the server tagged it, since this server's credential is its environment, which no tool argument changes; the execution-locus gate's refusals are `input_domain`, the method's (above); a route's 400/422 that no argument fixes (a request this server built, a key acting for no organization) takes the class the route declares; the reserved registry form of `method_ref` (501) is `input_domain`, the caller's own choice of form, where the runner says `config`; and a 404 the SDK does not read as the caller's, or any 404 on a route that names no resource, is `config` at `PIPELEX_BASE_URL`, the route missing. It overrides `retryable` for a start and a method create that may already have happened (see the run family and `mthds_save_method`), since the SDK's verdict says whether a retry can succeed, never whether it is safe. A failure the SDK did not raise keeps this server's reading: a fault nothing names is retryable `runtime`.

On a no-verdict error (`status: "error"`), the content summary is a terse headline followed by a Markdown list of each `errors[]` entry — its `location`, `message`, and `hint`. This surfacing is shared by every tool (the same `toolResultContent` helper): the agent reads `content`, so the actionable detail the capability writes into `errors[]` must reach that stream, not sit only in `structuredContent.errors` where a host that shows the agent only the top content line would strand it. `structuredContent.errors` stays the untouched machine contract.

**`kind` refines a class the headline cannot use.** Every no-verdict headline is derived from the error's `class`, which is the coarse machine contract and stays that way. One condition needs more: a **402 paywall** is deliberately `config` (the call cannot be made as credentialed), so a class-derived headline announces "the Pipelex API is unreachable or misconfigured" for what is a plan limit — and on a host that shows the agent only the top content line, that is the whole message, sending it to debug the base URL. So `classifyError`'s 402 arm also sets `kind: "paywall"`, and each capability's headline table declares a `paywall` entry alongside its three class entries; `summaryForToolError` consults `kind` first. The class contract is untouched — a machine consumer still branches on `class`, and `kind` is what lets it (and the headline) tell a billing refusal from an unreachable API without sniffing the message, exactly as `retryable` distinguishes a transient `config` from a permanent one. The headline table's type (`ErrorSummaries`) makes the `paywall` entry **mandatory**, so a new capability cannot inherit the connectivity headline for a billing refusal by omission — the miss is a type error rather than something a reviewer must catch. Adding a member to `kind` is how a future such cause gets its own headline; re-classifying it is not.

### The result streams

A tool result carries up to three independent streams, each with its own reader, and nothing belongs in two of them by accident:

- **`structuredContent`** is the machine contract the model reads. A consumer branches on its fields, never on the transport.
- **`content`** is the Markdown summary a model or a person reads. Each tool states what its summary carries: `mthds_validate`'s is the API's rendered Markdown, deliberately not duplicated into `structuredContent`, while the tools whose payload the model must act on deliberately repeat it in a fenced block — the template of `mthds_inputs_template`, the prepared inputs of `mthds_prepare_inputs`, the generated files of `mthds_codegen` when they are not written to disk, and the bounded output of the results tool — since some hosts read prose more reliably than structured fields. A summary is also the one layer that reaches a host whose copy of the tool list is cached, so a presentation rule that must reach existing installs is written there.
- **`_meta`** carries large data that **never reaches the model's context**: what a completed run holds beyond the model's bounded copy, the full output and the per-call usage records with their per-pipe rollup. It still travels on the raw MCP result, so a programmatic consumer can read it off the wire; it is withheld from the model, not from the transport.

Because the model never sees `_meta`, a result that fed a view would say so in `structuredContent`, in `available_view_specs`; the workshop registers no views, so that list is always empty (see What the workshop registers). A request's own `_meta` is treated as untrusted and is never logged, since a host may attach the user's location and stable identifiers to every call.

### The main pipe's signature (`main_pipe`)

`mthds_validate` returns the signature, read by one projection (`mainPipeSignatureOf`) from three artifacts of its `POST /v1/validate` report. It is the entry pipe's.

```ts
main_pipe?: {                                    // present on every valid verdict with a settled pipe
  pipe_ref: string;                              // namespaced domain.pipe_code
  inputs: Array<{                                // ordered — authored order where the descriptor states it
    name: string;
    concept_ref: string;                         // fully-qualified, multiplicity suffix stripped
    multiplicity: "single" | "variable" | "fixed";
    item_count?: number;                         // present exactly on the fixed arm
    required: boolean;                           // presence !== "optional"
  }>;
  output: {
    concept_ref: string;
    multiplicity: "single" | "variable" | "fixed";
    item_count?: number;
    optional: boolean;
    images?: string[];                           // where images sit, in `$` notation; absent = unknown, [] = none
  };
};
```

**The main pipe's signature rides `structuredContent`.** An agent integrating a method it cannot read — a `method_ref` or `method_id` source, where no bundle enters the conversation by design — needs the call site's types, and the alternative is guessing the produced concept by heuristic. `main_pipe` states them compactly: the main pipe's namespaced ref, each declared input with its fully-qualified `concept_ref`, multiplicity and `required` flag, and the produced concept with its own multiplicity and `optional` flag. The decisions behind that shape:

- **Source of truth is `pipe_io_contracts[main_pipe_ref]`**, a required field on every valid report and not gated by the `views` token. The input-form descriptor is consulted for exactly one thing, **input order** — the contract's `inputs` map deliberately contracts none, the descriptor states authored order — and when the descriptor (or its entry) is absent the map's own order stands. A descriptor naming the same field twice costs the repeat rather than duplicating the slot — the contract's map is what declares the inputs, the descriptor only orders them, and a signature listing one slot twice is wrong in exactly the plausible way a partial one is. The signature never depends on the descriptor being present.
- **Present on every valid verdict, pending signatures included.** The workshop has no views and is precisely the deployment the integrating agent uses, so the signature never depends on a view; a pending-signature verdict has a fully determined signature, and knowing the shape before the signatures resolve is useful. Absent when nothing settles an entry pipe — see the next bullet.
- **The entry pipe is the report's `default_pipe_ref`; the blueprint derivation stands only behind an absent field.** `default_pipe_ref` is the API's statement of the pipe a selector-less run of that same request would execute, and it is the only signal that knows a `method_ref` package's manifest (`METHODS.toml`), whose `main_pipe` outranks the bundle-level declaration on the run and build routes. Reading `bundle_blueprint.main_pipe` instead is manifest-blind, so a package where the two differ got a signature typing a call site the run would not execute. Three arms, and `null` is deliberately not `undefined`: a non-empty string is the stated default; a stated `null` (or any unreadable value) is the server reporting that it determined **none** — no `main_pipe` anywhere, or a manifest naming a pipe the closure does not declare or declares in several domains — which is precisely when a selector-less run would fail to resolve one too, so no signature is emitted and the blueprint is *not* consulted behind it; the field being **absent** means the runner predates it, and only there does the blueprint derivation (its primary blueprint's `main_pipe`, qualified by its domain) stand. A JSON body cannot carry an own property holding `undefined`, so reading the field is the whole absence test.
  - *Live coverage is no longer gated*: the field landed on `pipelex-api` after its 0.21.0 release and `validate.e2e.ts` carried a skipped assertion against an unseamed client — the one check the fallback cannot stand in for — waiting on a deployment that served it. Measured on 2026-09-21, the live suite's default target (`api-dev`) returns the field, so that assertion now runs. It matters more than when it was parked: since `@pipelex/sdk` 0.19.0 a stated `null` is a refusal rather than a fall-through, so the field's presence changes behaviour rather than only sharpening it.
- **Naming follows the standard's own artifact** (`concept_ref`, the `IOMultiplicity` vocabulary) per the brand boundary — MTHDS concepts inside a Pipelex envelope. `item_count` is absent off the fixed arm (this repo's "the unused field is absent" convention; the contract's `null` is the contract's own), and the three-valued `presence` collapses to `required` the way the standard recommends for a consumer that only needs "may this be absent?" — the plain/force distinction is lint- and graph-facing and does not bear on a call site. Inputs are an **array**, not a map, because order must be expressible.
- **Defensive narrowing, whole-signature omission.** Every member is checked against what actually arrived (strings non-empty, multiplicity in the closed vocabulary, `item_count` an integer of at least two exactly on the fixed arm and the literal `null` the contract states on every other arm — `Concept[1]` reports `"single"`, so a fixed count of one is a producer violation, and an omitted or non-null `item_count` off the fixed arm is drift — presence in the marker vocabulary). Any malformed member, or no contract entry for the declared main pipe, omits the **whole** signature rather than emitting a partial one — half a signature actively misleads the agent typing against it, where an absent one just sends it to the inputs template. The verdict is never affected.
- **No JSON Schemas.** The per-slot `json_schema` is the token-heavy part and stays behind the inputs template and `mthds_codegen`.
- **`output.images` says whether a run will produce pictures, and where they will sit.** The capability requests the standard's **output-form descriptor** alongside the input form (`views: ["input_form", "output_form"]`) and walks the entry pipe's single output node for `kind: "image"`, recursing into an `object` node's `fields` and a `list` node's `item`. The result is a list of paths from the output's root: `$` is the output itself, `$.name` a field of it, `$[]` an element of a list, `$[].name` a field of one — so a top-level `Image` output is `["$"]`, an `Image[]` is `["$[]"]`, and "this method produces pictures" is `images.length > 0`. Three rules matter. **An empty array and an absent member are different answers**: `[]` means the server described the **whole** output and it holds no image, absence means the question is unanswered — no descriptor arrived (an older runner, or an entry that did not narrow), *or* the walk met something it could not read — and the agent must not read silence as "no". **A `document` node is not a picture** and is deliberately not reported here; a `documents` member is a later increment rather than a silent inclusion. And **`kind: "unknown"` is opaque**: it is the standard's escape hatch for a producer that could not map a node honestly, so there may be an image inside it and no way to know.

  **The walk therefore reports its own completeness, and that decides whether the member rides at all.** Opacity and emptiness are not the same answer, but they collapsed into the same emitted value: an `unknown` root, a `kind` string this build does not know, a record carrying no `kind`, a field with no usable name and the depth ceiling each yielded `[]` — "described and holds none" — for a descriptor that said no such thing, and a consumer applying the documented `images.length > 0` rule read a confident **no** off a node nobody had looked into. So the walk returns `{ paths, complete }`, and the projection publishes the member only when it is a truthful answer: an incomplete walk that found **nothing** withholds it, which is the unanswered reading. An incomplete walk that **did** find an image still publishes — those positions really do hold pictures, and downgrading a known yes to "unknown" would lose the signal the member exists for, so a non-empty array is exhaustive unless part of the description was opaque. Only kinds the walk fully understands and that hold no picture (`text`, `prose`, `date`, `number`, `boolean`, `enum`, `document`) keep it complete; a `document` is an **answer**, not a failure to look, and must not poison completeness. The walk is a total map over the standard's own `FIELD_KINDS`, so a kind a later version adds fails this repo's build instead of quietly reading as "no images". The rendered signature line says it too, as a trailing ` (produces images)`, for agents that read prose more reliably than fields.
- **One rendered signature line is appended to the `content` summary** on the same verdicts, under its own `## Main pipe` heading, in MTHDS-flavoured notation — `demo.main(document: legal.Contract, notes?: native.Text, tags: native.Text[]) -> analysis.Report[2]`, where `?` marks an input the caller may omit (and an output a successful run may resolve absent), `[]` a variable list and `[N]` a fixed one. The two marks never meet on an input — the standard pins a plural slot to `presence: "plain"`, so an optional list is not a shape a caller can be offered — and only the output can carry both. Agents read prose more reliably than structured fields.

### Catalog Discovery Scope (`mthds_list_methods`)

`mthds_list_methods` lists the registered methods visible to the API key's organization through `@pipelex/sdk`'s `PipelexApiClient.listMethods()` (`GET /v1/methods`). Catalog listing uses the same org-bound credential as the by-id catalog paths, `PIPELEX_API_KEY`: the credential determines the active organization and therefore the entire visible catalog, and no catalog data is embedded in static server instructions. It is a plain, read-only tool with no view and no `_meta` payload: the assistant needs bounded names, descriptions, and canonical ids to choose a method, and a human catalog-management flow does not exist in this increment. Listing executes no method and spends no inference credit.

**The catalog is searched reactively.** The tool description carries the reactive triggers alone — the user asked what exists, or named a saved method without its id. The workshop's `instructions` state the reactive triggers and stop there — a coding-agent session is driven by skills, and a proactive clause in text that reaches every session had it searching the catalog in the middle of work no skill had asked it to leave, `/pipelex-design` included.

The public MCP input is:

```ts
{
  query?: string;  // case-insensitive substring, matched server-side over name and description
  limit?: number;  // integer 1..50; default 20
  cursor?: string; // opaque next_cursor from a previous call
}
```

`query` is trimmed and blank means no filter — the trimmed-away case omits `q` entirely rather than sending an empty string, which the API treats as bad input rather than as "no filter". Search, ordering and paging are all applied server-side: `q` matches across the whole catalog rather than one page, and rows arrive ordered newest first by the immutable `created_at` the catalog pages on. The MCP re-sorts and re-filters nothing — re-sorting would reorder a page against the cursor that produced it, and re-filtering would search only the rows the server already selected. A cursor is opaque and is passed back verbatim to continue.

Success projects exactly:

```ts
{
  status: "ok";
  returned_count: number;
  next_cursor: string | null;
  methods: Array<{
    method_id: string;
    name: string;
    name_truncated: boolean;
    description: string | null;
    description_truncated: boolean;
    created_at: string;
  }>;
}
```

The model-facing `name` is bounded to 200 Unicode code points and `description` to 500, with explicit truncation flags; the server's search examines their full stored values. `created_at` is reported rather than `updated_at`, because the catalog orders on `created_at` and showing a timestamp other than the sort key makes "newest first" unreadable. There is no total count in either form: counting a catalog means reading all of it, which is the cost paging exists to avoid. Missing descriptions normalize to `null`. Empty catalogs and no-match queries are successful empty results.

**There is no `has_source` flag.** The catalog index projection does not carry a method's source, and recomputing the flag would cost a `getMethod` per listed row — exactly the read the index exists to avoid. A source-less method instead announces itself where the answer is actionable rather than advisory: passing its id to a by-id validate, inputs template, prepare or run fails fast as an `input_domain` no-verdict at `method_id`.

The projection boundary is strict: `mthds`, `python`, `input_data`, `pipe_output`, `org_id`, and `created_by_user_id` never enter `structuredContent`, `content`, `_meta`, or logs. The index projection no longer returns them, but the boundary is enforced on what actually arrives rather than on what the type declares, so a looser server cannot leak through it. A response that is not a page object, a page missing its `items` array, a **missing or** non-string `nextCursor`, or a row whose `method_id`, `name`, or `created_at` is not a string is a reachable, non-retryable `runtime` contract error rather than a partial list. `nextCursor` is checked as strictly as `items` on purpose: the SDK reads the raw wire key, so a renamed or dropped `next_cursor` arrives as `undefined`, and treating that as the end of the catalog would hide every method past the first page while every live check stayed green. The text summary repeats the bounded name, description, and canonical id for each returned row, and includes cursor/query guidance without source or stored defaults.

**The summary specifies the listing's presentation, because the name alone is not an answer.** A catalog listing is read almost verbatim by the user, and the description is what lets them choose; observed live on the same two-method catalog, one host answer rendered name + description while another rendered bare names and volunteered "both contain source code, but I haven't checked whether they validate" — the model filling the silence with the one field that carries no verdict. So the summary leads its list with an explicit render directive ("report every method with BOTH its name and its description"), puts name and description first on each row with `method_id` demoted to a trailing parenthetical, and says nothing at all about source or validity — the flag that once carried that caveat is gone, and a row that volunteered it demonstrably leaked into user-facing answers as a half-verdict. The directive lives in the summary rather than the tool description on purpose: the summary is the one layer that reaches a host whose copy of the tool list is cached (see The result streams). The tool description carries the same instruction as a backup for hosts that weight it at selection time. Names and descriptions are org-authored and therefore untrusted: each is collapsed to a single line so it cannot break out of its bullet, and the directive names them as data to display rather than instructions to follow. The directive is omitted when the page is empty.

No-verdict failures use the shared error shape. Unreachable API is retryable `config` at `PIPELEX_BASE_URL` (the SDK's own request timeout, an API that took the request and did not answer, is retryable `runtime`); missing or rejected auth is `config` with the `PIPELEX_API_KEY` wording; 402 is the existing billing `config` arm, tagged `kind: "paywall"` so the headline names the plan rather than connectivity; a 400/422 is classified by request shape, because the route has two unrelated bad-request causes and only the caller's own input separates them: with no `cursor` supplied it is missing active-org context, `config` at the deployment's credential location; with a `cursor` supplied it is the cursor, `input_domain` at `cursor` with a start-over hint, since a machine consumer branches on the class and a paging fault must not read as an auth fault; missing `/v1/methods` (404) is `config` at `PIPELEX_BASE_URL`; a 5xx takes the SDK's verdict, retryable `runtime` unless the server says otherwise, except a 501, which is `config` at `PIPELEX_BASE_URL` and not retryable; a failure nothing names is retryable `runtime`; malformed success payloads are non-retryable `runtime`.

### Run Scope (the run family)

The run family adds durable (async) method execution against the hosted Pipelex API, wrapping `@pipelex/sdk`'s run lifecycle (`client.start` → `POST /v1/start`, `client.getRunStatus` → `GET /v1/runs/{id}/status`, `client.getRunResult` → `GET /v1/runs/{id}/results`). The MCP adds no execution logic and stays stateless: all run state lives behind the durable `run_id` on the platform. The server never calls the blocking `POST /v1/execute` or the SDK's blocking wrappers (`waitForResult`, `startAndWaitForResult`), and never surfaces `result_url` or other presigned URLs into model context.

**Run flow**:

1. The assistant starts a run with `mthds_run`, giving files, an address or an id and the inputs filled from `mthds_inputs_template`, prepared by `mthds_prepare_inputs` where they carry local files.
2. The start tool returns the durable `run_id` immediately.
3. If the user asks how it is going, the assistant calls the status tool — one cheap read, with a retry hint in the summary so it doesn't spin-poll.
4. Once the run is terminal, the assistant calls the results tool and reports the main output (bounded) on success, or, on a failure, why the run failed, what to do and what to give support.
5. Because everything is behind the durable id, the flow survives conversation gaps: days later, "what did that run produce?" is a single results call.

**Starting a run.** The start tool is `mthds_run`. It is not read-only: its description states that it executes the method on the hosted API and spends inference credit. Its inputs are stated in the `mthds_run` section; its result is:

```ts
// structuredContent
{
  status: "ok" | "error";
  run_id?: string;             // the durable pipeline_run_id — the handle for everything else
  run_status?: RunStatus;      // initial state from the ack, when the server includes one
  created_at?: string;
  method_provenance?: {        // method_ref runs only — what was actually fetched
    address: string;
    tag: string | null;        // null for a bare address (default branch at HEAD)
    commit_sha: string;        // the honest cache key; what keeps the run explainable when a tag moves
  };
  available_view_specs: Array<"live_run_status">;  // always [] on the workshop
  errors?: ToolError[];        // no-verdict only
}
```

`RunStatus` is the hosted lifecycle set: `PENDING | STARTED | RUNNING | COMPLETED | FAILED | CANCELLED | TERMINATED | TIMED_OUT`. The `content` summary states the run was accepted, gives the id, and spells out follow-up etiquette for the model (check with the status tool, fetch with the results tool when terminal, don't poll in a tight loop). Deliberately not exposed in v1: `output_name`, `output_multiplicity`, `dynamic_output_concept_ref`, `extra`, webhooks, client-supplied run ids. Binary inputs (PDFs, images) ride reachable https URLs or `pipelex-storage://` references inside `inputs`: `mthds_prepare_inputs` turns a local path or bytes into a storage reference (see Prepare Inputs Scope).

**Run-by-reference (`method_id`)**: `mthds_run` starts a registered method by its catalog id, so the model never carries the bundle — a run of a registered method is a tens-of-tokens call from any host. The platform resolves the id natively on `POST /v1/start`, with no fetch round-trip and no bundle on the wire. Methods have no versioning: a by-id run always executes the method's **current** stored content, and its description says so, so agents do not assume a run pins what they previously looked at. The catalog is org-scoped, so a by-id start needs a credential; an unauthenticated call fails with the instructive `config` auth texture, and an id the caller's organization cannot see is `input_domain` at `method_id`. Id format beyond non-blank stays server-owned, the same stance as `run_id`.

**Run-by-address (`method_ref`)**: `mthds_run` also starts a published method by its address — `github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0` — as a **server pass-through**: the SDK's typed `method_ref` start option rides `POST /v1/start`, the runner fetches the repository at the tag, locates the package by manifest identity, and runs it. A `method_ref` is a complete run source and pairs with nothing (`files` + `method_ref` and `method_ref` + `method_id` are both `input_domain` rejections — see Method Selectors); a `pipe_code` beside it is legal and overrides the manifest's `main_pipe`. The start ack's `method_provenance` (`{address, tag, commit_sha}`) is surfaced in `structuredContent` and echoed in the summary — the resolved SHA is what keeps the run explainable when a tag moves. Selector-resolution failures are no-verdict errors at `method_ref` (a ref that does not parse or fetch → 422; no matching package → 404; either execution-locus refusal → 403; a registry-form ref → 501), classified before anything executes — no inference credit is spent on a failed resolution.

**The status tool** (`mthds_run_status`) — check on a run. Read-only, plain tool (no view).

```ts
// input
{ run_id: string }

// structuredContent
{
  status: "ok" | "error";
  run_id?: string;
  run_status?: RunStatus;      // the coarse lifecycle state
  is_terminal?: boolean;       // convenience so the model needn't know the status set
  degraded?: boolean;          // true → status is last-known, not freshly derived
  retry_after_seconds?: number | null;
  created_at?: string;
  finished_at?: string | null;
  failure?: RunFailure;        // terminal statuses other than COMPLETED, when the run stored an error report — see below
  errors?: ToolError[];
}
```

The `content` summary while non-terminal includes "check again in ~Ns" from the retry hint.

**A failed run says why.** When a run fails, the runner stores an error report on it, and the platform serves that report on the status read (`RunRead.error`) and, from the platform release that relays it, in the body of the results read's `409`. Every failed arm of the run family carries it as one `failure` object: the status tool on a terminal status other than `COMPLETED`, and the `failed` state of the results tool, the image tool and `mthds_download_artifacts`.

```ts
interface RunFailure {
  run_id: string;
  error_type?: string;        // the runner's exception class name — for the support line, never matched against
  title?: string;             // the stable human label of the error class ("LLM completion")
  message?: string;           // what went wrong, as the runner wrote it; it can quote the provider's raw text
  error_domain?: string;      // who can fix it: "input", "config" or "runtime"
  error_category?: string;    // the finer class of an inference failure: "transient", "configuration", "content", …
  retryable?: boolean;        // whether running it again can succeed; absent means the report does not say
  user_action?: { kind: string; detail: string };   // the next step: wait_and_retry, change_input, change_model, check_billing, check_credentials, contact_support, unknown
  finished_at?: string;       // when the run ended, from the run record
}
```

The report is checked as it arrives, since the runner owns its shape: `@pipelex/sdk` hands it back checked field by field, so a field of the wrong type is absent and a `user_action` arrives whole or not at all, and this server reads a blank field as absent too. A report that is `null` (a run the platform finalized itself, such as a timeout) or carrying none of `error_type`, `title`, `message` and `user_action` gives no `failure` at all, so the arm carries its status alone. The report's `provider_metadata`, which holds the provider's raw body, is never carried. **Every text field is bounded**, because the runner embeds whatever its exception said and one report can run to hundreds of kilobytes (a structured output that failed after its re-asks quotes every validation error): `message` to `FAILURE_MESSAGE_MAX_CODE_POINTS` (2,000 code points) and every other field to `FAILURE_FIELD_MAX_CODE_POINTS` (300), each cut ending with a note of how much was left out; the failed arm's `failure_message`, which quotes the report's message once the platform relays it, takes the message's bound too. A `wait_and_retry` user action carries this server's own `detail` ("Wait a moment, then run it again.", or an empty one when `retryable` is `false`), since the runner's is worded for a pipe still inside its retries. **Whether running it again can help comes from `retryable` alone**, never inferred from the domain or the category: absent, no summary claims either way, and `false` never advises a retry. A `false` is worded as the report's expectation ("The report does not expect running it again unchanged to help"), never as a certainty, since the runner sets it for a failure it could not classify as well as for one that will recur. The results, image and download tools take the report from their failed arm when it carries one and otherwise from one status read of the same run that follows the arm, which is also where the time the run ended comes from. That read is bounded by `FAILED_RUN_READ_TIMEOUT_MS` (5 s), far under the SDK's own poll timeout, since it only adds to an answer already in hand; a status read that fails or runs out of time leaves the failure to what the arm carried, and never turns the verdict into an error or holds it back.

Each failed summary says, one labelled sentence per line: that the run ended and with which status; **Why**, the report's title and message; **What to do**, the report's `user_action.detail`, or a sentence chosen by its `kind` when the detail is blank (wait and run it again, change the inputs, choose another model, check billing, check the credentials, contact support), or that the report names no next step. A `wait_and_retry` kind always takes its own sentence, because the runner words that kind's detail for a pipe still inside its retries ("the system will retry automatically"), which nothing does once the run has ended, and on a report whose `retryable` is `false` it gives no next step at all; **Retry**, only when the report states `retryable`; and **For support**, the run id, the error type and the time the run ended (`Run run_… · LLMCompletionError · ended 2026-09-23T15:16:37.856067+00:00`). A run with no report says that its status is all that is known, and still gives the support line; when the failed arm carried no report and the status read that should have followed it failed, the summary says instead that the reason is unknown for now and that reading the run's status again returns it, since nothing then shows the run stored none.

**The results tool** (`mthds_run_results`) — report the results. Read-only.

```ts
// input
{ run_id: string }

// structuredContent
{
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";   // mirrors the SDK's RunResultState
  retry_after_seconds?: number | null;          // state=running only
  run_status?: RunStatus;                       // state=failed only (terminal status)
  failure_message?: string;                     // state=failed only — the platform's one-sentence account of the ending
  failure?: RunFailure;                         // state=failed only, when the run stored an error report — see the status tool above
  main_stuff?: unknown;                         // state=completed only — bounded, see below
  truncated?: boolean;                          // state=completed only; true when main_stuff was bounded down
  image_candidates?: string[];                  // state=completed only, and only when the output references stored files — the free image shortlist, see below
  image_candidates_omitted?: number;            // state=completed only, and only when the shortlist left some out
  usage?: RunUsage;                             // state=completed only, always present there — RUN-LEVEL token & USD-cost totals; per-pipe rollup + full per-call list ride _meta (see below)
  available_view_specs: Array<"run_graph">;     // always [] on the workshop
  errors?: ToolError[];
}
```

On `completed`, `content` composes a Markdown summary with the main output in a fenced code block (the `mthds_inputs_template` duplication pattern: the payload the model must read is deliberately repeated in the prose), bounded by the same cap as `structuredContent`. The **full** (unbounded) `main_stuff`, the **full** per-call `tokens_usages` record list, and the per-pipe usage rollup ride the `_meta` channel (keys mirror the API field names where they exist: `_meta.main_stuff`, `_meta.tokens_usages`, plus our own `_meta.usage_by_pipe`), never model context. A `state: "running"` result is a produced verdict ("no result *yet*" is an answer): `status: "ok"` with the retry hint. On `failed`, the summary says why the run failed, what to do, whether running it again can help and what to give support (see "A failed run says why" above), and states plainly that no graph exists for failed runs.

**A completed result reports what the run stored, and fetches none of it.** A run that produced an image, a PDF or a document carries it in `main_stuff` as content with a `pipelex-storage://` reference in `url` beside a presigned `public_url` that expires within the hour. The results summary is the moment the agent decides what to do with that, so the projection walks the **full** output (not the bounded copy — a reference pruned out of the model-facing copy is still a real file) and reports two things:

- **`structuredContent.image_candidates`**: the bare `pipelex-storage://` reference of each stored file whose storage key passes an extension prefilter (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, or no extension at all — the runtime does store extensionless keys, and only a fetched content type can settle those). The member is **absent**, not empty, when the output references no stored file, so a consumer can tell "nothing was produced" from "nothing looked like an image". The walk is `collectArtifacts` plus a string test: no link is resolved and no byte is read. It is a **shortlist, never a verdict** — the content type at fetch time is what decides, which is the image tool's job.
  **Bounded, and bare.** "Nothing reaches the model but a handful of short strings" was the intent and nothing enforced it: the walk reads the **full** output deliberately, so a method emitting a large `Image[]` put an arbitrarily long list into model-facing `structuredContent` — outside the `MAIN_STUFF_CAP` discipline the output beside it obeys, and capable of exceeding it several times over. So the list is capped at `MAX_IMAGE_CANDIDATE_ENTRIES` (32) and the remainder counted in **`image_candidates_omitted`**, absent when nothing was left out. The cap is a **prefix**, so an index into this list means to the image tool exactly what it means here, and that tool still walks the whole set — an omitted picture is reached by naming its reference. Entries are bare strings rather than `{ uri, key }` pairs: the key was a fixed-prefix strip of the reference beside it, so it doubled the list's cost and told a consumer nothing the reference did not. A reference the output names more than once is one candidate, deduplicated at the walk — otherwise the same picture would be fetched twice, billed twice and given two positions.
- **One merged sentence in the prose**: how many stored files there are, how many look like images, the image tool (`mthds_show_images`) to see one (with the standing warning that a shown picture stays in the conversation), and `mthds_download_artifacts` to save the run, the output as `main_stuff.json` and the full files beside it, with the `public_url` expiry stated.

**Every completed result says how to keep it.** When the output references no stored file, the summary still ends with one sentence naming `mthds_download_artifacts` as the way to keep the output on disk, verbatim as `main_stuff.json`, and telling the model never to retype it into a file itself. That is the failure it answers: in the proof lab of 2026-09-24 a model asked for the results as files rewrote each output with its own file tool, which costs output tokens in proportion to the result and can alter it silently.

**The results tool returns no image content block, and takes no flag that would make it.** That is a decision, not an omission — see Image Display Scope.

**Bounding `main_stuff`**: an output can be huge. The structured copy (and the fenced summary block) is bounded to a serialized cap (~32KB, tunable constant): JSON trees are pruned deterministically (deepest levels and longest collections first, with an ellipsis marker); plain text keeps head+tail. When bounded, `truncated: true` and the summary says the output was cut. The full output always rides `_meta`. The same sentence names `mthds_download_artifacts` as the way to read the rest: it writes the whole output to disk as `main_stuff.json`, where the agent reads it with its own file tools, so a cut output is never the last word.

**Run usage & cost**: on a `completed` result, `structuredContent.usage` carries **run-level** token and cost totals over the SDK's `RunResults.tokens_usages` — the per-inference-call record list (token counts by category, server-computed USD `cost`, and the `pipe_code` that made the call). The arithmetic is the SDK's: `usage` is a **projection of `summarizeUsage`** (`@pipelex/sdk`), which folds the list and its `usage_assembly_error` into one null-aware reading, and this server adds no totals of its own. The projection keeps this tool's established field names — the SDK's `total_cost_usd` is `cost_usd` here, and its separate `input` / `output` token totals are added into the one `tokens` figure the model has always been given. It is a small, fixed-shape totals object; there is deliberately **no per-pipe breakdown in the model-facing usage** (the agent gets the run's bottom line, not a table). The per-pipe rollup and the **full** per-call `tokens_usages` list ride the `_meta` channel (`_meta.usage_by_pipe`, `_meta.tokens_usages`) — never model context, exactly like `main_stuff` — where a future detailed-cost tool/view can read them. Usage is also **never rendered into the `content` prose**: the totals live only in `structuredContent.usage`.

```ts
usage: {
  state: "records" | "no_inference" | "unavailable";  // the SDK summary's state — read it first
  cost_usd: number | null;      // the SDK's total_cost_usd: Σ priced calls' cost; null under "records" when NO call was priced (own-GPU/mock/dry-run), 0 under "no_inference", null under "unavailable"
  cost_partial?: boolean;       // present (true) only when some calls were priced and some not — cost_usd is a lower bound
  tokens: number | null;        // the SDK's input total + its output total; null only when both are null. input_cached / output_reasoning are documented subsets and never counted
  calls: number;                // number of inference calls (0 outside "records")
  assembly_error: string | null; // the SDK's usage_assembly_error; non-null only when usage assembly broke for this run
}
```

`usage` is present on **every** completed result, and `state` says which of the SDK's three readings it is. `records`: `tokens_usages` is a non-empty list and the totals are folded from it. `no_inference`: the list is `[]` (assembly ran, no inference happened), so `cost_usd` is `0`, `tokens` is `0` and `calls` is `0`. `unavailable`: the list is null or absent, so the totals are null — and `assembly_error` is the only thing that says why, being non-null when assembly broke and null when usage was off or the run predates the artifact (all three leave the list null, so nothing else can tell them apart). Cost is null-aware: a `null` per-call `cost` means the model had no rate table (own-GPU/mock/dry-run) and `0` means it was priced at zero, so a `records` total of `null` ("no priced call") is deliberately distinct from `0` ("no inference"), and `cost_partial` flags a mix. The per-pipe rollup on `_meta.usage_by_pipe` is the SDK summary's `by_pipe`, projected row by row onto `{ pipe_code, cost_usd, tokens, calls }` with the same renaming and the same token figure, in the SDK's order: priced pipes by cost descending, unrated pipes after every priced one, ties broken by call count descending and then by pipe code, and the runtime-unattributed calls (a `null` `pipe_code`, one group of their own) after the named pipes when everything else ties. It is carried whenever the run reported a usage list (`[]` for `no_inference`, absent for `unavailable`), unbounded (it rides `_meta`, not the model's context), so a programmatic consumer keeps it.

Moving onto the SDK's summary changed three observable things. `usage` used to be **omitted** when the run reported no list and no assembly error; it is now present with `state: "unavailable"`, null totals and `assembly_error: null`. `assembly_error` is therefore always present, `null` where it used to be absent, and `state` is new. And on a tie in cost and calls, the unattributed (`null` `pipe_code`) group of `_meta.usage_by_pipe` used to sort **first** and now sorts **last**. The `tokens` figure is now the SDK's input and output totals added rather than a sum this server folded itself; the rule — only `input` and `output`, null when no call reported either — and therefore every value it takes are unchanged.

**Run verdict discipline**: `status: "ok"` means the API answered the question about the run — including "it failed" and "not done yet". A FAILED/CANCELLED/TIMED_OUT run is a produced verdict (`status: "ok"` with the terminal `run_status`), and so is a `state: "running"` results lookup. `status: "error"` + `errors[]` is reserved for no-verdict conditions:

- `input_domain` — empty/blank `run_id`, a blank pipe selector (`pipe_code`), no run source supplied, a blank selector, an illegal selector pairing (`files` + `method_ref`, `method_ref` + `method_id` — rejected before the wire), request-shape 400/422 at start, unknown `run_id` (a 404 on the run routes with the server's structured error envelope), unknown `method_id` (a 404 on `/v1/start`, located at `method_id`, not retryable — the hint says to check the id as the catalog returned it; the catalog is org-scoped to the caller's organization, so a method from another org reads exactly like a miss), and the `method_ref` resolution failures (parse/fetch/ambiguity 422, no-matching-package 404, either execution-locus refusal 403, a registry-form ref 501 — all at `method_ref`). The execution-locus gate also refuses a *submitted bundle* that ships `.py` on a deployment that is not sandbox-hosted, and a stored method's injected source on an id-only start, so that 403 locates at `files` or `method_id` accordingly — on a mixed start it is `files`, the executed source. On an id-only start the 400/422 arm covers two causes with one combined hint at `method_id`: the stored method may have no MTHDS source yet, and if the error mentions organization context the key's org binding is the issue (mint a key in the right org) — no message-sniffing to split them. On a mixed start (files + `method_id`) a 400/422 locates at `files` instead — the files are the executed source, so the rejection is about the submitted bundle/pipe_code/inputs, never the stored method (stored-source resolution does not run on that path).
- `config` — a missing or rejected credential (401/403 — `PIPELEX_API_KEY`), a paywall 402 (the org's plan does not cover the call — classified on the HTTP status, never the problem `code`, no location, not retryable, tagged `kind: "paywall"` so all three run headlines name the plan instead of connectivity, with a hint pointing at the org's plan/billing on app.pipelex.com; this arm is generic across routes), unreachable API, `RunLifecycleUnavailableError` (the configured base URL points at a bare runner — durable runs need the hosted API).
- `runtime` — 5xx, malformed report (e.g. a completed result missing `main_stuff`, the SDK's `MissingMainStuffError`).

The unknown-id 404 vs missing-route 404 distinction comes from the SDK: a missing lifecycle route throws `RunLifecycleUnavailableError` (`config`), while an unknown id surfaces as a plain 404 `ApiResponseError` (`input_domain`, via a per-route classification override). The same holds for an unknown `method_id` on `/v1/start`: any `ApiResponseError` 404 that reaches classification there is the platform's structured unknown-method envelope (a bare runner's missing-route 404 was already intercepted as `RunLifecycleUnavailableError`), so the `notFound` override at `method_id` is safe — and the same interception makes the `method_ref` `notFound` override safe on an address-shaped start (a 404 there is the runner's no-matching-package refusal). The classify options follow the executed source, in four shapes: an address request gets the by-ref texture (400/422, 404, and 501 all at `method_ref`); an id-only request gets the full by-id texture (400/422 and 404 both at `method_id`); a mixed request (files + `method_id`) keeps the files 400/422 texture but retains the by-id unknown-method 404 at `method_id` (a 404 there is about the linkage id, the one field the files cannot explain); a files-only request keeps today's options so nothing regresses.

An unknown `run_id` on the status, results and image tools has a hint of its own: it says to check the id and that `PIPELEX_BASE_URL` points at the deployment that started the run.

Every `errors[]` entry also carries `retryable` — whether retrying the same call may succeed. A `429` (the API limiting requests) and a `408` (a request timed out on its way in) are retryable `runtime`, since they refuse a call for its timing rather than its content. It is the SDK's verdict on the error (see Verdicts and errors), because the class+locator pair alone cannot carry it: an unreachable API (transient) and a missing run lifecycle (permanent) both classify as `config` at `PIPELEX_BASE_URL`, and a 5xx (transient) and a malformed report (permanent) are both `runtime`.

**A start that may have reached the server is not retryable.** A start creates a durable run that spends inference credit, and the hosted `/v1/start` honours an `Idempotency-Key` that `@pipelex/sdk` cannot send yet, so a start retried after a lost acknowledgement starts a second run. `classifyStartError` therefore marks as not retryable, on `mthds_run`, every failure after which the run may exist: the SDK's own timeout, a connection lost after the request went out (an unreachable-API error whose network code is not one of the refused-before-sending codes, or that carries none), a `502`, `504` or `408`, where something in front of the runner answered for a request it may have accepted, a `500`, which the platform relays from the runner when its start call failed (since pipelex-server#145, a `502` before) and which can arrive after Temporal has already recorded the start, and a `2xx` the SDK could not read, a start the server accepted whose acknowledgement was lost. That reading is decided by the failure alone, never by the SDK's `retryable`: the runner's catch-all `500` states `retryable: false` whatever it interrupted, a start included. A `429` is the gateway refusing the request before it runs, so it keeps the SDK's verdict, retryable. Its hint says the run may have started and to check before starting it again, and its headline opens "Run may have started" rather than saying the run could not start (a host may show the agent that line alone). A connection refused before anything was sent, and every other `5xx` from `/v1/start` (a `503` above all), keep the SDK's verdict, which is retryable; a `500` from any other route keeps the SDK's verdict too. When the SDK can send the key, these failures become retryable and this paragraph goes.

**Start-time rejection on the hosted API**: `/v1/start` reports runner-rejected submissions — an invalid bundle, missing required inputs — as a 422 carrying the real rejection reason (`input_domain`); earlier platform builds answered a generic 503 "Failed to start pipeline". The per-route 5xx hint is kept for any 503 that still occurs, pointing the agent at `mthds_validate` / `mthds_inputs_template` before blaming the platform, and the `mthds_run` tool description still nudges validating first — validation gives a structured, repairable verdict, where a start-time rejection only reports the failure.

### Image Display Scope (`mthds_show_images`)

The image tool, `mthds_show_images`, puts the pictures a completed run produced in front of the model, as MCP **image content blocks**. It is the deliberate counterpart to the results tool's free inventory: the results tool says what is there and fetches nothing, and this one fetches and shows. It is a plain tool — no view, no `_meta` channel, no `available_view_specs`.

**Why a tool and not a flag, and why the results tool never inlines.** An image block is cheap to send and **permanent to keep**. The host probe behind this feature (L-260920-fc66db in the workspace ledger) measured a workshop host billing an image block at the model's own native vision price — about 360 tokens for 512×512, 1,400 for 1024×1024 — with its base64 size costing nothing at all; the widely-repeated claim that base64 image data in a tool result is billed as text did not reproduce. But the same probe established the thing that decides the design: once a picture is in a conversation it is in **every prompt that follows**, and nothing takes it back. One picture is a rounding error; an agentic loop that generates twenty is twenty images of permanent context nobody chose to buy. So the cost that matters is not per-call, and no default can be safe. Seeing a picture is an act, with a name a person can say out loud, that nothing fires by accident.

The public MCP input shape is:

```ts
// input
{
  run_id: string;        // the durable run id from the start tool
  images?: string[];     // OPTIONAL selection: pipelex-storage:// references from image_candidates
  indices?: number[];    // OPTIONAL selection: zero-based positions in image_candidates
}
```

`images` and `indices` are mutually exclusive (both supplied is an `input_domain` no-verdict at `images`), and an empty array on either is refused rather than read as "all". Omitting both shows every candidate, up to the per-call attempt cap.

```ts
// structuredContent
{
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";   // the same reading the results tool reports
  retry_after_seconds?: number | null;          // state=running only
  run_status?: RunStatus;                       // state=failed only
  failure_message?: string;                     // state=failed only
  failure?: RunFailure;                         // state=failed only, when the run stored an error report — as on the results tool
  images?: Array<{                              // state=completed only — one entry per candidate CONSIDERED, in the order considered; bounded, see omitted
    uri: string;
    mime_type?: string;                         // the store's own content type, once the object was fetched — present on the withheld arm too
    bytes?: number;                             // once measured
    inlined: boolean;                           // true ⟺ this picture is one of the image blocks in content
    withheld?: "size" | "budget" | "count" | "type" | "deadline" | "empty";
    error?: ToolError;                          // this picture could not be read at all
  }>;
  omitted?: number;                             // state=completed only, and only when something was left out — THIS LISTING's truncation, not the run's surplus
  all_inlined?: boolean;                        // state=completed only; about the RUN, so false when a narrowed call left a candidate unconsidered; vacuously true for an empty walk
  errors?: ToolError[];
}
```

**A machine consumer branches on `images[i].inlined`, never on the presence of a block.** A not-inlined entry always says why: `withheld` names the cap or the gate that stopped it, and `error` carries a per-reference failure as a value. Leaving "no error" to mean both "too big" and "not an image" would be a contract a consumer cannot act on, which is why the vocabulary is closed and exhaustive.

**The order is the order considered, not discovery order.** A selection is answered in the caller's own order — that is what makes `indices: [3, 0]` mean something — and only an absent selection walks in discovery order. The entries and the image blocks follow the same order as each other either way.

**`images` is bounded exactly as the inventory is**, at `MAX_IMAGE_CANDIDATE_ENTRIES`, with the remainder in `omitted` (absent when nothing was left out) and one prose line rather than one entry each. One entry per candidate was itself unbounded output: a run holding hundreds of pictures produced hundreds of `withheld: "count"` entries, and a prose line for each, from a call that fetches six.

**`omitted` counts this listing's truncation, and `all_inlined` answers for the run — they are about different sets, and conflating them was a defect in both.** `omitted` is what the candidates *this call considered* lost to the cap, so it equals the run's own surplus only when the call considered the whole run; a hundred-candidate run with forty named reports `omitted: 8`, not 60. Its guidance is `indices` and not `images`: the references past the cap are exactly the ones nothing enumerates — the results tool truncates at the same 32 and a large run's `main_stuff` is pruned — so there is no reference to name, while `indices` is positional over the run's **full** candidate list, which the selection never caps, and always reaches them. `all_inlined` answers "is everything this run produced now in front of me", so **every** way a candidate can fail to be in front of the caller counts against it: withheld, failed, past the listing's cap, and — the one the walk could not see, since it is handed only the selection — never selected at all. A narrowed call therefore reports `false` whenever the run holds a picture it did not ask for, even where everything it asked for arrived.

**A repeated selection is deduplicated, not refused.** Naming the same picture twice is a plausible slip and refusing the whole call over it helps nobody; obeying it literally is worse than either, since a shown picture is permanent context — a duplicate would spend two of the six attempts, two shares of the byte budget, and put the same picture in every later prompt twice.

**The walk.** Read the run through the results route first, so a `running`, `failed` or candidate-free run is a produced verdict that fetches nothing. Then `collectArtifacts` over the full `main_stuff`, the same key prefilter `image_candidates` uses, and the caller's selection intersected with what the run actually produced — an unknown reference or an out-of-range index is an `input_domain` no-verdict at `images` / `indices`, refused before any network call rather than fetched and reported as missing. Each surviving candidate is then fetched through the SDK's own bounded `fetchArtifact` (fresh presigned link, `redirect: "manual"`, no credentials forwarded, the byte cap checked from `Content-Length` before a byte is read and again per chunk), with the plain-http rule the download tool derives (see Artifact Download Scope) and a 30-second per-image budget.

**The walk carries its own deadline, because a per-image timeout is per image.** The walk is sequential, so six stalled objects accumulated their timeouts into a call of three minutes and more, and a host whose deadline is shorter then failed the *whole* call, losing the pictures that had already arrived along with the reasons for the ones that had not. So `INLINE_IMAGES_DEADLINE_MS` (60s) bounds the walk: a candidate reached with none of it left is `withheld: "deadline"` without being attempted, and partial results always come back.

**It is applied two ways, and the second is the one that is easy to miss.** A per-fetch `timeoutMs` alone does not bound the walk end to end: the SDK resolves the storage reference *before* arming that timer, and the resolve runs under a fixed 30-second budget of its own that only an `AbortSignal` reaches. So a candidate started with 30s left could spend 30s resolving and then a full 30s fetching — **90s of walk against this 60s**, and about 120s of tool call once the run lookup ahead of it is counted, which is squarely inside the range of host deadlines the bound exists to stay under. Each fetch is therefore given both: whichever timeout is smaller, its own or the time left, **and** a signal for the time left. Because the SDK re-throws a caller's abort untouched, this tool's own deadline arrives as a raw `DOMException` rather than an `ArtifactFetchError`, so both catch sites recognise their own abort and withhold with `deadline` — left to the whole-request arm it would report the tool's own time budget as a failure of the request, and as a no-verdict when nothing had yet been inlined.

**A zero-byte object is withheld, not emitted.** Every gate clears for nothing — the declared type is an image type and no cap can be crossed by no bytes — so the block came out as `data: ""`, reported as a picture successfully shown. Hosts and model APIs refuse an empty image, and an image block is permanent, so one that can never render would sit in every later prompt rather than failing once. It is reachable rather than theoretical: nothing between an upload and a stored object enforces a minimum length (`/v1/upload` declares a maximum only, the SDK derives the content type from the filename, and the storage interface stores what it is handed), so a zero-byte `empty.png` prepared as an input and echoed by a run is enough. `withheld: "empty"` says so in the vocabulary a caller already branches on.

**The content-type gate is the store's answer, not the route's guess.** `ResolvedArtifact.content_type` is documented by the SDK as the platform's guess from the reference's *extension*; the object store's own `content-type` header is what the runtime stored with the object. So the gate reads the fetched response's header, accepts exactly `image/png`, `image/jpeg`, `image/gif` and `image/webp`, and cancels the body of anything else unread (`withheld: "type"`, with `mime_type` saying what it actually was). **No SVG**: it is not a model-accepted image type, and it is a script-bearing document in a renderer.

**The caps, and what each one is measuring.** Three named constants, all in `capabilities/shared.ts` with the probe's provenance in their comments:

| Constant | Value | What it bounds, and why that number |
| --- | --- | --- |
| `MAX_INLINE_IMAGE_BYTES` | 4 MiB | One picture. **Not a cost control** — bytes are free and pixels are billed. It is a transport guard (Claude Code's stdio transport carried an 8 MiB PNG and died on a 12 MiB one with `Connection closed`, taking the tool call with it) and a point of diminishing returns (above roughly a megabyte every host measured re-encodes the image anyway). |
| `INLINE_IMAGES_BUDGET` | 6 MiB | One call's total, so a whole tool result stays well under the message size that killed the 12 MiB rung. |
| `MAX_INLINE_IMAGES` | 6 | **Attempts**, not successes — one call makes at most this many network exchanges whatever the run produced, and buys at most this much permanent context. |

The walk stops *attempting* at the count, stops *inlining* at the first picture that does not fit the per-image cap or the remaining budget, and keeps walking to report the rest — a smaller sibling later in the list still gets its chance. Oversize means withheld and named, **never resized**: an image library in `dependencies` is install weight every `npx @pipelex/mcp` user pays on every session, and `mthds_download_artifacts` already brings the full file to disk.

**The emitted block, and the one thing that must not change.** Each inlined picture is `{ type: "image", data, mimeType, _meta: { uri } }`, appended to `content` after the text block so a host that renders in order shows the summary and then the pictures. `_meta.uri` is the storage reference, so a programmatic consumer can correlate a block with the `main_stuff` value it came from; `_meta` never reaches the model, so it costs the conversation nothing.

**No `annotations`, ever.** The MCP standard's optional `annotations` hint (audience, priority) looks harmless and is not: the host probe found that **Codex refuses an annotated image block outright**, with an opaque `tool call error … Unexpected response type`, against a control proving the identical block without them is accepted and the picture reaches the model. Shipping with annotations would have broken the whole feature on one of three named workshop hosts, diagnosable only from production. A unit test asserts that no emitted block carries the key.

**And the `_meta` the block does carry is measured, not assumed.** `_meta` is an optional field the standard permits on an image block — and so was `annotations`, so nothing about the first followed from the second. The probe's original variants (`full`, `bare`, `text`) never sent a block-level `_meta`, which left the shape this server actually ships untested on every host. A fourth variant, `meta`, closes that: run against codex-cli 0.153.4 it was **accepted**, and the model described the picture correctly, so the shipped block is measured on the host that refused the other optional field. Keep the variant — the next host, or the next version of this one, is measured the same way.

**Verdict discipline, and where a whole-request refusal falls.** Once the walk has run the result is produced (`status: "ok"`, `state: "completed"`), discriminated on `all_inlined`. Partial success is a produced verdict: pictures that arrived are never discarded because a sibling failed, and a whole-request refusal part-way through (the resolve route rejecting the credential, say) lands on the entry being worked, stops the walk, and reports the untouched rest as `withheld: "count"`. `status: "error"` keeps its usual meaning — a bad request shape, an unreachable or misconfigured API, a malformed report.

**Those two sentences used to contradict each other, and the tie is broken on whether anything was shown.** A whole-request refusal is not about any one picture, so when it stopped the walk before **any** picture arrived there is no partial answer to report: nothing was produced, which is precisely what `status: "error"` means here. Answering `status: "ok"` there told a consumer the call had succeeded on a deployment where every call fails deterministically — a 402 plan limit, a 403, a 404 from a runner with no bulk-resolve route, an unreachable host — and it buried the classified cause, the `paywall` headline above all, under a generic "no picture could be shown" line. It also diverged from `mthds_download_artifacts`, which answers `status: "error"` for the identical class. So: **a whole-request refusal that showed nothing is a no-verdict**, carrying the classified `ToolError` and its headline; once one picture has arrived, partial success is a produced verdict as described above and the refusal rides its own entry.

**The summary** names how many pictures follow and that they are now part of the conversation, lists any withheld candidate under `## Withheld` with its reason or its error (the `mthds_codegen` pattern), and reminds the caller the full files can be saved. A completed run with no candidate at all is one sentence and no blocks.

### Server instructions and the text budget

**Server instructions**: The workshop sets a short MCP `instructions` string that hosts surface to the model. It is the map, not the manual, and it is front-loaded, because a host that cuts keeps the head: it opens with what the server is for and the order of the steps, states the ways to name a method once, and ends with the rules that hold everywhere — a run spends inference credit, and a picture the image tool returns stays in the conversation for every turn that follows, so it is shown when someone wants to look at it rather than by reflex. The instructions embed no catalog, because a host may cache instructions. They tell the model to use its `mthds_*` tools for all method work when the connector's `pipelex_*` tools are also present, and never to mix the two servers (see The workshop and the Pipelex connector). Right after the flow, they say where a method stops, in one sentence: a method only turns the inputs it is given into results, and fetching from mail, drives or business systems, running on a schedule and writing back are up to whatever calls it. The instructions are the one text an agent reads without calling a tool or loading a skill, so this is where a model that goes straight to the tools learns that "read my mail every morning and post the digest" is a method plus the read, the schedule and the post around it. Concretely, they open with "This is the Pipelex plugin's local workshop…", give the flow — `mthds_list_methods`, `mthds_validate`, `mthds_inputs_template`, `mthds_prepare_inputs`, `mthds_run`, the status and results tools, then `mthds_show_images` or `mthds_download_artifacts` — name `mthds_codegen`, the catalog pair and `mthds_models`, state the three ways to name a method once for every method-taking tool, prefer the `{ path }` file form, prompt a catalog search reactively only, and say there are no views.

**The selector sentence names every method-taking tool and every selector it takes**, because a sentence that named `method_id` and omitted `method_ref` told the model a published method could not be validated, templated, prepared or run — so the by-address flow was never offered, however fully the tools supported it. The workshop's contract test holds that, and holds that the step order is complete, in order, near the head of the text. Everything per-tool stays out: when to call a tool, and the contract rules needed before calling it (which forms may be combined, what an absent `method_id` means to a save), live in the tool `description`; parameter detail, such as the address grammar, lives in the field descriptions.

**Text budget**: The workshop's `instructions` and every tool `description` are held to 1,800 Unicode code points, measured on what the server emits by `npm run check:tool-texts`, which `make check` and CI run. Claude Code cuts each of those texts at 2,048 characters, so a text over the cap reaches the model with its tail missing; the ceiling leaves room for one added sentence and a margin for hosts whose cap has not been measured. A fact goes in the last layer that still reaches the model when it needs it: the instructions carry the map (what the server is for, the three ways to name a method, the order of the steps, the rules that apply everywhere), a tool description says when to call that tool and states the contract rules needed before calling it, a field description carries parameter detail, and a result summary carries what matters only after the call.

### The files union and the path trust boundaries

Every files-taking tool (`mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`, `mthds_run`) takes `files` as one per-item union, inline content or a file path:

```ts
type SubmittedFileInput = { content: string; uri?: string | null } | { path: string };
```

- The **workshop resolves `{ path }` from disk** before invoking the capability — this is its headline feature: near-constant token cost, byte-accurate reads, and real provenance (the resolved item carries `uri` = the submitted path, so diagnostics locate to files the agent can open and edit). Inline `{ content, uri? }` items stay accepted, for a bundle the agent holds only in the conversation.

An item is one arm or the other; on a malformed item carrying both keys, `content` wins (first-match union semantics) and `path` is ignored.

A `{ path }` item is resolved by the resolution seam, not by the schema: each capability's context carries an optional file resolver, which the workshop sets, and the resolution runs ahead of the request-shape checks, which therefore see only resolved `{ content, uri? }` items. A context built without a resolver rejects every `{ path }` item as `input_domain` at `files[i].path`; the workshop never builds one.

**Path trust boundary (read side).** `{ path }` values resolve relative to the server's working directory — the host spawns the server in the workspace. Three bounds apply. **What** it reads: each `{ path }` arm is contracted to ONE extension — `.mthds` for every bundle argument, `.py` for `mthds_save_method`'s `python` — and the resolver rejects any other extension (case-insensitive) *before touching the filesystem*, so it never opens a `.env`, `.git/config`, or key file a prompt-injected path could point at. **Which directory** it reads from: every `{ path }` item must sit at or under the directory of the bundle's **first `{ path }` item**, checked before the read rather than after naming, and checked on REAL paths — the item's resolved target must live under the resolved bundle directory. A lexical comparison of the submitted strings is not this gate: it accepts `bundle/helpers.py` whatever that name points at, while the resolver follows symlinks and contains only against the workspace, so `bundle/helpers.py -> ../.env` passed the directory gate, passed the extension gate (which reads the submitted NAME, not the resolved target), and uploaded the workspace's secrets to the organization's catalog as the method's Python — where nothing validates them and no delete from this tool reaches them. Both comparisons are kept: the lexical one words the ordinary mistake in the caller's own path, the real-path one is the boundary. The distinction between that directory and the one a file is *named* relative to is load-bearing: a name may come from an inline item's `uri`, which is provenance and may be any label, but a read boundary taken from a label is a boundary the caller chooses — and `.py` files are uploaded to the organization's catalog, so it would publish whatever directory the caller named. A bundle submitted inline therefore establishes no directory at all, and a `{ path }` item beside one is refused rather than read. **Where** it reads: containment is enforced by real-path check — the resolved target (symlinks followed) must live inside the working-directory subtree. Non-`.mthds` paths, escapes, missing files, and non-regular files are `input_domain` errors located at `files[i].path`. MCP client roots are deliberately not consulted in this increment — cwd containment is the simple, correct core; honoring host-declared roots is a possible later widening.

All three gates are checked on the *submitted* items, before any read, which is what closes the prompt-injection vector: an injected request is the only thing that threat controls, and it can choose neither the kind of file, nor the directory it is read from, nor a target outside the workspace. The extension gate alone did not close it once `.py` joined `.mthds` — `.py` is a common home for credentials, and the read boundary used to be derived from the first file's label, which an inline item supplies freely, so an injected call could declare any directory the bundle root and have its `.py` files published to the catalog. Two residuals require a local process with **write** access to the workspace and are accepted, not mitigated, in this increment: (a) a symlink inside the bundle pointing at another file inside that same bundle whose extension does not match the arm's, and (b) a TOCTOU symlink swap between the real-path check and the read. Note (a) is what remains AFTER the bundle boundary became a real-path check; while it was lexical the residual was far wider than this — any file in the workspace, which is the leak described above. Both demand an attacker who already holds direct read access to those same files (and stronger primitives, e.g. planting a malicious `.mthds`), so the resolver's fail-value contract gains nothing from an fd-based read-after-verify here.

**Path trust boundary (write side).** The tools that write into the user's workspace — `mthds_download_artifacts` saves a run, `mthds_codegen` writes a generated tree under `output_dir`, the catalog pair pulls a method's sources and leaves a link file, `mthds_validate` writes the method graph page beside the files it read — share one containment routine, on real paths, enforced on both sides of the one `mkdir`. A lexical check refuses `..` escapes and absolute paths before the filesystem is touched; then the deepest *existing* ancestor of the target directory is real-path-checked **before** `mkdir`, so a symlink inside the workspace pointing outside cannot have directories created at its target; then the created directory is real-path-checked again, which closes the window between the two. Refusals are `input_domain` at the caller's own field (`dir`, `output_dir`). Containment is also available *without* creation, which is what lets a writer contain every destination before deciding whether to write any of them.

**What the writers do NOT share is policy, and they must not.** `mthds_download_artifacts` never overwrites — neither the `main_stuff.json` it writes itself nor the files the SDK downloads beside it — because a collision there means two different files. `mthds_codegen` must overwrite its own previous output and only that, because its paths come from the engine and the lock hashes them. The method graph page takes codegen's side, for the same reason: it is regenerated on every validation and must land on the same name. One shared "write a file" helper would either suffix a regeneration or let a download clobber. Each scope states its own policy; the boundary above is all that is common.

### Model Deck Scope (`mthds_models`)

`mthds_models` reads the model deck, the model references a method's pipes can name in their `model` field, through `@pipelex/sdk`'s `models()` (`GET /v1/models`, the MTHDS Protocol's `ModelDeck`), and either lists it or checks one reference against it. It is read-only, has no view and no `_meta`, and spends no inference credit. It replaces what the CLI era's `mthds-agent models` and `mthds-agent check-model` gave an authoring agent, which the CLI-free plugin reaches only through this server.

The public MCP input is:

```ts
{
  category?: "llm" | "extract" | "img_gen" | "search" | "judgment"; // for a PipeLLM, PipeExtract, PipeImgGen, PipeSearch, PipeJudge
  reference?: string; // $preset, @alias, ~waterfall, a bare handle, or a preset:/alias:/waterfall:/handle: prefix; at most 199 characters
}
```

Without `reference` the tool lists the deck; with it, it checks that reference. **The `category` filter is closed and what the tool reads is open.** The filter takes the protocol's categories and nothing else, since a runner refuses any other value on `?type=`: its enum is `mthds`'s `MODEL_CATEGORIES`, and the table of the pipe type that names each category is total over it, so a category the protocol gains or drops fails this repository's build until the tool is taught to describe it. The deck it reads is held to the protocol's reader rule, "A client reading a model list MUST NOT fail it because an entry carries a category it does not recognize; it keeps that entry with its raw value or leaves it out.", and the tool keeps it: a category of the deck it does not know, which a runner of a later protocol may report, is listed and checked under the runner's own name.

**What the deck holds.** On the Pipelex runner, the protocol's flat `models` list carries the presets, each stamped with its category, and two extensions keyed by category carry the rest: `aliases` (an alias's name to its model handle) and `waterfalls` (a waterfall's name to the handles it tries in order). The same alias name can exist in several categories pointing at different models, which is why the extensions are keyed by category and why the tool answers per category. **The deck lists no model handle as such**: a handle appears only as an alias's target or a waterfall's step.

**Listing.** A listing asks the route for the category when one is given, and projects one entry per category in scope: the protocol's, in its order, each present even when it is empty, then, when no category was named, each category the tool does not know that holds a preset, an alias or a waterfall, in the order the deck first names it:

```ts
{
  status: "ok";
  category?: ModelCategory;
  deck: Array<{
    category: string; // a ModelCategory, or a category the tool does not know under the runner's name
    presets: string[];
    aliases: Array<{ reference: string; target: string }>;
    waterfalls: Array<{ reference: string; fallbacks: string[] }>;
  }>;
}
```

Every reference is written as it is typed in a method (`$writing-factual`, `@best-gpt`, `~robust-llm`), in the runner's order. The summary repeats the deck by category, names each category's pipe type or says that the tool does not know the category, says what each kind of reference is for and that presets are the ones to prefer, and ends with how to check a reference.

**Checking.** A check parses the reference as the runner does (`ModelReference.parse`): a sigil, else a spelled-out namespace, else a bare handle. A blank reference, a sigil or namespace with nothing after it, and a reference longer than 199 characters are `input_domain` at `reference`, refused before any call, and the summary names which of the faults it was. The bound refuses nothing a method could name, since no model name comes near it, and it bounds the work of the nearest-name match, which grows with the reference's length. The check then reads the **whole** deck, whatever the category, so that a reference missing from the category asked about can still be placed in the one that holds it, and answers:

```ts
{
  status: "ok";
  category?: ModelCategory;
  reference: string; // the caller's, trimmed
  kind: "preset" | "alias" | "waterfall" | "handle";
  resolution: "resolved" | "not_found" | "unconfirmed";
  matches: Array<{ category: string; target?: string; fallbacks?: string[]; via?: string[] }>;
  suggestions: string[];
  other_kinds: string[];
  other_categories: string[];
}
```

- `resolved`: the reference names something in the categories checked. `matches` says where, with an alias's model, a waterfall's steps, or, for a handle, the aliases and waterfalls that name it.
- `not_found`: a preset, alias or waterfall the deck does not hold. This is definitive, since the deck lists every one of them.
- `unconfirmed`: a bare handle that no alias or waterfall names. The deck cannot settle it either way, so the tool never calls a handle `not_found`. Validation checks a handle against the runner's full model list, and the summary says so.

On `not_found` and `unconfirmed`, `suggestions` holds the nearest names, up to five of the same kind and then up to three of each other kind; `other_kinds` holds the same name under another sigil (`best-claude` exists as `@best-claude`); and, when a category was named, `other_categories` holds the categories where the same reference resolves (`$gen-image` checked as `llm` resolves in `img_gen`). All three are empty on `resolved`. The nearest names are difflib's `get_close_matches` at the runner's own cutoffs (0.5 within the kind, 0.7 across kinds), ported and held to Python's output, including the order of a tie. For a preset, alias or waterfall checked with a category, they are the names a failed validation of the same reference suggests. They can differ in two cases: a handle's candidates are only the handles the deck names, as alias targets and waterfall steps, where the runner draws on every model of the pipe's type, and a check without a category draws on every category, where validation checks within the pipe's own. The summary puts the wrong sigil first, since it is the likeliest fault.

**The deck is not the account.** The deck is what the runner can route to, not what the caller's account may use: a gateway can refuse a listed model when a run starts, after validation has passed. The tool description and every summary say so. An account-level check belongs to hosted validation, not to this tool.

**Malformed and failed reads.** What arrives is checked rather than trusted. A deck that is not an object, a missing `models` list, an entry without a name, a category that is present but is not a non-blank string, and an extension that is present but shaped wrong are a non-retryable `runtime` no-verdict. An entry whose category is absent or null is skipped, since it has no category to be listed under, an unknown category is kept as described above, and an absent extension reads as empty, since `aliases` and `waterfalls` are the runner's rather than the protocol's. A 400 or 422 is classified by status, since the two come from two layers: a 422 is the runner refusing the category, `input_domain` at `category`, which happens when the runner implements an older protocol than the one that defined the category (a runner before protocol 0.7.0 refuses `judgment`), and the hint says so rather than offering the refused value back; a 400 is the platform's missing active organization, `config` at the credential, whether or not a category was sent. The route takes a user credential alone today, so the second is not expected, but a valid category must never take the blame for it. An unreachable API, a refused credential, a paywall, a missing route and a server fault take the shared arms.

### Validation Scope (`mthds_validate`)

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[]; // { content, uri? } | { path } — see The files union
  method_ref?: string;          // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;           // catalog id (mt_…) of a registered method
  graph_page?: boolean;         // default true — write method-graph.html beside { path } files (see The method graph page)
}
```

Exactly one of (non-empty `files`, `method_ref`, `method_id`) is required — the tooling rule from Method Selectors: no selector is `input_domain` at `files`, a second selector is `input_domain` at the fixed field for its pair (`method_ref` beside files, `method_id` beside either of the others), and a supplied-but-blank selector is `input_domain` at that selector. Both selector forms are **server pass-throughs** carried on `POST /v1/validate` itself via `@pipelex/sdk`'s `validate({ method_ref })` / `validate({ method_id })`: the runner resolves an address through the same fetch path as a `method_ref` run, the hosted platform resolves an id against the org's catalog and injects the stored source before the runner sees the request. Nothing is expanded client-side, and diagnostics get their source labels from the package's (or the stored method's) real file names rather than an MCP-side `uri` relabel. Selector-resolution failures are no-verdict errors per Method Selectors, located at the selector: an unknown/foreign-org id or no package at the address (404), a ref that does not parse or fetch (422), either execution-locus refusal (403, at `method_ref`), a registry-form ref (501); a paywall stays the generic 402 `config` arm (`kind: "paywall"`). A credential is required for by-id calls.

The result carries no graph and none of the form's artifacts, because the workshop registers no views: those are view-only data.

The capability always permits pending signatures, always requests rendered markdown, and always requests the `input_form` and `output_form` views from the Pipelex API, the second being what feeds `main_pipe.output.images`.

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  available_view_specs: Array<"dry_run_graph" | "input_form">;  // always [] on the workshop
  main_pipe?: MainPipeSignature;   // present on every valid verdict with an effective entry pipe — see The main pipe's signature
  graph_page?: {                   // present when every file came as { path } and graph_page was not false
    path: string;                  // where the page is, or would have been, relative to the working directory
    written: boolean;
    error?: ToolError;             // why it was not written — never a change to the verdict
  };
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

The MCP `content` text is the API's rendered Markdown, which is not duplicated in `structuredContent`, with the signature line appended under its own heading when `main_pipe` was produced, and a `## Method graph` section last when the page was written or tried, after any error details.

#### The method graph page (`graph_page`)

A builder in a host that renders no views never saw the method's flowchart; the `pipelex` CLI used to give one as a local HTML file, and the CLI-free plugin had lost it. So when every item of `files` is a `{ path }`, `mthds_validate` also writes `method-graph.html` into the directory holding them — the deepest directory holding them all, when they span several, each file then named by its path relative to it — and reports it as `graph_page`.

- **What the page is.** A standalone HTML file that embeds the method's `.mthds` files, exactly as validated, in the `mthds-sources` element `@pipelex/mthds-ui`'s standalone viewer reads, and loads that viewer and elkjs from jsDelivr, each pinned by exact version and by Subresource Integrity with `crossorigin="anonymous"`. The viewer builds the static graph in the browser, the way a Mermaid page carries its diagram's text and loads the renderer. So the page opens from disk with no server and no Pipelex install, costs no API call to draw, and draws a method that does not validate as well, with the notes reading its source turned up on the viewer's toolbar. It needs a network connection: offline, or when a CDN file fails its integrity check, it shows a line saying so. Every `<` in the embedded text is written `\u003c`, so no method text can close the element or change how the page parses. The embed is written by mthds-ui's own `serializeMthdsSourcesEmbed`, from the release this repository installs, and the page loads the viewer of that same release, so the writer and the reader of the element cannot drift apart; the build inlines the serializer, so the published package gains no dependency.
- **When it is written.** On every call whose files all came as `{ path }`, whatever the verdict and even when the API produced none, since the page draws from the files and not from the report; so it never shows an older version of the method than the one on disk last validated. Nothing is written for inline `{ content }` files, a mix of the two arms, `method_ref`, `method_id`, a request refused before the API call, or `graph_page: false`. `mthds_save_method`'s validation leg writes none either: its result never reports a page.
- **How it is written.** Through the write-side boundary, on real paths, and with `mthds_codegen`'s policy: a missing page is created exclusively, and an existing one is replaced only when it carries the page's own generator mark (`<meta name="generator" content="@pipelex/mcp method-graph">`). A file without it, a symlink or a directory at that name is left untouched and reported as `graph_page.error`, `input_domain` at `graph_page`; an unwritable directory is a `runtime` error there. A page that could not be written never changes the verdict, and the call's `status` and `isError` are the validation's alone.
- **What the summary says.** Where the page is; on its first write, also that it opens in a browser, loads its viewer from the CDN, is rewritten on every validation, and is a generated file a project under version control may want to ignore.
- **Annotations.** `mthds_validate` is therefore not read-only. It stays non-destructive, because the only file it ever replaces is a page carrying its own mark, whose whole content derives from the files beside it, and because Codex asks for confirmation before every destructive call, which would put a prompt on the call a design loop makes after every edit.

### Inputs Template Scope (`mthds_inputs_template`)

`mthds_inputs_template` projects a pipe's declared inputs as a fill-in template. It reads one `POST /v1/pipe-io` through `@pipelex/sdk`'s `pipeIo()` for the one pipe, with no dry run, and projects the template client-side from that pipe's input-form descriptor. It is a plain tool: no view, no `_meta` channel, no `available_view_specs` field — the template is small structured data the model must read, so it belongs in `structuredContent`.

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[]; // { content, uri? } | { path } — see The files union
  method_ref?: string;          // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;           // catalog id (mt_…) of a registered method
  pipe_ref?: string;
  explicit?: boolean;
  format?: "json" | "toml";
}
```

- Exactly one of (non-empty `files`, `method_ref`, `method_id`) is required — the tooling rule from Method Selectors, with the same locations (no selector → `input_domain` at `files`; a second or blank selector → `input_domain` at that selector). All three are **server pass-throughs** on `POST /v1/pipe-io`: nothing is expanded or fetched client-side.
- `files` mirrors `mthds_validate`'s shape for consistency. The SDK's crate envelope spells the provenance label `source` (`MthdsFileItem`), so the capability adapts `uri` → `source` at its boundary, the way validate adapts to `/v1/validate`'s parallel arrays.
- `method_ref` projects a published method by its address: the runner fetches the package's `.mthds` files at the tag and resolves the closure, so a package that ships Python is answered here on any deployment (see the execution-locus gate above). The registry form stays a 501. Selector-resolution failures are no-verdict errors at `method_ref` per Method Selectors.
- `method_id` projects a registered method's current stored content: the hosted platform resolves the id against the key's organization and forwards the stored files, so a key is required. An unknown or foreign-org id is a 404 → `input_domain` at `method_id` (the catalog is org-scoped, so a foreign-org method reads exactly like a miss), and a stored method the platform cannot resolve into files, such as one with no MTHDS source yet, is a 422 → `input_domain` at `method_id`. A bare pipelex-api runner has no catalog and does not resolve the selector.
- `pipe_ref` is the pipe to project, as a qualified `domain.pipe_code` — the same value `mthds_run` takes as `pipe_code` (the names mirror their routes; see Naming Conventions). Optional; the route's selection chain then settles the method's entry pipe: a fetched package's manifest `main_pipe`, else the closure's single `main_pipe` declaration — the pipe `mthds_prepare_inputs` prepares and a run naming none executes. A `pipe_ref` the closure does not declare, and a method that settles no entry pipe or several, are refused by the route with a typed 422 (`EntryPipeNotFoundError`, `EntryPipeAmbiguousError`), which the tool reports as an `input_domain` no-verdict at `pipe_ref` carrying the route's reason, whatever named the method.
- `explicit` defaults to **true** (the ceremonial `{concept, content}` envelope per input — each input's declared concept ref plus its canonical content shape, which is what an agent needs to fill the template correctly); `false` requests the light template shape (bare example values). The default was flipped from `false` to `true` for agent UX (concept refs and canonical shapes by default); the light shape stays one flag away.
- `format` defaults to **"json"** (parsed template object in `inputs`); `"toml"` returns raw TOML text in `inputs_toml`, preserving concept comments and key order.

**The projection.** The route's valid arm is keyed by exactly the `pipe_ref` it resolved, and the template is projected from `input_form[pipe_ref]` by `inputsTemplateFor` (`src/capabilities/inputs-template.ts`, over `mthds/protocol`'s `projectInputsTemplate` and `renderInputsTemplate`). `explicit` and `format` are the projection's options and never travel to the route. The TOML text and the summary's JSON fence are the standard's own rendering, byte-identical with the Python twin; the `inputs` object is the same projection as plain JSON. A method with pending signatures still gets its template, since the route reports runnability without refusing and the template describes the pipe's declared inputs.

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  format?: "json" | "toml";
  explicit?: boolean;
  inputs?: Record<string, unknown>;
  inputs_toml?: string;
  validation_errors?: unknown[];
  errors?: Array<{
    class: "input_domain" | "config" | "runtime";
    kind?: "paywall";
    location?: string;
    message: string;
    hint?: string;
    retryable: boolean;
  }>;
}
```

Verdict discipline is identical to `mthds_validate`: any *produced* verdict is `status: "ok"`, discriminated on `is_valid`. On the valid arm the tool returns the resolved `pipe_ref` (always qualified), the echoed `format`/`explicit`, and the template on exactly one of `inputs` / `inputs_toml` (chosen by `format`; the unused field is absent). A closure that does not load is a produced verdict: the route's invalid arm is `is_valid: false` with the shared `validation_errors[]` and a `message`, and consumers branch on the field, never on transport. `status: "error"` + `errors[]` is reserved for no-verdict conditions: bad request shape (`input_domain`), unreachable/misconfigured API or auth failure (`config`), a refused pipe selection (API 422 → `input_domain` at `pipe_ref`), a selector-resolution failure (at the selector), a route request-shape 422 such as too many files or an oversized one (`input_domain` at `files`), a deployment that does not serve `/v1/pipe-io` (a runner's bare 404 → `config` at `PIPELEX_BASE_URL`, naming the route, whatever the selector, since the selector textures take only a 404 that names what was not found; the hosted gateway answers an unlisted path with a 403, which reads as the credential arm), a valid answer carrying no descriptor the projection can walk for the resolved pipe (a malformed answer → `runtime`, not retryable), or server faults (`runtime`) — classified by the same `classifyError` the validation capability uses.

The route returns no `rendered_markdown`, so the capability composes its own `content` summary: the resolved pipe, the template itself in a fenced code block (` ```json ` or ` ```toml ` to match `format`), and after it the next step — call `mthds_prepare_inputs` once the template is filled, or go straight to `mthds_run` when every file value is already an http(s) URL or a `pipelex-storage://` reference; on the TOML arm it first says to convert the filled template to a JSON object, since both tools take `inputs` as one. The next step rides the summary rather than the tool description because the model reads it exactly when it has a template in hand, and because the description and the instructions are held under the length a host shows. Unlike validation, the template is deliberately duplicated between `structuredContent` and the summary — it is the payload the model must read, and some hosts read prose more reliably than structured fields. An invalid closure's summary carries the route's `message` and one line per validation error.

### Codegen Scope (`mthds_codegen`)

`mthds_codegen` projects a method's concept set into typed artifacts in the language the calling context needs, wrapping `POST /v1/codegen` through `@pipelex/sdk`'s `codegen()`. It is a plain tool: no view, no `_meta` channel, no `available_view_specs` field — decided on 2026-08-29: the summary's fenced blocks already carry the artifacts to every host. It takes the same thin-front-end posture as every other tool here: the engine projects, the MCP selects the method, chooses nothing on the user's behalf that the model can choose from context, and hands the artifacts back verbatim so the codegen trust chain (stamps, `codegen.lock`, the offline check — the workspace's `docs/specs/pipelex-codegen.md`) survives the trip through a conversation.

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[];   // { content, uri? } | { path } — see The files union
  method_ref?: string;            // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;             // catalog id (mt_…) of a registered method — resolved by the hosted platform
  target: "ts-zod" | "python-pydantic" | "python-structures";
  output_dir?: string;            // write the tree here instead of returning its content
}
```

- Exactly one of (non-empty `files`, `method_ref`, `method_id`) — the tooling rule from Method Selectors, with the same locations. **Every selector is a server pass-through**: `method_ref` is resolved by the runner (the repository fetched at the tag), `method_id` by the hosted platform's tooling selector (`PipelexHostedToolingExtensions.method_id` on the SDK's `CodegenRequest`). There is no fetch-and-forward leg and no method source in the conversation; the tool is hosted-first for `method_id` exactly as `mthds_validate` is.
- `target` is **required and has no default** — the engine's flavor identifier, verbatim. There is no `language: "typescript" | "python"` alias layer: the codegen spec rejects a flat enum that mixes artifact kinds with output formats, the two Python targets differ by *audience* rather than language, and an alias would be a second vocabulary to keep in sync with the engine's. The enum is typed from the SDK's `CodegenTarget` and closed in both directions (`satisfies` rejects a target the SDK dropped; a `Record` over the union rejects one it gained), so a widened SDK widens the tool in a deliberate edit that also has to write the new target's profile. Picking the target is the tool's whole point, so the decision rule lives in the tool description and is derived from those profiles — the description states only who each target is for, while the `target` field description adds what each emits and the file names, which is parameter detail the length budget keeps out of the description: the user's explicit request wins; a TypeScript or JavaScript project wants `ts-zod` (`types.ts` — zod schemas and inferred types, depending only on zod — plus `binder.ts`, a parse/serialize pair per concept; keep both); a Python consumer with no Pipelex runtime wants `python-pydantic` (`models.py`, plain `BaseModel`s); a Pipelex host or a `@pipe_func` implementation wants `python-structures` (`structures.py`, runtime `StructuredContent` classes). File names are fixed per target; what varies per method is the type names inside them. Field keys are wire-native snake_case in every target, TypeScript included.
- `kind` is **not exposed**: the engine serves one kind (`types`, the crate's whole concept set), and a single-member enum on every `tools/list` spends tokens on a choice that does not exist. The capability always sends `kind: "types"` and never a `pipe_ref` (the route rejects one on `types` with a 422 rather than ignoring it). When per-pipe kinds ship (`docs`, `tools`, `tests`), `kind?` and `pipe_ref?` are added together as optional fields — additive, not a rename.

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  target?: "ts-zod" | "python-pydantic" | "python-structures";
  kind?: "types";
  crate_fingerprint?: string;
  engine_version?: string;
  artifacts?: Array<{ path: string; bytes: number; content?: string; written_to?: string }>;
  lock?: { filename: string; bytes: number; content?: string; written_to?: string };
  truncated?: boolean;             // some content was withheld for size — whole files only, never a cut file
  // The written arm (output_dir was supplied and the write succeeded):
  output_dir?: string;             // the generated directory, relative to the working directory
  is_current?: boolean;            // the offline check's verdict over what landed on disk
  orphans?: string[];              // always present on this arm, empty when clean
  orphans_truncated?: boolean;     // a walk bound tripped, so orphan detection is partial
  drifts?: unknown[];              // present when non-empty — any drift that is NOT an orphan
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

**Verdict discipline** is `mthds_inputs_template`'s: a produced verdict is `status: "ok"` discriminated on `is_valid`; an unresolvable closure is `is_valid: false` with the shared `validation_errors[]` (the same items `mthds_validate` renders, so the assistant repairs through the validation flow and retries); `status: "error"` + `errors[]` is reserved for no-verdict conditions. On the valid arm the tool echoes `target` and `kind`, the crate fingerprint and engine version the stamps carry, and the artifact set plus its lock.

**Artifacts and the lock are handed over verbatim, always.** No reformatting, no re-serialized lock, no trimmed trailing newline: any byte change breaks the stamp's content hash and the lock's artifact hash, and the point of the trust chain is that a tree written from this tool is byte-identical to a local `pipelex codegen types` run, so `pipelex codegen check` and the SDK's `runCodegenCheck` pass on it. `bytes` is each file's UTF-8 size and is present even when its content is withheld. Prettier and ruff settings that rewrite generated files are the user's concern. What arrives is checked rather than trusted, because what arrives is what gets written into a user's tree — and the check runs on **both arms**, not only the write path: without `output_dir` the bytes go to a model that will write them, so a report the write arm would refuse is one the inline arm must not hand over either. One notion of a valid report is what keeps the two arms from diverging.

The check is the SDK's own: every valid response is fed to `runCodegenCheck` in memory before anything is written or relayed. That one call establishes far more than a hand-rolled rule set would — the lock parses and its `lock_version` is readable, every path in the lock and in the artifact set is safe, canonical and unique (control characters and drive prefixes included), and every artifact's stamp and body hash agree with the lock. A `CodegenLockError` and a non-current verdict are equally contract violations, and both are `runtime` no-verdicts. What remains hand-checked is only what the SDK cannot know: that `artifacts`, `lock` and `lock_filename` are present and typed, that every artifact path is one the check can verify (`isStampableArtifactPath`), that **the report answers the request that was sent** — `target` and `kind` are documented as an echo of the request's projection axes, and a report for another language is internally current and passes the offline check, so only comparing the echo catches it, which matters most on the write arm where `output_dir` would otherwise fill with another language's files and be reported as a current tree — and that **`lock_filename` is exactly `codegen.lock`** — the one name the SDK's own contract fixes, pinned rather than merely checked for being bare. That last rule is not decoration, and it earns three things at once: the writer joins the lock filename under the generated directory and the inline arm hands it to a model that will do the same, so a `lock_filename` of `../../…` is the one value in the whole path that would otherwise reach a write uncontained; the lock lands where the offline check looks for it, so `pipelex codegen check` finds the tree this tool says passes; and it cannot **alias an artifact path**, since an artifact must carry a stampable suffix to reach here and so can never be `codegen.lock` — which closes the one case the in-memory preflight structurally cannot see, `runCodegenCheck` taking the lock content separately and never learning its filename, where the writer would overwrite an artifact it had just written with lock text and report that as drift. Containment in the writer still stands on its own — canonical is not the same as contained — but the rule belongs where it holds for both arms.

**The streams rule is written for size.** The artifacts are the payload the model must act on and also the largest thing this server puts in a response. `content` is present on `structuredContent.artifacts[].content` and `lock.content`, and the Markdown summary repeats each file in a fenced block tagged for its language (` ```ts `, ` ```python `, ` ```toml ` for the lock; the fence grows past any backtick run inside the file), because some hosts read prose more reliably than structured fields and the model needs the exact bytes to write files itself. Both copies are bounded by one budget over the whole set (`CODEGEN_CONTENT_CAP`, 64 KiB of UTF-8 — sized so a small method never truncates and a large concept set degrades rather than breaks), applied **by whole file, in order, stopping at the first that does not fit**, with **the lock's bytes reserved off the top** and the artifacts filling what remains. Filling artifacts first and letting the lock fall off the end would drop the trust anchor to fit the code it anchors, leaving the model code it cannot check under an instruction promising the offline check will pass on what it writes; the lock is the smallest file in the set, so the reservation costs the artifacts almost nothing. A lock that alone exceeds the cap is the one remaining truncation of it, and nothing rides then. The withheld files carry `path` and `bytes` with `content` absent, and `truncated: true` names what happened. A half file is worse than no file (a partial `types.ts` neither compiles nor passes the check), and a `binder.ts` without its `types.ts` is no more useful than none. The summary of a truncated result lists the withheld files with their sizes and points at generating locally with the CLI. Nothing rides `_meta`: there is no view to feed, and a non-LLM consumer reading the raw MCP result sees exactly what the model sees.

**Error classification** uses `classifyError` with route options chosen by request shape, like `mthds_validate`'s. On a files request a 400/422 locates at `target`: an unresolvable closure is a produced verdict on this route and the client sends only `kind: "types"` with no `pipe_ref`, so the projection axes are what is left, and the hint names the targets. A by-ref request's 422 / 404 / 501 locate at `method_ref` (parse or fetch failure, no matching package, the reserved registry form); a by-id request's 422 / 404 at `method_id` (no stored source or a deployment that does not resolve the selector on this route; an unknown or foreign-org id). A 402 is `config` with `kind: "paywall"`. **A 403 carries the deployment's auth wording plus the gate**: the hosted authorizer requires the `FF_PLAYGROUND` feature flag for `/v1/codegen` beside the plan checks, so a caller whose credential is perfectly valid can still be refused, and "check your key" would send them to debug the wrong thing — `classifyError` gained a per-route `forbidden` hint for exactly this, read on a 403 and never on a 401, composed at call time so the deployment's own auth wording stays in front. 5xx and a malformed report are `runtime`. The credential is `PIPELEX_API_KEY`.

#### The write arm (`output_dir`)

Passing `output_dir` writes the generated tree to disk instead of returning its content, so the artifact bytes never enter the conversation at all. The directory is relative to the server's working directory, created if missing, and required to stay inside it — the write-side path trust boundary in The files union and the path trust boundaries.

**`output_dir` is advertised with `readOnlyHint: false` and `destructiveHint: true`** on the tool, because an annotation says what a tool *may* do, and a call with `output_dir` overwrites the stamped files a previous generation wrote.

**Overwrite policy is the inverse of `mthds_download_artifacts`'s, deliberately.** That tool never overwrites, because a collision there means two different files. This one *must* overwrite, because its paths come from the engine, the lock hashes them, and regeneration has to land on the same names. So it overwrites its own previous output and only that:

- A destination that does not exist is written.
- A destination that is a **regular file carrying a codegen stamp** — for an artifact, the file's text starts with the begin marker in its suffix's comment syntax; for the lock, the text starts with `# codegen.lock` — is overwritten. **Whether or not it was hand-edited**: the stamp says not to edit by hand, edits below it are discarded without warning, and a formatter run over the generated directory must not become a permanent block on regeneration. The lock's test pins the `# codegen.lock` prefix rather than the engine's full header sentence, whose trailing prose the lock parser ignores entirely — a verbatim match would turn a reworded header into a "foreign file" refusal on a file this tool wrote itself.
- **Anything else refuses the whole write**: an unstamped file, a **symlink whatever it points at** (destinations are inspected with `lstat`, because an overwrite through a symlink writes wherever it points), a directory, anything not a regular file. The refusal is `input_domain` at `output_dir`, names the file, and points at using a dedicated generated directory.

**"Whole tree or nothing" describes the refusal path, not a crash.** Every destination — the lock included — is contained *before* anything is created, and every existing one is inspected before anything is written, so a refusal leaves the tree byte-identical, directories included. There is no temp-and-rename dance: what matters is that a half-written tree is *detectable*, which the lock already makes true, so the guarantee is **detectable**, not atomic. A failure mid-write is a `runtime` error naming what landed, with the hint to call again with the same `output_dir` — regeneration overwrites its own files, so the retry finds the stamped files it left and proceeds. The window between inspection and write is accepted: the workshop is one user in one working directory.

**After writing, the tree is checked against itself.** The directory is walked recursively — symlinks skipped, vendor and VCS directories pruned (`node_modules`, `.git`, `dist`, `build`, `target`, `.next`, `.venv`, `__pycache__`) — filtered with `isStampableArtifactPath`, decoded with a **strict** UTF-8 decoder (`readFile(p, "utf8")` substitutes U+FFFD and never throws, so a corrupted artifact could otherwise hash to the locked value and report current), and handed to `runCodegenCheck` with **the lock re-read from disk**, not the copy that was meant to be written — passing the in-memory copy would leave the one write the check exists to verify unverified. The walk is bounded by a file count and a decoded-bytes budget, because `output_dir: "."` is legal and would otherwise read a whole repository into a long-lived stdio process; the bounds apply to orphan candidates only, so the files just written are always read back and a tripped bound can never fabricate a `missing` drift. A tripped bound sets `orphans_truncated`, and the summary then says orphan detection was partial rather than reporting a clean tree it did not fully see.

**Orphans are reported and never deleted.** A stamped file the new lock does not list — left by an earlier generation into the same directory, a different target, or an engine version that renamed an artifact — comes back in `orphans` and stays on disk. Consequence, stated rather than discovered: **a directory holding more than one generation stays non-current by design.** The summary says what the orphans actually are and that a dedicated directory per generation is the fix; "delete them by hand" would be wrong advice the moment a user has generated two methods into one place.

**On the written arm, content is withheld from every stream.** `artifacts[]` carries `path`, `bytes` and `written_to`; `lock` carries `filename`, `bytes` and `written_to`; the summary names the files and the check verdict and carries **no fenced blocks**. `truncated` is always `false` — nothing rode, so nothing was withheld for size. **`output_dir`'s presence is the arm discriminator** (with `written_to` per file), not `truncated` and not a new field: a third encoding of one fact is a third thing to keep aligned.

**A refused or failed write is a no-verdict `status: "error"`, never a fallback to riding the content.** The caller asked for a write and none happened; silently inlining tens of kilobytes they did not ask for would both blow the budget and change the shape they expected, and the retry is one cheap call with a fixed `output_dir`. A **produced-invalid** verdict never touches disk at all, on either arm: it carries no artifacts, so the write arm is never reached.

### Prepare Inputs Scope (`mthds_prepare_inputs`)

`mthds_prepare_inputs` prepares a pipe's *filled* inputs for a run: it uploads the file-bearing values to Pipelex storage and rewrites them to the canonical content shape carrying `pipelex-storage://`, so the returned `inputs` can be handed straight to `mthds_run`. It wraps `@pipelex/sdk`'s `prepareInputs`. It is a plain tool: no view, no `_meta` channel, no `available_view_specs` — the prepared inputs are small structured data the model reads directly.

Where it sits in the flow: `mthds_inputs_template` produces the empty template → the agent fills it (with text, `http(s)` URLs, local file references, or inline bytes) → `mthds_prepare_inputs` turns the filled inputs into run-ready inputs → `mthds_run` executes them. The prepare step is what makes local/byte assets runnable; an inputs set that is already all pass-through (`http(s)` URLs, existing `pipelex-storage://` URIs) can skip prepare and go straight to `mthds_run`.

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[];    // { content, uri? } | { path } — the method closure (signature source)
  method_ref?: string;             // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;              // catalog id (mt_…) of a registered method
  pipe_ref?: string;               // qualified domain.pipe_code; omit for the method's entry pipe
  inputs: Record<string, unknown>; // the caller's FILLED inputs (the mthds_inputs_template output, populated) — compact or the explicit {concept, content} envelope
}
```

- Exactly one of (non-empty `files`, `method_ref`, `method_id`) is required — the tooling rule from Method Selectors (no selector → `input_domain` at `files`; a second selector, or a blank one → `input_domain` at the offending field). All three are **server pass-throughs**: the selector rides `POST /v1/pipe-io`, which resolves an address on the runner and an id on the hosted platform. Nothing is expanded client-side, so this tool no longer carries a `getMethodClosure` leg of its own.

  **A `method_ref` here is not subject to the execution-locus gate.** `/v1/pipe-io` fetches a package's `.mthds` files alone, as the routes of `mthds_inputs_template` and `mthds_codegen` do, so a published package shipping `.py` prepares on any deployment; its run is refused at the start by `mthds_run` off a deployment that is not sandbox-hosted. Before `@pipelex/sdk` 0.27.0 the signature came from `/v1/validate`, which applies the gate, and such a package was a `403` here.

- `pipe_ref` is the pipe whose declared signature drives asset identification — the same qualified value as `mthds_inputs_template`'s `pipe_ref` and `mthds_run`'s `pipe_code`. Optional; it defaults server-side to the method's entry pipe, the one `/v1/pipe-io` settles (for a package whose manifest names a `main_pipe`, that pipe). A method that settles none, such as one whose domains declare several `main_pipe`s, and a `pipe_ref` the method does not declare are refused by the route, and the refusal is an `input_domain` no-verdict at `pipe_ref` carrying the route's reason. Unlike `mthds_inputs_template` there is no `format` / `explicit` — this tool returns prepared inputs, not a template.
- `inputs` is **required** (it is the whole point — the filled values to prepare). An empty object `{}` is accepted (nothing to prepare); it passes through and uploads nothing. **Both filled template shapes are accepted**: the compact value, and the explicit `{concept, content}` envelope that `mthds_inputs_template` returns by default (`explicit: true`). An envelope's inner `content` is interpreted exactly as the compact value would be, and the envelope is **preserved on output** — the `concept` annotation rides through to the run, which the runtime accepts as a first-class explicit form. The envelope is recognized by the strict rule "a plain object whose keys are *exactly* `concept` and `content`", so a declared structured concept that merely happens to carry both fields is not misread as one. This matches `@pipelex/sdk`'s `prepareInputs` (0.9.0+).

**Signature-driven asset identification (inherited from the SDK).** The SDK resolves the pipe's declared signature from the **input-form descriptor** — one `POST /v1/pipe-io` for the one pipe, the MTHDS standard's own artifact — and walks the caller's `inputs` top-down against it. **The descriptor is the classifier, never the value's shape**: a `document` / `image` node marks a file position at any depth, an `object` recurses through `fields`, a `list` through `item`, and every other kind passes through. That is what makes an *optional* nested file field prepare like a required one, and a `text` field merely *named* `url` stay untouched — the two misclassifications the earlier rendered-template signature made, whose file signal was a `url`-bearing dict. Only values at descriptor-declared file positions are treated as assets; the identical bare string at a Text position is never touched. Per file-bearing value:

| Source at a file-bearing input | Action |
| --- | --- |
| Local filesystem path (Node) / `data:` URL / inline bytes | Uploaded to Pipelex storage → rewritten to `pipelex-storage://` |
| Existing `pipelex-storage://` URI | Already prepared — passes through unchanged |
| `http(s)` URL | Passes through unchanged |


**The asset boundary.** Uploading a local or byte asset means reading the caller's bytes, which only the server co-located with them can do. The workshop prepares local paths, `data:` URLs and bytes within its asset boundary, uploading with the user's `PIPELEX_API_KEY`, and it delegates the whole walk to the SDK's `prepareInputs`. It always uploads.

**The upload size ceiling is ~7.5 MiB decoded, not the documented 50 MiB.** Measured 2026-07-31 against the hosted API: 7.4 MiB uploads, 7.5 MiB is rejected `413`. `POST /v1/upload` takes a base64 JSON body behind an AWS API Gateway HTTP API integration, whose 10 MiB request limit is a hard quota; base64's 4/3 inflation puts the decoded wall at exactly 7.5 MiB. The app-level `MAX_UPLOAD_MIB` (50 MiB) is therefore unreachable through the public gateway and must not be quoted as the limit of any path that crosses it.

The ceiling is enforced client-side by `SizeGuardedPipelexApiClient` (`capabilities/upload-ceiling.ts`), a `PipelexApiClient` subclass overriding `upload` — the one seam the MCP owns, since the SDK's `prepareInputs` walk reaches the wire through `this.upload`. One override therefore covers the workshop's delegated walk. It throws the same `RejectedAssetError` a real `413` maps onto, so every downstream classifier is unchanged; what improves is that the message can name the actual limit, which the server's cannot. **What it does not do is skip reading and base64-encoding the asset first**: for a local path the SDK owns that step inside `uploadFile` (`readLocalPath`), so refusing before the read needs a pre-flight in `@pipelex/sdk` itself — a cross-repo item, carried alongside the presigned direct-upload redesign. The wasted network round-trip, the expensive half, is gone either way. `MAX_UPLOAD_BYTES` is derived from the gateway quota rather than hardcoded, so the derivation stays visible.

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;                 // true on the produced (success) arm — see verdict discipline below
  pipe_ref?: string;                 // echoed when the caller supplied it (the SDK does not return the resolved default)
  inputs?: Record<string, unknown>;  // the prepared (rewritten) inputs — ready for mthds_run
  uploads?: string[];                // the pipelex-storage:// uris of the assets uploaded this call ([] when all pass-through)
  errors?: Array<{
    class: "input_domain" | "config" | "runtime";
    kind?: "paywall";
    location?: string;
    message: string;
    hint?: string;
    retryable: boolean;
  }>;
}
```

**Verdict discipline.** A produced result is `status: "ok"`, `is_valid: true`, carrying the rewritten `inputs` and the `uploads` uri list. Unlike `mthds_inputs_template`, `mthds_prepare_inputs` has **no produced-invalid arm**: an unresolvable closure (invalid bundle, unknown `pipe_ref`, unresolvable `main_pipe`) is a **no-verdict** `status: "error"` `input_domain`, because the SDK's `prepareInputs` throws `InputPreparationError` on an invalid closure without returning the structured `validation_errors[]` list. The agent's recovery path is `mthds_validate` / `mthds_inputs_template`, which *do* produce the structured diagnostics — prepare sits downstream of them and delegates the verdict surface rather than duplicating it (re-fetching the list would cost a redundant `/v1/validate` round-trip).

`status: "error"` + `errors[]` cover every failure:

- `input_domain` — bad request shape (no selector, a second selector, a blank selector, a blank `pipe_ref`); every client-side refusal the SDK raises before or during its walk (below); a selector the route refuses (a `method_ref` that does not parse or fetch at `method_ref`, an unknown or foreign-org `method_id` at `method_id`, a stored method with no MTHDS source at `method_id`, either execution-locus 403 at whatever named the method); a rejected asset (`RejectedAssetError`, a 413 past the service size cap, at `inputs`); an invalid local source (`InvalidLocalSourceError` — missing/unreadable path, at `inputs`).
- `config` — auth failure (`UploadAuthenticationError`, 401/403, carrying the `PIPELEX_API_KEY` texture), a paywall (402, the org's plan does not cover the call, tagged `kind: "paywall"`, on the pipe I/O route and on the upload leg alike), an unreachable API, on either leg, a deployment with no upload route (`UnsupportedUploadCapabilityError`, 404), and a runner too old to serve `/v1/pipe-io` (a bare 404, at `PIPELEX_BASE_URL`).
- `runtime` — a fault on the upload route (`UploadTransportError` wrapping a 5xx, a throttle or storage's own fault), retryable when the SDK says asking again can succeed, and a reachable-but-malformed report.

The SDK wraps whatever the upload leg meets, other than a refused credential or size, in an `UploadTransportError` that takes the verdict of the error it wraps. Where that cause is a fault this server words (the upload ceiling's own refusal, a plan limit, an unreachable API), `classifyError` classifies the cause itself, so a 402 on the upload leg reads as the paywall and not as a passing transport fault. Each is classified in `classifyError` (extended for the `InputPreparationError` family) with the SDK's verdict, using per-route `ClassifyErrorOptions` picked by the request's selector shape, exactly as `mthds_validate` and `mthds_codegen` do: a route 400/422 locates at `files`, `method_ref` or `method_id` according to what the caller supplied. **A files-shaped request takes the default `files` locator and NOT the pipe's** — pipe selection is client-side here, so `/v1/validate` can never be complaining about a `pipe_ref` that never rode the wire.

**The SDK's client-side refusals all land at `pipe_ref`.** The SDK raises every refusal of its own as a plain `InputPreparationError` — an unqualified or unknown `pipe_ref` and a method settling no single default pipe, but also a value at a file position it cannot read as a file (a malformed `data:` URL, a value of an unsupported type), a closure that does not validate ("the method signature did not resolve") and a report carrying no `input_form` descriptor — so `classifyError` cannot tell them apart and reports each as `input_domain` at `pipe_ref`, with the hint to qualify the pipe. For the pipe refusals that is the right field. For the rest it is not: a bad value is a question about `inputs`, a broken closure is a question about whatever named the method, and a missing descriptor is a question about the deployment. The workshop can locate those two at the selector and at `PIPELEX_BASE_URL` once `@pipelex/sdk` raises them as distinct errors.

**Summary.** The build/prepare surface returns no `rendered_markdown`, so the capability composes its own `content` summary: the resolved pipe (when known), a one-line note of how many assets were uploaded vs passed through, and the prepared `inputs` in a fenced JSON block (the `mthds_inputs_template` duplication pattern — the prepared inputs are the small payload the model must carry to `mthds_run`).

### Catalog Write Scope (`mthds_save_method`, `mthds_get_method`)

Two tools carry a bundle between the workspace and the organization's catalog: `mthds_save_method` sends the files on disk to the catalog, creating a method or updating one, and `mthds_get_method` brings a saved method's files back. They complete the loop `mthds_list_methods` opened — the listing says which methods exist, these two say what a method *is* and let a workshop session change it.

**Both need the working directory** (see What the workshop registers). `mthds_save_method` submits the bundle as `files` in the `{ path }` form and finishes by writing the link file that makes the next save an update rather than a duplicate, and `mthds_get_method`'s write arm has nowhere to write without a working directory; its inline arm exists for the single case of explaining a method to a workshop session that is about to work on it. The catalog's human surface lives in the webapp's editor.


#### `mthds_save_method`

One call reads the files, validates them and saves those same bytes. Splitting it — validate in the skill, save in a second call — would read the files twice and the saved bytes would not be provably the validated ones.

The public MCP input shape is:

```ts
{
  files: SubmittedFileInput[];    // the bundle's .mthds files, ROOT FILE FIRST — { path } on the workshop
  name: string;                   // the catalog name; on an update, a changed name is a rename
  method_id?: string;             // absent creates; present updates THAT method
  python?: SubmittedFileInput[];  // the bundle's .py files, replaced as a set
  expected_updated_at?: string;   // the stored updated_at this save believes it is overwriting
  link_dir?: string;              // where to write pipelex-method.json; defaults to the root file's directory
}
```

- **`files` is required and non-empty, and its order is load-bearing.** The platform derives a method's listed description from the first file, so the root `.mthds` file — the one carrying the bundle's `domain` — is sent first. The tool does not reorder and does not guess which file is the root: the caller orders them, and the tool states the rule in its description. Every item is subject to the workshop's read boundary (`.mthds` extension, real-path containment) exactly as every other `files` argument is. **And every name this save produces is held to the same rule the pull enforces on the way back** — one predicate, asked at both ends. A stored name that `mthds_get_method`'s written arm would refuse (a component beginning with a dot, the link file's own name, an extension that is neither `.mthds` nor `.py`, or two names differing only in case, counted across `files` and `python` together since both write into one directory) is refused here as an `input_domain` no-verdict, before anything is stored. Without it a caller-supplied `uri` went to the catalog verbatim and every later written pull of that method failed outright with no flag to bypass it; the inline arm still returns the bytes, so the method was not lost — except above `MAX_INLINE_SOURCE_BYTES`, where the inline arm withholds the content and names the written arm as the cure.
- **`name` is required on a create and on an update alike**, because the platform's `PUT` rewrites the whole row; an update that omitted the name would blank it. A `name` different from the stored one *is* the rename gesture, and the tool says which it did.
- **`method_id` is the arm discriminator**, as `files` versus `method_id` is on `mthds_run`. Absent, the tool calls `createMethod` (`POST /v1/methods`, the id minted by the server). Present, it calls `updateMethod` (`PUT /v1/methods/{id}`, which never creates). There is no `create`/`update` flag and no second tool: the difference is the presence of one argument.
- **`python` accepts the same two item forms as `files`** but is contracted to `.py` files, so the workshop's read boundary gates on that extension instead. Omitting it preserves whatever Python is stored (the SDK's documented three-way on `MethodWriteInput.python`); sending an empty array clears it; sending files replaces the set. The tool never merges. A bundle with no `.py` file sends nothing, so a save from a directory the user has not changed cannot silently erase stored Python.
- **`expected_updated_at`, when given, is a best-effort precondition — check-then-act, not atomic.** The tool reads the stored method first; if its `updated_at` differs, the save is refused as an `input_domain` no-verdict located at `expected_updated_at`, carrying both timestamps, and nothing is written — not the method, not the link file. It is ignored on a create, where there is nothing to be stale against, and its absence on an update means the caller is knowingly overwriting. **The window between that read and the write is real and cannot be closed here**: the platform offers no compare-and-swap — `MethodWriteInput` carries no version and the SDK's `updateMethod` sends no `If-Match` — so a save that lands inside the window is still overwritten. The tool's own description says "best-effort" for that reason; a real precondition needs the platform to accept one, and until it does this argument narrows the race rather than closing it.
- **`link_dir` is relative to the working directory and subject to the write-side containment boundary.** Omitted, the link file goes beside the first `files` item — **its `path`, and only a `path`**. An inline-only submission with no `link_dir` writes no link file and says so in the result, because there is no directory to put it in: an inline item's `uri` is provenance for diagnostics and may be any label at all, so deriving a directory from it created one named `memory:` for a `uri` of `memory://draft.mthds`, and put the link at the working-directory root for a bare `bundle.mthds`. That is a different question from what a file is NAMED inside the method, which is relative to the bundle directory and may legitimately come from an inline `uri`. **A directory already linked to a different method is not re-pointed**: the link file is committed and shared, so a silent takeover would send a teammate's next save to this method instead of theirs. **Both arms read the link BEFORE touching the catalog, and refuse there**, because both writes are irreversible in the same way and delete is admin-only: a create into a claimed directory is refused as an `input_domain` no-verdict rather than minting a duplicate nobody can remove, and an update whose `method_id` is not the one the directory is linked to is refused at `method_id` rather than rewriting a different method with this directory's bundle and name — a catalog that keeps no earlier version cannot give that one back. `link_dir` is the deliberate fork for each, and the hints name it. **A link file that cannot be READ counts as a claim**, not as an empty slot: `readMethodLink` reports a malformed, truncated or symlinked link as `unreadable` precisely because something claims the directory, and treating that as "no link" is what let a create run and a duplicate appear. When a link write fails after a successful save, the result says which of the three states holds — linked and refreshed, linked but stale, or genuinely unlinked — and never the last about a directory where a link survives, since the advice that answer carries has itself overwritten the wrong method.

**Behaviour, in order.** Resolve the files; validate them through the same capability `mthds_validate` uses; on an invalid verdict answer with the verdict and write nothing, anywhere. On a valid verdict — pending signatures included, since the catalog holds drafts in the webapp too — serialize the same resolved bytes into the webapp's stored form with `mthds/protocol`'s `serializeMethodFiles`, `name` being the file's path relative to the bundle directory and the root file first, so that a method saved from the workshop opens in the webapp's editor as the same files. **The serializer is the shared one, never a local `JSON.stringify`**: `mthds/protocol`'s `method_files` module exists precisely so the platform, `@pipelex/sdk` and this server agree on the shape instead of each re-porting it, it names this server as one of its three consumers, and it differs from the obvious hand-rolling in two ways that matter — a blank-content entry is dropped, and the empty set serializes to `""`, the platform's "no source" sentinel, rather than to the literal `"[]"`, which the platform would store as a bundle. `mthds` is a transitive dependency of `@pipelex/sdk` today, so this makes it a direct one. On an update, read the stored method first (which is also the `expected_updated_at` check) and send its `input_data` back unchanged, because the platform's `PUT` rewrites the whole row and only `python` is kept on omission — an update that omitted `input_data` would erase the form inputs a webapp user had saved. Then write the link file of the section below. A valid bundle with pending signatures is saved and the summary says the method does not run yet.

**No source comes back.** The result carries the id, the name, whether the method was created or updated, the new `updated_at`, the API host and the verdict's summary fields. The bytes the caller submitted are already in the caller's hands.

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable?: boolean;
  pending_signatures?: string[];
  method_id?: string;
  name?: string;
  saved?: "created" | "updated" | "renamed";   // renamed = updated with a changed name
  updated_at?: string;
  api_host?: string;
  link_file?: { path: string; written: boolean; reason?: string };
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

**Verdict discipline** is the family's: a produced verdict is `status: "ok"` discriminated on `is_valid`, an invalid bundle is `is_valid: false` with `validation_errors[]` and no save, and `status: "error"` + `errors[]` is reserved for no-verdict conditions — an unreadable file, a rejected credential, a stale `expected_updated_at`, an unknown `method_id`, a failed write.

**A create is never retried automatically, and the tool says so.** `POST /v1/methods` honours an `Idempotency-Key` and `@pipelex/sdk` exposes no way to send one, so a create whose response was lost cannot be replayed safely: the retry mints a second method. A create-side timeout or transport fault is therefore classified **not retryable**, with a hint to list the catalog before trying again, and so is a `2xx` the SDK could not read, which the SDK already calls final: the platform accepted the create, so the method exists. An update has no such hazard — `PUT` is idempotent by construction — and its transport faults stay retryable. When the SDK gains the key, the create becomes retryable and this paragraph goes.

**A failed link-file write does not fail the save.** The method is already stored by then, and answering `status: "error"` would tell the caller their save did not happen. The link file reports itself in `link_file` with `written: false` and the reason, and the summary says the directory is not linked, so the next save would create a second method unless the caller passes the id.

#### `mthds_get_method`

```ts
{
  method_id: string;
  output_dir?: string;   // write the sources here; omitted, they come back inline
  overwrite?: boolean;   // only meaningful with output_dir; see the linked-directory rule
}
```

**With `output_dir`** the method's `.mthds` and `.py` files are written verbatim, the link file is written beside them, and the result returns the paths — no source passes through the conversation, which is the rule `mthds_codegen`'s write arm set. The directory is relative to the working directory under the shared write-side containment boundary.

**A stored method carries names only in the catalog form, and the legacy form has none.** `MethodData.mthds` is polymorphic: the named `[{ name, content }]` array the webapp editor writes, or raw `.mthds` text from before that form existed. `parseMethodFiles` reads the first and throws on the second by design, and the SDK's own `methodSourceToContents` reads both but returns contents alone, so neither one hands this tool a filename on the legacy shape. The written arm therefore reads the named form through `parseMethodFiles` and, when that refuses, falls back to the raw shape as a single file it names `<slugified method name>.mthds` — saying in the result that the name is the tool's and not the method's, because the next save sends that name back and would rename the file in the catalog. A method saved from this workshop is always in the named form, so the fallback is reachable only for one written before the editor existed. The inline arm has no such problem and reports the legacy shape as one unnamed file.

**What the pull may write at all.** A stored file's name comes from whoever saved the method, and `mthds_save_method` takes an inline item's name from a caller-supplied `uri`, so the catalog is an untrusted source of paths while `output_dir` may be any directory the user is standing in. Containment is therefore necessary and not sufficient: every destination must also end in `.mthds` or `.py`, carry no path component beginning with a dot, not be `pipelex-method.json` (which the pull writes last, so a stored file of that name would be overwritten by the link and reported as written anyway), and be unique across the set after case folding (two names landing on one file wrote one over the other and reported both). Without those, a stored method pulled into a workspace could leave a CI workflow or an agent's configuration behind it, since the occupancy guard only refuses destinations that already exist. Each refusal is `runtime` — the request was fine and the stored method is not — and writes nothing.

**The refusal rule, and why it is not the codegen writer's.** `mthds_codegen` overwrites its own stamped output because the engine owns those filenames; a method's sources are the *user's* files and carry no stamp, so the only evidence of ownership is the link file. So: a directory holding neither any file this pull would land nor a bundle of its own is written; a directory whose `pipelex-method.json` names this same method is compared destination by destination against the stored sources, and three outcomes follow, which are box R's rule in the design this tool was specified from — identical means **nothing is written at all** and only the link's `synced_updated_at` is refreshed (rewriting identical bytes woke watchers and, with one read-only source, turned a pure link refresh into a mid-write failure); different while the stored `updated_at` still equals the recorded `synced_updated_at` means the local files are work this directory has not saved, so the pull is refused and says it would be lost; different after the stored method has moved means the tool cannot tell whose change it is looking at, so it refuses unless `overwrite: true`, which the caller sends only after asking the user. A destination that is simply **absent** is none of the three and is written: nothing is lost by creating a file that is not there, and counting it as a difference refused every pull that would have restored a file the user had deleted, with no flag to open it. A directory already holding any file this pull would land, or any `.mthds` file of its own under other names, or a link naming another method, is refused outright: it is somebody else's work. **Every half of that rule is asked of the whole write set — the `.py` files and the nested paths included — never of the `.mthds` sources alone**: a guard that inspects a narrower set than the write loop lands is not a guard, and a top-level `.mthds` scan let a directory holding the user's own `helpers.py` read as empty. The one exception is a link carrying `partial_pull`, which an interrupted pull of this same method leaves behind so that the retry it advertises is actually permitted — and it is an exception to the *ownership* question only: a destination whose bytes have **changed** since that pull landed is still refused without `overwrite`, because the marker says a pull was interrupted and nothing more, and it rides in a file the user is told to commit, so it can be stale or planted. Every destination is also inspected with `lstat` before anything is written, and a symlink is refused: containment is decided on a joined path, and a write through a symlink lands at its target. Every refusal is `input_domain` at `output_dir` and writes nothing at all.

**Without `output_dir`** the sources come back inline, bounded by one budget over the whole set applied by whole file in order — the codegen streams rule, for the same reason: half a `.mthds` file is worse than none. Withheld files carry their name and byte size with no content, and `truncated: true` names what happened. This arm exists for the one case where the model has to read the source anyway, which is explaining a method it cannot see on disk.

```ts
{
  status: "ok" | "error";
  method_id?: string;
  name?: string;
  updated_at?: string;
  api_host?: string;
  files?: Array<{ name: string; bytes: number; content?: string; written_to?: string }>;
  python?: Array<{ name: string; bytes: number; content?: string; written_to?: string }>;
  output_dir?: string;                          // present on the written arm — the arm discriminator
  link_file?: { path: string; written: boolean; reason?: string };
  unmanaged?: string[];                         // written arm — source files here that this method does not have
  unmanaged_truncated?: boolean;                // written arm — the walk did not finish, so `unmanaged`'s absence is not "none"
  truncated?: boolean;                          // inline arm only; always false on the written arm
  errors?: ToolError[];
}
```

**A pull writes what the catalog holds now, which is not the same as making the directory match it.** A file somebody removed from the stored method is neither written nor deleted, and the link is refreshed regardless — so without saying anything the directory would certify a sync it does not have, holding a bundle that validates and runs differently from the catalog's, and a later save from it would put the removed file back. The tool records no per-file state, so it cannot tell a file the catalog dropped from one the user simply keeps beside the method, and deleting on that guess is the one thing it must not do. So it names them in `unmanaged` and says in prose which two things they might be. Telling them apart needs the link file to record what it manages, which is a change to the link's format and is filed rather than guessed at. The walk is bounded, and reports nothing at all rather than a partial list, since the line's whole claim is that it names everything. **It reports its own completeness in `unmanaged_truncated`**, because "nothing to report" and "I could not finish looking" are different answers that an absent list renders identically — a directory it could not read, or more entries than it looks at, sets the flag and says so in prose instead of leaving a silence that reads as a clean directory. It does not descend vendored or dot-leading directories (`node_modules`, `.git`, `.venv`, `dist`, `build` and the rest of the set the codegen writer's orphan walk shares): the link file is designed to be committed, so a repository at `output_dir` is the expected case, and descending them either spent the whole budget inside one or listed a `.venv`'s files as sources this method does not have. Nothing there could be this method's in any event — `storedNameReason` refuses to WRITE a dotted component.

A method whose stored source parses to nothing is a produced failure, not an empty success: it is `status: "error"`, `input_domain` at `method_id`, with the SDK's own `EmptyMethodSourceError` as its cause — the row exists but has no runnable source yet, which is a different answer from "no such method" (404, also `input_domain` at `method_id`, since an id from another organization is indistinguishable from an unknown one).

#### The link file — `pipelex-method.json`

Both tools write it; no skill does, and nobody edits it by hand. It sits beside the root `.mthds` file and is meant to be **committed**: a team shares an organization, and the link is what lets the second person update the method the first one saved rather than creating a second. An id grants nothing without the organization's key.

```json
{
  "comment": "Written by the Pipelex workshop (@pipelex/mcp). This directory is saved on Pipelex as the method below. Commit this file so that a teammate updates the same method instead of creating a second one. Do not hand-edit it.",
  "generator": "pipelex-mcp",
  "api_host": "api.pipelex.com",
  "method_id": "mt_…",
  "name": "Summarize PDF",
  "synced_updated_at": "<the saved method's updated_at at the last save or pull>"
}
```

**The workshop writes it because the workshop is the only party that knows which API host it talks to.** `api_host` is the host of the configured base URL, and it is what makes an unknown id on a later update diagnosable: a link made against one plane, or with another organization's key, reports the host it records rather than reading as a vanished method.

**It records no source hashes**, deliberately. The cost is stated rather than hidden: with no record of the files as they were at the last sync, a pull into a linked directory cannot tell whose change it is looking at, which is why the three-outcome rule above ends in a question for the user in its last case instead of an answer. Inside a git repository `git status` answers that question for them.

`synced_updated_at` is known only at a save or a pull, because it costs a call. A save sends the recorded value as `expected_updated_at`; both tools rewrite it with the new one.

### `mthds_run`

`mthds_run` starts a durable run on the workshop, with the start result, the lifecycle and the verdict discipline of Run Scope. It takes its method any of three ways, and its description nudges validating a files bundle first (see the start-time rejection note in Run Scope).

```ts
// input
{
  files?: SubmittedFileInput[];      // { content, uri? } | { path } — see The files union
  method_ref?: string;               // published method address — see run-by-address below
  method_id?: string;                // catalog id (mt_…) of a registered method — see run-by-reference below
  pipe_code?: string;                // pipe to run — the same qualified value mthds_inputs_template takes as pipe_ref; omitted → server resolves the bundle's (or the manifest's) main pipe
  inputs?: Record<string, unknown>;  // method inputs, as filled from the mthds_inputs_template template
}
```

**Beside files.** `method_id` is a separate optional top-level argument beside a now-optional `files` — deliberately **not** a third arm on the files union (a method id is not a file, and a mixed array would falsely suggest merging) and not a distinct tool (one run tool for the model; the lifecycle family keeps its stem). Request shape follows the run rule from Method Selectors: at least one source among (non-empty `files`, `method_ref`, `method_id`) is required, else `input_domain`; a supplied-but-blank selector is `input_domain` at that selector; id format beyond non-blank stays server-owned (the same stance as `run_id`). Precedence mirrors the platform: **inline `files` win** — when both are supplied, the files run and `method_id` is recorded as the run-history linkage on the platform's Run row (the webapp's own semantics for saved methods); `method_id` alone runs the stored method, as Run Scope describes.

### Artifact Download Scope (`mthds_download_artifacts`)

`mthds_download_artifacts` saves a completed run to disk: its main output, and the files it produced. It is the workshop's download counterpart to its upload path: `mthds_prepare_inputs` pushes local files *into* Pipelex storage and rewrites them to `pipelex-storage://` references; nothing brought a run's outputs back *out*. A run that produces an image, a PDF or a document returns it in `mthds_run_results` as content carrying its `pipelex-storage://` reference in `url` beside a presigned `public_url` with a one-hour life — so every file a run produced reached the user as a link that dies within the hour, and whether it ever landed on disk depended on the agent thinking to fetch it in time (observed live: the generated image reached the user only because the agent happened to fetch the link before expiry, and first into a scratch directory rather than the workspace). This tool makes that outcome the default. It is a plain tool: no view, no `_meta` channel, no `available_view_specs` — the saved paths are small structured data the model reports directly.
**The output is saved too, always, as `main_stuff.json`.** A run's main output used to reach the disk only by the model retyping it: in the proof lab of 2026-09-24 a model asked for the results as files rewrote each output with its own file tool — thousands of characters of output tokens per run, with nothing to stop it altering the JSON on the way — and a long output was worse off still, cut at `MAIN_STUFF_CAP` in `mthds_run_results` with no tool to read the rest, until the session reached for curl. So every completed save writes the **full** `main_stuff`, exactly as the API returned it (the `pipelex-storage://` references and their expiring `public_url` links included — the file is a record of the run, and the verdict is what maps each reference to its saved file), as `JSON.stringify(value, null, 2)` plus a newline, to `main_stuff.json` — the name `pipelex run --save-main-stuff` writes and the one the hosted platform stores the same artifact under. There is no flag: the failure it answers is a model that does not know to ask. It is written **first**, before a single file is fetched, so it always takes its own name, and a stored file that would collide with it is the one suffixed. A run whose output references no stored file is saved all the same — that is the case that motivated it. Only JSON is written: the CLI's Markdown and HTML renderings need the runtime's content classes, which the hosted API does not relay.
**Why a companion tool and not an option on `mthds_run_results`.** Two shapes were plausible: a `save_artifacts` flag on the results tool, or this companion. The companion keeps the tool contract simplest on three counts. First, the results tool is annotated read-only; writing files to the user's disk is not a read. Second, the results projection is already the busiest surface in the repo (bounding, usage, three `_meta` channels); a filesystem write does not belong inside it. Third, a separate tool answers the durable case on its own terms — "save the files from run X" days later is one call with the id, no re-projection of a result the agent already read. The cost is one more tool on the workshop's list. The same three counts settled where the output write went when the need for it surfaced (2026-09-24): an `output_path` on the results tool was proposed, and the output was given to this tool instead, which keeps its name — `main_stuff.json` is a run artifact in Pipelex's own vocabulary, beside `graphspec.json` and `working_memory.json`.

**Why it is keyed on the run id, not on a list of URIs.** The run id is the durable handle the whole family already uses, and the agent holds it. Taking `uris` instead would have the agent copy references out of a bounded result (a pruned copy could have dropped one) and would invite misspelled schemes; taking the id lets the tool walk the run's **full** main output, find every reference, and resolve each through the API to a **fresh** presigned link — so the hour-long life of the `public_url` embedded in the results never matters, and the same call still works days after the run. Finding the references is a contract, not a heuristic: the scheme is unambiguous, so every string that *is* a `pipelex-storage://` reference anywhere in the output is a produced file (or an input the output echoes — accepted, and harmless). Nothing is guessed from field names.

**The mechanics are the SDK's; the tool is thin over them.** The walk, the fresh links, the filenames, the never-overwrite rule and the download bounds are `@pipelex/sdk`'s artifact stack — `locateArtifacts` (the pure walk, which also says where each reference sits; `collectArtifacts` is its references alone), `resolveArtifacts` (one call to the platform's bulk resolve route, `POST /v1/resolve-storage-url/bulk`, for the whole set) and `downloadArtifacts` (resolve, fetch and write under a directory, returning a produced verdict), documented in the SDK's [`docs/artifact-download.md`](https://github.com/Pipelex/pipelex-sdk/blob/main/js/docs/artifact-download.md). What this tool keeps is what is the workshop's own: the tool envelope and its run-state verdicts, the containment of `dir` against the working directory, the deployment gate, the plain-http rule below, the classification of every failure into `ToolError`s, and the prose summary. It carries no walker, filename rule or downloader of its own.

The public MCP input shape is:

```ts
{
  run_id: string;   // the durable run id from mthds_run
  dir?: string;     // where to save, relative to the server's working directory; created if missing; must stay inside it; omitted → runs/<run_id>; "." → the working directory itself
}
```

- `run_id` follows the run family's stance: non-blank is the only client-side check, format is server-owned.
- `dir` is optional and relative. A blank value, an absolute path, a lexical escape (`../x`) and a symlink inside the workspace that points out of it are all refused as `input_domain` at `dir`. The lexical half runs on the request, before the run is read, so a run that is still running or has failed refuses an escaping `dir` too rather than answering that there is nothing to save yet; the real-path half runs with the one `mkdir`, once the run has completed. Omitted, the run is saved into **`runs/<run_id>/`** under the working directory — one folder per run, so a second run's `main_stuff.json` never becomes a `main_stuff-1.json` that no longer says which run it came from, and it is the folder the `pipelex-run` skill already chose. The segment is built from the run id the API **answered**, never from the caller's argument, reduced to `[A-Za-z0-9_-]`; one with nothing left is a `runtime` no-verdict at `run_id` whose hint says to pass `dir`, and the containment above holds whatever the segment. `"."` saves into the working directory itself.

**Behavior.** The tool reads the run itself (`GET /v1/runs/{id}/results`, the same route and classification as `mthds_run_results`) and branches on its state exactly as the results tool does: `running` and `failed` are produced verdicts (`status: "ok"` with `state`), since "nothing to save yet" and "a failed run produced nothing" are answers. On `completed`, it resolves the target directory under the containment rule and writes `main_stuff.json` into it; a directory that cannot take that one small file will not take the downloads either, so a failed output write stops the save there. It then walks the main output with `collectArtifacts`: a completed run with no reference is a produced verdict (`scope: "main_stuff"`, the `output`, `artifacts: []`, `all_saved: true`). Otherwise it hands the results it already holds to `downloadArtifacts` — the `results` form, so the run is never read twice — with that directory, the scope and the plain-http answer. The SDK resolves the whole set in one bulk call, downloads a bounded few at a time (four by default), re-resolves any link that has expired by the time its turn comes, and answers one entry per reference in discovery order; the tool turns each absolute path into one relative to the working directory and each per-item error into a `ToolError`. Per-item failures ride the item; the rest of the set still downloads. Reading the run here rather than through the SDK's `run_id` form is deliberate: a run that is still running or has failed never touches the disk.

**Scope.** The tool takes no `scope` input and always walks `main_stuff`, the SDK's default, naming it explicitly so the empty-walk check and the download agree. The verdict names what was walked: `scope: "main_stuff"` on every completed verdict, beside `artifacts`, whose length is the count of references found there, errors included. That is what makes an empty verdict read as "this run's main output references no stored file" rather than as an unexplained success. The SDK's other scope, `working_memory` (echoed inputs and every intermediate), is not offered here.

**The plain-http rule.** The SDK refuses a plain `http:` download link unless its caller opts in, and this tool opts in exactly when the configured API is itself plain http: `PIPELEX_BASE_URL` with the `http:` scheme is the local compose stack, whose object store mints plain-http presigned links, so a download there must accept them; a deployment reached over `https:` mints `https:` links, so a plain-http one from it is refused rather than followed silently. The explicit override is **`PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP`**: `true` (or `1`) accepts plain-http links from any deployment — the case of an `https:` tunnel in front of the local stack — and `false` (or `0`) refuses them from every deployment, the local stack included. Unset or blank, the rule derives from the base URL. Any other value refuses, so a misspelled override can only make the tool stricter. A refused link is that item's error (`config`, not retryable), and its hint names the override.

**Write policy.** Containment is the shared write-side boundary described in The files union and the path trust boundaries, and it stays this tool's own: the directory is real-path-checked on its deepest existing ancestor before it is created and again after, before the SDK writes a byte into it. The *filename* and the *collision rule* are the SDK's (`artifactFilename` and its exclusive create), and both follow from where the names come from. The filename is never taken from anything the caller typed: each file is named after the field it fills in the main output, the first path in its `found_at`, so the picture at `$.rooms[3].staged_photo.url` is saved as `rooms-3-staged_photo.png`. A final `url` key is dropped, each key is reduced to `[A-Za-z0-9_]`, the segments are joined with `-`, a name over the length cap keeps its tail, and a stem Windows reserves for a device gets a trailing `_`; a reference that is the whole output takes the scope's name, so an output that is one image is saved as `main_stuff.png`. The storage key supplies only the extension, and the object's content type supplies one when the key carries none (an unknown type gets no extension rather than a guessed one). The result is a bare filename, never empty and never starting with a dot, so no traversal survives. The full rule is the SDK's, in its `docs/artifact-download.md`. **Files are never overwritten**: the file is created exclusively (`wx`) and a name collision gets a numeric suffix (`name-1.ext`). Two fields can reduce to the same name (`staged photo` and `staged-photo`), and since a few files download at once, which of the two takes the suffix is not fixed. A collision here means two *different* files, so suffixing is the right answer — the exact inverse of `mthds_codegen`'s write arm, whose paths come from the engine and whose regeneration must land on the same names. The two writers share containment and nothing above it.

`main_stuff.json` is the one file this tool writes itself, and it follows the same rule: an exclusive create, `main_stuff-1.json` and on when the name is taken, and the file removed again if the write fails. Saving the same run twice into the same folder therefore adds copies of everything rather than replacing anything. Because it is written before any download starts, the output has first claim on its name: a produced file that would also be called `main_stuff.json` — an output that is itself one stored JSON document — is the one that takes the suffix. The write is a few lines here rather than an SDK function because writing one JSON value is not the network work the SDK's artifact stack exists for, and the SDK's suffixing helper is internal to it.

**Download boundary.** The link is the configured API's own answer, so this is not an SSRF surface — but a download that writes to the user's disk is bounded regardless of who named the URL, and the bounds are the SDK's, taken at their defaults: `http(s)` only (plain `http:` under the rule above), no credentials in the URL and none of ours forwarded, redirects refused outright, a timeout covering the whole exchange (120 s per file), a byte cap enforced from `content-length` before a byte is written and again mid-stream (1 GiB per file), and a cap on the bytes the whole call writes (4 GiB), past which the file that would cross it and every file not yet started are item errors. The caps are accident guards against filling the disk, not product limits: run outputs are produced server-side, so a user cannot shrink one the way they can shrink an upload, and a low ceiling would leave them with no recourse but the expiring link. A refused or failed download leaves no partial file behind.

Each per-item error carries the SDK's code, which this tool classifies, and locates at `artifacts[i].uri`. The resolve route's per-reference refusals are `input_domain` and not retryable: `invalid_storage_uri` (the API rejected the reference as found in the output) and `forbidden` (it belongs to another organization than the key's). A vanished object (`not_found`, a `404`/`410` from the store), an oversized one (`too_large`) and one past the call's total cap (`total_limit_exceeded`) are `input_domain` and not retryable either, the last two pointing at the `public_url` for the file that would not fit. A store refusing a *fresh* signature (`store_refused`, a `401`/`403` — clock skew, a signing misconfiguration), any other store status (`store_error`), a timeout, a network fault and an expired link that could not be re-resolved (`resolve_failed`) are retryable `runtime`, since every call mints new links. A refused redirect, a link the tool does not fetch (`unsupported_url` — not http(s), or carrying credentials) and a failed write (`write_failed`) are `runtime` and not retryable, and a refused plain-http link is `config` as above. A code the SDK adds later reads as a retryable `runtime` fault.

The structured output is:

```ts
{
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";   // mirrors mthds_run_results
  retry_after_seconds?: number | null;          // state=running only
  run_status?: RunStatus;                       // state=failed only
  failure_message?: string;                     // state=failed only
  failure?: RunFailure;                         // state=failed only, when the run stored an error report — as on the results tool
  scope?: "main_stuff" | "working_memory";      // state=completed only — what was walked; always "main_stuff" here
  output?: {                                    // state=completed, and every refusal of the file download — the main output, saved first
    path: string;                               // where main_stuff.json was written, relative to the working directory
    size: number;                               // bytes written
  };
  artifacts?: Array<{                           // state=completed — one per storage reference, in discovery order; its length is the count walked. Also on a credential refused after some files were saved
    uri: string;                                // the pipelex-storage:// reference found in the output
    found_at: string[];                         // the $-rooted paths in main_stuff.json where the reference sits, in walk order, at most `MAX_FOUND_AT_PATHS` (8); the first named the file — on both arms
    found_at_omitted?: number;                  // how many further paths found_at leaves out; absent when it lists them all
    path?: string;                              // where it was saved, relative to the working directory — on success
    content_type?: string | null;               // the platform's content type from the reference; null when it has none
    size?: number;                              // bytes written
    error?: ToolError;                          // per-item failure
  }>;
  saved_paths?: string[];                       // wherever output is — every file written: main_stuff.json first, then the saved artifacts
  all_saved?: boolean;                          // state=completed only — the output and every reference saved
  errors?: ToolError[];                         // no-verdict only
}
```

**Verdict discipline**, consistent with the run family: once the run has been read, the result is produced (`status: "ok"`), discriminated on `state`; once the per-file walk has run, `all_saved` is the produced discriminator for the walk. **Partial success is a produced verdict, not an error** — the output and the files that landed are on disk and useful, and a sibling's failure must not hide them. The output itself is always saved by the time a verdict exists, so `all_saved` turns on the files. `status: "error"` + `errors[]` is reserved for no-verdict conditions: a blank `run_id` or a bad `dir` (`input_domain`), an output that could not be written (`input_domain` at `dir`, not retryable, and nothing downloaded), an answered run id that cannot name the default folder (`runtime` at `run_id`), an unknown `run_id` (the results route's 404, `input_domain` at `run_id`), a missing or rejected credential, a paywall (`kind: "paywall"`), an unreachable API or a bare runner without the run lifecycle (`config`), and a malformed report (`runtime`). The bulk resolve route adds its whole-request refusals, which are about the caller or the deployment rather than any reference: a deployment that does not serve the route (a `404` — the bare `pipelex-api` runner has no resolve route at all, and a hosted deployment that predates the bulk route answers the same; `config` at `PIPELEX_BASE_URL`, naming the route), a key acting for no organization (a `400`, `config`, with a hint to use a key minted in the run's organization), a credential the route refuses (`401`/`403`, `config` at the key, like every auth failure), a paywall, and a signing failure (a `5xx`, retryable `runtime`). Every one of those refusals — and any other failure of the download itself, an unreachable API included — arrives after the output was written, so each carries `output` and `saved_paths` beside the `errors[]`, and its headline speaks of the run's *files* not being saved rather than the run. A credential refused part-way through a download — possible only when a link expires mid-set and its re-resolution is refused — also leaves the files saved before it on disk: the SDK hands them back on the error, and they ride the result as `artifacts` and in `saved_paths`, with the summary naming them too. A credential refused before any file was saved carries no `artifacts`: the SDK's verdict there is nothing but aborted items, each inviting a retry the refusal itself rules out. `state` and `all_saved` stay absent, because no verdict was produced and nothing here may read as one; a consumer that could only parse the prose would otherwise call again and get suffixed copies of files it already has. Per-item errors are classified as above.

**Summary.** The saved paths are deliberately repeated in the prose (the `mthds_inputs_template` pattern — they are what the agent must report), with the working directory named once so the paths read as locations, `main_stuff.json` first with its size, each file's content type, size and the field it fills (its first path, with a count of any others), and the never-overwrite rule stated. A file that failed is named by its field and its reference. It ends by telling the model to read the output from the file rather than retype it. Per-item failures ride here too, since they are not in the top-level `errors[]`. A completed run whose output references no stored file says that the output is the whole run.

**Live coverage.** The hermetic suite runs the tool over a mocked SDK client — a fake `getRunResult` and a fake `downloadArtifacts` that writes into the directory it is handed — against a real temp working directory, so the containment, the directory creation, the relative-path reporting and the classification of every SDK outcome are exercised on disk. The fake names and locates each file with the SDK's own `artifactFilename` and `locateArtifacts`, so its names and `found_at` are the released SDK's rather than a copy of them. The download boundary itself, the filename rule, the never-overwrite rule and the caps are the SDK's, proven there on the wire and on disk. The live leg, `artifacts.e2e.ts`, has a free half that refuses an unknown run id before anything is written, and a paid half, in the run family's tier, that saves a completed run of the published `text_stats` package and compares `main_stuff.json` with the unbounded output the platform holds. That run references no stored file, so the bulk resolve route is not reached there: a run that produces one costs an image generation, which the suite does not buy on every paid run.

### Workshop tools at a glance

**Tool: `mthds_list_methods`**

- **Input**: `{ query?, limit?, cursor? }` — trimmed case-insensitive search applied server-side, bounded page size, opaque continuation cursor (see Catalog Discovery Scope).
- **Output**: `{ status, returned_count?, next_cursor?, methods?, errors? }` in `structuredContent`, plus a bounded text summary that opens with a render directive (report each method with its name **and** description) and then repeats names, descriptions, ids, and cursor guidance. No method source, stored inputs/outputs, org/user ids, `_meta`, or view payload.
- **Behavior**: Asks the platform for one page of the active key's organization catalog through the SDK, immediately validates and projects the rows it returns, and treats empty catalogs and no-match queries as success. Listing executes nothing; a returned id can be passed to `mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs` and `mthds_run`.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none — bounded catalog metadata is read directly by the model.

**Tool: `mthds_models`**

- **Input**: `{ category?, reference? }` — a category narrows either use; without `reference` the tool lists the deck, and with it, it checks that reference (see Model Deck Scope).
- **Output**: `{ status, category?, deck?, reference?, kind?, resolution?, matches?, suggestions?, other_kinds?, other_categories?, errors? }` in `structuredContent`, plus a text summary that repeats the deck by category or states the check's answer, and says that the deck is what the runner can serve rather than what the account may use. No `_meta`, no `available_view_specs`.
- **Behavior**: Reads `GET /v1/models` through the SDK, passing the category on a listing and reading the whole deck on a check. A preset, alias or waterfall the deck lacks is `not_found`; a bare handle no alias or waterfall names is `unconfirmed`, never `not_found`. A miss carries the nearest names, the same name under another sigil and, when a category was named, the categories where the reference resolves.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none.

**Tool: `mthds_validate`**

- **Input**: `{ files?, method_ref?, method_id?, graph_page? }` — exactly one of `files` / `method_ref` / `method_id` (see Method Selectors and Validation Scope)
- **Output**: `{ status, is_valid, is_runnable, pending_signatures, available_view_specs, main_pipe?, graph_page?, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content` carrying the rendered signature line and, when the page was written or tried, a `## Method graph` section. The workshop renders no views, so no graph or form artifact rides `_meta` and `available_view_specs` is always empty. `main_pipe` is the main pipe's typed signature, the one thing a valid verdict puts in the model's context beyond the verdict itself (see Validation Scope).
- **Behavior**: Validates request shape, calls the Pipelex API against `PIPELEX_BASE_URL` or `https://api.pipelex.com` with signatures and markdown enabled, and maps produced validation verdicts into flattened structured content, projecting the main pipe's signature from the report's per-pipe IO contracts. A `method_ref` or `method_id` is a server pass-through on `POST /v1/validate` itself — the runner resolves the address, the hosted platform resolves the id; nothing is expanded client-side. When every file came as `{ path }`, it writes `method-graph.html` beside them unless `graph_page` is false (see The method graph page).
- **Annotations**: Not read-only (it writes the method graph page), non-destructive (it replaces only a page carrying its own mark), no open-world publishing.
- **View**: none — the flowchart is the page on disk.

**Tool: `mthds_inputs_template`**

- **Input**: `{ files?, method_ref?, method_id?, pipe_ref?, explicit?, format? }` — exactly one of `files` / `method_ref` / `method_id` (see Method Selectors and Inputs Template Scope)
- **Output**: `{ status, is_valid, pipe_ref?, format?, explicit?, inputs?, inputs_toml?, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content` that includes the template in a fenced code block and, after it, the next step: fill it in (converting a TOML template to a JSON object) and call `mthds_prepare_inputs`, or go straight to `mthds_run` when every file value is already a URL or a storage reference. No `_meta`, no `available_view_specs`.
- **Behavior**: Validates request shape, calls `POST /v1/pipe-io` against `PIPELEX_BASE_URL` or `https://api.pipelex.com` (adapting `uri` → `source`) for the one pipe, projects the template client-side from that pipe's input-form descriptor, and maps the produced verdict into flattened structured content with the same `status`/`is_valid` discipline as `mthds_validate`. Every selector is a server pass-through — the runner resolves an address, the hosted platform resolves an id; nothing is expanded client-side.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none — the template is small structured data the model reads directly.

**Tool: `mthds_codegen`**

- **Input**: `{ files?, method_ref?, method_id?, target, output_dir? }` — exactly one of `files` / `method_ref` / `method_id`, plus the required `target` and an optional `output_dir` (see Method Selectors and Codegen Scope)
- **Output**: `{ status, is_valid, target?, kind?, crate_fingerprint?, engine_version?, artifacts?, lock?, truncated?, output_dir?, is_current?, orphans?, orphans_truncated?, drifts?, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content`. Without `output_dir` the summary repeats every artifact and the lock in fenced blocks tagged for their language; on the written arm it carries no content and no fenced blocks, only where the files landed and the check verdict. No `_meta`, no `available_view_specs`.
- **Behavior**: Validates request shape, calls `POST /v1/codegen` with `kind: "types"` and the requested `target` (never a `pipe_ref`), and projects the produced verdict with the same `status`/`is_valid` discipline as `mthds_inputs_template`. Every selector is a server pass-through — the runner resolves an address, the hosted platform resolves an id. Every valid response is preflighted through the SDK's `runCodegenCheck` before it is written or relayed. Without `output_dir`, artifacts and the lock ride the response verbatim, bounded by whole file with the lock's bytes reserved first. With `output_dir`, the tree is written to disk — stamped files overwritten, anything else refusing the whole write — and content is withheld from every stream.
- **Annotations**: NOT read-only (`readOnlyHint: false` — it can write) and **destructive** (`destructiveHint: true`) — regeneration overwrites the stamped files it wrote before and discards hand-edits below the stamp, which is a destructive update rather than an additive one, and this is the hint a host reads to decide whether to confirm before calling. No open-world publishing. Contrast `mthds_download_artifacts`, which stays non-destructive because it never overwrites.
- **View**: none — decided out; the fenced blocks in the summary serve the copy-out case on every host.

**Tool: `mthds_prepare_inputs`**

- **Input**: `{ files?, method_ref?, method_id?, pipe_ref?, inputs }` — exactly one of `files` / `method_ref` / `method_id` (see Method Selectors), plus the filled `inputs` (see Prepare Inputs Scope)
- **Output**: `{ status, is_valid, pipe_ref?, inputs?, uploads?, errors? }` in `structuredContent`, plus a text summary in MCP `content` that repeats the prepared `inputs` in a fenced code block. No `_meta`, no `available_view_specs`.
- **Behavior**: Resolves the pipe's declared signature from the input-form descriptor (one `POST /v1/pipe-io` for the one pipe, with no dry run, whatever the selector), uploads file-bearing input values to Pipelex storage, and rewrites them to `pipelex-storage://` (wrapping `@pipelex/sdk`'s `prepareInputs`); `http(s)` / `pipelex-storage://` values pass through unchanged. Uploads with the user's key. An unresolvable closure is a no-verdict error (the SDK throws without a structured verdict).
- **Annotations**: NOT read-only (`readOnlyHint: false` — it uploads), non-destructive, no open-world publishing.
- **View**: none — the prepared inputs are small structured data the model reads directly.

**Tool: `mthds_run`**

- **Input**: `{ files?, method_ref?, method_id?, pipe_code?, inputs? }` — at least one run source; `method_ref` pairs with nothing, `files` + `method_id` is legal (see Method Selectors and Run Scope)
- **Output**: `{ status, run_id?, run_status?, created_at?, method_provenance?, available_view_specs, errors? }` in `structuredContent`, plus a start-ack text summary in MCP `content` with the run id and follow-up etiquette (and the resolved provenance on a `method_ref` run).
- **Behavior**: Validates request shape, then starts a durable run via `POST /v1/start` (fire-and-forget 202) — from inline files, from a published method's address by `method_ref` (server-resolved at the tag, provenance returned), or from a registered method's current stored content by `method_id` (files win when both are supplied; the id then rides as run-history linkage — see Run Scope). Never blocks on the result.
- **Annotations**: NOT read-only (`readOnlyHint: false`), non-destructive, no open-world publishing. The description states it executes the method on the hosted API and spends inference credit.
- **View**: none; `available_view_specs` is always empty here.

**Tool: `mthds_run_status`**

- **Input**: `{ run_id }`
- **Output**: `{ status, run_id?, run_status?, is_terminal?, degraded?, retry_after_seconds?, created_at?, finished_at?, failure?, errors? }` in `structuredContent`, plus a text summary with a check-again hint while non-terminal, and why the run failed once it ended without completing.
- **Behavior**: One cheap self-healing status read (`GET /v1/runs/{id}/status`). A terminal non-COMPLETED status is a produced verdict, not an error, and carries the run's stored error report as `failure` (see "A failed run says why").
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none.

**Tool: `mthds_run_results`**

- **Input**: `{ run_id }`
- **Output**: `{ status, run_id?, state?, retry_after_seconds?, run_status?, failure_message?, failure?, main_stuff?, truncated?, image_candidates?, usage?, available_view_specs, errors? }` in `structuredContent`, plus a text summary that on `completed` repeats the bounded main output in a fenced code block. The workshop carries no executed graph, and `available_view_specs` is always empty.
- **Behavior**: One-shot result lookup (`GET /v1/runs/{id}/results`), discriminated on `state`: `running` (with retry hint), `completed` (bounded `main_stuff` + `truncated` flag), `failed` (terminal status, the platform's failure message and the `failure` report, read from a status read of the run when the arm carries none; no graph exists for failed runs). On `completed` it also reports the free stored-file inventory — `image_candidates` and one merged prose sentence naming `mthds_show_images` — walking the full output in memory and **fetching nothing**; the summary also names `mthds_download_artifacts` on every completed result, as the way to keep the run and, when the output was truncated, to read the rest. The read names the artifacts it wants (`?artifacts=`), so the platform reads and re-signs only what the tool projects: the main output and the usage records; the working memory is never read.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none.

**Tool: `mthds_show_images`**

- **Input**: `{ run_id, images?, indices? }` — the selection fields are mutually exclusive; omitting both shows every candidate (see Image Display Scope)
- **Output**: `{ status, run_id?, state?, retry_after_seconds?, run_status?, failure_message?, failure?, images?, omitted?, all_inlined?, errors? }` in `structuredContent`, plus a text summary and, after it, one MCP **image content block** per inlined picture: `{ type: "image", data, mimeType, _meta: { uri } }` and **never `annotations`** (Codex refuses an annotated block). No view, no `_meta` on the result itself, no `available_view_specs`.
- **Behavior**: Reads the run through the results route, asking for the main output alone, prefilters the stored references by storage key, intersects the caller's selection with what the run produced, then fetches each surviving candidate through the SDK's bounded `fetchArtifact` under a per-image cap, a per-call budget and a per-call attempt count. The content-type gate is the object store's own header. A picture that does not fit is `withheld` with its reason; a per-reference failure is an `error` value; partial success is a produced verdict.
- **Annotations**: Read-only (it writes nothing anywhere — what it changes is the conversation, which the description says), non-destructive, no open-world publishing (the link it fetches is the configured API's own answer).

**Tool: `mthds_download_artifacts`**

- **Input**: `{ run_id, dir? }` — the durable run id, and optionally a directory relative to the server's working directory to save into; omitted, `runs/<run_id>`, and `"."` for the working directory itself (see Artifact Download Scope).
- **Output**: `{ status, run_id?, state?, retry_after_seconds?, run_status?, failure_message?, failure?, scope?, output?, artifacts?, saved_paths?, all_saved?, errors? }` in `structuredContent`, plus a text summary that repeats the saved paths (relative to the working directory, which it names once) and any per-file failure. No `_meta`, no `available_view_specs`.
- **Behavior**: Reads the run (`GET /v1/runs/{id}/results`, asking for the main output alone, the one artifact it writes and walks) and branches on its state like `mthds_run_results`; on `completed`, writes the full main output verbatim as `main_stuff.json` in the target directory, then walks it for `pipelex-storage://` references and hands the results to the SDK's `downloadArtifacts`, which resolves them to fresh presigned links in one call to `POST /v1/resolve-storage-url/bulk` and streams the bytes into files under the working directory within the SDK's download boundary (http(s) only with plain http under the base-URL rule, no redirects, bounded timeout, per-file and per-call byte caps, no partial file left behind). Each file is named after the field it fills (the first path in its `found_at`, the storage key supplying only the extension) and never overwrites an existing file; the directory is real-path-contained on both sides of `mkdir` before the SDK writes into it. Partial success is a produced verdict.
- **Annotations**: NOT read-only (`readOnlyHint: false` — it writes files), non-destructive (it never overwrites), no open-world publishing (it fetches only links the configured Pipelex API minted).
- **View**: none — the saved paths are small structured data the model reports directly.

**Tool: `mthds_save_method`** and **Tool: `mthds_get_method`** — stated in full in Catalog Write Scope.

## Non-Goals

The server must not add Pipelex Hosted API deployment behavior, blocking execution (`POST /v1/execute` or the SDK's blocking wrappers), run cancellation, resources, logs, package publishing (of MTHDS method packages to a registry — not this server's own npm distribution, which is how the workshop ships), subprocess fallbacks, or a production validation UI. Filesystem access is scoped: the workshop reads exactly the `{ path }` and `{ path }`-shaped items submitted to it and writes only saved runs — a completed run's main output and the files it references (`mthds_download_artifacts`) — generated trees (`mthds_codegen`'s `output_dir`), a pulled method's sources (`mthds_get_method`'s `output_dir`), the link file both catalog-write tools leave beside a bundle, and the method graph page `mthds_validate` leaves beside the `{ path }` files it validated, within its trust boundaries. The workshop registers no views at launch (tools-first — see What the workshop registers); local view delivery is a later increment gated on self-contained view bundles. `mthds_prepare_inputs` (see Prepare Inputs Scope) now covers turning file-bearing inputs into run-ready `pipelex-storage://` references, from local paths/bytes/`data:` URLs using the user's key. What stays out of scope beside it:

- **Inline asset bytes in tool arguments remain out of scope.** Nothing may **accept** base64 as an argument, because bytes in an argument pass through the model's context. Per-user auth settles *whose* storage an upload targets; it never settled the context-cost concern. Returning base64 has one deliberate exception, the image tool (see Image Display Scope): an MCP image content block is base64 in the result, it is the only way a host can show a model a picture, and it is the reason the gesture is a tool of its own rather than a default on any other surface — the caller chooses the permanent context cost, it is bounded by named caps, and the results tool is not changed by it.
- **Opt-in `http(s)`→storage ingest** for ordinary user-pasted URLs stays parked — an `http(s)` URL at a file position passes through unchanged, and ingesting it is a later, additive SDK feature.

Method access by selector is in scope (`method_ref` and `method_id` per the Method Selectors table), server-resolved on every tool that takes them. Catalog listing is in scope through `mthds_list_methods`, and **three of the exclusions that stood beside it have ended**: method source retrieval, catalog create/update, and a save tool are served by `mthds_save_method` and `mthds_get_method` (see Catalog Write Scope). What remains out of scope for this increment: **delete** — the platform makes it admin-only, it erases every run the method produced, and it stays a webapp gesture; **dynamic per-method tool projection**; and **stored-`input_data` defaulting**, which the save tool preserves on an update precisely so that it never has to read it. The catalog's human surface is still the webapp's: these two tools exist so that a bundle authored on disk can reach the catalog and come back, not so that the catalog can be administered from a conversation. Code generation is in scope through `mthds_codegen` (see Codegen Scope), and only that: no `mthds_resolve` tool (the crate itself is not something a model reads), no `codegen check` tool (the check is offline by design — a workshop agent runs `pipelex codegen check` or the SDK's `runCodegenCheck` directly), no per-pipe kinds until the engine serves them, no JSON Schema target until the engine has one (a cross-repo cascade, not an MCP composition of the per-pipe `build/output` schemas), no reformatting of artifacts, no deletion of orphaned generated files (they are reported and left on disk), and no detection or reporting of hand-edits before an overwrite (a stamped file is this tool's, edited or not).

Repository quality gates are in scope: ESLint, Prettier, TypeScript type checking, Vitest unit tests, and a combined `npm run check` command should remain available locally.

The prototype should call the Pipelex API (local OSS `pipelex-api` during development) only through `@pipelex/sdk`'s `PipelexApiClient`; it should not expose API internals such as `mthds_contents` or `mthds_sources` in the MCP schema.

## UX Flows

Discover a registered method:

1. When the user asks what saved methods exist or names one without an id, the assistant calls `mthds_list_methods`, with a focused `query` when possible.
2. One strong match supplies its canonical `method_id`; several plausible matches are presented by bounded name/description for the user to choose; no matches are reported without inventing an id.
3. A listed row is never presented as a validation or runnable verdict — the listing carries no such signal. A method whose stored source is missing surfaces that at the point of use, as an `input_domain` no-verdict at `method_id` from a by-id validate, template, prepare or run.
4. The chosen id feeds the flow: optionally `mthds_validate`, then `mthds_inputs_template` → fill and prepare the inputs → `mthds_run`.

Validate MTHDS files:

1. The user asks the assistant to validate one or more `.mthds` files.
2. The assistant submits the files to `mthds_validate` — `{ path }` items, or inline contents with optional provenance URIs (see The files union).
3. The tool returns structured validation facts plus a text summary that the assistant can use to repair the files. For `{ path }` files it has also written the method's flowchart, `method-graph.html`, beside them, and says where; the assistant tells the user where to open it when they want to see the method.
4. The assistant may repeat the same flow after editing the submitted source content, which rewrites the page.

Name a model in a method:

1. The user names a model while the assistant writes or edits a method, or asks which models a pipe can use.
2. The assistant calls `mthds_models` with the pipe's category to see the deck and offers a preset where one fits; a pipe the user named no model for keeps no `model` field.
3. For a reference the user typed, the assistant calls `mthds_models` with `reference`. On `not_found` it offers the nearest names or the right sigil; on `unconfirmed` it writes the handle and lets validation check it.
4. The assistant validates the method, which checks every reference against the runner's full model list. A run can still be refused a listed model by the account's gateway, which the tool has said.

Prepare inputs for a method:

1. The user asks the assistant to prepare inputs for a `.mthds` method (or a skill needs the method's input schema).
2. The assistant submits the files (and optionally a qualified `pipe_ref`) to `mthds_inputs_template` — the same file forms as validation, or the method's `method_ref` or `method_id`.
3. The tool returns the fill-in template plus the resolved pipe, which the assistant fills with user data, synthetic data, or placeholders.
4. On an invalid closure, the tool returns the validation errors instead; the assistant can repair via the validation flow and retry.

Generate typed code for a method:

1. The user asks for types or models for a method in their project, or an assistant building a consumer needs them — a TypeScript app reading run results, a Python service, a Pipelex host.
2. The assistant picks the target from the project (the user's explicit request wins: a TypeScript or JavaScript project wants `ts-zod`, a Python consumer `python-pydantic`, a Pipelex host or `@pipe_func` implementation `python-structures`) and calls `mthds_codegen` with the files, a `method_ref` address, or a `method_id`.
3. **It passes `output_dir`** — a dedicated generated directory such as `src/generated/<method>/`. The tool writes the artifacts and `codegen.lock` there verbatim, reports where each landed and whether the offline check finds the tree current, and returns no file content at all. Regeneration into the same directory overwrites the stamped files it wrote before; a foreign file there refuses the whole write instructively.
4. **Without `output_dir`**, when the assistant wants the bytes, the tool returns the stamped artifacts and `codegen.lock`; the assistant writes each artifact at its path and the lock beside them, verbatim, into a dedicated generated directory. `pipelex codegen check` (or the SDK's `runCodegenCheck`) then passes on that tree.
5. On an unresolvable closure the tool returns the validation errors instead; the assistant repairs via the validation flow and retries. A set too large for the response is withheld by whole file (`truncated: true`); the assistant passes `output_dir`, or generates locally with the CLI, rather than writing a partial file.

Prepare filled inputs for a run:

1. After filling the `mthds_inputs_template` output, the assistant calls `mthds_prepare_inputs` with the same selector it templated from — the same files, the same `method_ref` address, or the same `method_id` — plus the pipe and the filled `inputs`.
2. File-bearing values (local paths, `data:` URLs, bytes) are uploaded with the user's key and rewritten to `pipelex-storage://`; `http(s)` and `pipelex-storage://` values pass through unchanged.
3. The assistant passes the prepared `inputs` straight to `mthds_run`. An inputs set that is already all pass-through can skip this step. An unresolvable closure is a no-verdict error; the assistant repairs via the validation flow and retries.

Run a method durably:

1. The user asks the assistant to run a `.mthds` method (usually after validating it and filling the inputs template).
2. The assistant submits the files (or an address or an id), the pipe to run, and the filled inputs to `mthds_run`; the tool returns the durable `run_id` immediately.
3. The assistant checks on the run with `mthds_run_status` when asked (honoring the retry hint rather than spin-polling); once the run is terminal it reports through `mthds_run_results`, and `mthds_show_images` shows a picture the run produced when someone asks to see it.
4. Days later, the same `run_id` still answers `mthds_run_status` / `mthds_run_results` — the run is durable and the MCP is stateless.

Save a run's produced files to disk:

1. A completed run's results carry its main output, and any produced image, PDF or document in it as content with a `pipelex-storage://` reference beside a presigned `public_url` that expires within the hour. The results summary names `mthds_download_artifacts` as the way to keep the run, and counts those references when there are any.
2. The assistant calls `mthds_download_artifacts` with the run id (optionally a `dir` relative to the working directory; by default the run lands in `runs/<run_id>/`). The tool writes the full output as `main_stuff.json`, walks it for references, resolves them to fresh links through the API, and saves the files beside it — never overwriting, suffixing on collision.
3. The assistant reports the saved paths. Days later, the same call with the same run id still works; no presigned link is ever the thing the user has to catch in time.

Run a registered method by reference:

1. The user names a registered method. If no catalog id (`mt_…`) is supplied, the assistant resolves it in-band with `mthds_list_methods` and disambiguates by name/description when necessary.
2. The assistant may first call `mthds_validate` with `method_id` (no files) to confirm the stored method's current content still validates — e.g. after a suspected edit — getting the same structured verdict as a files-based call, with no bundle entering the conversation.
3. The assistant calls `mthds_inputs_template` with `method_id` (no files) and fills the returned template with user data.
4. The assistant calls `mthds_run` with `method_id` and the filled `inputs` — no bundle ever enters the conversation, and the run executes the method's current stored content.
5. Everything downstream is unchanged: `mthds_run_status` and `mthds_run_results` operate on the durable `run_id` and don't care how the run started.

Run a published method by address:

1. The user pastes or names a method address — `github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0`. Nothing needs discovering: the address is the reference, no catalog and no id.
2. The assistant calls `mthds_inputs_template` with `method_ref` (no files) and fills the returned template with user data. It may first call `mthds_validate` with `method_ref` for a structured verdict — the server fetches the package either way, so no bundle enters the conversation.
3. The assistant calls `mthds_run` with `method_ref` and the filled `inputs`. The start ack carries `method_provenance` — the address, the tag, and the commit SHA that was actually fetched — which the assistant can report so the run stays explainable if the tag later moves.
4. Everything downstream is unchanged: `mthds_run_status` and `mthds_run_results` operate on the durable `run_id`.
