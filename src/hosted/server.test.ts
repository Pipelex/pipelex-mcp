import { describe, expect, it } from "vitest";

import { TEST_OAUTH, emittedContract } from "../shell-test-support.js";
import { createHostedServer } from "./server.js";

describe("the console's emitted contract", () => {
  /**
   * Everything a remote-connector host is shown, pinned byte for byte. ChatGPT
   * caches a connector's tool list when it is added and never refreshes it, so
   * any change here strands existing installs on the old list until each user
   * re-adds the connector: a diff to this file is a release note, never a
   * formality. Update it with `npx vitest run -u` only for a change you meant.
   */
  it("emits the pinned initialize result and tools/list", async () => {
    await expect(await emittedContract(createHostedServer(TEST_OAUTH))).toMatchFileSnapshot(
      "./console.contract.json",
    );
  });
});
