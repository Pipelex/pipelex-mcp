import { readFileSync } from "node:fs";

import { SDK_VERSION } from "@pipelex/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BARE_APP_INFO,
  MAX_USER_AGENT_LENGTH,
  MCP_VERSION,
  consoleHost,
  mcpAppInfo,
  sanitizeHostPart,
  userAgentFor,
  userAgentOf,
  workshopHost,
} from "./client-identification.js";
import { createPipelexApiClient } from "./shared.js";

const NODE = { versions: { node: "24.14.1" }, platform: "darwin", arch: "arm64" };

/** The `User-Agent` a client built by the factory actually sends. */
async function sentUserAgent(config: Parameters<typeof createPipelexApiClient>[0]) {
  let seen: Headers | undefined;
  vi.stubGlobal("fetch", (_url: string, init?: { headers?: HeadersInit }) => {
    seen = new Headers(init?.headers);
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  await createPipelexApiClient(config).health();
  return seen?.get("user-agent") ?? undefined;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP_VERSION", () => {
  it("is the version package.json ships", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(MCP_VERSION).toBe(pkg.version);
  });
});

describe("sanitizeHostPart", () => {
  it.each([
    ["claude-code", "claude-code"],
    ["Visual Studio Code", "visual-studio-code"],
    ["  Cursor  ", "cursor"],
    ["codex-mcp-client", "codex-mcp-client"],
    ["1.99.0 (Universal)", "1.99.0-universal"],
    ["acme; evil=1", "acme-evil-1"],
    ["name/with/slashes", "name-with-slashes"],
    ["bot@example.com", "bot-example.com"],
    ["Zéd\tEditor\n", "z-d-editor"],
    ["a(b)c", "a-b-c"],
  ])("%j -> %j", (raw, expected) => {
    expect(sanitizeHostPart(raw)).toBe(expected);
  });

  it.each([[""], ["   "], ["@@@"], ["()"], [undefined]])(
    "returns undefined when nothing survives: %j",
    (raw) => {
      expect(sanitizeHostPart(raw)).toBeUndefined();
    },
  );

  it("never lets through a character the header or the platform would choke on", () => {
    const hostile = 'A b@c;d(e)f/g\\h"i,j=k[l]m{n}o:p?q<r>sét';
    expect(sanitizeHostPart(hostile)).toMatch(/^[!#$%&'*+\-.^_`|~0-9a-z]+$/);
  });
});

describe("workshopHost", () => {
  it("joins the sanitised name and version", () => {
    expect(workshopHost({ name: "claude-code", version: "2.1.4" })).toBe("claude-code/2.1.4");
    expect(workshopHost({ name: "Visual Studio Code", version: "1.99.0" })).toBe(
      "visual-studio-code/1.99.0",
    );
  });

  it("reports the name alone when the version sanitises to nothing", () => {
    expect(workshopHost({ name: "cursor", version: "   " })).toBe("cursor");
    expect(workshopHost({ name: "cursor" })).toBe("cursor");
  });

  it("omits the host when the name sanitises to nothing or the handshake has not happened", () => {
    expect(workshopHost({ name: "@@", version: "1.0.0" })).toBeUndefined();
    expect(workshopHost(undefined)).toBeUndefined();
  });
});

describe("consoleHost", () => {
  it.each([
    ["openai-mcp/1.0.0 (+https://openai.com/bot)", "openai"],
    ["ChatGPT-User/1.0", "openai"],
    ["Claude-User", "claude"],
    ["claude-ai/0.1.0", "claude"],
    ["Anthropic/1.0", "claude"],
  ])("%j -> %j", (userAgent, expected) => {
    expect(consoleHost(userAgent)).toBe(expected);
  });

  it("omits a host it does not recognise, and never forwards the raw header", () => {
    expect(consoleHost("node")).toBeUndefined();
    expect(consoleHost("Mozilla/5.0 (Macintosh)")).toBeUndefined();
    expect(consoleHost(undefined)).toBeUndefined();
  });

  it("reads a repeated header", () => {
    expect(userAgentOf({ "user-agent": ["proxy/1", "openai-mcp/1.0.0"] })).toBe(
      "proxy/1 openai-mcp/1.0.0",
    );
    expect(userAgentOf({})).toBeUndefined();
    expect(userAgentOf(undefined)).toBeUndefined();
  });
});

describe("mcpAppInfo", () => {
  it("names the shell and the host in the comment", () => {
    expect(mcpAppInfo("workshop", "claude-code/2.1.4", NODE)).toEqual({
      name: "pipelex-mcp",
      version: MCP_VERSION,
      details: ["workshop", "host=claude-code/2.1.4"],
    });
    expect(mcpAppInfo("console", "openai", NODE)).toEqual({
      name: "pipelex-mcp",
      version: MCP_VERSION,
      details: ["console", "host=openai"],
    });
  });

  it("names the shell alone when there is no host", () => {
    expect(mcpAppInfo("console", undefined, NODE).details).toEqual(["console"]);
  });

  it("drops the host rather than push the header past its ceiling", () => {
    const host = "h".repeat(MAX_USER_AGENT_LENGTH);
    const appInfo = mcpAppInfo("workshop", host, NODE);
    expect(appInfo.details).toEqual(["workshop"]);
    expect(userAgentFor(appInfo, NODE).length).toBeLessThanOrEqual(MAX_USER_AGENT_LENGTH);
  });

  it("keeps the longest host that still fits", () => {
    const base = userAgentFor({ ...BARE_APP_INFO, details: ["workshop", "host="] }, NODE).length;
    const host = "h".repeat(MAX_USER_AGENT_LENGTH - base);
    expect(mcpAppInfo("workshop", host, NODE).details).toEqual(["workshop", `host=${host}`]);
  });
});

describe("the header on the wire", () => {
  it("is what userAgentFor predicts, so the length guard measures the real value", async () => {
    const appInfo = mcpAppInfo("workshop", "claude-code/2.1.4");
    const sent = await sentUserAgent({
      baseUrl: "https://api.test",
      apiKey: "k",
      appInfo: () => appInfo,
    });
    expect(sent).toBe(userAgentFor(appInfo));
  });

  it("reads, for the workshop, pipelex-mcp then the SDK then the runtime", async () => {
    const sent = await sentUserAgent({
      baseUrl: "https://api.test",
      apiKey: "k",
      appInfo: () =>
        mcpAppInfo("workshop", workshopHost({ name: "Claude Code", version: "2.1.4" })),
    });
    expect(sent).toBe(
      `pipelex-mcp/${MCP_VERSION} (workshop; host=claude-code/2.1.4) pipelex-sdk-js/${SDK_VERSION} ` +
        `node/${process.versions.node} (${process.platform}; ${process.arch})`,
    );
  });

  it("reads, for the console, the coarse host", async () => {
    const sent = await sentUserAgent({
      baseUrl: "https://api.test",
      apiKey: "k",
      appInfo: () => mcpAppInfo("console", consoleHost("openai-mcp/1.0.0")),
    });
    expect(sent).toMatch(
      new RegExp(
        `^pipelex-mcp/${MCP_VERSION.replace(/\./g, "\\.")} \\(console; host=openai\\) pipelex-sdk-js/`,
      ),
    );
  });

  it("still names pipelex-mcp when no shell set an identity", async () => {
    const sent = await sentUserAgent({ baseUrl: "https://api.test", apiKey: "k" });
    expect(sent?.startsWith(`pipelex-mcp/${MCP_VERSION} pipelex-sdk-js/${SDK_VERSION}`)).toBe(true);
  });

  it("reads the identity when the client is built, not when the context is", async () => {
    const handshake: { host?: string } = {};
    const config = {
      baseUrl: "https://api.test",
      apiKey: "k",
      appInfo: () => mcpAppInfo("workshop", handshake.host),
    };
    handshake.host = "codex-mcp-client/0.40.0";
    const sent = await sentUserAgent(config);
    expect(sent).toContain("(workshop; host=codex-mcp-client/0.40.0)");
  });
});
