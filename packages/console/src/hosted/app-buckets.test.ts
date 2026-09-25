import { describe, expect, it } from "vitest";

import { RUN_OUTPUT_SOURCES, UPLOAD_CONNECT_DOMAINS } from "./app-buckets.js";

/**
 * CSP's host-source matching, reduced to the two shapes these lists use: an
 * origin matches any path on it, and a source ending in `/` matches the paths
 * under it. The query string never takes part, so a presigned signature does
 * not change the answer.
 */
function allowedBy(sources: readonly string[], link: string): boolean {
  const url = new URL(link);
  return sources.some((source) => {
    const allowed = new URL(source);
    if (allowed.origin !== url.origin) return false;
    return source.endsWith("/") && allowed.pathname !== "/"
      ? url.pathname.startsWith(allowed.pathname)
      : true;
  });
}

describe("RUN_OUTPUT_SOURCES", () => {
  it("allows the fresh link the platform's bulk resolve route mints", () => {
    // The shape measured on the route's answer against api-dev on 2026-09-25.
    const link =
      "https://pipelex-app-dev.s3.amazonaws.com/org_x/runs/run_x/staged.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260925T110925Z&X-Amz-Expires=900";
    expect(allowedBy(RUN_OUTPUT_SOURCES, link)).toBe(true);
  });

  it("allows the regional virtual-hosted form too", () => {
    expect(
      allowedBy(RUN_OUTPUT_SOURCES, "https://pipelex-app-prod.s3.us-west-2.amazonaws.com/k.png"),
    ).toBe(true);
  });

  it("names each bucket's own host and never the shared regional endpoint", () => {
    for (const source of RUN_OUTPUT_SOURCES) {
      const url = new URL(source);
      expect(url.pathname).toBe("/");
      expect(source).toBe(url.origin);
      expect(url.hostname.startsWith("pipelex-app-")).toBe(true);
    }
    expect(
      allowedBy(RUN_OUTPUT_SOURCES, "https://s3.us-west-2.amazonaws.com/pipelex-app-dev/x.png"),
    ).toBe(false);
    expect(allowedBy(RUN_OUTPUT_SOURCES, "https://someone-else.s3.amazonaws.com/x.png")).toBe(
      false,
    );
  });
});

describe("UPLOAD_CONNECT_DOMAINS", () => {
  it("carries both virtual-hosted forms a grant can name", () => {
    expect(UPLOAD_CONNECT_DOMAINS).toContain("https://pipelex-app-dev.s3.amazonaws.com");
    expect(UPLOAD_CONNECT_DOMAINS).toContain("https://pipelex-app-dev.s3.us-west-2.amazonaws.com");
  });
});
