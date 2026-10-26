import { SDK_VERSION } from "@pipelex/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BARE_APP_INFO,
  MAX_USER_AGENT_LENGTH,
  mcpAppInfo,
  sanitizeHostPart,
  userAgentFor,
  workshopHost,
} from "./client-identification.js";
import type { McpShell } from "./client-identification.js";
import { createPipelexApiClient } from "./shared.js";

const NODE = { versions: { node: "24.14.1" }, platform: "darwin", arch: "arm64" };

// The workshop hands in its own version.
const WORKSHOP: McpShell = { mode: "workshop", version: "0.21.0" };

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

describe("mcpAppInfo", () => {
  it("names the shell, its own version and the host", () => {
    expect(mcpAppInfo(WORKSHOP, "claude-code/2.1.4", NODE)).toEqual({
      name: "pipelex-mcp",
      version: "0.21.0",
      details: ["workshop", "host=claude-code/2.1.4"],
    });
  });

  it("drops the host rather than push the header past its ceiling", () => {
    const host = "h".repeat(MAX_USER_AGENT_LENGTH);
    const appInfo = mcpAppInfo(WORKSHOP, host, NODE);
    expect(appInfo.details).toEqual(["workshop"]);
    expect(appInfo.version).toBe("0.21.0");
    expect(userAgentFor(appInfo, NODE).length).toBeLessThanOrEqual(MAX_USER_AGENT_LENGTH);
  });

  it("keeps the longest host that still fits", () => {
    const base = userAgentFor(
      { ...BARE_APP_INFO, version: WORKSHOP.version, details: ["workshop", "host="] },
      NODE,
    ).length;
    const host = "h".repeat(MAX_USER_AGENT_LENGTH - base);
    expect(mcpAppInfo(WORKSHOP, host, NODE).details).toEqual(["workshop", `host=${host}`]);
  });
});

describe("the header on the wire", () => {
  it("is what userAgentFor predicts, so the length guard measures the real value", async () => {
    const appInfo = mcpAppInfo(WORKSHOP, "claude-code/2.1.4");
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
      appInfo: () => mcpAppInfo(WORKSHOP, workshopHost({ name: "Claude Code", version: "2.1.4" })),
    });
    expect(sent).toBe(
      `pipelex-mcp/0.21.0 (workshop; host=claude-code/2.1.4) pipelex-sdk-js/${SDK_VERSION} ` +
        `node/${process.versions.node} (${process.platform}; ${process.arch})`,
    );
  });

  it("still names pipelex-mcp, with no version, when no shell set an identity", async () => {
    const sent = await sentUserAgent({ baseUrl: "https://api.test", apiKey: "k" });
    expect(sent?.startsWith(`pipelex-mcp pipelex-sdk-js/${SDK_VERSION}`)).toBe(true);
  });

  it("reads the identity when the client is built, not when the context is", async () => {
    const handshake: { host?: string } = {};
    const config = {
      baseUrl: "https://api.test",
      apiKey: "k",
      appInfo: () => mcpAppInfo(WORKSHOP, handshake.host),
    };
    handshake.host = "codex-mcp-client/0.40.0";
    const sent = await sentUserAgent(config);
    expect(sent).toContain("(workshop; host=codex-mcp-client/0.40.0)");
  });
});
