import { describe, expect, it } from "vitest";

import { listTools } from "@pipelex/mcp-core/shell-test-support.js";
import type { ListedTool } from "@pipelex/mcp-core/shell-test-support.js";

import { createHostedServer } from "../packages/console/src/hosted/server.js";
import { TEST_OAUTH } from "../packages/console/src/hosted/test-oauth.js";
import { createLocalServer } from "../packages/workshop/src/server.js";

/**
 * One tool name means one contract (`wip/mcp-server-split/design.md`, D1): when
 * the two servers' contracts for a tool diverge, the names diverge too. Each
 * shell owns its tool table, so nothing else stops a name they share from
 * quietly meaning two things — which is how a model, a skill or an instruction
 * that says "call `mthds_run`" ends up calling something other than it meant.
 *
 * The contract is what a tool accepts, what it returns and what it may do: its
 * two schemas and its annotations. The description is not part of it, because
 * the description is how each server tells its own audience when to call the
 * tool, and the two audiences refresh on different timescales.
 */
describe("a tool name both shells register", () => {
  it("carries the same schemas and annotations on both", async () => {
    const consoleTools = await listTools(createHostedServer(TEST_OAUTH));
    const workshopTools = await listTools(createLocalServer());

    for (const workshopTool of workshopTools) {
      const consoleTool = consoleTools.find((tool) => tool.name === workshopTool.name);
      if (consoleTool === undefined) continue;

      expect(contractOf(consoleTool), workshopTool.name).toEqual(contractOf(workshopTool));
    }
  });
});

function contractOf(tool: ListedTool) {
  return {
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  };
}
