# Client identification (`User-Agent`)

Every request the workshop sends to the Pipelex API carries a `User-Agent` header that says it came from this server and on behalf of which AI host. The hosted platform parses that header into the client surface it reports in product analytics and in its access log, so a run started from a coding agent through the workshop is counted as `mcp` and not as an anonymous SDK call. The convention is shared by every first-party Pipelex client; this page describes how this server implements it.

## What the server sends

The value is a sequence of RFC 9110 product tokens, outermost first: this server with a comment naming the shell and the host, then `@pipelex/sdk`, then the runtime.

```
pipelex-mcp/<version> (workshop; host=claude-code/2.1.4) pipelex-sdk-js/<sdk version> node/<version> (darwin; arm64)
pipelex-mcp/<version> (workshop) pipelex-sdk-js/<sdk version> node/<version> (linux; x64)
```

`<version>` is the workshop's version, read from `packages/workshop/package.json` so it cannot drift from the release. The capability core that builds the header is never released and has no version of its own; the workshop hands its mode and its version to the core as one `McpShell` value. The first word of the comment is the shell, `workshop`, the local stdio server that coding-agent hosts spawn with `npx @pipelex/mcp`. The product token is `pipelex-mcp`, although the server reports `pipelex-plugin` as its name in the MCP handshake: the token names this repository's product, and the comment says which server sent the request. The `host=` parameter names the AI host driving the call and is left out when the server cannot tell.

The server does not build the header itself. It passes an `appInfo` of `{ name: "pipelex-mcp", version, details: [<shell>, "host=<host>"] }` to `PipelexApiClient`, and the SDK renders it in front of its own tokens (see the SDK's own `docs/client-identification.md`).

The header is self-declared and unauthenticated. The platform uses it for analytics and diagnostics only, never for authorization, rate limits or entitlements, and it never carries a secret, a user identifier, an email or a hostname.

## Where the host comes from

The workshop reads the host from the `clientInfo` the MCP host sent in the `initialize` handshake, as `<name>/<version>`. The capability contexts are built before any host connects, so the host cannot be captured when they are; each context instead carries a function that reads the handshake when a client is constructed, which happens inside every tool call, after the handshake has completed.

MCP does not restrict `clientInfo` to header-safe characters, and a host may well call itself `Visual Studio Code`. Before a name or a version becomes part of the header, the server lowercases it, replaces every run of characters outside the RFC 9110 `tchar` set with a single `-`, and trims a leading or trailing `-`. So `Visual Studio Code` with version `1.99.0 (Universal)` is sent as `host=visual-studio-code/1.99.0-universal`. Whitespace, `@`, `;`, `/`, quotes and parentheses therefore never reach the header; `@` matters most, because the platform drops any field that contains one. A name that sanitises to nothing leaves the `host=` parameter out, and a version that sanitises to nothing leaves the name alone. A host name that would push the header past its 512-character ceiling is also left out, because the SDK refuses an over-long `appInfo` at construction and a host's name must never be able to fail a tool call.

## One factory, and the guard that keeps it the only one

Every Pipelex API client the server builds comes from `createPipelexApiClient` in `packages/core/src/capabilities/shared.ts`, which passes the context's `appInfo`, or a bare `pipelex-mcp` with no version and no comment when the server has set none (the live test suites and the scripts, which call capabilities directly without starting the server). A capability that needs a subclass, such as the upload size guard, passes the class to the factory rather than constructing it.

The workshop sets the identity on every capability context of its table through `patchLocalApiContexts` in `packages/workshop/src/tools.ts`, the one list of contexts a server-level override has to reach. It applies it once, in `packages/workshop/src/server.ts`, with a function that reads the handshake late.

Two lint rules in `eslint-rules/pipelex-api-boundary.mjs` make the factory the only way to reach the API, and `tests/api-boundary-lint.test.ts` pins them under the repo's real ESLint config:

- `pipelex/sdk-client-factory` refuses `new PipelexApiClient(…)`, `new MthdsApiClient(…)`, or `new` of any class whose name ends in `ApiClient`, anywhere but the factory, whether the class was imported by name, under an alias or through a namespace. It also refuses subclassing an SDK client outside `packages/core/src/capabilities/upload-ceiling.ts`.
- `pipelex/no-raw-fetch` refuses a bare `fetch(…)` or `globalThis.fetch(…)`, because a raw request to the API would carry the runtime's default `User-Agent` and be counted as anonymous traffic. The one exempt file is the method graph page's live check, `packages/core/src/capabilities/graph-page.e2e.ts`, which fetches the public CDN files the page pins and never the Pipelex API.

Unit tests are exempt from both, since they construct clients to test them and stub the global `fetch`.

What the rules do not catch: a class whose name does not end in `ApiClient` that wraps the SDK some other way, an HTTP call made through `node:http`, `undici` or another library, and a `fetch` reached through an alias (`const f = fetch`). None exists today, and a review should refuse one.

## Requests that deliberately carry no identity

Requests to third parties keep their own `User-Agent`, as the convention requires. The SDK fetches a presigned object-store link for `mthds_show_images` and for `mthds_download_artifacts` with no header, and the method graph page's viewer is loaded by the user's browser, never by the server. Only requests to the Pipelex API are identified.
