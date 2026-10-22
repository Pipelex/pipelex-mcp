# Tools reference

The workshop is the Pipelex plugin's local MCP server, published to npm as `@pipelex/mcp` under the server name `pipelex-plugin`: a coding agent spawns it over stdio in your project, and it registers the `mthds_*` tools below. This page gives every tool's input, its `structuredContent`, and how it behaves; [Registering the workshop in a host](hosts.md) gives each host's configuration, and the full contracts (verdict discipline, the `_meta` channel) live in [`SPEC.md`](../SPEC.md). Chat hosts do not run the workshop: they use the Pipelex connector at `https://mcp.pipelex.com/mcp`, a separate product ([Chat hosts use the Pipelex connector](../README.md#chat-hosts-use-the-pipelex-connector)).

## The tools at a glance

| What it does | Tool |
| --- | --- |
| List the saved methods | `mthds_list_methods` |
| List the organization's files, to run a method on one | `mthds_list_files` |
| List the model deck and check a model reference | `mthds_models` |
| Validate a method | `mthds_validate` |
| Project an inputs template | `mthds_inputs_template` |
| Generate typed code | `mthds_codegen` |
| Prepare filled inputs | `mthds_prepare_inputs` |
| Start, follow and read a run | `mthds_run`, `mthds_run_status`, `mthds_run_results` |
| Show a run's pictures | `mthds_show_images` |
| Save a run to disk | `mthds_download_artifacts` |
| Save a method's folder to the catalog as its draft, and pull a draft or a version back to disk | `mthds_save_method`, `mthds_get_method` |
| Publish a method's draft as its next version, when the user asks | `mthds_publish_method` |

## The tools

