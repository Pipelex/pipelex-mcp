# Tools reference

The workshop is the Pipelex plugin's local MCP server, published to npm as `@pipelex/mcp` under the server name `pipelex-plugin`: a coding agent spawns it over stdio in your project, and it registers the `mthds_*` tools below. This page gives every tool's input, its `structuredContent`, and how it behaves; [Registering the workshop in a host](hosts.md) gives each host's configuration, and the full contracts (verdict discipline, the `_meta` channel) live in [`SPEC.md`](../SPEC.md). Chat hosts do not run the workshop: they use the Pipelex connector at `https://mcp.pipelex.com/mcp`, a separate product ([Chat hosts use the Pipelex connector](../README.md#chat-hosts-use-the-pipelex-connector)).

## The tools at a glance

| What it does | Tool |
| --- | --- |
| List the saved methods | `mthds_list_methods` |
| List the model deck and check a model reference | `mthds_models` |
| Validate a method | `mthds_validate` |
| Project an inputs template | `mthds_inputs_template` |
| Generate typed code | `mthds_codegen` |
| Prepare filled inputs | `mthds_prepare_inputs` |
| Start, follow and read a run | `mthds_run`, `mthds_run_status`, `mthds_run_results` |
| Show a run's pictures | `mthds_show_images` |
| Save a run to disk | `mthds_download_artifacts` |
| Save a method's draft to the catalog, and pull a draft or a version back | `mthds_save_method`, `mthds_get_method` |
| Publish a method's draft as its next version, when the user asks | `mthds_publish_method` |

## The tools

Every call runs on the `plx_sk_` key in `PIPELEX_API_KEY`. The method-taking tools take a method three ways: `files`, a published method's address as `method_ref`, or a catalog id as `method_id`. `files` uses `SubmittedFileInput`, `{ content: string; uri?: string | null } | { path: string }`, described in [Files on the workshop, by path](../README.md#files-on-the-workshop-by-path).

