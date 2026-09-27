import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { RUN_OUTPUT_SOURCES } from "../hosted/app-buckets.js";
import { FILE_RELAY_PAGE, fileRelayLink, storedFileLinkOf } from "./file-relay.js";

const SERVER_URL = "https://console.example";

// A presigned link as the platform mints it: every parameter already
// percent-encoded, and the signature covering all of them.
const STORED =
  "https://pipelex-app-dev.s3.amazonaws.com/org_1/runs/run_1/generated/81873860.png" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIA%2F20260927%2Fus-west-2%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20260927T223459Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host" +
  "&X-Amz-Security-Token=IQoJ%2BSRRX%3D&X-Amz-Signature=500faf";

const PAGE = readFileSync(new URL(`../../public/${FILE_RELAY_PAGE}`, import.meta.url), "utf8");
const PAGE_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1] ?? "";

/**
 * Runs the relay page's script against a page URL, as a browser would load it,
 * and reports where it sent the browser, or the message it showed instead.
 */
function loadRelayPage(pageUrl: string): { replacedWith?: string; status?: string } {
  const outcome: { replacedWith?: string; status?: string } = {};
  const status = {
    set textContent(text: string) {
      outcome.status = text;
    },
  };
  runInNewContext(PAGE_SCRIPT, {
    URL,
    location: {
      hash: new URL(pageUrl).hash,
      replace: (link: string) => {
        outcome.replacedWith = link;
      },
    },
    document: { getElementById: (id: string) => (id === "status" ? status : null) },
  });
  return outcome;
}

describe("fileRelayLink", () => {
  it("sends a link to an app bucket through the relay page, carried in the fragment", () => {
    expect(fileRelayLink(SERVER_URL, STORED)).toBe(
      `${SERVER_URL}/assets/open-file.html#${encodeURIComponent(STORED)}`,
    );
  });

  it("leaves a link to anywhere else as it is", () => {
    const elsewhere = "https://example.com/report.pdf?page=2";
    expect(fileRelayLink(SERVER_URL, elsewhere)).toBe(elsewhere);
    expect(fileRelayLink(SERVER_URL, "not a link")).toBe("not a link");
  });
});

/**
 * A clicked element inside `ancestors`, the nearest first, as far as
 * `storedFileLinkOf` reads it: `closest("a[href]")` finds the nearest anchor
 * with a link, whose `href` a browser reports absolute.
 */
function clickedInside(...ancestors: { tag: string; href?: string }[]) {
  return {
    closest: (selector: string) => {
      expect(selector).toBe("a[href]");
      return ancestors.find((node) => node.tag === "a" && node.href !== undefined) ?? null;
    },
  };
}

describe("storedFileLinkOf", () => {
  it("finds the stored file a click on an image preview or a file's name opens", () => {
    expect(storedFileLinkOf(clickedInside({ tag: "img" }, { tag: "a", href: STORED }))).toBe(
      STORED,
    );
    expect(storedFileLinkOf(clickedInside({ tag: "a", href: STORED }))).toBe(STORED);
  });

  it("leaves a click that opens anything else to the page", () => {
    expect(storedFileLinkOf(clickedInside({ tag: "a", href: "https://example.com/doc" }))).toBe(
      undefined,
    );
    expect(storedFileLinkOf(clickedInside({ tag: "button" }))).toBe(undefined);
    expect(storedFileLinkOf(null)).toBe(undefined);
    expect(storedFileLinkOf({})).toBe(undefined);
  });
});

describe("the relay page", () => {
  it("replaces itself with the stored file's link, unchanged", () => {
    expect(loadRelayPage(fileRelayLink(SERVER_URL, STORED))).toEqual({ replacedWith: STORED });
  });

  it("ignores a parameter the host appended to the page's own query", () => {
    const relayed = new URL(fileRelayLink(SERVER_URL, STORED));
    relayed.searchParams.set("redirectUrl", "https://chatgpt.com/c/6ab999bf");
    expect(loadRelayPage(relayed.href)).toEqual({ replacedWith: STORED });
  });

  it("ignores a parameter a host concatenated after the fragment", () => {
    const relayed = `${fileRelayLink(SERVER_URL, STORED)}?redirectUrl=https%3A%2F%2Fchatgpt.com%2Fc%2F1`;
    expect(loadRelayPage(relayed)).toEqual({ replacedWith: STORED });
    expect(loadRelayPage(`${relayed.replace("?", "&")}`)).toEqual({ replacedWith: STORED });
  });

  it("follows a link to every app bucket the views load files from", () => {
    for (const source of RUN_OUTPUT_SOURCES) {
      const link = `${source}/org_1/file.png?X-Amz-Signature=abc`;
      expect(
        loadRelayPage(`${SERVER_URL}/assets/open-file.html#${encodeURIComponent(link)}`),
      ).toEqual({ replacedWith: link });
    }
  });

  it("follows no link outside the app buckets, so it is no open redirect", () => {
    const refused = { status: "This link does not point to a Pipelex file." };
    for (const link of [
      "https://attacker.s3.amazonaws.com/phish.html",
      "https://pipelex-app-dev.s3.amazonaws.com.attacker.net/x",
      "http://pipelex-app-dev.s3.amazonaws.com/x",
      "javascript:alert(1)",
      "%E0%A4%A",
      "",
    ]) {
      expect(
        loadRelayPage(`${SERVER_URL}/assets/open-file.html#${encodeURIComponent(link)}`),
      ).toEqual(refused);
    }
    expect(loadRelayPage(`${SERVER_URL}/assets/open-file.html#%E0%A4%A`)).toEqual(refused);
  });

  it("lists exactly the app buckets `app-buckets.ts` names", () => {
    const listed = /var FILE_SOURCES = (\[[\s\S]*?\]);/.exec(PAGE_SCRIPT)?.[1];
    expect(listed).toBeDefined();
    expect(new Set(JSON.parse(listed ?? "[]"))).toEqual(new Set(RUN_OUTPUT_SOURCES));
  });
});
