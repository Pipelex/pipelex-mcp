#!/usr/bin/env node
/**
 * check-server-bundle.mjs — boot the console from dist/server.bundle.js alone, and prove
 * it serves the console's contract.
 *
 * The console is started from the esbuild bundle `skybridge build` emits for Vercel,
 * copied into dist/ by scripts/emit-server-bundle.mjs, so that nothing reads `skybridge`
 * from node_modules at run time and it can be a devDependency (every `npx @pipelex/mcp`
 * install used to carry its non-optional peers: react, react-dom, vite, nodemon). That
 * bundle is Skybridge's Vercel output, not a promised interface, and two ways it can go
 * wrong are invisible to every other gate: a package left external that only an
 * installed node_modules satisfies, and a server that bundles but no longer boots. Alpic
 * would refuse such a deployment at its validation step, which is the wrong place to
 * learn it.
 *
 * So this copies the bundle, and nothing else, into an empty temporary directory — no
 * node_modules in it or above it — and starts it there the way Alpic does (`node
 * dist/server.bundle.js`, NODE_ENV=production, the port in __PORT). The console refuses
 * to boot without WorkOS AuthKit, and AuthKit discovery is fetched at boot, so a local
 * stub stands in for the authorization server: it serves the discovery document and a
 * JWKS holding a key minted for this run, which lets the check sign its own access token.
 * Nothing leaves the machine.
 *
 * Then it asserts, in order: the protected-resource metadata answers and names the
 * configured resource; an unauthenticated POST /mcp is refused with 401; and an
 * authenticated MCP client gets the same `tools/list` the source's contract snapshot
 * pins (src/hosted/console.contract.json), the same server name and the same resource
 * URIs, and can read every view resource. The last one is what proves the bundle carries
 * the view manifest rather than a file it expects to find on disk.
 *
 * Usage: node scripts/check-server-bundle.mjs. Run it after a build; `npm run check` does.
 */
import { spawn } from "node:child_process";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// `no-console` is an error in this repo's eslint config, and this is a CLI whose whole
// output is its report. `scripts/check-cascade.mjs` writes the same way.
const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "server.bundle.js");
const CONTRACT = path.join(ROOT, "src", "hosted", "console.contract.json");
const BOOT_TIMEOUT_MS = 30_000;
// Every request the check makes is bounded on its own, so a bundle that accepts a
// connection and never answers fails in seconds rather than at undici's five-minute
// header timeout, or the MCP client's one-minute request timeout.
const REQUEST_TIMEOUT_MS = 10_000;
const bounded = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

/**
 * A production build versions each view's resource URI with a content hash
 * (`ui://views/ext-apps/run-graph.html?v=d37e7701`), so a host refetches a view whose
 * bundle changed. The contract snapshot is taken from source, where there is no build and
 * so no hash; the hash is the only difference between the two, and it moves on every
 * view change, so it is removed before comparing rather than pinned.
 */
