# Tools reference

Pipelex MCP is two servers with two tool sets. The console, the hosted Pipelex connector (server name `pipelex`), registers `pipelex_*` tools; the workshop, the Pipelex plugin's local stdio server (server name `pipelex-plugin`), registers `mthds_*` tools. No tool name is registered by both. This page gives every tool's input, its `structuredContent`, and how it behaves. Full contracts (verdict discipline, `_meta` channels, view behavior) live in [`SPEC.md`](../SPEC.md).

## Which server registers which tool

| What it does | Console (`pipelex`) | Workshop (`pipelex-plugin`) |
| --- | --- | --- |
| List the saved methods | `pipelex_list_methods` | `mthds_list_methods` |
| Show a method: signature, inputs template, graph and form | `pipelex_show_method` | none |
| Validate a method | none | `mthds_validate` |
| Project an inputs template | inside `pipelex_show_method` | `mthds_inputs_template` |
| Generate typed code | none | `mthds_codegen` |
| Prepare filled inputs | inside `pipelex_run` | `mthds_prepare_inputs` |
| Ingest a chat attachment | `pipelex_upload_attachments` (ChatGPT) | none |
| Grant the run form an upload | `pipelex_request_upload` (called by the view) | none |
| Start, follow and read a run | `pipelex_run`, `pipelex_run_status`, `pipelex_run_results` | `mthds_run`, `mthds_run_status`, `mthds_run_results` |
| Show a run's pictures | `pipelex_show_images` | `mthds_show_images` |
| Save a run to disk | none | `mthds_download_artifacts` |
| Save a method to the catalog, and pull one back | none | `mthds_save_method`, `mthds_get_method` |

A chatbot runs methods; it does not author them. So the console names a method by reference only, a saved method's catalog id or a published method's address, and none of its tools takes `files`. It has no validate, inputs template, codegen or prepare tool: `pipelex_show_method` reports whether a method can run and hands over its inputs template, and `pipelex_run` puts its own file inputs in the shape the run needs. The workshop keeps every tool, because writing, repairing and integrating a method needs its files. The tools only one server has each turn on something the other lacks: `pipelex_upload_attachments` takes an attachment reference that only ChatGPT substitutes, `pipelex_request_upload` is called by a view and the workshop has none, and `mthds_download_artifacts`, `mthds_save_method` and `mthds_get_method` read or write the working directory only the workshop has.

## The console's tools (`pipelex`)

Every console call runs on the caller's own sign-in, so the catalog it sees and the runs it spends are the signed-in organization's.

### `pipelex_list_methods`

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

The console's read-only, no-view catalog entry point; the workshop's `mthds_list_methods` has the same shape. Search and paging are the server's job: `query` is applied across the whole organization catalog rather than over one page, and rows arrive already ordered newest first by the immutable `created_at` the catalog pages on. Continue a listing by passing the returned `next_cursor` back as `cursor`. Names are bounded to 200 Unicode code points and descriptions to 500, with explicit truncation flags. Empty catalogs and no-match queries are successful empty results.

There is deliberately no total: counting a catalog means reading all of it, which is the cost paging exists to avoid.

The projection is deliberately source-free: `mthds`, Python, stored inputs and outputs, organization ids, and creator ids never enter `structuredContent`, `content`, `_meta`, or logs — and the index projection no longer carries them at all. A malformed row fails the whole result as a non-retryable runtime contract error rather than returning a misleading partial list.

Name-to-run flow:

```text
pipelex_list_methods({ query: "invoice" })
  → choose/disambiguate method_id
  → pipelex_show_method({ method_id })            # signature, template, and on a view host the graph and form
  → fill the template, or the user fills the form
  → pipelex_run({ method_id, pipe_ref, inputs })
```

No method source crosses the conversation in this flow.

### `pipelex_show_method`

