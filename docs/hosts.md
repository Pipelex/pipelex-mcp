# Registering the workshop in a host

The workshop is this repository's stdio server. This page gives its registration in each host that spawns it, the environment variables it reads, and the working directory it is bound to. On Claude Code and Codex, the [Pipelex plugin](https://github.com/Pipelex/pipelex-plugins) runs this server for you, beside the skills that build methods, so register it by hand only where you do not use the plugin, and never beside it. A chatbot adds the hosted Pipelex connector by its address instead: see [Chat hosts use the Pipelex connector](../README.md#chat-hosts-use-the-pipelex-connector). The connector's tools are `pipelex_*` and the workshop's are `mthds_*`, so a host that ends up with both, as Claude Code does when a claude.ai connector syncs into it, can tell them apart, and the workshop's instructions tell the model to use its `mthds_*` tools for all method work there.

The workshop is published as [`@pipelex/mcp`](https://www.npmjs.com/package/@pipelex/mcp). Hosts spawn it on demand with `npx -y @pipelex/mcp@latest` (bin `pipelex-mcp`); you do not install it globally. Every registration below spells it with `@latest`, which has `npx` look up the newest release at each start: with the bare package name, `npx` keeps starting whatever copy it cached first, an old server that ignores what was added since, the `login` argument included. It needs **Node.js 24.14.1 or later** and a `plx_sk_` platform key, saved by the login or passed in the host's registration as `PIPELEX_API_KEY` (see [Your API key](#your-api-key)): against the hosted Pipelex API every tool needs one, and only a local `pipelex-api` runner started without authentication answers `mthds_validate`, `mthds_inputs_template` and `mthds_codegen` without a key.

The registration name is yours to choose; these snippets use `pipelex` (which yields `mcp__pipelex__mthds_validate`-style tool names). Whatever you call it, the server reports itself as `pipelex-plugin` in its MCP handshake.

## Your API key

The simplest way to give the workshop its key is to log in once, in a terminal:

```bash
npx -y @pipelex/mcp@latest login
```

The command prints a sign-in link and opens your browser on it, and says so when no browser could be opened, the printed link then being the way through. Once you sign in at [app.pipelex.com](https://app.pipelex.com), the page creates a key for your current organization and hands it back to the command, which waits up to five minutes for it. The command checks the key with the Pipelex API and saves it as `PIPELEX_API_KEY` in `~/.pipelex/.env`, or in the `.env` of `PIPELEX_HOME` when you set that, keeping the file's other lines. When your shell sets `PIPELEX_BASE_URL`, the key is checked against that API, and the login saves `PIPELEX_BASE_URL` beside the key whenever the file would otherwise name another, so every host pairs the key with the API that accepted it, even one that does not pass your shell's environment. A key the API refuses is not saved, and one it could not check is saved with a warning. The key is never printed, and the command exits as soon as it is done, with code `0` when the key is saved and a non-zero code when nothing was. The workshop uses that key whenever its host passes no `PIPELEX_API_KEY` of its own, from its next tool call, with no restart, and a tool call made with no key at all says so and names the command. The pipelex CLI's `pipelex login` writes the same file, so either login serves both.

On a machine whose browser cannot reach the command, over SSH or in a container, `npx -y @pipelex/mcp@latest login --paste` asks instead for a key you created on the Developer page of the Pipelex app, and reads it without showing it. It needs a terminal to read from, so it refuses under Claude Code's `!`, where the browser login works. `login --help` prints the usage, any other argument after `login` prints it too and exits with a non-zero code, and `PIPELEX_APP_URL` points the login at a Pipelex app other than app.pipelex.com, for development.

Spell the command with `@latest`: a copy of the package that `npx` cached before the login existed ignores the word `login` and starts the server, which then waits silently for a host.

The alternative is to set the key in the host's own configuration, as each registration below does with `PIPELEX_API_KEY`, pasting a key you created on the Developer page of the Pipelex app. A key the host passes always wins over the saved one, so to use the login's key, leave `PIPELEX_API_KEY` out of the registration, or empty; with the Pipelex plugin, leave its API key option empty on Claude Code, and on Codex leave `PIPELEX_API_KEY` unset in the shell you start it from. A host that does not pass your shell's environment must also be given `PIPELEX_HOME` when you set it (see [Environment](#environment)).

## Claude Code

```bash
claude mcp add pipelex --env PIPELEX_API_KEY=plx_sk_... -- npx -y @pipelex/mcp@latest
```

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.pipelex]
command = "npx"
args = ["-y", "@pipelex/mcp@latest"]
env = { PIPELEX_API_KEY = "plx_sk_..." }
```

## Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "npx",
      "args": ["-y", "@pipelex/mcp@latest"],
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
      "args": ["-y", "@pipelex/mcp@latest"],
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

Mistral Vibe spawns stdio servers with a minimal environment plus this `env` table and expands no variables, so a key exported in your shell never reaches the server: write the key here, or leave it empty here and run the login (see [Your API key](#your-api-key)). Keep exporting it in your shell as well, because the plugin's validation hook reads it from there. `PIPELEX_BASE_URL` stays empty for the hosted API — an empty value counts as unset — and any other variable `npx` needs, such as `HTTPS_PROXY` behind a proxy, goes in the same table. `startup_timeout_sec` is raised above Mistral Vibe's 10-second default because the first `npx` spawn fills the npm cache and takes longer than that. Two things to clear out of the file first: a `mcp_servers = []` line, which Mistral Vibe writes into a new config and which makes it refuse to start, since TOML cannot add a `[[mcp_servers]]` table to an array already written inline; and any `pipelex` server you registered by hand, since it refuses to start with two servers of the same name.

## Environment

- `PIPELEX_API_KEY` — a `plx_sk_` platform key. Required for `mthds_list_methods` because the returned catalog is the key's active, workspace-shared organization catalog. Optional for `mthds_validate` / `mthds_inputs_template` / `mthds_codegen` calls that submit `files` against a key-less API; effectively required for the run family and for any `method_id` call on any tool, since the catalog is org-scoped (a missing or refused key is a `config` no-verdict tagged `kind: "auth"`, whose headline names the key and whose hint says which key it was and names the login). When the host passes a non-empty `PIPELEX_API_KEY`, the workshop uses that key and reads nothing else. When the host passes none, or passes it empty, the workshop uses the key saved in `~/.pipelex/.env`, or in the `.env` of `PIPELEX_HOME` when that is set, which is the file `npx -y @pipelex/mcp@latest login` writes, and the pipelex CLI's `pipelex login` too. It reads that file afresh at the start of every tool call, so a key saved there while a session runs is used from the next call, with no restart. The working directory's `.env` is never read: the host spawns the workshop in your project, and a cloned repository could ship one.
- `PIPELEX_BASE_URL` — defaults to the hosted Pipelex API (`https://api.pipelex.com`). Set it to `http://localhost:8081` to develop against a local `pipelex-api` runner. Durable runs need the hosted API; a bare runner has no run lifecycle. When the key is the one saved in the home `.env`, the environment's `PIPELEX_BASE_URL` still wins, but when the environment sets none, the `PIPELEX_BASE_URL` saved in the same file applies, so a development key saved beside `PIPELEX_BASE_URL=https://api-dev.pipelex.com` is sent to the development API and not to production. A base URL in the file never applies to a key the host passes, nor to a call that has no key at all. When the file's base URL is the one in use, an error the base URL causes, such as an unreachable API, says that it was read from that file.
- `PIPELEX_HOME` — optional: the directory that holds the home `.env` in place of `~/.pipelex`, as it is for the pipelex CLI. It must be an absolute path or start with `~/`. A relative value is refused, the file is then not read, and a call's error says so, since a relative home would resolve against the project the host spawned the workshop in. A host that does not pass your shell's environment must be given `PIPELEX_HOME` whenever you set it, or the workshop reads `~/.pipelex/.env` while the key was saved elsewhere: Codex passes a server only a short list of variables of its own plus the ones its registration names (`env` or `env_vars`), and Mistral Vibe passes only its `[mcp_servers.env]` table, so name `PIPELEX_HOME` there.
- `PIPELEX_MCP_ARTIFACTS_ALLOW_HTTP` — optional. `mthds_download_artifacts` accepts a plain `http:` download link only when `PIPELEX_BASE_URL` is itself `http:` (the local compose stack, whose object store mints such links). Set it to `true` to accept them from any deployment, or `false` to refuse them everywhere; any other value refuses.

## The working directory

**The working directory matters.** The host spawns the workshop in your project, and that directory is the boundary for everything the server touches on disk: `files: { path }` items resolve inside it, `mthds_download_artifacts` saves under it, `mthds_codegen`'s `output_dir` writes under it, and so do `mthds_get_method`'s `output_dir` and the link file `mthds_save_method` writes. Nothing outside it is ever read or written — an absolute path, a `..`, or a symlink pointing out of the tree is refused.
