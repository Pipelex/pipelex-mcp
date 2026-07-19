# Methods as tools: dynamic per-user tool projection on the hosted console

Status: design direction, agreed. Third document in the dual-deployment series — reads on top of `wip/dual-deployment-assessment.md` (the two-server decision) and `wip/build-vs-run-dimension.md` (the workshop/console lifecycle split and the catalog bridge). Feeds the same upcoming SPEC.md increment.

## 1. The thesis

A registered method **is** a tool. It has a name, a human description (the catalog's read-time derived `description`), a typed input contract (the same projection that powers `mthds_inputs_template`), and a defined output (the pipe's output concept). Once a user has a handful of methods in the platform catalog, their agent should treat them the way it treats any other tool: know they exist, know what they take and produce, and **take the initiative** to run them when a task calls for it.

Listing methods through a catalog tool (`list`/`get`) answers questions the agent already thought to ask. The goal here is stronger: the agent should be *already aware* — the way it is aware of registered MCP tools and skill stubs — without a listing round trip.

## 2. The mechanism: per-session tool lists, not per-user servers

An MCP server's tool list is not static. It is served per connection, after the handshake, and the protocol's `listChanged` notification lets it update mid-session. The hosted console already authenticates the user and resolves their active org (the OAuth + org-context work on the critical path per the build-vs-run doc). So the server can answer `tools/list` **dynamically**: enumerate the user's catalog and project each (exposed) method as its own MCP tool.

Per projected tool:

- **Name**: derived from the method name, sanitized to MCP tool-name constraints, with a collision policy (methods are org-shared, so names can clash across the catalog).
- **Description**: the catalog's derived `description` (parsed from the bundle's top-level TOML `description`), plus a standard suffix stating what running it entails (executes on the hosted API, spends inference credit — the same honesty `mthds_run` carries).
- **Input schema**: derived from the method's input contract — the concept-level projection behind `/v1/build/inputs`, converted to JSON Schema.
- **Output description**: from the pipe's output concept, so the agent knows what it gets back before calling.
- **Behavior**: a projected tool call is a run-by-reference — the server resolves the stored bundle server-side and starts a durable run (the fetch-and-forward mechanism from the build-vs-run doc). The projected tool can register the same `run-follow` view as `mthds_run`, so running a method through its own tool still gets the live card and the completion handoff.

This is the strongest form of the awareness because it is **live**: no staleness, no sync artifacts, no per-machine state. The list reflects the catalog at connection time and can follow it via `listChanged`. One deployment, one URL — personalization happens at the protocol layer, not the infrastructure layer.

Hosts inject registered tools' names, descriptions, and schemas into the model's context up front. That is exactly the property that lets an agent act unprompted — "I have an `invoice_extractor` tool; this task calls for it" — and it is the same mechanism that makes skills and MCP servers discoverable in the first place. Methods simply join the club.

## 3. The awareness gradient (and the shipping sequence)

There is a spectrum of "how present is the catalog in the agent's mind," and it doubles as the incremental shipping plan:

1. **Tool-description nudges** (available now, costs nothing): the catalog `list` tool's description says to call it at the start of any task one of the user's saved methods might solve. Soft power, reactive, but free.
2. **Catalog-in-instructions** (cheap middle step): the server `instructions` string is delivered per session, after auth — embed a compact catalog summary (method names + one-line descriptions, no schemas). A few hundred tokens, staleness bounded by the session. Ships before schema derivation exists.
3. **Full dynamic tool projection** (the destination): each exposed method becomes a first-class tool as described above. Gated on the OAuth/org milestone and on the concept→JSON-Schema projection.
4. **Curation** (when real catalogs grow): an "expose as tool" flag or favorites mechanism so a user with a large catalog doesn't blow the host's tool budget — the exposed few become tools, the rest stay reachable through `list`/`get`. This mirrors how skills solved the same economics: terse stub always present, detail on demand.

