# Candidate strategy: dual-server "conducted views" (local tools + hosted views on one host)

Status: **candidate under consideration — recorded 2026-07-21, not decided, not scheduled.** Captured mid-conversation so the train of thought isn't lost; no implementation implied. Part of the dual-deployment series (read `README.md` first).

## The idea

Connect **both** servers to the same view-rendering workshop host (ChatGPT desktop in Codex mode, Cowork) and let the **Pipelex skill conduct them**:

1. The **local workshop** (stdio, plugin-installed) does the heavy iterate/repair loop — `mthds_validate` with `{ path }`, so file contents never cross the LLM (the whole point of the workshop, per `dual-deployment-assessment.md` §1's latency split).
2. The **hosted console** (https connector, BYOK key) supplies the **views** — its `run-graph` / `run-follow` iframes load their JS/CSS from the public https origin, which V1 proved these hosts render fine ("Codex-via-hosted" ✓ in doc 4 §4). The localhost-origin penalty never applies because no view asset ever comes from localhost.

Best of both worlds: workshop-grade file efficiency, console-grade visuals — **without waiting on self-contained view bundles** (Fred's reply gates nothing here; the view keeps coming from the origin that already works).

## Why it's plausible (evidence already in hand)

- Codex mode renders console views over https (V1 matrix, doc 4 §4) and supports multiple MCP servers side by side, namespaced per server.
- Both servers already register identical tool names by design, so the skill addresses them via the host's per-server namespacing — no tool-contract fork.
- BYOK (0.5.0) gives the hosted connector per-user auth today (`?api_key=` / Bearer header).

## The one hard constraint: a view is bound to its own tool call

A view renders from the `_meta` of **the hosted tool's own result**. There is no channel for the agent to hand local data to a hosted view directly — whatever the view shows must flow through the hosted server so it can ride `_meta`. Two ways to feed it:

### Variant A — re-submit inline (works today, zero server code)

When the user should see the graph, the skill has the agent call the **hosted** `mthds_validate` with `{ content, uri }` items (the console accepts that form already). Cost: contents cross the LLM once for the view call, and validation runs twice. Often acceptable — after an edit loop the contents are frequently in context anyway; the frequent repair loop stays on cheap `{ path }` calls. Pure skill-authoring change + a second connector in the host config.

### Variant A′ — static client-side render (recorded 2026-07-21; supersedes A as the preferred cheap variant)

`mthds-ui`'s static-graph module (`buildStaticGraphSpecFromToml` — pure TS, no React, no filesystem; proven in the VS Code extension) lets the **view build the graph client-side from raw `.mthds` TOML**, emitting a `GraphSpec` with `meta.mode: "static"` that the existing `GraphViewer` renders unchanged. This removes the validation API from the view moment entirely:

- New trivial hosted tool (e.g. `mthds_show_graph(files)`): accepts inline contents, essentially echoes them to the view; the iframe parses + renders. No `/v1/validate` call, no double validation.
- **Renders broken/WIP bundles** — the static walk is best-effort by design, so the graph shows mid-repair, a state the validation-derived `graph_spec` can never cover (invalid verdicts produce no graph).
- **Plausibly keyless** — a pure-echo tool never touches the Pipelex API, so even a BYOK-keyless console connection could render.
- Unchanged: the bundle text still crosses the LLM once per view moment (the irreducible cost absent a by-reference channel); the repair loop stays on local `{ path }` calls.
- Positioning (**decided 2026-07-21**): the static graph is the **default** — "display this method" renders the static graph from bundle source, no validation involved. The validation-issued graph (`graph_spec` from the dry run) **must remain available on demand** — it is the authoritative post-validation picture (resolved refs, runnability) — surfaced when the user asks for the validated view or as part of a validation verdict, via the existing hosted `mthds_validate` view path (inline today, by-reference under Variant B). Both feed the same `GraphViewer`; `meta.mode` distinguishes them.
- Local-side bonus: the workshop could import the same React-free module to compute specs locally with zero API calls — the producer side of a future by-reference push, and an ingredient for the self-contained-bundle local-view increment.

### Variant B — render by reference (the elegant one, needs new code)

The local validate stores its dry-run artifact server-side (the Pipelex API is the natural rendezvous — both servers already talk to it), returning a small reference id. A new hosted tool (e.g. `mthds_show_graph(ref)`) fetches the graph spec by id and ships it in its `_meta` for the view. Only a tiny id crosses model context — the "model never pays for the graph" invariant holds end to end. Needs API-side storage of validation artifacts + one hosted tool. The **run family is already halfway there**: runs have durable ids and views re-resolve by id (SPEC.md run scope); this extends the same pattern to dry-run artifacts. Kinship: catalog run-by-reference (README decision list) — same fetch-and-forward philosophy.

## Tension with a recorded decision

The series decided **"One host, one server — never both"** (README §Decisions; motivated by the claude.ai-connector-syncs-into-Claude-Code trap). This strategy deliberately revisits that rule for the *view-rendering workshop hosts only*: there, two servers with distinct roles (tools vs views) conducted by the skill is the feature, not the trap. If adopted, the rule should be rescoped: "one server per role per host; never two servers doing the same job" — and the connector-sync warning stays for the hosts where duplication is accidental.

## Caveats

- Only pays off on view-rendering workshop hosts (**Codex, Cowork**). Claude Code, Cursor, Vibe TUI: hosted connector adds nothing visual — the skill must degrade to local-only.
- Identical tool names on both servers means the skill must be explicit about which server's tool to call at each step, or the agent picks arbitrarily.
- Two places to configure the same `plx_sk_` key (workshop `PIPELEX_API_KEY` env + console BYOK connector param) until console OAuth lands — document it.
- Variant A's double-validation cost and inline-content cost should be measured against the latency numbers in `dual-deployment-assessment.md` §1 before claiming the UX win.

## Cheapest next step (when picked up)

Variant A needs no code: add the hosted console as a second connector in a Codex config alongside the plugin's workshop, edit the skill to conduct (local `{ path }` validate for the loop, hosted inline validate for the view moment), and verify the choreography live. That experiment also de-risks Variant B's host-side assumptions before any API work.
