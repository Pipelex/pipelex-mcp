import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Pins the guard that keeps every call to the Pipelex API identified: the lint
 * rules in `eslint-rules/pipelex-api-boundary.mjs`, as `eslint.config.mjs`
 * wires them. It lints source text under the repo's real config, so a rule
 * that stops firing, or an exemption that widens, fails here rather than
 * letting an unidentified client through the gate.
 */
const eslint = new ESLint({ cwd: new URL("..", import.meta.url).pathname });

async function boundaryViolations(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .map((message) => message.ruleId ?? "")
    .filter((ruleId) => ruleId.startsWith("pipelex/"));
}

const PROBE = "packages/core/src/capabilities/probe.ts";

describe("the Pipelex API boundary lint rules", () => {
  it("refuse constructing an SDK client outside the factory, however it is imported", async () => {
    const code = [
      'import { PipelexApiClient, PipelexApiClient as Api } from "@pipelex/sdk";',
      'import * as sdk from "@pipelex/sdk";',
      "export const a = new PipelexApiClient({});",
      "export const b = new Api({});",
      "export const c = new sdk.PipelexApiClient({});",
    ].join("\n");

    expect(await boundaryViolations(code, PROBE)).toEqual([
      "pipelex/sdk-client-factory",
      "pipelex/sdk-client-factory",
      "pipelex/sdk-client-factory",
    ]);
  });

  it("refuse constructing a local subclass outside the factory", async () => {
    const code = [
      'import { SizeGuardedPipelexApiClient } from "./upload-ceiling.js";',
      "export const client = new SizeGuardedPipelexApiClient({});",
    ].join("\n");

    expect(await boundaryViolations(code, PROBE)).toEqual(["pipelex/sdk-client-factory"]);
  });

  it("refuse subclassing an SDK client outside the file configured for it", async () => {
    const code = [
      'import { PipelexApiClient } from "@pipelex/sdk";',
      "export class Sneaky extends PipelexApiClient {}",
    ].join("\n");

    expect(await boundaryViolations(code, PROBE)).toEqual(["pipelex/sdk-client-factory"]);
    expect(
      await boundaryViolations(code, "packages/core/src/capabilities/upload-ceiling.ts"),
    ).toEqual([]);
  });

  it("refuse a bare fetch outside the third-party fetch boundary", async () => {
    const code = [
      'export const a = fetch("https://api.pipelex.com/v1/version");',
      'export const b = globalThis.fetch("https://api.pipelex.com/health");',
    ].join("\n");

    expect(await boundaryViolations(code, PROBE)).toEqual([
      "pipelex/no-raw-fetch",
      "pipelex/no-raw-fetch",
    ]);
    expect(await boundaryViolations(code, "scripts/probe.ts")).toEqual([
      "pipelex/no-raw-fetch",
      "pipelex/no-raw-fetch",
    ]);
    expect(
      await boundaryViolations(code, "packages/core/src/capabilities/attachment-fetch.ts"),
    ).toEqual([]);
  });

  it("allow the factory and a call through an injected fetcher", async () => {
    const factory = [
      'import { PipelexApiClient } from "@pipelex/sdk";',
      "export const client = new PipelexApiClient({});",
    ].join("\n");
    const injected =
      "export const run = (fetcher: { fetch(u: string): void }) => fetcher.fetch('x');";

    expect(await boundaryViolations(factory, "packages/core/src/capabilities/shared.ts")).toEqual(
      [],
    );
    expect(await boundaryViolations(injected, PROBE)).toEqual([]);
  });
});
