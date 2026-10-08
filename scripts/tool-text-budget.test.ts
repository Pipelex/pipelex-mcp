import { describe, expect, it } from "vitest";

import {
  HOST_TEXT_CAP,
  TOOL_TEXT_CEILING,
  budgetEmittedTexts,
  overCeiling,
  textLength,
} from "./tool-text-budget.js";

describe("textLength", () => {
  it("counts code points, not UTF-16 code units", () => {
    // An astral character is two code units and one code point; the cut was
    // measured in code points, so it must count once.
    expect("𝄞".length).toBe(2);
    expect(textLength("𝄞")).toBe(1);
    expect(textLength("a — b…")).toBe(6);
  });
});

describe("budgetEmittedTexts", () => {
  it("keeps the ceiling under the host cap", () => {
    expect(TOOL_TEXT_CEILING).toBeLessThan(HOST_TEXT_CAP);
  });

  it("sorts largest first, then by name, and reports headroom against the ceiling", () => {
    const entries = budgetEmittedTexts(
      [
        { name: "b", text: "xx" },
        { name: "a", text: "xx" },
        { name: "c", text: "xxxxx" },
      ],
      4,
    );

    expect(entries).toEqual([
      { name: "c", length: 5, headroom: -1 },
      { name: "a", length: 2, headroom: 2 },
      { name: "b", length: 2, headroom: 2 },
    ]);
  });
});

describe("overCeiling", () => {
  it("fails a text one past the ceiling and passes one exactly at it", () => {
    const entries = budgetEmittedTexts([
      { name: "at", text: "x".repeat(TOOL_TEXT_CEILING) },
      { name: "over", text: "x".repeat(TOOL_TEXT_CEILING + 1) },
    ]);

    expect(overCeiling(entries)).toEqual([
      { name: "over", length: TOOL_TEXT_CEILING + 1, headroom: -1 },
    ]);
  });

  it("returns nothing when every text is within budget", () => {
    expect(overCeiling(budgetEmittedTexts([{ name: "a", text: "ok" }]))).toEqual([]);
  });
});
