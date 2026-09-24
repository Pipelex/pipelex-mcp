# Registering the workshop in a host

The workshop is this repository's stdio server. This page gives its registration in each host that spawns it, the environment variables it reads, and the working directory it is bound to. On Claude Code and Codex, the [Pipelex plugin](https://github.com/Pipelex/pipelex-plugins) runs this server for you, beside the skills that build methods, so register it by hand only where you do not use the plugin, and never beside it. A chatbot adds the hosted console by its address instead: see [Which server, for which host](../README.md#which-server-for-which-host).

The workshop is published as [`@pipelex/mcp`](https://www.npmjs.com/package/@pipelex/mcp). Hosts spawn it on demand with `npx -y @pipelex/mcp` (bin `pipelex-mcp`); you do not install it globally. It needs **Node.js 24+** and a `PIPELEX_API_KEY` (a `plx_sk_` platform key) for the run tools; validation and inputs work without one against a key-less API.

The registration name is yours to choose; these snippets use `pipelex` (which yields `mcp__pipelex__mthds_validate`-style tool names).

## Claude Code

```bash
claude mcp add pipelex --env PIPELEX_API_KEY=plx_sk_... -- npx -y @pipelex/mcp
```

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.pipelex]
command = "npx"
args = ["-y", "@pipelex/mcp"]
env = { PIPELEX_API_KEY = "plx_sk_..." }
```

## Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "npx",
      "args": ["-y", "@pipelex/mcp"],
      "env": { "PIPELEX_API_KEY": "plx_sk_..." }
    }
  }
}
```

## Cowork / Claude Desktop (builder mode)

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "npx",
      "args": ["-y", "@pipelex/mcp"],
      "env": { "PIPELEX_API_KEY": "plx_sk_..." }
    }
  }
}
```

## Mistral Vibe (TUI)

In `~/.vibe/config.toml` (`$VIBE_HOME/config.toml` when `VIBE_HOME` is set):

```toml
[[mcp_servers]]
name = "pipelex"
transport = "stdio"
command = "npx"
args = ["-y", "@pipelex/mcp@latest"]
startup_timeout_sec = 60.0

[mcp_servers.env]
PIPELEX_API_KEY = "plx_sk_..."
PIPELEX_BASE_URL = ""
```

**Append this at the end of the file**, after every top-level setting: pasted above one, the `[mcp_servers.env]` header claims that setting as an environment variable of the server, silently. And **Mistral Vibe copies its whole configuration, this `env` table included, into every session log** under `~/.vibe/logs/session/`, so your key is written there unredacted — redact it before you share a log.

Mistral Vibe spawns stdio servers with a minimal environment plus this `env` table and expands no variables, so the key has to be written here; a key exported in your shell never reaches the server. Keep exporting it in your shell as well, because the plugin's validation hook reads it from there. `PIPELEX_BASE_URL` stays empty for the hosted API — an empty value counts as unset — and any other variable `npx` needs, such as `HTTPS_PROXY` behind a proxy, goes in the same table. `startup_timeout_sec` is raised above Mistral Vibe's 10-second default because the first `npx` spawn fills the npm cache and takes longer than that. Two things to clear out of the file first: a `mcp_servers = []` line, which Mistral Vibe writes into a new config and which makes it refuse to start, since TOML cannot add a `[[mcp_servers]]` table to an array already written inline; and any `pipelex` server you registered by hand, since it refuses to start with two servers of the same name.

## Environment

- `PIPELEX_API_KEY` — a `plx_sk_` platform key. Required for `mthds_list_methods` because the returned catalog is the key's active, workspace-shared organization catalog. Optional for `mthds_validate` / `mthds_inputs_template` / `mthds_codegen` calls that submit `files` against a key-less API; effectively required for the run family and for any `method_id` call on any tool, since the catalog is org-scoped (a missing/invalid key is a `config` no-verdict).
- `PIPELEX_BASE_URL` — defaults to the hosted Pipelex API (`https://api.pipelex.com`). Set it to `http://localhost:8081` to develop against a local `pipelex-api` runner. Durable runs need the hosted API; a bare runner has no run lifecycle.
- `PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP` — optional. `mthds_download_artifacts` accepts a plain `http:` download link only when `PIPELEX_BASE_URL` is itself `http:` (the local compose stack, whose object store mints such links). Set it to `true` to accept them from any deployment, or `false` to refuse them everywhere; any other value refuses.

## The working directory

**The working directory matters.** The host spawns the workshop in your project, and that directory is the boundary for everything the server touches on disk: `files: { path }` items resolve inside it, `mthds_download_artifacts` saves under it, `mthds_codegen`'s `output_dir` writes under it, and so do `mthds_get_method`'s `output_dir` and the link file `mthds_save_method` writes. Nothing outside it is ever read or written — an absolute path, a `..`, or a symlink pointing out of the tree is refused.
