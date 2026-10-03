/**
 * Live e2e — the files the method graph page loads from jsDelivr.
 *
 * The page pins the viewer, its stylesheet and elkjs by exact version and by
 * Subresource Integrity, and the browser refuses a file whose hash differs. A
 * hash typed wrong, or a CDN serving other bytes, would therefore leave every
 * page blank in every browser while the hermetic suite, which cannot fetch,
 * stays green. This fetches each file and recomputes its hash.
 *
 * Free: it calls no Pipelex API, only the public CDN.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GRAPH_PAGE_ASSETS } from "./graph-page.js";

describe("the method graph page's pinned CDN files", () => {
  for (const [name, asset] of Object.entries(GRAPH_PAGE_ASSETS)) {
    it(`serves ${name} with the bytes its integrity hash pins`, async () => {
      const response = await fetch(asset.url);
      expect(response.status, asset.url).toBe(200);
      const digest = createHash("sha384")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("base64");

      expect(`sha384-${digest}`, asset.url).toBe(asset.integrity);
      // The page loads each file with `crossorigin="anonymous"`, so the CDN
      // must allow a cross-origin read, or the browser discards the file
      // before the hash is ever compared.
      expect(response.headers.get("access-control-allow-origin"), asset.url).toBe("*");
    });
  }
});