```ts
// input — exactly ONE of method_id / method_ref
{
  method_id?: string;   // catalog id (mt_…) of a saved method — shows its CURRENT stored content
  method_ref?: string;  // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  pipe_ref?: string;    // qualified domain.pipe_code; omitted → the method's entry pipe
}

// structuredContent
{
  status: "ok" | "error";
  method_id?: string;                // echoed selector
  method_ref?: string;
  is_valid: boolean;
  is_runnable: boolean;              // pipelex_run can execute it
  pipe_ref?: string;                 // the pipe the signature and template are for — pass it to pipelex_run
  main_pipe?: MainPipeSignature;     // the same signature mthds_validate returns, below
  inputs?: Record<string, unknown>;  // the fill-in template, runnable methods only
  pending_signatures: string[];
  validation_errors?: unknown[];
  available_view_specs: Array<"dry_run_graph" | "input_form">;
  errors?: ToolError[];
}
```

The console's one way to look at a method before running it. The model gets the pipe's signature and a fill-in inputs template in the explicit `{ concept, content }` shape, ready to fill and pass to `pipelex_run`; on a host that renders views, the user gets the `run-graph` view, with the method's graph and an input form whose Run button starts the run from the view. Nothing executes and no inference credit is spent. It reads `POST /v1/validate`, so a method that does not validate, or whose signatures are still pending, comes back as not runnable with the reason, and no template. `pipe_ref` shows another pipe than the entry pipe; a bare or unknown one is refused, naming the pipes the method declares.

The graph comes with the dry run of the bundle's own `main_pipe`, so a published package whose bundle declares none, such as one whose manifest alone names its entry pipe, comes back with no graph; the signature, the template and the form still come. The graph and the form's artifacts ride the view-only `_meta` channel and never reach the model.

The summary tells the model who goes first. If the user already gave the input values, it fills the template and calls `pipelex_run` straight away. Otherwise it stops and lets the user choose between the form, where the host shows one, and giving the values in chat, and it never calls `pipelex_run` while the user may be filling in the form, since the method would run twice. Which of the two hosts it is on comes from the console's instructions, which differ between a host that renders views and one that does not. See `SPEC.md` → "Show Method Scope".

### `pipelex_upload_attachments`

```ts
// input — the host fills this in; never construct one yourself
{
  attachments: Array<{
    download_url: string;   // required — the host's signed HTTPS URL
    file_id: string;        // required — e.g. "sediment://file_0000…"
    mime_type?: string;
    file_name?: string;
  }>;
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;                  // true only when EVERY attachment ingested
  attachments?: Array<{
    file_id: string;
    file_name?: string;
    uri?: string;                     // the pipelex-storage:// reference, on success
    content_type?: string;
    size?: number;                    // decoded bytes
    error?: ToolError;                // per-item failure
  }>;
  uploads?: string[];                 // the successful uris
  errors?: ToolError[];               // no-verdict only
}
```

