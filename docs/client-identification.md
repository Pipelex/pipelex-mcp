# Client identification (`User-Agent`)

Every request `pipelex-mcp` sends to the Pipelex API carries a `User-Agent` header that says it came from this server, from which of its two shells, and on behalf of which AI host. The hosted platform parses that header into the client surface it reports in product analytics and in its access log, so a run started from a coding agent through the workshop, or from ChatGPT through the console, is counted as `mcp` and not as an anonymous SDK call. The convention is shared by every first-party Pipelex client; this page describes how this server implements it.

## What the server sends

The value is a sequence of RFC 9110 product tokens, outermost first: this server with a comment naming the shell and the host, then `@pipelex/sdk`, then the runtime.

```
pipelex-mcp/<version> (workshop; host=claude-code/2.1.4) pipelex-sdk-js/<sdk version> node/<version> (darwin; arm64)
pipelex-mcp/<version> (console; host=openai) pipelex-sdk-js/<sdk version> node/<version> (linux; x64)
pipelex-mcp/<version> (console) pipelex-sdk-js/<sdk version> node/<version> (linux; x64)
```

`<version>` is the version of the server that sent the request, read from its own package's `package.json` so it cannot drift from the release: the two servers are released on separate tracks, so the workshop reports `packages/workshop/package.json`'s version and the console `packages/console/package.json`'s. The capability core that builds the header is never released and has no version of its own; each shell hands its mode and its version to the core as one `McpShell` value. The first word of the comment is the shell: `workshop` for the local stdio server that coding-agent hosts spawn with `npx @pipelex/mcp`, `console` for the hosted Skybridge server that remote connectors reach. The product token is `pipelex-mcp` on both, although the two report different server names in their MCP handshake, `pipelex-plugin` for the workshop and `pipelex` for the console: the token names this repository's product, and the comment says which of its servers sent the request. The `host=` parameter names the AI host driving the call and is left out when the server cannot tell.

The server does not build the header itself. It passes an `appInfo` of `{ name: "pipelex-mcp", version, details: [<shell>, "host=<host>"] }` to `PipelexApiClient`, and the SDK renders it in front of its own tokens (see the SDK's own `docs/client-identification.md`).

The header is self-declared and unauthenticated. The platform uses it for analytics and diagnostics only, never for authorization, rate limits or entitlements, and it never carries a secret, a user identifier, an email or a hostname.

## Where the host comes from

**The workshop** reads the host from the `clientInfo` the MCP host sent in the `initialize` handshake, as `<name>/<version>`. The capability contexts are built before any host connects, so the host cannot be captured when they are; each context instead carries a function that reads the handshake when a client is constructed, which happens inside every tool call, after the handshake has completed.

MCP does not restrict `clientInfo` to header-safe characters, and a host may well call itself `Visual Studio Code`. Before a name or a version becomes part of the header, the server lowercases it, replaces every run of characters outside the RFC 9110 `tchar` set with a single `-`, and trims a leading or trailing `-`. So `Visual Studio Code` with version `1.99.0 (Universal)` is sent as `host=visual-studio-code/1.99.0-universal`. Whitespace, `@`, `;`, `/`, quotes and parentheses therefore never reach the header; `@` matters most, because the platform drops any field that contains one. A name that sanitises to nothing leaves the `host=` parameter out, and a version that sanitises to nothing leaves the name alone. A host name that would push the header past its 512-character ceiling is also left out, because the SDK refuses an over-long `appInfo` at construction and a host's name must never be able to fail a tool call.

**The console** is stateless HTTP: nothing links a `tools/call` to the `initialize` that preceded it, so it has no handshake to read. It reads the incoming request's own `User-Agent` instead, on every call, and reduces it to a closed, coarse set: `openai` when the connector's header mentions OpenAI or ChatGPT, `claude` when it mentions Claude or Anthropic, and no `host=` parameter at all otherwise. The connector's raw header is never forwarded.

## One factory, and the guard that keeps it the only one

Every Pipelex API client the server builds comes from `createPipelexApiClient` in `packages/core/src/capabilities/shared.ts`, which passes the context's `appInfo`, or a bare `pipelex-mcp` with no version and no comment when no shell has set one (the live test suites and the scripts, which call capabilities directly and belong to neither server). A capability that needs a subclass, such as the upload size guard, passes the class to the factory rather than constructing it.

Each shell sets the identity on every capability context of its own table through the patch helper that sits beside its context set — `patchHostedApiContexts` in `packages/console/src/hosted/tools.ts` and `patchLocalApiContexts` in `packages/workshop/src/tools.ts` — each being the one list of contexts a shell-level override has to reach on that shell. The console applies it per request in `packages/console/src/hosted/contexts.ts`, alongside the caller's token; the workshop applies it once in `packages/workshop/src/server.ts`, with a function that reads the handshake late.

Two lint rules in `eslint-rules/pipelex-api-boundary.mjs` make the factory the only way to reach the API, and `tests/api-boundary-lint.test.ts` pins them under the repo's real ESLint config:

- `pipelex/sdk-client-factory` refuses `new PipelexApiClient(…)`, `new MthdsApiClient(…)`, or `new` of any class whose name ends in `ApiClient`, anywhere but the factory, whether the class was imported by name, under an alias or through a namespace. It also refuses subclassing an SDK client outside `packages/core/src/capabilities/upload-ceiling.ts`.
- `pipelex/no-raw-fetch` refuses a bare `fetch(…)` or `globalThis.fetch(…)` outside `packages/core/src/capabilities/attachment-fetch.ts`, because a raw request to the API would carry the runtime's default `User-Agent` and be counted as anonymous traffic.

Unit tests are exempt from both, since they construct clients to test them and stub the global `fetch`.

What the rules do not catch: a class whose name does not end in `ApiClient` that wraps the SDK some other way, an HTTP call made through `node:http`, `undici` or another library, and a `fetch` reached through an alias (`const f = fetch`). None exists today, and a review should refuse one.

## Requests that deliberately carry no identity

Requests to third parties keep their own `User-Agent`, as the convention requires. The attachment fetch boundary downloads a file from the host's signed link with no headers at all, and the SDK fetches a presigned object-store link for the image tools (`pipelex_show_images`, `mthds_show_images`) and for `mthds_download_artifacts` with no header either. Only requests to the Pipelex API are identified.