Every call runs on a `plx_sk_` key: the `PIPELEX_API_KEY` the host passes, or, when it passes none, the key `npx -y @pipelex/mcp@latest login` saves in `~/.pipelex/.env` ([Registering the workshop in a host](hosts.md#your-api-key)). The method-taking tools take a method in any of these forms: its folder on disk as `method_dir`, `files`, a published method's address as `method_ref`, or a catalog id as `method_id`. `files` uses `SubmittedFileInput`, `{ content: string; uri?: string | null } | { path: string }`, described in [Files on the workshop, by path](../README.md#files-on-the-workshop-by-path).

**For a method on disk, pass its folder as `method_dir`.** The folder is resolved against the working directory, must stay inside it on its real path, and must hold a `.mthds` file at its top. Every tool sends the folder's whole tree, the same tree `mthds_save_method` stores, so what a validation checks is what a run runs and what a save keeps: its `.mthds` files, its templates, its Python modules and its data. Which files belong to it is the MTHDS standard's rule, read through `mthds`' own lister, `listMethodTree`: a file belongs to the folder unless a segment of its path starts with a dot (`.git/`, `.env`, the folder's own `.pipelex/`), it sits under `__pycache__/` or `node_modules/`, it sits under a directory holding a `pyvenv.cfg` (a Python virtual environment) or, below the folder's top, under one holding a `.git` entry (a nested repository or a submodule) or a `METHODS.toml` (a nested package), it is a run's inputs file, a file named exactly `inputs.json` or `inputs.toml` at any depth (to run with one, pass its path as `inputs_path`, which reads `.json` files only), or a `.gitignore` inside the folder or the folder's own `METHODS.toml` `[package] exclude` keeps it out (git's semantics; a `.gitignore` above the folder does not count). The workshop leaves out one more file, the method graph page `mthds_validate` writes. A symbolic link refuses the folder, naming its path, unless the rule already leaves it out, and so do two names that collide once normalized or case-folded. Every tool holds the tree to the limits the deployment announces on `GET /v1/version`, and to the workshop's own for any it does not announce: 10,000 files, 32 MiB for one file and 64 MiB in all; a large sample file the method does not need belongs outside the folder or behind a `.gitignore` line. The SDK sends a small tree inline and a larger one by hash, uploading only the files the organization's storage lacks. The result lists every file sent in `files_sent` and under `## Files sent` in the summary, so a stray file the folder holds is seen. Every refusal of the folder is located at `method_dir`, and so is an error the API locates at `files`. A folder is one selector like the others: on `mthds_run` it pairs with a bare `method_id` as `files` does, and it never pairs with `files` or `method_ref`. `mthds_save_method` takes only a folder (see [below](#mthds_save_method--mthds_get_method--mthds_publish_method)). A run directory inside a method's folder is part of it unless a `.gitignore` keeps it out; `mthds_download_artifacts` marks a directory it creates with one. `SPEC.md` → "The method folder" has the whole rule.

**A list of `files` is sent as one tree too.** Each `{ path }` item is a `.mthds` file or a template file (`.html`, `.xlsx`, `.docx` or `.pptx`), read as bytes, and the items keep where they sit relative to one another: the tree is rooted at the deepest directory holding them all, and each file is sent under its path from there, the name diagnostics give it. Beside an inline item, the tree is rooted at the working directory instead, and each `{ path }` item is sent under its path from there, so `[{ content, uri: "invoice.mthds" }, { path: "templates/invoice.xlsx" }]` keeps `templates/invoice.xlsx`. A `PipeDocGen` step finds its template where its `template_file` leads from its `.mthds` file, so lay the files out as the steps name them and list the template beside them: `[{ path: "invoice.mthds" }, { path: "templates/invoice.xlsx" }]` sends `templates/invoice.xlsx` for a step whose `template_file` is `templates/invoice.xlsx`. An inline `{ content, uri? }` item is a `.mthds` file at the tree's top, under its `uri`'s file name when that names a `.mthds` file, else `bundle.mthds`, `bundle-2.mthds` and on; a template file is never inline. A name no method's tree holds (a segment starting with a dot, `__pycache__`, `node_modules`, a run's inputs file), a name the standard refuses, two names that collide and two spellings of one name once Unicode-normalized are refused at their item before anything is sent, and a list holding no `.mthds` file, inline or by path, is refused at `files` before any of it is read, since it makes no method. Every item is checked before any is read, and the deployment's limits hold the files, inline items included, as they hold a folder, on their sizes before the reads and on the running total during them. A method that needs any other file, a Python module or a data file, is sent as its folder. `files_sent` lists every file sent, each `{ path }` as given and each inline item under the name it was sent as. `SPEC.md` → "The files union and the path trust boundaries" has the whole rule.

**A method that looks like it holds a secret is never sent.** Every tool that sends a method's files, from a folder or a list, refuses a file named like a key or a credentials store (a `.key` file that is not a Keynote deck, `.p12`, `id_rsa`, `credentials.json` and the like; a `.pem` file is judged by what it holds, so a certificate goes), or a file holding a well-known key format, whatever its encoding (UTF-8, Latin-1, UTF-16) and inside a binary file too (a PEM private key, an AWS access key id, a GitHub, Slack, Stripe, OpenAI, Anthropic or Pipelex key, among others), before anything of the method is sent. The refusal names each file and what it matched, never the matched text, at `method_dir` for a folder and at each item for a list, and the fix is to move the key into the environment or keep the file out: with a `.gitignore` line or a name starting with a dot for a folder, by leaving it off the list for a list of files. The guard is a tripwire for those well-known shapes, not a promise that a tree holds no secret.

**A `method_id` names a content, not just a method.** A saved method has a draft, which every save writes, and published versions numbered from 1, which only a publish makes. A bare `mt_…` names the latest published version, `mt_…@<n>` version n, and `mt_…@draft` the draft; beside a folder or `files` on `mthds_run` the id must be bare. The workshop works against platforms that resolve the suffix and ones that do not yet: it sends every selector exactly as given on both, so a platform that does not resolve the suffix refuses it, and the refusal's hint says that a bare id reads the draft there. It asks `GET /v1/version` whether `method_versions` is among its extensions only to say what a bare id read. Every by-id result says which content it read or ran, in `method_version` and in its summary: a number, `"draft"`, or `"latest"` for a bare id on a platform that resolves versions. `SPEC.md` → "Method versions, on two platforms" has the whole rule, including the caching and what happens when the platform does not answer. The workshop registers no views, so every `available_view_specs` it returns is empty and none of its results carries the graph or a form on `_meta`; `mthds_validate` writes the method's flowchart as an HTML page instead (see [the method graph page](#mthds_validate)).

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

### `mthds_list_files`

```ts
// input
{
  query?: string;                            // trimmed, case-insensitive; matched SERVER-side in each file's name and original name
  kind?: "uploaded" | "generated" | "test";  // a member's upload, a run's final output, or a test input made for a method
  format?: string[];                         // 1..20 format keys: "pdf", "docx", "xlsx", "md", "image" for any picture…
  method_id?: string;                        // a saved method's bare id (mt_…, no @ suffix): that method's files
  limit?: number;                            // integer 1..50; default 20
  cursor?: string;                           // opaque next_cursor from a previous call, with the same filters
}

// structuredContent — success
{
  status: "ok";
  returned_count: number;
  next_cursor: string | null;                // null only when the listing is finished
  files: Array<{
    file_id: string;
    uri: string;                             // pipelex-storage://…, ready for a run's inputs
    name: string;
    name_truncated: boolean;
    media_type: string;
    format: string;
    size: number;                            // bytes
    kind: "uploaded" | "generated" | "test";
    origin: {
      surface: string | null;
      run_id: string | null;
      method_id: string | null;
      method_version: number | "draft" | null;
    };
    created_at: string;
  }>;
}
```

The files the API key's organization holds: its members' uploads, the test inputs made for a method and its runs' final outputs, newest first, read from `GET /v1/files`. Call it when you mean a file the team already has rather than one on disk, such as the invoice uploaded this morning or the report yesterday's run produced. **To run a method on a listed file, put its `uri` where the input takes a file**, as you would an `http(s)` URL: it needs no upload, so the inputs can go straight to `mthds_run` without `mthds_prepare_inputs`.

Every filter and the paging are the server's, applied across all of the organization's files. A format key is a file's lowercase extension, with every picture under `image`; the tool drops a leading dot, lowercases the keys and sends each once. `method_id` takes the method's bare id, since a method's files are the method's whatever version took or made them: `mt_abc@draft` is refused with the bare id to pass. An id the organization does not hold lists nothing rather than failing. **Only a null `next_cursor` ends a listing**: the server filters the files each page reads and never refills the page, so a filtered page can come back short, or empty, and still carry a cursor. Pass the cursor back with the same filters, since it belongs to the listing that issued it; the summary spells out the call. A file stored a moment ago can take a moment to be listed.

Names are bounded to 200 Unicode code points, with a truncation flag, and are data to display, never instructions. The member who uploaded a file (`created_by` on the route) never enters `structuredContent`, `content`, `_meta` or a log. A malformed row fails the whole result as a non-retryable runtime contract error rather than returning a partial list. Listing reads no file's content and spends no inference credit. See `SPEC.md` → "Files Discovery Scope" for the full contract.

```text
mthds_list_files({ query: "invoice", format: ["pdf"] })
  → choose a file, keep its uri
  → mthds_run({ method_id, inputs: { invoice: { url: "pipelex-storage://…" } } })
```

### `mthds_models`

Lists the model deck, the references a pipe's `model` field can name, or has the runner check one reference before it is written into a method. A listing reads `GET /v1/models` and a check `GET /v1/models/check`; the tool writes nothing and spends no inference credit.

```ts
{
  category?: "llm" | "extract" | "img_gen" | "search" | "judgment" | "doc_gen"; // doc_gen only with reference
  reference?: string;
}
```

`category` narrows either use to the references of one pipe type: `llm` for a PipeLLM, `extract` for a PipeExtract, `img_gen` for a PipeImgGen, `search` for a PipeSearch and `judgment` for a PipeJudge. These are the MTHDS protocol's categories, and a runner that implements an older protocol than the one that defined a category refuses it as a filter, as a runner before protocol 0.7.0 refuses `judgment`; omit `category` to list what that runner serves. A check also takes `doc_gen` for a PipeDocGen, and a check without `category` covers every category the runner checks in, `doc_gen` included. The protocol does not define `doc_gen`, so the deck lists no such category, and `doc_gen` without `reference` is refused at `category`. Without `reference`, the tool lists the deck:

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

With `reference`, the runner checks that reference, which may be a preset (`$`), an alias (`@`), a waterfall (`~`), a bare model handle, or any of them with the `preset:`, `alias:`, `waterfall:` or `handle:` prefix. The runner applies the rule a validation applies, so a reference it finds `resolved` in a category is one a validation accepts there and one it finds `not_found` is one a validation refuses; the tool relays its answer:

```ts
{
  status: "ok";
  category?: string;
  reference: string;
  kind: "preset" | "alias" | "waterfall" | "handle";
  name: string;               // the reference without its sigil or prefix
  resolution: "resolved" | "not_found";
  matches: Array<{
    category: string;
    resolves_to: string | null;  // the model a run calls now; null when it reaches none
    target?: string;             // a preset's or an alias's binding
    description?: string | null; // a preset's description
    fallbacks?: string[];        // a waterfall's steps, in order
    via?: string[];              // for a handle: the presets, aliases and waterfalls that name it
  }>;
  suggestions: string[];      // the nearest names, e.g. "$writing-factual" for "$writing-factul"
  other_kinds: string[];      // the same name under another sigil, e.g. "@best-gpt" for "best-gpt"
  other_categories: string[]; // with a category: where the reference resolves instead
}
```

`resolved` says in which categories the reference resolves, what the deck binds it to there and which model a run through it calls now. A match whose `resolves_to` is `null` names something the runner holds that reaches no model it can call, such as an alias whose target sits on a backend it has not enabled: a validation accepts it, but a run through it fails, and the summary says so. `not_found` is definitive for every kind, a bare model handle included, since the runner knows every model it can call; the lists then say what was probably meant, the wrong sigil first. A reference the runner cannot read at all, such as a blank one or a sigil with no name after it, is an error at `reference` carrying the runner's reason.

**The deck is what the runner can serve, not what your account may use.** A gateway can refuse a listed model when a run starts, after the method validated. The tool's description and every summary say so.

### `mthds_validate`

```ts
// input — exactly ONE of method_dir / files / method_ref / method_id
{
  method_dir?: string;         // the method's folder, relative to the working directory
  files?: SubmittedFileInput[];
  method_ref?: string;         // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;          // catalog id (mt_…) of a registered method
  graph_page?: boolean;        // default true: write method-graph.html into method_dir or beside { path } files
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
  graph_page?: {                   // when the method came from method_dir or every file came as { path }, and graph_page was not false
    path: string;                  // relative to the working directory
    written: boolean;
    error?: ToolError;             // why it was not written; the verdict is unaffected
  };
  warnings?: unknown[];            // a valid verdict's advisory findings, as sent; absent when none
  validation_errors?: unknown[];
  files_sent?: string[];           // method_dir and files: every file of the tree sent
  errors?: ToolError[];
}
```

`warnings` carries a valid verdict's advisory findings, which never change `is_valid`; the Markdown summary lists them too, under `## Warnings`. When the tree carries a step's template, a `PipeDocGen` step's template check reports what it found in it as a `template_check_warning` item, such as a field that matches no input of the step, with `pipe_code`, `template_file` (the file as the step names it) and `template_location` (where in the file), each `null` when unknown.

`main_pipe` is the main pipe's typed signature — what an agent needs to write a call site against a method whose source it never sees (a `method_ref` or `method_id` call), instead of guessing the produced concept. It is present on every valid verdict for which the server settled an effective entry pipe — for a published method, the one its manifest names — pending signatures included. Its absence means no entry pipe was settled, not that the method declares none. Any malformed member omits the whole signature rather than emitting a partial one; the verdict is unaffected. The same thing is rendered as one line of the Markdown summary, `demo.main(document: legal.Contract, notes?: native.Text, tags: native.Text[]) -> analysis.Report[2]` (`?` may be omitted, `[]` a list, `[N]` exactly N).

`output.images` answers "will this method produce pictures?" before anything runs. It lists where images sit inside the produced output, as paths from its root: `$` is the output itself, `$.name` a field of it, `$[]` an element of a list, `$[].name` a field of one — so a top-level `Image` output is `["$"]`, an `Image[]` is `["$[]"]`, and the question is `images.length > 0`. It is read from the MTHDS standard's output-form descriptor, which the capability requests from the API, so it costs nothing at run time. An empty array and an absent member are **different answers**: `[]` means the output was described and holds no image, while absence means nothing described it — unknown, not none. The rendered summary line says it too, as a trailing ` (produces images)`.

The MCP `content` text is the API's rendered summary, with the signature line appended. The source forms are **mutually exclusive — supply exactly one**. `method_ref` validates a published method by its address (`github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0`); `method_id` validates a registered method by its catalog id, the content its suffix names (requires an API key, since the catalog is org-scoped). Both are **server pass-throughs**: the selector rides the `/v1/validate` body and the hosted API resolves it — no method source enters the conversation.

**The method graph page.** The workshop shows no views, so it gives the builder the flowchart as a file instead: when the method came from `method_dir`, or every item of `files` is a `{ path }`, the call writes `method-graph.html` into the directory holding the `.mthds` files (the folder itself, or the deepest directory holding them all, when they span several) and reports it under `graph_page`; a folder never sends the page back, since the workshop leaves it out of the tree. The page embeds the `.mthds` files as validated, none of the method's other files, and loads `@pipelex/mthds-ui`'s standalone viewer and elkjs from jsDelivr, pinned by exact version and Subresource Integrity, and the viewer builds the static graph in the browser, the way a Mermaid page carries its diagram's text. So it opens from disk with no server and no Pipelex install, needs a network connection to draw, and draws a method that does not validate too, with the notes reading its source turned up. It is written whatever the verdict, even when the API produced none, and each validation of the files rewrites it, so it never shows an older version of the method. The write goes through the workshop's write boundary and follows `mthds_codegen`'s policy rather than the download tool's: it replaces only a page carrying its own generator mark, and a file it did not write at that name, a symlink or a directory is left untouched and reported as `graph_page.error`. A page that could not be written never changes the verdict. Inline `{ content }` files, `method_ref` and `method_id` write nothing, and `graph_page: false` skips the page. The summary's `## Method graph` section says where the page is, and on its first write that it is a generated file a project under version control may want to ignore.

### `mthds_inputs_template`

```ts
// input — exactly ONE of method_dir / files / method_ref / method_id
{
  method_dir?: string;         // the method's folder, relative to the working directory
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
  files_sent?: string[];           // method_dir and files: every file of the tree sent
  errors?: ToolError[];
}
```

`pipe_ref` is a qualified `domain.pipe_code`; omit it for the method's entry pipe — a package manifest's `main_pipe`, else the closure's single `main_pipe` declaration. A `pipe_ref` the method does not declare, and a method with no single entry pipe, are refused at `pipe_ref` with the route's reason. `explicit` (default true) emits the ceremonial `{concept, content}` envelope per input — the declared concept ref plus the canonical content shape; pass `false` for the light shape (bare example values). `format` (default `"json"`) chooses the template encoding. The source forms are **mutually exclusive — supply exactly one**. `method_ref` projects a published method by address, resolved server-side; `method_id` projects the content a registered method's id names (see above), resolved by the hosted platform (requires an API key, since the catalog is org-scoped). The tool reads one `POST /v1/pipe-io`, with no dry run, and projects the template client-side from the pipe's input-form descriptor; a closure that does not load comes back as a produced `is_valid: false` verdict with its `validation_errors`. The template is small structured data the model reads directly, and the `content` summary repeats it in a fenced block, followed by the next step: `mthds_prepare_inputs`, or straight to `mthds_run` when every file value is already a URL or a `pipelex-storage://` reference.

### `mthds_codegen`

```ts
// input — exactly ONE of method_dir / files / method_ref / method_id, plus the required target
{
  method_dir?: string;         // the method's folder, relative to the working directory
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
  files_sent?: string[];           // method_dir and files: every file of the tree sent
  errors?: ToolError[];
}
```

Projects the method's concept set into typed models through the Pipelex codegen engine (`POST /v1/codegen`). `target` is required and has no default — the tool description carries the decision rule, so the assistant picks it from the project (the user's explicit request wins): `ts-zod` for a TypeScript or JavaScript project (`types.ts` with zod schemas and inferred types, plus `binder.ts` with a parse/serialize pair per concept — keep both), `python-pydantic` for a Python consumer with no Pipelex runtime (`models.py`), `python-structures` for a Pipelex host or a `@pipe_func` implementation (`structures.py`). Field keys stay snake_case in every target. Every selector is a server pass-through — no bundle enters the conversation.

**Pass `output_dir`** — a dedicated generated directory relative to the working directory, such as `src/generated/<method>/`. The tool writes the artifacts and `codegen.lock` there verbatim and returns no file content at all: `output_dir`, `written_to` per file, `is_current` and any `orphans` instead. It overwrites files it generated (they carry a codegen stamp) and the lock beside them, and refuses the whole write rather than touch anything else — a symlink, a directory, or a file it did not write. Orphans, a stamped file the new lock does not list, are reported and never deleted, so a directory holding two generations stays non-current by design; give each generation its own directory.

**Without `output_dir`**, write every artifact at its path and the lock as `codegen.lock` beside them, **verbatim**, into a dedicated generated directory; `pipelex codegen check` (or `runCodegenCheck` from `@pipelex/sdk`) then passes on that tree. The `content` summary repeats each file in a fenced block tagged for its language. A large set is withheld by whole file rather than cut (`truncated: true`, `content` absent on the withheld entries; the lock's bytes are reserved first, so the trust anchor always rides).

### `mthds_prepare_inputs`

```ts
// input — exactly ONE of method_dir / files / method_ref / method_id, plus exactly ONE of inputs / inputs_path
{
  method_dir?: string;              // the method's folder, relative to the working directory
  files?: SubmittedFileInput[];
  method_ref?: string;              // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;               // catalog id (mt_…) of a registered method
  pipe_ref?: string;
  inputs?: Record<string, unknown>; // the FILLED mthds_inputs_template output
  inputs_path?: string;             // or a .json file in the workspace holding that object
  kind?: "uploaded" | "test";       // what the uploads are recorded as; uploaded by default
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;                // echoed only when the caller supplied it
  inputs?: Record<string, unknown>; // the prepared (rewritten) inputs — ready for mthds_run
  uploads?: string[];               // the pipelex-storage:// uris uploaded this call ([] when all pass-through)
  kind?: "uploaded" | "test";       // echoed only when the caller supplied it
  test_method_id?: string;          // with kind test: the method the uploads are test files of
  files_sent?: string[];            // method_dir and files: every file of the tree sent
  errors?: ToolError[];
}
```

Sits between `mthds_inputs_template` (produces the empty template) and `mthds_run` (executes the filled inputs): it makes file-bearing inputs run-ready. The pipe's declared signature identifies which values are assets — read from the MTHDS standard's **input-form descriptor**, which states the kind of every input at every depth, so an optional nested file field prepares like a required one and a text field merely *named* `url` stays untouched. Each asset is uploaded to Pipelex storage and rewritten to `pipelex-storage://`. `http(s)` URLs and existing `pipelex-storage://` references pass through unchanged, so an inputs set that is already all pass-through can skip this step. Every selector is resolved server-side, by the one `POST /v1/pipe-io` the signature comes from, which runs no dry run and, for an address, fetches only the package's `.mthds` files, so a published package that ships Python prepares on any deployment. Omitting `pipe_ref` prepares the method's entry pipe; a method with no single entry pipe, or a `pipe_ref` it does not declare, is refused at `pipe_ref` with the route's reason. Local paths, `data:` URLs and inline bytes are uploaded with your API key. The prepared inputs are small structured data the model reads directly, repeated in the `content` summary. Unlike the other tools this has **no produced-invalid arm**: a closure that does not load is a no-verdict `status: "error"` located at whatever named the method (recover via `mthds_validate` / `mthds_inputs_template`), and a value at a file input that cannot be read as a file is one located at `inputs`. See `SPEC.md` → "Prepare Inputs Scope" for the full contract.

**Uploads as a method's test files (`kind`).** Every upload is recorded among the organization's files, where `mthds_list_files` lists it, as `uploaded`, a member's own file. Pass `kind: "test"` to record the call's uploads as test inputs made for the method instead, so the method's file list holds them. A test file belongs to a saved method, so name the method by `method_id`, whose version suffix is dropped since a test file is the method's whatever version it tests, or by a `method_dir` that `mthds_save_method` linked to its saved method through `.pipelex/method.json`. A list of `files`, a `method_ref`, a folder with no link, a link file that cannot be read and a link made against another API are each refused at `kind` before anything is sent. A value that passes through is not uploaded and keeps whatever record it has. The platform refuses a test upload from a member whose role is `runner`.

#### Inputs from a file (`inputs_path`)

`mthds_prepare_inputs` and `mthds_run` both take the inputs as an inline `inputs` object or as `inputs_path`, the path of a `.json` file holding that same object. Use the file for a large or machine-produced inputs set, such as facts a script computes each week, so the agent never retypes it into the conversation. The two are mutually exclusive: supplying both is refused at `inputs_path`, and `mthds_prepare_inputs` needs one of them while `mthds_run` takes neither for a method without inputs. The path resolves relative to the server's working directory and is read under the same bounds as a `{ path }` file: the extension must be `.json` (in any case), checked before the disk is touched; the real target, symlinks followed, must sit inside the working directory; it must be a regular file of at most 1 MiB; and it must parse as one JSON object, a leading UTF-8 byte-order mark being skipped. Each refusal is an `input_domain` error at `inputs_path`. Once read, the object is used exactly as the same object passed inline: `mthds_prepare_inputs` still uploads its file-bearing values, and a relative local path inside it is read as it would be inline. A deployment without the workshop's file reader refuses `inputs_path` and asks for inline `inputs`.

### `mthds_run` / `mthds_run_status` / `mthds_run_results`

Durable (async) method execution on the hosted Pipelex API. `mthds_run` starts a run — from the method's folder (`method_dir?`) or submitted files (`files?`, plus `pipe_code?` and `inputs?`, or `inputs_path?` for inputs held in a `.json` file, see [Inputs from a file](#inputs-from-a-file-inputs_path)), from a published method's address (`method_ref?` — `github.com/<owner>/<repo>[/<selector>][@<tag>]`, resolved server-side with the resolved commit SHA echoed back as `method_provenance`), or from a registered method's catalog id (`method_id?`, mt_…) — and returns a durable `run_id` immediately (never blocks); `mthds_run_status` is a cheap read of the coarse lifecycle state and of how far the run has got; `mthds_run_results` fetches the terminal outcome (main output on success, why it failed otherwise) along with a compact run-level `usage` object — its `state` (`records`, `no_inference` or `unavailable`), total USD cost (null-aware), tokens, inference-call count and any usage-assembly error — projected from the SDK's `summarizeUsage`. The per-pipe rollup and the full per-call record list ride the view-only `_meta` (`_meta.usage_by_pipe` / `_meta.tokens_usages`) for a future detailed-cost surface, and usage never appears in the prose. A completed result carries neither the executed graph nor the artifacts that describe its data, and the tool does not ask the platform for them: each results read names the artifacts it uses, so the platform reads nothing the tool would drop. A by-id run executes the content its `method_id` names — a bare id the latest published version, `@<n>` that version, `@draft` the draft — requires an API key, and reports what ran in `method_version`, which `mthds_run_status` also carries when the platform records it; when `method_dir` or `files` is supplied with `method_id`, the files run and the id, which must then be bare, is recorded as run-history linkage on the platform. `method_ref` is a complete run source of its own and pairs with nothing — beside `method_dir`, `files` or `method_id` the request is refused. A run from a folder lists every file it sent in `files_sent`. All run state lives behind the durable `run_id` on the platform, so the flow survives conversation gaps — days later, the same id still answers. See `SPEC.md` → "Run Scope" for the full contract.

The pipe selector is `pipe_code` here and `pipe_ref` on `mthds_inputs_template` / `mthds_prepare_inputs` — the same qualified `domain.pipe_code` value under the name each underlying route uses; each description names the other, so copying the value across the two calls is expected.

A completed `mthds_run_results` also reports, for free, what the run **stored**: `image_candidates` lists the `pipelex-storage://` references whose key looks like an image, and the prose says how many stored files there are and what can be done with them. Nothing is fetched to produce it — the walk is in memory over the full output, so a reference pruned out of the bounded `main_stuff` still appears. The list is capped at 32 entries, with any remainder counted in `image_candidates_omitted`; the cap is a prefix, so an index into it still means the same thing to `mthds_show_images`, which walks the whole set. **The results tool never returns an image itself, and takes no flag that would make it**; showing a picture is `mthds_show_images` below.

**A run says how far it has got.** After reading a run's status, `mthds_run_status` reads its progress snapshot from the hosted API once (`GET /v1/runs/{id}/progress`), whatever the status, and relays it as `progress`: the snapshot's `status`, `version`, `assembled_at`, its one-line `summary`, its `degradation` when the run reads degraded, and its `invocations`, one per run of a pipe inside the run, each with its `path` (the entry pipe's `pipe_ref`, then one segment per controller level, such as `filings.review_filings/step_3/item_2/step_1`), its pipe, its `status` and times, a batch's `{ total, done, running, failed }` counts, a condition's outcome, and the health annotations `attempts`, `last_failure` and `degradation` where the run is retrying or stuck. The summary gets a paragraph of its own in the Markdown, right after the status, exactly as the platform worded it:

```
Progress: Running summarize_filing_batch (step 3 of 4): 1 of 3 items done, 2 running; not progressing at summarize_filing (step 3 of 4, item 3 of 3) after 4 failed attempts
```

A wide batch gives one invocation per item and every one below each, so `invocations` lists at most 50, those running, failed or carrying a health annotation first with their ancestors, then the others in snapshot order, and `progress_invocations_omitted` counts the rest; the list keeps snapshot order, so each invocation follows its ancestors. The progress is best effort: the read is bounded at five seconds, and when it fails, or the hosted API is older than the progress route, the status comes back alone, never as an error. A degraded status is reassured as unaffected only when the platform could not read the run, and never when the progress says the run is not progressing. `SPEC.md` → "A run says how far it has got" has the whole contract.

**A failed run says why.** When a run ends without completing, `mthds_run_status` and the `failed` state of `mthds_run_results`, `mthds_show_images` and `mthds_download_artifacts` carry the error report the runner stored on the run, as one `failure` object:

```ts
// failure — present when the run stored an error report
{
  run_id: string;
  error_type?: string;        // the runner's exception class name, for the support line
  title?: string;             // the stable label of the error class ("LLM completion")
  message?: string;           // what went wrong, as copy written for the caller; only when the report is flagged caller-facing
  error_domain?: string;      // "input", "config" or "runtime"
  error_category?: string;    // "transient", "configuration", "content", …
  retryable?: boolean;        // absent: the report does not say
  user_action?: { kind: string; detail: string };
  finished_at?: string;
}
```

The platform serves the report through the runner's strict disclosure, which keeps a report's message and next step only when the report is flagged as written for the caller (`caller_facing_message: true`) and otherwise serves the placeholder "An internal error occurred.". So `message` is present only on a flagged report, and on any other the title, the next step and the support line are what there is to tell the user; Pipelex support finds the full report by the run id. The failed state's `failure_message`, the platform's one-sentence account of the ending, follows the same rule: it quotes the report's message after the status only for a flagged report, and is otherwise `Run finished with status <STATUS>; no result available`. When the failed state carries no report, the platform's own account is kept as written, unless it quotes a report's message, which then gives way to that sentence too. A deployment that serves the verbose report is treated the same way, so a message not written for the caller never reaches the model from it either.

The summary says it in sentences: why the run failed (the report's title, and its message when the report is flagged caller-facing), what to do (the report's advice, or a sentence chosen by its `kind`, and never the runner's "the system will retry automatically", which is untrue of a run that has ended), whether running it again can help (only when the report says, never a retry when it says no, and a no worded as the report's expectation rather than a certainty), and a line for support with the run id, the error type and the time the run ended. The provider's raw metadata is never carried, the message is cut at 2,000 code points and every other text at 300, and a `wait_and_retry` action carries this server's own advice in `structuredContent` too. A run with no stored report, such as a cancelled one, carries its status alone and says so. The results, image and download tools read the report from the results route's failed arm when it relays one, and otherwise from one status read of the same run, bounded at five seconds, which is also where the time comes from; when that read fails and the arm carried nothing, the summary says the reason is unknown for now rather than that the run stored none.

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
                    // a directory this call creates is marked with a .gitignore of *
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

**A directory the save creates is marked as generated.** For the default location, the topmost directory a save creates, `runs/` on the first save or the run's own folder when `runs/` already exists, gets a `.gitignore` holding `*` before anything is written into it; for a `dir` you name, the directory the run lands in gets it when the save created it, and an ancestor created on the way does not. That keeps the run's files out of git, and out of a method folder the run was saved into, which `method_dir` would otherwise read: its membership rule reads the `.gitignore` files inside the folder and knows no `runs/` by name. A directory the save found is never marked, and an existing `.gitignore` is never touched; a `runs/` made before this needs the same `.gitignore` written by hand. The mark is not listed among the saved files, but the summary says in one line which directory it marked. When the mark cannot be written, the save is refused and the empty directories it created are removed, so a retry creates and marks them again.

A completed run's results also carry a produced image, PDF or document with a `pipelex-storage://` reference beside a presigned `public_url` that expires within the hour. Pass the run id here instead of racing that link: every reference in the run's full output is resolved to a *fresh* link through the API and streamed into a file beside `main_stuff.json`, so the same call still works days later. The walk, the links and the download are `@pipelex/sdk`'s artifact stack (`locateArtifacts`, `downloadArtifacts`), so the tool needs a Pipelex platform serving the bulk resolve route (`POST /v1/resolve-storage-url/bulk`); a bare `pipelex-api` runner has none.

Each file is named after the field it fills in the output: the picture at `$.rooms[3].staged_photo.url` is saved as `rooms-3-staged_photo.png`, and an output that is one image as `main_stuff.png`. The storage key supplies only the extension. Each entry's `found_at` lists the paths in `main_stuff.json` where its reference sits, the first being the one that named the file; an output that repeats one reference lists the first few and counts the rest in `found_at_omitted`. Files are **never overwritten**: a collision gets a numeric suffix, `main_stuff.json` included, and since the output is written first, a produced file never takes its name. `dir` cannot escape the working directory (no absolute paths, no `..`, no symlink out). Plain `http:` links are accepted only against a plain-http `PIPELEX_BASE_URL` unless `PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP` says otherwise. A `running` or `failed` run is a produced verdict with nothing to save, a failed one saying why it failed as `mthds_run_results` does, and partial success is a produced verdict with the failures on their items. Every completed `mthds_run_results` summary names this tool as the way to keep the run, and a truncated one names it as the way to read the rest. See `SPEC.md` → "Artifact Download Scope" for the full contract and the reasoning behind a companion tool rather than a flag on `mthds_run_results`.

### `mthds_save_method` / `mthds_get_method` / `mthds_publish_method`

Three tools carry a method between the working directory and the organization's catalog: `mthds_save_method` saves a method's folder as a method's draft, creating the method or writing the draft of an existing one; `mthds_get_method` brings back a saved method's draft, or one of its published versions; and `mthds_publish_method` makes the draft the method's next published version, which is what callers of its bare id run. A saved method is a **method tree**: every file of its folder that the standard's rule keeps (see [`method_dir`](#the-tools) above), its `.mthds` files, its Python modules, its templates and its data, each at its path with its exact bytes. A save never publishes, so a save never changes what those callers run on a platform that resolves versions; the publish is called only when the user asks for one. A save writes `.pipelex/method.json` in the folder it saved, and so does a pull with `output_dir`; that link file ties a folder to the method it was saved as, and sits outside the method's tree, since a name starting with a dot never belongs to it. A folder still holding `pipelex-method.json`, the name earlier releases wrote, is refused by both tools until the file is moved with `mkdir -p .pipelex && git mv pipelex-method.json .pipelex/method.json`. Commit it, so that a teammate's save from the same folder writes the same method's draft instead of creating a second method. A pull without `output_dir` writes no link, so a save from a folder that never had one must pass `method_id` or it creates a second method; `link_file.written` on the save's result says which happened.

```ts
// mthds_save_method — input
{
  method_dir: string;             // the method's folder, relative to the working directory: its whole tree is saved
  name?: string;                  // required on a create; on an update, omitted keeps the name and a changed one renames
  method_id?: string;             // absent creates; present writes THAT method's draft (bare, or mt_…@draft)
  expected_updated_at?: string;   // the draft token to compare-and-swap on; defaults to the link file's
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
  files_sent?: string[];                        // every file of the tree sent, as method_dir joined with its path
  rename_error?: ToolError;                     // the draft was saved; the rename was not
  validation_errors?: unknown[];
  validation_refused?: ToolError;               // saved unvalidated: the deployment refused the method's Python
  errors?: ToolError[];
}
```

`mthds_save_method` reads the folder's tree, validates it and saves those same bytes as the draft in one call, with the verdict beside the save: an invalid method is saved all the same, as `is_valid: false` with its `validation_errors`, because a draft is work in progress and a publish is where validity is required. Only a validation that was sent and produced no verdict refuses the save, and the summary says why, with one exception: a deployment that refuses to load the method for the Python it holds, which is not sandbox-hosted, can give no verdict about it, so the draft is saved unvalidated and the refusal comes back as `validation_refused`, in place of `is_valid`, `is_runnable` and `pending_signatures`. The tree is listed by the standard's rule under the limits the deployment announces, and sent inline or as blobs the organization lacks, so a method saved from the workshop opens in the webapp's editor as the same files; `files_sent` lists every file, and the summary names the method graph page when the workshop left it out. The platform derives the method's listed description from the first `.mthds` file, in path order, that declares one. **A folder that looks like it holds a secret is refused before anything of it is sent**, by the guard every tool shares (see [The tools](#the-tools)).

The draft write carries neither the name nor the form inputs, so both are kept: a different `name` renames the method through a call of its own, and a failed rename leaves the draft saved and says so in `rename_error`. A name that is the one `.pipelex/method.json` recorded before the method was renamed elsewhere, in the webapp or by a teammate, keeps the stored name instead of undoing that rename; the summary says so, and since the link then records the stored name, saving again with the older name renames the method back. The write is a compare-and-swap on the draft's token: `expected_updated_at` when given, and otherwise the linked folder's `synced_updated_at`, so a save from a linked folder never replaces a draft somebody saved since the folder synced, the webapp's autosave included. Such a save is refused at `expected_updated_at` with both tokens named; to replace that draft knowingly, after asking the user, pass its current `updated_at`. A link that cannot vouch for the draft is refused rather than read as no token: one that cannot be read, or whose last pull never finished, at `method_dir`, and one holding a pulled version, at `expected_updated_at`, since saving it is a restore. The link is written only while it still holds what the save read before its files, so a link a pull or another save wrote meanwhile is left as that call wrote it, and `link_file` says so; and a save whose link moved while it read the files is refused, retryably, without sending anything. The save reads its link and files holding the write lock all of the user's workshop processes share, so no pull lands while it reads, and a save that cannot take that lock is refused without sending anything. Two overlapping saves from one folder read the same token, so the platform takes one and refuses the other rather than let older bytes replace a newer draft. Two overlapping creates from one folder take turns, so the second finds the first's link and is refused instead of minting a duplicate. A rename keeps the draft write's token, so a save by somebody else between the two calls is never adopted as this one. A folder already linked to another method is refused rather than re-pointed, and a create is never retried automatically, because a retry after a lost response would create a second method. No file comes back; the summary names `mt_…@draft` as the id that validates or runs what was saved, or the bare id where the platform does not resolve versions, and the publish call for when the user asks for one.

```ts
// mthds_get_method — input
{
  method_id: string;     // bare or mt_…@draft: the draft; mt_…@<n>: version n
  output_dir?: string;   // write the tree here; omitted, its text files come back inline
  overwrite?: boolean;   // only meaningful with output_dir; see the linked-folder rule
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
  files?: Array<{ path: string; bytes: number; content?: string; binary?: boolean; written_to?: string }>;
  output_dir?: string;                          // present on the written arm — the arm discriminator
  link_file?: { path: string; written: boolean; reason?: string };
  unmanaged?: string[];                         // written arm — files of the folder's tree that this method does not have
  unmanaged_truncated?: boolean;                // written arm — the folder could not be listed, so `unmanaged`'s absence is not "none"
  truncated?: boolean;                          // inline arm only; always false on the written arm
  errors?: ToolError[];
}
```

**With `output_dir`**, `mthds_get_method` writes every file of the stored tree at its path under the working directory, byte for byte and checked against its hash, with `.pipelex/method.json` in the folder, and no file passes through the conversation. A stored path with a segment starting with a dot, or two paths that land on one file once letter case is folded, are refused, writing nothing. It refuses rather than overwrite work it does not own. A folder not linked to this method is written only when its tree, listed as a save would list it, holds no file but those the pull lands and none of those yet, since the link claims the whole folder and the next save sends its whole tree: pulling into a project's root is refused, naming the project's files, and a fresh folder is the cure. The folder is listed again just before the files land, so a file that appeared while the pull downloaded is refused the same way. A folder linked to another method is refused outright. In a folder linked to this method, files that differ from the pulled ones are refused as unsaved local work while the draft has not moved, and refused without `overwrite: true` once it has, which the caller sends only after asking the user; files whose bytes the catalog already stores, as the draft's or as the version the folder last pulled, are written over freely. A pull of a version records it in the link as `synced_version`, and saving from that folder with the draft's token as `expected_updated_at` is how a version is restored: the save replaces the draft's whole tree with the version's and publishes nothing, and without the token it is refused, so a version pulled to be read is never saved over the draft by accident. A version whose files are exactly the draft's is recorded as no version, since the folder then holds the draft, and a save from it needs no token. A symlinked destination is refused, and so is a destination below a directory that is a symlink, since writing through it would land wherever it points. The tree is downloaded to a private temporary directory before anything is written, so a failed download leaves the folder as it was. A pull whose folder's link was rewritten by a save or another pull after it read it, or one of whose files changed after it read them, writes nothing and asks to be run again, since what it planned is about a folder that has moved. Files of the folder's tree that the method does not have are named in `unmanaged` and never deleted. **Without `output_dir`**, the text files come back inline, bounded by whole file to 256 KiB in all, a file that is not UTF-8 text marked `binary` with no content, for explaining a method the model cannot see on disk. A method whose draft holds no file yet is an error at `method_id`.

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

An entry may also carry a `kind`, which says what a `config` error is about when its class alone would read as an unreachable API, and picks the summary's headline:

- `paywall`: the organization's plan does not cover the call (a `402`).
- `auth`: the Pipelex API key is missing or was refused (a `401` or `403`, the upload and download legs' refused credential included). The headline names the key, and the hint says whether no key was set, the host's key was refused or the saved key was refused, naming `npx -y @pipelex/mcp@latest login` to save one. On `mthds_codegen` a `403` can also mean that code generation is not enabled for the key's organization, and its headline and hint say so. The execution-locus refusals, which are `403`s about the method, are `input_domain` and carry no kind, and so is the `403` refusing a run whose inputs reference a file another organization stored, which a key changed since `mthds_prepare_inputs` uploaded them meets, after a login to another organization for instance: it is located at `inputs`, and its hint says to prepare the inputs again under the current key.
- `role`: the key was accepted, but the role its owner holds in the organization does not allow the action (the platform's `403 role_not_permitted`). A runner meets it on a save, a publish and a run of anything but a published version, such as `mt_…@draft`; a member meets it on an action only an admin may take. The headline names the role, such as "The method was not saved: your role in this organization does not allow this.", the message is the platform's own sentence naming the role the caller holds and what the action needs, and the hint never suggests a new key or a login, since neither changes a role: an admin of the organization does.

A machine consumer branches on `class` and may read `kind` to tell these causes apart without parsing the message.