Registered on the console, and populated by **ChatGPT only** — see [Chat attachments](../README.md#chat-attachments-chatgpt-only) for the flow and the 7 MiB cap, and the fetch boundary below. The four-field attachment shape is mandated, not chosen: OpenAI's app review requires exactly these properties with exactly this required/optional split, and the host's runtime substitution is gated on the same schema — so a deliberately lenient variant would never be populated. **Partial success is a produced verdict**: `status: "ok"` with `is_valid: false`, the successful `uploads` returned alongside per-item errors rather than discarded. No Skybridge view — the returned URIs are small structured data the model reads directly, repeated in the `content` summary.

**Attachment fetch boundary.** Fetching a host-supplied URL from a public endpoint is an SSRF surface, so the fetch is a deny-by-default policy: `https:` only; the host must be `oaiusercontent.com` at the apex or on any subdomain (OpenAI's own locked domain — where live attachment traffic is served), or `oaisdmntpr<azure-region>.blob.core.windows.net` (where it used to be, and where the `oaisdmntpr` prefix stays **required**, because that suffix is multi-tenant and a suffix-only rule would admit any Azure customer's storage account); no credentials in the URL, no non-default port; redirects refused; the size cap enforced from `content-length` before the body is read *and* again mid-stream; a bounded timeout; no headers forwarded; non-2xx refused. Because these hosts are undocumented vendor infrastructure that changes without notice — it already has once — the cap, the timeout, and the no-redirect rule hold on their own; the host check is a filter, not the defence.

### `pipelex_request_upload`

Called by the `run-graph` view, never by the model.

```ts
// input — the file's description, never its bytes
{ filename: string; content_type?: string; size: number }

// structuredContent — the grant's URL and signed headers ride _meta.upload_grant
{
  status: "ok" | "error";
  uri?: string;          // the pipelex-storage:// reference, once the file is sent
  expires_at?: string;   // after which storage refuses the upload
  max_bytes?: number;    // the upload cap (50 MiB)
  errors?: ToolError[];
}
```

The `run-graph` view's input form calls it when the user picks a file for a file-bearing input, then sends the file itself with `@pipelex/sdk/upload`'s `uploadWithGrant`: the bytes go from the browser straight to the app bucket, crossing neither the conversation, the host's relay, this server nor the API gateway, which is why a file up to 50 MiB is accepted here while an attachment stops at 7 MiB. The grant is a one-time, create-only permission to write one object, so it rides the view-only `_meta` channel and never `structuredContent`. The tool is declared `_meta.ui.visibility: ["app"]`, so a host that honours the MCP Apps standard never offers it to the model. See `SPEC.md` → "Run-Form Upload Scope".

### `pipelex_run`

```ts
// input — exactly ONE of method_id / method_ref
{
  method_id?: string;                // catalog id (mt_…) — runs the method's CURRENT stored content
  method_ref?: string;               // published address — resolved server-side at the tag
  pipe_ref?: string;                 // qualified domain.pipe_code, as pipelex_show_method reports it; omitted → the entry pipe
  inputs?: Record<string, unknown>;  // pipelex_show_method's template, filled
}

// structuredContent
{
  status: "ok" | "error";
  run_id?: string;                   // the durable run id — the handle for everything else
  run_status?: RunStatus;
  created_at?: string;
  method_provenance?: { address: string; tag: string | null; commit_sha: string };  // method_ref runs only
  available_view_specs: Array<"live_run_status">;
  errors?: ToolError[];
}
```

Starts a durable run of a method named by reference and returns its `run_id` at once, never blocking. There is no `files` argument: a saved method runs by its catalog id, and its **current** stored content runs, since methods are not versioned; a published method runs by its address, and the commit the tag resolved to comes back as `method_provenance`. `pipe_ref` rides the run as its `pipe_code`, and only when the caller named one; it must be qualified (`domain.pipe_code`), and a bare one is refused before any call.

When `inputs` is given, the tool checks them against the pipe's declared signature before the run starts, read from the MTHDS input-form descriptor, and reshapes them itself: a file input takes an `http(s)` URL or a `pipelex-storage://` reference, and each one is put in the `{ url }` content the run expects, the explicit `{ concept, content }` envelope preserved. It never uploads: a local path, a `data:` URL or inline bytes is refused before anything starts, with a hint to pass a URL or a storage reference, and a file the user attached in the chat goes through `pipelex_upload_attachments` first. During that check, a method whose bundle does not validate is refused at the selector with a hint to call `pipelex_show_method` for the diagnostics; with no inputs there is no check, and the start's own errors apply. A start that failed in a way that may still have created the run (a timeout, a connection lost after sending, a 502 or 504) is reported as not retryable, because starting it again would be a second paid run. It executes the method on the hosted Pipelex API and spends inference credit. On a host that renders views, the `run-follow` card follows the run live and hands the conversation back to the model when the run is over. See `SPEC.md` → "`pipelex_run` and its input walk".

### `pipelex_run_status` / `pipelex_run_results`

The console's names for the run lifecycle reads, with the contract of `mthds_run_status` and `mthds_run_results` below. On the console, a completed result also carries the executed graph and the artifacts that describe its data on the view-only `_meta` channel, which is what lets the run card show each node's actual value; the summary names `pipelex_show_images` when the run stored pictures; and an unknown run id reads as a run not visible to your organization. There is no download tool on the console: the user downloads a run's files from the app's UI.

### `pipelex_show_images`

The console's name for the image tool, with the contract of [`mthds_show_images`](#mthds_show_images) below.

## The workshop's tools (`pipelex-plugin`)

Every workshop call runs on the `plx_sk_` key in `PIPELEX_API_KEY`. The method-taking tools take a method three ways: `files`, a published method's address as `method_ref`, or a catalog id as `method_id`. `files` uses `SubmittedFileInput`, `{ content: string; uri?: string | null } | { path: string }`, described in [Files on the workshop, by path](../README.md#files-on-the-workshop-by-path). The workshop registers no views, so every `available_view_specs` it returns is empty and none of its results carries the graph or a form on `_meta`.

### `mthds_list_methods`

The same input and result as `pipelex_list_methods`, over the API key's organization.

Name-to-run flow:

```text
mthds_list_methods({ query: "invoice" })
  → choose/disambiguate method_id
  → mthds_validate({ method_id })                 # optional current-content check
  → mthds_inputs_template({ method_id })
  → fill inputs; prepare/upload assets if needed
  → mthds_run({ method_id, inputs })
```

No method source crosses the conversation in this flow.

### `mthds_validate`

```ts
// input — exactly ONE of files / method_ref / method_id
{
  files?: SubmittedFileInput[];
  method_ref?: string;         // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;          // catalog id (mt_…) of a registered method
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
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

`main_pipe` is the main pipe's typed signature — what an agent needs to write a call site against a method whose source it never sees (a `method_ref` or `method_id` call), instead of guessing the produced concept. It is present on every valid verdict for which the server settled an effective entry pipe — for a published method, the one its manifest names — pending signatures included, on the workshop as much as the console: it does not ride the views branch. Its absence means no entry pipe was settled, not that the method declares none. Any malformed member omits the whole signature rather than emitting a partial one; the verdict is unaffected. The same thing is rendered as one line of the Markdown summary, `demo.main(document: legal.Contract, notes?: native.Text, tags: native.Text[]) -> analysis.Report[2]` (`?` may be omitted, `[]` a list, `[N]` exactly N).

`output.images` answers "will this method produce pictures?" before anything runs. It lists where images sit inside the produced output, as paths from its root: `$` is the output itself, `$.name` a field of it, `$[]` an element of a list, `$[].name` a field of one — so a top-level `Image` output is `["$"]`, an `Image[]` is `["$[]"]`, and the question is `images.length > 0`. It is read from the MTHDS standard's output-form descriptor, which the capability requests from the API, so it costs nothing at run time. An empty array and an absent member are **different answers**: `[]` means the output was described and holds no image, while absence means nothing described it — unknown, not none. The rendered summary line says it too, as a trailing ` (produces images)`.

The graph and the form's artifacts are view-only data, and the workshop renders no views, so a workshop verdict never carries them; on the console, `pipelex_show_method` runs the same projection and delivers them to the `run-graph` view. The MCP `content` text is the API's rendered summary, with the signature line appended. The three source forms are **mutually exclusive — supply exactly one**. `method_ref` validates a published method by its address (`github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0`); `method_id` validates a registered method by its catalog id (requires an API key, since the catalog is org-scoped). Both are **server pass-throughs**: the selector rides the `/v1/validate` body and the hosted API resolves it — no method source enters the conversation.

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

`pipe_ref` is a qualified `domain.pipe_code`; omit it to default to the closure's declared `main_pipe`. `explicit` (default true) emits the ceremonial `{concept, content}` envelope per input — the declared concept ref plus the canonical content shape; pass `false` for the light shape (bare example values). `format` (default `"json"`) chooses the template encoding. The three source forms are **mutually exclusive — supply exactly one**. `method_ref` projects a published method by address, resolved server-side on the build envelope; `method_id` projects a registered method's current stored content (requires an API key, since the catalog is org-scoped). No Skybridge view — the template is small structured data the model reads directly, and the `content` summary repeats it in a fenced block, followed by the next step: `mthds_prepare_inputs`, or straight to `mthds_run` when every file value is already a URL or a `pipelex-storage://` reference.

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

**Without `output_dir`**, write every artifact at its path and the lock as `codegen.lock` beside them, **verbatim**, into a dedicated generated directory; `pipelex codegen check` (or `runCodegenCheck` from `@pipelex/sdk`) then passes on that tree. The `content` summary repeats each file in a fenced block tagged for its language. A large set is withheld by whole file rather than cut (`truncated: true`, `content` absent on the withheld entries; the lock's bytes are reserved first, so the trust anchor always rides). No Skybridge view.

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

Sits between `mthds_inputs_template` (produces the empty template) and `mthds_run` (executes the filled inputs): it makes file-bearing inputs run-ready. The pipe's declared signature identifies which values are assets — read from the MTHDS standard's **input-form descriptor**, which states the kind of every input at every depth, so an optional nested file field prepares like a required one and a text field merely *named* `url` stays untouched. Each asset is uploaded to Pipelex storage and rewritten to `pipelex-storage://`. `http(s)` URLs and existing `pipelex-storage://` references pass through unchanged, so an inputs set that is already all pass-through can skip this step. All three selectors are resolved server-side, by the one `POST /v1/validate` the signature comes from. Local paths, `data:` URLs and inline bytes are uploaded with your API key. No Skybridge view — the prepared inputs are small structured data the model reads directly, repeated in the `content` summary. Unlike the other tools this has **no produced-invalid arm**: an unresolvable closure is a no-verdict `status: "error"` (recover via `mthds_validate` / `mthds_inputs_template`). See `SPEC.md` → "Prepare Inputs Scope" for the full contract.

### `mthds_run` / `mthds_run_status` / `mthds_run_results`

Durable (async) method execution on the hosted Pipelex API. `mthds_run` starts a run — from submitted files (`files?`, plus `pipe_code?` and `inputs?`), from a published method's address (`method_ref?` — `github.com/<owner>/<repo>[/<selector>][@<tag>]`, resolved server-side with the resolved commit SHA echoed back as `method_provenance`), or from a registered method's catalog id (`method_id?`, mt_…) — and returns a durable `run_id` immediately (never blocks); `mthds_run_status` is a cheap read of the coarse lifecycle state; `mthds_run_results` fetches the terminal outcome (main output on success, failure message otherwise) along with a compact run-level `usage` object — its `state` (`records`, `no_inference` or `unavailable`), total USD cost (null-aware), tokens, inference-call count and any usage-assembly error — projected from the SDK's `summarizeUsage`. The per-pipe rollup and the full per-call record list ride the view-only `_meta` (`_meta.usage_by_pipe` / `_meta.tokens_usages`) for a future detailed-cost surface, and usage never appears in the prose. On the console, a completed result also carries the executed graph and the artifacts that describe its data on the same channel, for its run card; the workshop, which has no views, carries none of them. A by-id run executes the method's **current** stored content (methods are not versioned) and requires an API key; when both `files` and `method_id` are supplied, the files run and the id is recorded as run-history linkage on the platform. `method_ref` is a complete run source of its own and pairs with nothing — beside `files` or `method_id` the request is refused. All run state lives behind the durable `run_id` on the platform, so the flow survives conversation gaps — days later, the same id still answers. These are plain tools, with no view. See `SPEC.md` → "Run Scope" for the full contract.

The pipe selector is `pipe_code` here and `pipe_ref` on `mthds_inputs_template` / `mthds_prepare_inputs` (and on every console tool) — the same qualified `domain.pipe_code` value under the name each underlying route uses; each description names the other, so copying the value across the two calls is expected.

A completed `mthds_run_results` also reports, for free, what the run **stored**: `image_candidates` lists the `pipelex-storage://` references whose key looks like an image, and the prose says how many stored files there are and what can be done with them. Nothing is fetched to produce it — the walk is in memory over the full output, so a reference pruned out of the bounded `main_stuff` still appears. The list is capped at 32 entries, with any remainder counted in `image_candidates_omitted`; the cap is a prefix, so an index into it still means the same thing to `mthds_show_images`, which walks the whole set. **The results tool never returns an image itself, and takes no flag that would make it**; showing a picture is `mthds_show_images` below.

### `mthds_show_images`

Put the pictures a completed run produced in front of the model, as MCP **image content blocks**. The console's `pipelex_show_images` has the same contract.

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

**What your host does with an image block** (measured, 2026-09-21 — the study is `wip/mcp-image-results/host-probe.md` in the Pipelex workspace):

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

Each file is named after the field it fills in the output: the picture at `$.rooms[3].staged_photo.url` is saved as `rooms-3-staged_photo.png`, and an output that is one image as `main_stuff.png`. The storage key supplies only the extension. Each entry's `found_at` lists the paths in `main_stuff.json` where its reference sits, the first being the one that named the file; an output that repeats one reference lists the first few and counts the rest in `found_at_omitted`. Files are **never overwritten**: a collision gets a numeric suffix, `main_stuff.json` included, and since the output is written first, a produced file never takes its name. `dir` cannot escape the working directory (no absolute paths, no `..`, no symlink out). Plain `http:` links are accepted only against a plain-http `PIPELEX_BASE_URL` unless `PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP` says otherwise. A `running` or `failed` run is a produced verdict with nothing to save, and partial success is a produced verdict with the failures on their items. On the workshop, every completed `mthds_run_results` summary names this tool as the way to keep the run, and a truncated one names it as the way to read the rest. See `SPEC.md` → "Artifact Download Scope" for the full contract and the reasoning behind a companion tool rather than a flag on `mthds_run_results`.

### `mthds_save_method` / `mthds_get_method`

Two tools carry a bundle between the working directory and the organization's catalog: `mthds_save_method` saves the files on disk as a method, creating one or updating one, and `mthds_get_method` brings a saved method's files back. A save whose root file is a `{ path }` item, or that names a `link_dir`, writes `pipelex-method.json` there, and so does a pull with `output_dir`; that link file ties a directory to the method it was saved as. Commit it, so that a teammate's save from the same directory updates the same method instead of creating a second one. A save sent inline with no `link_dir`, and a pull without `output_dir`, write no link, so the next save must pass `method_id` or it creates a second method; `link_file.written` on the save's result says which happened. Every `{ path }` item, `python` included, must sit at or under the root file's directory, and the root file must itself be a `{ path }` for any other item to be read from disk.

```ts
// mthds_save_method — input
{
  files: SubmittedFileInput[];    // the bundle's .mthds files, ROOT FILE FIRST — { path } items to link the directory
  name: string;                   // the catalog name; on an update, a changed name is a rename
  method_id?: string;             // absent creates; present updates THAT method
  python?: SubmittedFileInput[];  // the bundle's .py files, replaced as a set
  expected_updated_at?: string;   // the stored updated_at this save believes it is overwriting
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
  saved?: "created" | "updated" | "renamed";   // renamed = updated with a changed name
  updated_at?: string;
  api_host?: string;
  link_file?: { path: string; written: boolean; reason?: string };
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

`mthds_save_method` validates the files and saves those same bytes in one call; an invalid bundle is an `is_valid: false` verdict that saves nothing and writes nothing. The root file goes first because the platform derives the method's listed description from it. `name` is required on an update as on a create, because the platform rewrites the whole row. Omitting `python` keeps the stored Python, `[]` clears it, and files replace the set. `expected_updated_at` is a best-effort precondition, not an atomic one, since the platform offers no compare-and-swap. A directory already linked to another method is refused rather than re-pointed, and a create is never retried automatically, because a retry after a lost response would create a second method. No source comes back.

```ts
// mthds_get_method — input
{
  method_id: string;
  output_dir?: string;   // write the sources here; omitted, they come back inline
  overwrite?: boolean;   // only meaningful with output_dir; see the linked-directory rule
}

// mthds_get_method — structuredContent
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

**With `output_dir`**, `mthds_get_method` writes the method's `.mthds` and `.py` files verbatim under the working directory, with the link file beside them, and no source passes through the conversation. It refuses rather than overwrite work it does not own. A directory not linked to this method is written only when it holds none of the files the pull would land and no bundle of its own, and one linked to another method is refused outright. In a directory linked to this method, files that differ from the stored ones are refused as unsaved local work while the stored method has not moved, and refused without `overwrite: true` once it has, which the caller sends only after asking the user. A symlinked destination is refused. Files in the directory that the method does not have are named in `unmanaged` and never deleted. **Without `output_dir`**, the sources come back inline, bounded by whole file, for explaining a method the model cannot see on disk. See `SPEC.md` → "Catalog Write Scope" for the full contract.

## Success and verdict discipline

A successful catalog page is `status: "ok"` with counts and `methods` (there is no `is_valid` field). For tools that produce a method verdict, a *produced* verdict is always `status: "ok"` — discriminate on `is_valid` (and, for validation, `is_runnable`); an invalid bundle or unresolvable closure is a produced `is_valid: false` verdict, not an error. `status: "error"` is reserved for **no result/verdict could be produced** and carries an `errors[]` array, each tagged `input_domain` (bad request), `config` (env/auth/unreachable API), or `runtime` (server fault), plus a `retryable` flag. Every `errors[]` entry's `location`, `message`, and `hint` are also surfaced in the `content` text.