const unversioned = (value) => JSON.stringify(value).replace(/(ui:\/\/[^"?]+)\?v=[0-9a-f]+/g, "$1");

/** A free TCP port on the loopback interface. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const base64url = (value) => Buffer.from(value).toString("base64url");

/** The authorization server stand-in: OIDC discovery, a JWKS, and a signer for its key. */
async function startAuthorizationServer() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const discovery = {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    jwks_uri: `${issuer}/oauth2/jwks`,
    response_types_supported: ["code"],
  };
  const server = http.createServer((req, res) => {
    const body =
      req.url === "/.well-known/openid-configuration" ||
      req.url === "/.well-known/oauth-authorization-server"
        ? discovery
        : req.url === "/oauth2/jwks"
          ? { keys: [jwk] }
          : undefined;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const sign = (claims) => {
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = base64url(JSON.stringify(claims));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
  };
  return { issuer, sign, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Poll until the console answers its metadata route, or the process dies, or time runs out. */
async function waitForBoot(url, child, logs) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `the bundle exited before it answered (code ${child.exitCode}, signal ${child.signalCode})\n${logs()}`,
      );
    }
    try {
      const response = await fetch(url, { signal: bounded() });
      if (response.ok) return response;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the bundle did not answer ${url} within ${BOOT_TIMEOUT_MS / 1000}s\n${logs()}`);
}

const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    out(`PASS ${label}`);
  } else {
    failures.push(label);
    err(`FAIL ${label}${detail ? `\n  ${detail}` : ""}`);
  }
};

if (!fs.existsSync(BUNDLE)) {
  err(
    `check-server-bundle: ${path.relative(ROOT, BUNDLE)} does not exist. Run \`npm run build\` first.`,
  );
  process.exit(1);
}

const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipelex-mcp-bundle-"));
fs.mkdirSync(path.join(workDir, "dist"));
fs.copyFileSync(BUNDLE, path.join(workDir, "dist", "server.bundle.js"));

const authorizationServer = await startAuthorizationServer();
const port = await freePort();
const origin = `http://localhost:${port}`;
const resource = `${origin}/`;

let output = "";
const child = spawn(process.execPath, ["dist/server.bundle.js"], {
  cwd: workDir,
  // A minimal environment, so nothing the developer's shell exports (a PIPELEX_API_KEY,
  // a NODE_PATH, a NODE_OPTIONS) can make the bundle boot for a reason Alpic does not have.
  env: {
    PATH: process.env.PATH ?? "",
    HOME: workDir,
    NODE_ENV: "production",
    __PORT: String(port),
    WORKOS_AUTHKIT_DOMAIN: authorizationServer.issuer,
    PIPELEX_MCP_RESOURCE_INDICATOR: resource,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const logs = () =>
  output.trim() ? `bundle output:\n${output.trim()}` : "the bundle printed nothing";

let client;
try {
  const metadataResponse = await waitForBoot(
    `${origin}/.well-known/oauth-protected-resource`,
    child,
    logs,
  );
  const metadata = await metadataResponse.json();
  check(
    "boots from an empty directory and serves its protected-resource metadata",
    metadata.resource === resource &&
      metadata.authorization_servers?.includes(authorizationServer.issuer),
    `got ${JSON.stringify(metadata)}`,
  );

  const anonymous = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: bounded(),
  });
  check(
    "refuses an unauthenticated POST /mcp with 401",
    anonymous.status === 401,
    `got ${anonymous.status}`,
  );

  const now = Math.floor(Date.now() / 1000);
  const token = authorizationServer.sign({
    iss: authorizationServer.issuer,
    aud: resource,
    sub: "user_bundle_check",
    iat: now,
    exp: now + 300,
  });
  client = new Client({ name: "check-server-bundle", version: "0.0.0" });
  const timeout = { timeout: REQUEST_TIMEOUT_MS };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
    timeout,
  );

  const serverName = client.getServerVersion()?.name;
  check(
    "reports the contract's server name",
    serverName === contract.initialize.serverInfo.name,
    `got ${serverName}, the contract pins ${contract.initialize.serverInfo.name}`,
  );

  const tools = (await client.listTools(undefined, timeout)).tools;
  check(
    "serves the tools/list the console contract pins",
    unversioned(tools) === JSON.stringify(contract.tools),
    `bundle lists [${tools.map((tool) => tool.name).join(", ")}]; the contract pins [${contract.tools
      .map((tool) => tool.name)
      .join(", ")}]. If the names agree, a schema or description differs: rebuild, and ` +
      "re-run the console contract test to see which.",
  );

  const resources = (await client.listResources(undefined, timeout)).resources;
  const uris = resources.map((entry) => entry.uri);
  const pinnedUris = contract.resources.map((entry) => entry.uri);
  check(
    "lists the contract's view resources",
    unversioned(uris) === JSON.stringify(pinnedUris),
    `got [${uris.join(", ")}], the contract pins [${pinnedUris.join(", ")}]`,
  );

  for (const uri of new Set(uris)) {
    const read = await client.readResource({ uri }, timeout);
    const text = read.contents.map((content) => content.text ?? "").join("");
    check(
      `reads ${uri} from the bundled view manifest`,
      text.includes("<"),
      `got ${text.slice(0, 200)}`,
    );
  }
} catch (error) {
  failures.push("the check itself");
  err(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client?.close().catch(() => undefined);
  child.kill("SIGTERM");
  await authorizationServer.close();
  fs.rmSync(workDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  err(`\ncheck-server-bundle: ${failures.length} check(s) failed. ${logs()}`);
  process.exit(1);
}
out(
  "check-server-bundle: the console boots from dist/server.bundle.js with no node_modules and serves its contract",
);