**A `method_id` names a content, not just a method.** A saved method has a draft, which every save writes, and published versions numbered from 1, which only a publish makes. A bare `mt_…` names the latest published version, `mt_…@<n>` version n, and `mt_…@draft` the draft; beside `files` on `mthds_run` the id must be bare. The workshop works against platforms that resolve the suffix and ones that do not yet: it sends every selector exactly as given on both, so a platform that does not resolve the suffix refuses it, and the refusal's hint says that a bare id reads the draft there. It asks `GET /v1/version` whether `method_versions` is among its extensions only to say what a bare id read. Every by-id result says which content it read or ran, in `method_version` and in its summary: a number, `"draft"`, or `"latest"` for a bare id on a platform that resolves versions. `SPEC.md` → "Method versions, on two platforms" has the whole rule, including the caching and what happens when the platform does not answer. The workshop registers no views, so every `available_view_specs` it returns is empty and none of its results carries the graph or a form on `_meta`; `mthds_validate` writes the method's flowchart as an HTML page instead (see [the method graph page](#mthds_validate)).

### `mthds_list_methods`

```ts
// input
{
  query?: string;   // trimmed, case-insensitive; matched SERVER-side over name/description
  limit?: number;   // integer 1..50; default 20
  cursor?: string;  // opaque next_cursor from a previous call
}

// structuredContent — success
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

The read-only catalog entry point, over the API key's organization. Search and paging are the server's job: `query` is applied across the whole organization catalog rather than over one page, and rows arrive already ordered newest first by the immutable `created_at` the catalog pages on. Continue a listing by passing the returned `next_cursor` back as `cursor`. Names are bounded to 200 Unicode code points and descriptions to 500, with explicit truncation flags. Empty catalogs and no-match queries are successful empty results.

There is deliberately no total: counting a catalog means reading all of it, which is the cost paging exists to avoid.

The projection is deliberately source-free: `mthds`, Python, stored inputs and outputs, organization ids, and creator ids never enter `structuredContent`, `content`, `_meta`, or logs — and the index projection no longer carries them at all. A malformed row fails the whole result as a non-retryable runtime contract error rather than returning a misleading partial list.

Name-to-run flow:

```text
mthds_list_methods({ query: "invoice" })
  → choose/disambiguate method_id
  → mthds_validate({ method_id })                 # optional check of the version that will run
  → mthds_inputs_template({ method_id })
  → fill inputs; prepare/upload assets if needed
  → mthds_run({ method_id, inputs })
```

No method source crosses the conversation in this flow.

### `mthds_models`

Lists the model deck, the references a pipe's `model` field can name, or checks one reference before it is written into a method. It reads `GET /v1/models`, writes nothing and spends no inference credit.

```ts
{
  category?: "llm" | "extract" | "img_gen" | "search" | "judgment";
  reference?: string; // at most 199 characters
}
```

`category` narrows either use to the references of one pipe type: `llm` for a PipeLLM, `extract` for a PipeExtract, `img_gen` for a PipeImgGen, `search` for a PipeSearch and `judgment` for a PipeJudge. These are the MTHDS protocol's categories, and a runner that implements an older protocol than the one that defined a category refuses it as a filter, as a runner before protocol 0.7.0 refuses `judgment`; omit `category` to list what that runner serves. Without `reference`, the tool lists the deck:

```ts
{
  status: "ok";
  category?: string;
  deck: Array<{
    category: string;
    presets: string[];                                        // "$writing-factual"
    aliases: Array<{ reference: string; target: string }>;    // "@best-gpt" → "gpt-5.6-sol"
    waterfalls: Array<{ reference: string; fallbacks: string[] }>; // "~robust-llm" → handles in order
  }>;
}
```

Every reference is written the way a method writes it, and every category in scope is present, empty or not. A category the tool does not know, which a runner of a later protocol may report, is not dropped: a listing of every category shows it after the protocol's under the runner's own name, a check resolves in it, and the summary says the tool does not know which pipe type names it. Presets pair a model with settings for a kind of task and are the ones to prefer. The deck names no model handle on its own: a handle appears only as an alias's target or a waterfall's step.

With `reference`, the tool checks that reference, which may be a preset (`$`), an alias (`@`), a waterfall (`~`), a bare model handle, or any of them with the `preset:`, `alias:`, `waterfall:` or `handle:` prefix the runner also accepts. A check reads the whole deck, so it can tell a reference written into the wrong pipe type from one that does not exist:

```ts
{
  status: "ok";
  category?: string;
  reference: string;
  kind: "preset" | "alias" | "waterfall" | "handle";
  resolution: "resolved" | "not_found" | "unconfirmed";
  matches: Array<{ category: string; target?: string; fallbacks?: string[]; via?: string[] }>;
  suggestions: string[];      // the nearest names, e.g. "$writing-factual" for "$writing-factul"
  other_kinds: string[];      // the same name under another sigil, e.g. "@best-gpt" for "best-gpt"
  other_categories: string[]; // with a category: where the reference resolves instead
}
```

`resolved` says where the reference resolves and what it resolves to. `not_found` is a preset, alias or waterfall the deck does not hold. `unconfirmed` is a bare handle that no alias or waterfall names: the deck cannot say whether the runner serves it, but `mthds_validate` checks a handle against the runner's full model list. For a preset, alias or waterfall checked with a category, the nearest names are the ones the runner itself suggests when a validation fails on the same reference. A handle's nearest names come only from the handles the deck names, and a check without a category draws on every category, so there they can differ from validation's.

**The deck is what the runner can serve, not what your account may use.** A gateway can refuse a listed model when a run starts, after the method validated. The tool's description and every summary say so.

### `mthds_validate`

```ts
// input — exactly ONE of files / method_ref / method_id
{
  files?: SubmittedFileInput[];
  method_ref?: string;         // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;          // catalog id (mt_…) of a registered method
  graph_page?: boolean;        // default true: write method-graph.html beside { path } files
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  available_view_specs: Array<"dry_run_graph" | "input_form">;
  main_pipe?: {                    // on every valid verdict with an effective entry pipe
    pipe_ref: string;              // namespaced domain.pipe_code
    inputs: Array<{                // ordered: authored order when the runner states it
      name: string;
      concept_ref: string;         // fully-qualified, multiplicity suffix stripped
      multiplicity: "single" | "variable" | "fixed";
      item_count?: number;         // only on the fixed arm
      required: boolean;
    }>;
    output: {
      concept_ref: string;
      multiplicity: "single" | "variable" | "fixed";
      item_count?: number;
      optional: boolean;
      images?: string[];           // where images sit; [] = none, absent = unknown
    };
  };
  graph_page?: {                   // when every file came as { path } and graph_page was not false
    path: string;                  // relative to the working directory
    written: boolean;
    error?: ToolError;             // why it was not written; the verdict is unaffected
  };
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

`main_pipe` is the main pipe's typed signature — what an agent needs to write a call site against a method whose source it never sees (a `method_ref` or `method_id` call), instead of guessing the produced concept. It is present on every valid verdict for which the server settled an effective entry pipe — for a published method, the one its manifest names — pending signatures included. Its absence means no entry pipe was settled, not that the method declares none. Any malformed member omits the whole signature rather than emitting a partial one; the verdict is unaffected. The same thing is rendered as one line of the Markdown summary, `demo.main(document: legal.Contract, notes?: native.Text, tags: native.Text[]) -> analysis.Report[2]` (`?` may be omitted, `[]` a list, `[N]` exactly N).

`output.images` answers "will this method produce pictures?" before anything runs. It lists where images sit inside the produced output, as paths from its root: `$` is the output itself, `$.name` a field of it, `$[]` an element of a list, `$[].name` a field of one — so a top-level `Image` output is `["$"]`, an `Image[]` is `["$[]"]`, and the question is `images.length > 0`. It is read from the MTHDS standard's output-form descriptor, which the capability requests from the API, so it costs nothing at run time. An empty array and an absent member are **different answers**: `[]` means the output was described and holds no image, while absence means nothing described it — unknown, not none. The rendered summary line says it too, as a trailing ` (produces images)`.

The MCP `content` text is the API's rendered summary, with the signature line appended. The three source forms are **mutually exclusive — supply exactly one**. `method_ref` validates a published method by its address (`github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0`); `method_id` validates a registered method by its catalog id, the content its suffix names (requires an API key, since the catalog is org-scoped). Both are **server pass-throughs**: the selector rides the `/v1/validate` body and the hosted API resolves it — no method source enters the conversation.

**The method graph page.** The workshop shows no views, so it gives the builder the flowchart as a file instead: when every item of `files` is a `{ path }`, the call writes `method-graph.html` into the directory holding them (the deepest one holding them all, when they span several) and reports it under `graph_page`. The page embeds the `.mthds` files as validated and loads `@pipelex/mthds-ui`'s standalone viewer and elkjs from jsDelivr, pinned by exact version and Subresource Integrity, and the viewer builds the static graph in the browser, the way a Mermaid page carries its diagram's text. So it opens from disk with no server and no Pipelex install, needs a network connection to draw, and draws a method that does not validate too, with the notes reading its source turned up. It is written whatever the verdict, even when the API produced none, and each validation of the files rewrites it, so it never shows an older version of the method. The write goes through the workshop's write boundary and follows `mthds_codegen`'s policy rather than the download tool's: it replaces only a page carrying its own generator mark, and a file it did not write at that name, a symlink or a directory is left untouched and reported as `graph_page.error`. A page that could not be written never changes the verdict. Inline `{ content }` files, `method_ref` and `method_id` write nothing, and `graph_page: false` skips the page. The summary's `## Method graph` section says where the page is, and on its first write that it is a generated file a project under version control may want to ignore.

### `mthds_inputs_template`

```ts
// input — exactly ONE of files / method_ref / method_id
{
  files?: SubmittedFileInput[];
  method_ref?: string;         // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;          // catalog id (mt_…) of a registered method
  pipe_ref?: string;
  explicit?: boolean;
  format?: "json" | "toml";
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  format?: "json" | "toml";
  explicit?: boolean;
  inputs?: Record<string, unknown>;
  inputs_toml?: string;
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

`pipe_ref` is a qualified `domain.pipe_code`; omit it for the method's entry pipe — a package manifest's `main_pipe`, else the closure's single `main_pipe` declaration. A `pipe_ref` the method does not declare, and a method with no single entry pipe, are refused at `pipe_ref` with the route's reason. `explicit` (default true) emits the ceremonial `{concept, content}` envelope per input — the declared concept ref plus the canonical content shape; pass `false` for the light shape (bare example values). `format` (default `"json"`) chooses the template encoding. The three source forms are **mutually exclusive — supply exactly one**. `method_ref` projects a published method by address, resolved server-side; `method_id` projects the content a registered method's id names (see above), resolved by the hosted platform (requires an API key, since the catalog is org-scoped). The tool reads one `POST /v1/pipe-io`, with no dry run, and projects the template client-side from the pipe's input-form descriptor; a closure that does not load comes back as a produced `is_valid: false` verdict with its `validation_errors`. The template is small structured data the model reads directly, and the `content` summary repeats it in a fenced block, followed by the next step: `mthds_prepare_inputs`, or straight to `mthds_run` when every file value is already a URL or a `pipelex-storage://` reference.

### `mthds_codegen`

```ts
// input — exactly ONE of files / method_ref / method_id, plus the required target
{
  files?: SubmittedFileInput[];
  method_ref?: string;         // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;          // catalog id (mt_…) of a registered method
  target: "ts-zod" | "python-pydantic" | "python-structures";
  output_dir?: string;         // write the tree here instead of returning its content
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  target?: "ts-zod" | "python-pydantic" | "python-structures";
  kind?: "types";
  crate_fingerprint?: string;
  engine_version?: string;
  artifacts?: Array<{ path: string; bytes: number; content?: string; written_to?: string }>;
  lock?: { filename: string; bytes: number; content?: string; written_to?: string };
  truncated?: boolean;
  // the written arm (output_dir):
  output_dir?: string;
  is_current?: boolean;
  orphans?: string[];
  orphans_truncated?: boolean;
  drifts?: unknown[];
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

Projects the method's concept set into typed models through the Pipelex codegen engine (`POST /v1/codegen`). `target` is required and has no default — the tool description carries the decision rule, so the assistant picks it from the project (the user's explicit request wins): `ts-zod` for a TypeScript or JavaScript project (`types.ts` with zod schemas and inferred types, plus `binder.ts` with a parse/serialize pair per concept — keep both), `python-pydantic` for a Python consumer with no Pipelex runtime (`models.py`), `python-structures` for a Pipelex host or a `@pipe_func` implementation (`structures.py`). Field keys stay snake_case in every target. The three selectors are server pass-throughs — no bundle enters the conversation.

**Pass `output_dir`** — a dedicated generated directory relative to the working directory, such as `src/generated/<method>/`. The tool writes the artifacts and `codegen.lock` there verbatim and returns no file content at all: `output_dir`, `written_to` per file, `is_current` and any `orphans` instead. It overwrites files it generated (they carry a codegen stamp) and the lock beside them, and refuses the whole write rather than touch anything else — a symlink, a directory, or a file it did not write. Orphans, a stamped file the new lock does not list, are reported and never deleted, so a directory holding two generations stays non-current by design; give each generation its own directory.

**Without `output_dir`**, write every artifact at its path and the lock as `codegen.lock` beside them, **verbatim**, into a dedicated generated directory; `pipelex codegen check` (or `runCodegenCheck` from `@pipelex/sdk`) then passes on that tree. The `content` summary repeats each file in a fenced block tagged for its language. A large set is withheld by whole file rather than cut (`truncated: true`, `content` absent on the withheld entries; the lock's bytes are reserved first, so the trust anchor always rides).

### `mthds_prepare_inputs`

```ts
// input — exactly ONE of files / method_ref / method_id, plus the filled inputs
{
  files?: SubmittedFileInput[];
  method_ref?: string;              // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;               // catalog id (mt_…) of a registered method
  pipe_ref?: string;
  inputs: Record<string, unknown>;  // the FILLED mthds_inputs_template output
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;                // echoed only when the caller supplied it
  inputs?: Record<string, unknown>; // the prepared (rewritten) inputs — ready for mthds_run
  uploads?: string[];               // the pipelex-storage:// uris uploaded this call ([] when all pass-through)
  errors?: ToolError[];
}
```

Sits between `mthds_inputs_template` (produces the empty template) and `mthds_run` (executes the filled inputs): it makes file-bearing inputs run-ready. The pipe's declared signature identifies which values are assets — read from the MTHDS standard's **input-form descriptor**, which states the kind of every input at every depth, so an optional nested file field prepares like a required one and a text field merely *named* `url` stays untouched. Each asset is uploaded to Pipelex storage and rewritten to `pipelex-storage://`. `http(s)` URLs and existing `pipelex-storage://` references pass through unchanged, so an inputs set that is already all pass-through can skip this step. All three selectors are resolved server-side, by the one `POST /v1/pipe-io` the signature comes from, which runs no dry run and, for an address, fetches only the package's `.mthds` files, so a published package that ships Python prepares on any deployment. Omitting `pipe_ref` prepares the method's entry pipe; a method with no single entry pipe, or a `pipe_ref` it does not declare, is refused at `pipe_ref` with the route's reason. Local paths, `data:` URLs and inline bytes are uploaded with your API key. The prepared inputs are small structured data the model reads directly, repeated in the `content` summary. Unlike the other tools this has **no produced-invalid arm**: an unresolvable closure is a no-verdict `status: "error"` (recover via `mthds_validate` / `mthds_inputs_template`). See `SPEC.md` → "Prepare Inputs Scope" for the full contract.

### `mthds_run` / `mthds_run_status` / `mthds_run_results`

Durable (async) method execution on the hosted Pipelex API. `mthds_run` starts a run — from submitted files (`files?`, plus `pipe_code?` and `inputs?`), from a published method's address (`method_ref?` — `github.com/<owner>/<repo>[/<selector>][@<tag>]`, resolved server-side with the resolved commit SHA echoed back as `method_provenance`), or from a registered method's catalog id (`method_id?`, mt_…) — and returns a durable `run_id` immediately (never blocks); `mthds_run_status` is a cheap read of the coarse lifecycle state; `mthds_run_results` fetches the terminal outcome (main output on success, why it failed otherwise) along with a compact run-level `usage` object — its `state` (`records`, `no_inference` or `unavailable`), total USD cost (null-aware), tokens, inference-call count and any usage-assembly error — projected from the SDK's `summarizeUsage`. The per-pipe rollup and the full per-call record list ride the view-only `_meta` (`_meta.usage_by_pipe` / `_meta.tokens_usages`) for a future detailed-cost surface, and usage never appears in the prose. A completed result carries neither the executed graph nor the artifacts that describe its data, and the tool does not ask the platform for them: each results read names the artifacts it uses, so the platform reads nothing the tool would drop. A by-id run executes the content its `method_id` names — a bare id the latest published version, `@<n>` that version, `@draft` the draft — requires an API key, and reports what ran in `method_version`, which `mthds_run_status` also carries when the platform records it; when both `files` and `method_id` are supplied, the files run and the id, which must then be bare, is recorded as run-history linkage on the platform. `method_ref` is a complete run source of its own and pairs with nothing — beside `files` or `method_id` the request is refused. All run state lives behind the durable `run_id` on the platform, so the flow survives conversation gaps — days later, the same id still answers. See `SPEC.md` → "Run Scope" for the full contract.

The pipe selector is `pipe_code` here and `pipe_ref` on `mthds_inputs_template` / `mthds_prepare_inputs` — the same qualified `domain.pipe_code` value under the name each underlying route uses; each description names the other, so copying the value across the two calls is expected.

A completed `mthds_run_results` also reports, for free, what the run **stored**: `image_candidates` lists the `pipelex-storage://` references whose key looks like an image, and the prose says how many stored files there are and what can be done with them. Nothing is fetched to produce it — the walk is in memory over the full output, so a reference pruned out of the bounded `main_stuff` still appears. The list is capped at 32 entries, with any remainder counted in `image_candidates_omitted`; the cap is a prefix, so an index into it still means the same thing to `mthds_show_images`, which walks the whole set. **The results tool never returns an image itself, and takes no flag that would make it**; showing a picture is `mthds_show_images` below.

**A failed run says why.** When a run ends without completing, `mthds_run_status` and the `failed` state of `mthds_run_results`, `mthds_show_images` and `mthds_download_artifacts` carry the error report the runner stored on the run, as one `failure` object:

```ts
// failure — present when the run stored an error report
{
  run_id: string;
  error_type?: string;        // the runner's exception class name, for the support line
  title?: string;             // the stable label of the error class ("LLM completion")
  message?: string;           // what went wrong, as the runner wrote it; it can quote the provider's raw text
  error_domain?: string;      // "input", "config" or "runtime"
  error_category?: string;    // "transient", "configuration", "content", …
  retryable?: boolean;        // absent: the report does not say
  user_action?: { kind: string; detail: string };
  finished_at?: string;
}
```

The summary says it in sentences: why the run failed (the report's title and message), what to do (the report's advice, or a sentence chosen by its `kind`, and never the runner's "the system will retry automatically", which is untrue of a run that has ended), whether running it again can help (only when the report says, never a retry when it says no, and a no worded as the report's expectation rather than a certainty), and a line for support with the run id, the error type and the time the run ended. The provider's raw metadata is never carried, the message is cut at 2,000 code points and every other text at 300, and a `wait_and_retry` action carries this server's own advice in `structuredContent` too. A run with no stored report, such as one the platform timed out itself, carries its status alone and says so. The results, image and download tools read the report from the results route's failed arm when it relays one, and otherwise from one status read of the same run, bounded at five seconds, which is also where the time comes from; when that read fails and the arm carried nothing, the summary says the reason is unknown for now rather than that the run stored none.

### `mthds_show_images`

Put the pictures a completed run produced in front of the model, as MCP **image content blocks**.

```ts
// input
{
  run_id: string;        // the durable run id from mthds_run
  images?: string[];     // optional selection: pipelex-storage:// references from image_candidates
  indices?: number[];    // optional selection: their zero-based positions instead
}

// structuredContent (state = "completed")
{
  status: "ok";
  run_id: string;
  state: "completed";
  images: Array<{
    uri: string;
    mime_type?: string;   // the object store's own content type
    bytes?: number;
    inlined: boolean;     // true ⟺ this picture is one of the image blocks in content
    withheld?: "size" | "budget" | "count" | "type" | "deadline" | "empty";
    error?: ToolError;
  }>;
  omitted?: number;       // of the candidates THIS CALL considered, how many are past the 32 listed
  all_inlined: boolean;   // about the RUN: false when a narrowed call left one of its pictures unconsidered
}
```

Entries come back **in the order considered**: the order you named them when `images` or `indices` was given, and discovery order only when neither was. A repeated reference is deduplicated rather than refused — a shown picture is permanent, so buying the same one twice is never what was meant.

**Why it is a tool and not an option on the results tool.** An image block is cheap to send and permanent to keep: it costs the model's own native vision price — its base64 size is free — but once it is in a conversation it is in every prompt that follows, and nothing takes it back. One picture is a rounding error; a loop that generates twenty is twenty images of context nobody chose. So nothing inlines by default, and seeing a picture is a gesture with a name.

Each inlined picture is fetched through `@pipelex/sdk`'s bounded `fetchArtifact` (fresh presigned link, redirects refused, no credentials forwarded, the byte cap checked before and during the read), gated on the object store's own `content-type` — `image/png`, `image/jpeg`, `image/gif`, `image/webp`, and nothing else. Five bounds hold a call: **4 MiB** per picture, **6 MiB** across the call, **6 attempts**, a **60-second deadline** over the whole walk, and at most **32 candidates** enumerated. The deadline exists because the per-image timeout is per image and the walk is sequential: without it, stalled objects accumulated into a call of three minutes and more, and a host with a shorter deadline lost the whole thing — pictures already fetched included. It is carried both as a per-fetch timeout and as an abort signal, because the SDK resolves a reference before arming its timeout and only the signal reaches that half; with the timeout alone a call could still reach 90 seconds. A picture that does not fit is reported as `withheld` with its reason rather than resized or dropped silently — as is a stored object that declares an image type and holds no bytes, which would otherwise become an empty, unrenderable block that never leaves the conversation; a per-reference failure rides its entry as an `error`; pictures that arrived are never discarded because a sibling failed. A whole-request refusal — a plan limit, a rejected credential, an unreachable host — that stopped the walk before any picture arrived is a `status: "error"` no-verdict naming the cause, rather than a success with nothing in it. The same `PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP` rule as the download tool applies. A `running` or `failed` run, and a run whose output holds no image candidate, are produced verdicts that fetch nothing. See `SPEC.md` → "Image Display Scope".

**What your host does with an image block** (measured, 2026-09-21 — the study is recorded under L-260920-fc66db in the private Pipelex workspace ledger):

| Host | Model sees the picture | Person sees the picture | Notes |
|---|---|---|---|
| Claude Code | Yes | **No** — the terminal renders nothing | Priced at the model's native vision cost; the base64 size is free. Ask for a description if you want one in the transcript. |
| Codex (ChatGPT desktop) | Yes | Not measured | **Refuses a block carrying `annotations`** with `Unexpected response type` — which is why ours carries none. Accepts the block-level `_meta` ours does carry; that was measured too, not assumed. |
| Cursor | Not measured | Not measured | Tracked as its own follow-up. |

### `mthds_download_artifacts`

`mthds_download_artifacts` saves a completed run to disk: its main output, and the files it produced. It is the download counterpart of `mthds_prepare_inputs`: where prepare pushes local files *into* Pipelex storage, this brings a run back *out*, onto disk.

```ts
// input
{
  run_id: string;   // the durable run id from mthds_run
  dir?: string;     // where to save, relative to the server's working directory (created if missing; must stay inside it)
                    // omitted → runs/<run_id>; "." → the working directory itself
}

// structuredContent (state = "completed")
{
  status: "ok";
  run_id: string;
  state: "completed";
  scope: "main_stuff";     // what was walked: the run's main output
  output: { path: string; size: number };   // main_stuff.json, written first
  artifacts: Array<{ uri: string; found_at: string[]; found_at_omitted?: number; path?: string; content_type?: string | null; size?: number; error?: ToolError }>;
  saved_paths: string[];   // every file written, main_stuff.json first; relative to the working directory
  all_saved: boolean;      // the output and every referenced file saved
}
```

Every completed save writes the run's **full** main output to `main_stuff.json`, exactly as the API returned it: the name `pipelex run --save-main-stuff` uses. The model never has to retype an output into a file, and an output that `mthds_run_results` cut to fit the conversation is on disk whole, where the agent reads it with its own file tools. By default the run lands in its own folder, `runs/<run_id>/`.

A completed run's results also carry a produced image, PDF or document with a `pipelex-storage://` reference beside a presigned `public_url` that expires within the hour. Pass the run id here instead of racing that link: every reference in the run's full output is resolved to a *fresh* link through the API and streamed into a file beside `main_stuff.json`, so the same call still works days later. The walk, the links and the download are `@pipelex/sdk`'s artifact stack (`locateArtifacts`, `downloadArtifacts`), so the tool needs a Pipelex platform serving the bulk resolve route (`POST /v1/resolve-storage-url/bulk`); a bare `pipelex-api` runner has none.

Each file is named after the field it fills in the output: the picture at `$.rooms[3].staged_photo.url` is saved as `rooms-3-staged_photo.png`, and an output that is one image as `main_stuff.png`. The storage key supplies only the extension. Each entry's `found_at` lists the paths in `main_stuff.json` where its reference sits, the first being the one that named the file; an output that repeats one reference lists the first few and counts the rest in `found_at_omitted`. Files are **never overwritten**: a collision gets a numeric suffix, `main_stuff.json` included, and since the output is written first, a produced file never takes its name. `dir` cannot escape the working directory (no absolute paths, no `..`, no symlink out). Plain `http:` links are accepted only against a plain-http `PIPELEX_BASE_URL` unless `PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP` says otherwise. A `running` or `failed` run is a produced verdict with nothing to save, a failed one saying why it failed as `mthds_run_results` does, and partial success is a produced verdict with the failures on their items. Every completed `mthds_run_results` summary names this tool as the way to keep the run, and a truncated one names it as the way to read the rest. See `SPEC.md` → "Artifact Download Scope" for the full contract and the reasoning behind a companion tool rather than a flag on `mthds_run_results`.

### `mthds_save_method` / `mthds_get_method` / `mthds_publish_method`

Three tools carry a bundle between the working directory and the organization's catalog: `mthds_save_method` saves the files on disk as a method's draft, creating the method or writing the draft of an existing one; `mthds_get_method` brings back a saved method's draft, or one of its published versions; and `mthds_publish_method` makes the draft the method's next published version, which is what callers of its bare id run. A save never publishes, so a save never changes what those callers run on a platform that resolves versions; the publish is called only when the user asks for one. A save whose root file is a `{ path }` item, or that names a `link_dir`, writes `pipelex-method.json` there, and so does a pull with `output_dir`; that link file ties a directory to the method it was saved as. Commit it, so that a teammate's save from the same directory writes the same method's draft instead of creating a second method. A save sent inline with no `link_dir`, and a pull without `output_dir`, write no link, so the next save must pass `method_id` or it creates a second method; `link_file.written` on the save's result says which happened. Every `{ path }` item, `python` included, must sit at or under the root file's directory, and the root file must itself be a `{ path }` for any other item to be read from disk.

```ts
// mthds_save_method — input
{
  files: SubmittedFileInput[];    // the bundle's .mthds files, ROOT FILE FIRST — { path } items to link the directory
  name?: string;                  // required on a create; on an update, omitted keeps the name and a changed one renames
  method_id?: string;             // absent creates; present writes THAT method's draft (bare, or mt_…@draft)
  python?: SubmittedFileInput[];  // the bundle's .py files, replaced as a set
  expected_updated_at?: string;   // the draft token to compare-and-swap on; defaults to the link file's
  link_dir?: string;              // where to write pipelex-method.json; defaults to the root file's directory when that file is a { path } item — an inline-only save with no link_dir writes no link
}

// mthds_save_method — structuredContent
{
  status: "ok" | "error";
  is_valid?: boolean;
  is_runnable?: boolean;
  pending_signatures?: string[];
  method_id?: string;
  name?: string;
  saved?: "created" | "updated" | "renamed";   // renamed = the draft written and the method renamed
  updated_at?: string;                          // the draft's new token
  latest_version?: number | null;               // null: never published
  publish_state?: "never_published" | "draft_unchanged" | "draft_ahead";
  api_host?: string;
  link_file?: { path: string; written: boolean; reason?: string };
  rename_error?: ToolError;                     // the draft was saved; the rename was not
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

`mthds_save_method` validates the files and saves those same bytes as the draft in one call, with the verdict beside the save: an invalid bundle is saved all the same, as `is_valid: false` with its `validation_errors`, because a draft is work in progress and a publish is where validity is required. Only a validation that produced no verdict refuses the save. The root file goes first because the platform derives the method's listed description from it. The draft write carries neither the name nor the form inputs, so both are kept: a different `name` renames the method through a call of its own, and a failed rename leaves the draft saved and says so in `rename_error`. A name that is the one `pipelex-method.json` recorded before the method was renamed elsewhere, in the webapp or by a teammate, keeps the stored name instead of undoing that rename; the summary says so, and since the link then records the stored name, saving again with the older name renames the method back. Omitting `python` keeps the draft's Python, `[]` clears it, and files replace the set. The write is a compare-and-swap on the draft's token: `expected_updated_at` when given, and otherwise the linked directory's `synced_updated_at`, so a save from a linked directory never replaces a draft somebody saved since the directory synced, the webapp's autosave included. Such a save is refused at `expected_updated_at` with both tokens named; to replace that draft knowingly, after asking the user, pass its current `updated_at`. A link that cannot vouch for the draft is refused rather than read as no token: one that cannot be read, or whose last pull never finished, at `link_dir`, and one holding a pulled version, at `expected_updated_at`, since saving it is a restore. A `link_dir` naming another directory changes where the link is written, not these guards: when the link beside the files names the same method, its refusals still apply, its token is sent when `link_dir` offers none, and two links recording different syncs are refused at `link_dir`. A rename keeps the draft write's token, so a save by somebody else between the two calls is never adopted as this one. A directory already linked to another method is refused rather than re-pointed, and a create is never retried automatically, because a retry after a lost response would create a second method. No source comes back; the summary names `mt_…@draft` as the id that validates or runs what was saved, and the publish call for when the user asks for one.

```ts
// mthds_get_method — input
{
  method_id: string;     // bare or mt_…@draft: the draft; mt_…@<n>: version n
  output_dir?: string;   // write the sources here; omitted, they come back inline
  overwrite?: boolean;   // only meaningful with output_dir; see the linked-directory rule
}

// mthds_get_method — structuredContent
{
  status: "ok" | "error";
  method_id?: string;
  name?: string;
  version?: number | "draft";                   // which content was read
  updated_at?: string;                          // the draft's token, whichever content was read
  latest_version?: number | null;
  publish_state?: "never_published" | "draft_unchanged" | "draft_ahead";
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

**With `output_dir`**, `mthds_get_method` writes the content's `.mthds` and `.py` files verbatim under the working directory, with the link file beside them, and no source passes through the conversation. It refuses rather than overwrite work it does not own. A directory not linked to this method is written only when it holds none of the files the pull would land and no bundle of its own, and one linked to another method is refused outright. In a directory linked to this method, files that differ from the pulled ones are refused as unsaved local work while the draft has not moved, and refused without `overwrite: true` once it has, which the caller sends only after asking the user; files whose bytes the catalog already stores, as the draft's or as the version the directory last pulled, are written over freely. A pull of a version records it in the link as `synced_version`, and saving from that directory with the draft's token as `expected_updated_at` is how a version is restored: the save replaces the draft with those files and publishes nothing, and without the token it is refused, so a version pulled to be read is never saved over the draft by accident. A version whose files are exactly the draft's is recorded as no version, since the directory then holds the draft, and a save from it needs no token. The restore sends `python` as the version's `.py` files, or `[]` when it has none, since an omitted `python` keeps the draft's. A symlinked destination is refused. Files in the directory that the method does not have are named in `unmanaged` and never deleted. **Without `output_dir`**, the sources come back inline, bounded by whole file, for explaining a method the model cannot see on disk.

```ts
// mthds_publish_method — input
{
  method_id: string;                  // bare, or mt_…@draft; a version is refused
  expected_draft_updated_at: string;  // the draft token you last saw — required
}

// mthds_publish_method — structuredContent
{
  status: "ok" | "error";
  outcome?: "published" | "unchanged" | "refused";
  method_id?: string;
  name?: string;
  version?: number;                    // published and unchanged
  published_at?: string;
  crate_fingerprint?: string | null;
  reason?: "invalid" | "not_runnable"; // refused
  message?: string;
  is_valid?: boolean;
  is_runnable?: boolean;
  pending_signatures?: string[];
  validation_errors?: unknown[];
  updated_at?: string;                 // the draft's token
  latest_version?: number | null;
  publish_state?: "never_published" | "draft_unchanged" | "draft_ahead";
  api_host?: string;
  errors?: ToolError[];
}
```

`mthds_publish_method` publishes the draft its caller has seen: a draft that moved since `expected_draft_updated_at` is refused at that field, with the draft's current token named, and nothing is published. The token is the updated_at of a save or of a pull of the draft; a pull of a version reports the draft's token without its content, for a restore only, so it is never one to publish under. Each outcome is a produced verdict: `published` with the new version, which `mt_…@<n>` names for good; `unchanged` when the draft already equals the latest version, so nothing was added; and `refused` with the runner's verdict when the draft does not validate or does not run yet. It is annotated destructive, since it changes what every caller of the bare id runs and a published version is never taken back. See `SPEC.md` → "Catalog Write Scope" for the full contract of the three tools.

## Result streams

Every result carries its machine contract on `structuredContent` and a Markdown summary on `content`. What the model need not read rides `_meta`, which a host does not put in front of it: a completed run's full output and its per-call usage records, and a valid verdict's entry pipe (`main_pipe_ref`). [SPEC.md](../SPEC.md#the-result-streams) states the rule.

## Success and verdict discipline

A successful catalog page is `status: "ok"` with counts and `methods` (there is no `is_valid` field). For tools that produce a method verdict, a *produced* verdict is always `status: "ok"` — discriminate on `is_valid` (and, for validation, `is_runnable`); an invalid bundle or unresolvable closure is a produced `is_valid: false` verdict, not an error. `status: "error"` is reserved for **no result/verdict could be produced** and carries an `errors[]` array, each tagged `input_domain` (bad request), `config` (env/auth/unreachable API), or `runtime` (server fault), plus a `retryable` flag. Every `errors[]` entry's `location`, `message`, and `hint` are also surfaced in the `content` text.
