import { describe, expect, it } from "vitest";

import { bundleImportSpecifiers, unloadableImports } from "./bundle-imports.js";

describe("bundleImportSpecifiers", () => {
  it("reads static, multi-line, side-effect, re-exported and literal dynamic imports", () => {
    const source = [
      "#!/usr/bin/env node",
      'import { promises as fs } from "node:fs";',
      "import {",
      "  z,",
      "  ZodError",
      '} from "zod";',
      'import "node:process";',
      'export { thing } from "mthds/protocol";',
      'const lazy = await import("@pipelex/sdk");',
    ].join("\n");

    expect(bundleImportSpecifiers(source)).toEqual([
      "@pipelex/sdk",
      "mthds/protocol",
      "node:fs",
      "node:process",
      "zod",
    ]);
  });
});

describe("unloadableImports", () => {
  const dependencies = ["@pipelex/sdk", "mthds", "zod"];

  it("refuses a built-in whose prefix the build stripped", () => {
    // Round 4: `node:sqlite` shipped as `sqlite`, which no install provides.
    expect(unloadableImports(["node:sqlite", "sqlite", "fs"], dependencies)).toEqual(["sqlite"]);
  });

  it("refuses a package the manifest does not declare, and a relative import", () => {
    expect(
      unloadableImports(
        ["@pipelex/sdk/client", "mthds/protocol", "lodash", "./chunk.js"],
        dependencies,
      ),
    ).toEqual(["lodash", "./chunk.js"]);
  });
});
