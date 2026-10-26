import { describe, expect, it } from "vitest";

import { unpublishableDependencies, unpublishableReason } from "./publish-guard.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("unpublishableReason", () => {
  it("accepts a registry range, an exact version, a tag and an alias to the registry", () => {
    for (const spec of ["^0.28.0", "0.28.0", ">=1.2.3 <2", "~4.3.6", "latest", "npm:zod@^4.3.6"]) {
      expect(unpublishableReason(spec), spec).toBeUndefined();
    }
  });

  it("refuses the sprint prerelease wt pin writes, however it is ranged or aliased", () => {
    for (const spec of [
      `0.28.1-sprint.g${SHA}`,
      `^0.28.1-sprint.g${SHA}`,
      `npm:@pipelex/sdk@0.28.1-sprint.g${SHA}`,
    ]) {
      expect(unpublishableReason(spec), spec).toBe("a sprint prerelease");
    }
  });

  it("refuses a git source in every spelling npm reads", () => {
    for (const spec of [
      `github:Pipelex/pipelex-sdk#${SHA}`,
      `git+https://github.com/Pipelex/pipelex-sdk.git#${SHA}`,
      `git+ssh://git@github.com/Pipelex/pipelex-sdk.git#${SHA}`,
      "git://github.com/Pipelex/pipelex-sdk.git",
      "gitlab:Pipelex/pipelex-sdk",
      "bitbucket:Pipelex/pipelex-sdk",
      `Pipelex/pipelex-sdk#${SHA}`,
      "Pipelex/pipelex-sdk",
      "Pipelex/pipelex-sdk#semver:^0.28",
      "git@github.com:Pipelex/pipelex-sdk.git",
      `git@github.com:Pipelex/pipelex-sdk.git#${SHA}`,
    ]) {
      expect(unpublishableReason(spec), spec).toBe("a git source");
    }
  });

  it("refuses a URL", () => {
    expect(unpublishableReason("https://example.com/sdk-0.28.0.tgz")).toBe("a URL");
  });

  it("refuses a local source, the form make use-local writes", () => {
    for (const spec of [
      "file:/Users/someone/repos/Pipelex/pipelex-sdk/js",
      "file:../pipelex-sdk/js",
      "link:../mthds-ui",
      "portal:../mthds-ui",
      "workspace:*",
      "../pipelex-sdk/js",
      "/Users/someone/repos/Pipelex/pipelex-sdk/js",
      "~/repos/Pipelex/pipelex-sdk/js",
      "sdk-0.28.0.tgz",
      "sdk-0.28.0.tar.gz",
    ]) {
      expect(unpublishableReason(spec), spec).toBe("a local source");
    }
  });

  it("refuses an alias to anything but the registry", () => {
    expect(unpublishableReason(`npm:@pipelex/sdk@github:Pipelex/pipelex-sdk#${SHA}`)).toBe(
      "a spec npm cannot read",
    );
  });

  it("refuses a spec npm cannot read at all", () => {
    expect(unpublishableReason("not a spec")).toBe("a spec npm cannot read");
  });
});

describe("unpublishableDependencies", () => {
  it("names nothing in a manifest of registry ranges", () => {
    expect(
      unpublishableDependencies({
        dependencies: { "@pipelex/sdk": "^0.28.0", zod: "^4.3.6" },
        devDependencies: { "@pipelex/mthds-ui": "^0.27.0" },
      }),
    ).toEqual([]);
  });

  it("names each refused dependency with its block, its spec and why", () => {
    expect(
      unpublishableDependencies({
        dependencies: { "@pipelex/sdk": `0.28.1-sprint.g${SHA}`, zod: "^4.3.6" },
        devDependencies: { "@pipelex/mthds-ui": `github:Pipelex/mthds-ui#${SHA}` },
      }),
    ).toEqual([
      {
        block: "dependencies",
        name: "@pipelex/sdk",
        spec: `0.28.1-sprint.g${SHA}`,
        reason: "a sprint prerelease",
      },
      {
        block: "devDependencies",
        name: "@pipelex/mthds-ui",
        spec: `github:Pipelex/mthds-ui#${SHA}`,
        reason: "a git source",
      },
    ]);
  });

  it("reads the optional and peer blocks too", () => {
    expect(
      unpublishableDependencies({
        optionalDependencies: { a: "file:../a" },
        peerDependencies: { b: "Pipelex/b" },
      }).map(({ block, name }) => `${block}:${name}`),
    ).toEqual(["optionalDependencies:a", "peerDependencies:b"]);
  });
});