The generic tools (`mthds_validate`, `mthds_inputs_template`, `mthds_run`, `mthds_run_status`, `mthds_run_results`, plus catalog `list`/`get`) remain registered throughout — projection adds tools, it never replaces the contract surface.

## 4. Constraints that shape the design

- **Context budget and host tool caps.** Every projected schema costs context, and hosts cap tool counts. Curation (above) is the answer; the default for a small catalog can be expose-everything, flipping to opt-in as it grows.
- **Host asymmetry.** claude.ai connectors and Claude Code handle dynamic, per-user tool lists well. The ChatGPT **apps directory** likely expects a stable, reviewed tool list — per-user projection may not be directory-compatible. Plan: ship projection on the Claude side first; ChatGPT keeps the generic tools plus catalog-in-instructions until the policy picture is verified (live check needed before the SPEC increment commits).
- **Schema derivation is the real work.** Concept→JSON-Schema conversion plus honest descriptions decide whether a projected tool is *usable*, not just present. Open design question: does this projection belong in the platform (a "method as tool spec" read route) or in the MCP server (composing existing routes)? Platform-side is reusable by other consumers (webapp, future publishing products); MCP-side ships without a platform change.
- **Quality pressure on authoring — a feature, not a bug.** A method's tool-worthiness is exactly the quality of its MTHDS metadata (`description`, input concepts, output concept). The MTHDS language already carries everything needed; the workshop side (build skills, validation summaries) can start nudging authors toward tool-grade descriptions. "A well-authored method is already a well-defined tool" is the product line.
- **Naming.** Projected tool names must not collide with the reserved `mthds_*` stems, must survive sanitization, and need a deterministic collision policy within the org catalog.
- **No versioning on methods** (carried over from the build-vs-run doc): a projected tool always runs the method's current content. Tool descriptions should state it.

## 5. Relation to skills (the manual stays a manual)

Workspace convention: **tools are the contract; skills are the manual.** Skills (in `../pipelex-plugins`) should teach the stable workflow — how to fill an inputs template, run etiquette, following a durable run — knowledge that doesn't rot. The catalog itself is live data and belongs to the server, not to authored documentation: a hand-written list of "which methods exist" goes stale silently (PUT overwrites, no versioning) and exists only on hosts with a skills mechanism. Where a local snapshot is genuinely useful (coding agents, pre-projection stopgap), it should be a *generated* artifact — e.g. a session-start hook or plugin command that fetches the catalog and writes a fresh `methods.md` — never an authored one.

## 6. Parked (explicitly out of this track)

Dedicated per-user MCP deployments are not a discoverability mechanism — the protocol delivers per-user tool lists from one deployment. A dedicated deployed server becomes interesting only when the audience is *not the method's author*: "publish your method as an MCP server / ChatGPT app" for the author's own customers — branded, curated, distributed. That is a separate future distribution product (plausibly an Alpic partnership), not part of this design.

## 7. Open questions

- Where does the "expose as tool" flag live — a new field on the method record (platform change, `MethodSaveBody`), or MCP-side config? Platform-side makes it an org-shared product concept; it also implies back-office/webapp surfacing.
- Who owns concept→JSON-Schema projection (platform route vs MCP composition), and does the projection reuse `pipe_io_contracts`?
- Does the projected tool return the run ack (durable id + `run-follow` view, matching `mthds_run`) or block for short runs? Default: mirror `mthds_run` exactly — one behavior to learn.
- How does `listChanged` actually behave across the target hosts (claude.ai, Claude Code, Codex-with-remote)? Needs a live check; if support is weak, the list is simply fixed per session — still live enough.
- ChatGPT apps directory policy on dynamic tool lists — verify before the SPEC increment commits to a per-host rollout order.
- Stored `input_data` interplay: a projected tool's schema could mark inputs optional when the method record carries usable `input_data` defaults (same product question flagged in the build-vs-run doc).
