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

  it("merges a text two shells emit identically into one entry naming both", () => {
    const entries = budgetEmittedTexts([
      { shell: "console", name: "mthds_run", text: "Run it." },
      { shell: "workshop", name: "mthds_run", text: "Run it." },
    ]);

    expect(entries).toEqual([
      { shells: ["console", "workshop"], name: "mthds_run", length: 7, headroom: 1793 },
    ]);
  });

  it("keeps the same name with different texts as separate entries", () => {
    const entries = budgetEmittedTexts([
      { shell: "console", name: "instructions", text: "short" },
      { shell: "workshop", name: "instructions", text: "a little longer" },
    ]);

    expect(entries.map((entry) => [entry.shells, entry.length])).toEqual([
      [["workshop"], 15],
      [["console"], 5],
    ]);
  });

  it("does not merge two different names that happen to carry the same text", () => {
    const entries = budgetEmittedTexts([
      { shell: "console", name: "mthds_run_status", text: "Same." },
      { shell: "console", name: "mthds_run_results", text: "Same." },
    ]);

    expect(entries.map((entry) => entry.name)).toEqual(["mthds_run_results", "mthds_run_status"]);
  });

  it("sorts largest first, then by name, and reports headroom against the ceiling", () => {
    const entries = budgetEmittedTexts(
      [
        { shell: "workshop", name: "b", text: "xx" },
        { shell: "workshop", name: "a", text: "xx" },
        { shell: "workshop", name: "c", text: "xxxxx" },
      ],
      4,
    );

    expect(entries).toEqual([
      { shells: ["workshop"], name: "c", length: 5, headroom: -1 },
      { shells: ["workshop"], name: "a", length: 2, headroom: 2 },
      { shells: ["workshop"], name: "b", length: 2, headroom: 2 },
    ]);
  });
});

describe("overCeiling", () => {
  it("fails a text one past the ceiling and passes one exactly at it", () => {
    const entries = budgetEmittedTexts([
      { shell: "console", name: "at", text: "x".repeat(TOOL_TEXT_CEILING) },
      { shell: "console", name: "over", text: "x".repeat(TOOL_TEXT_CEILING + 1) },
    ]);

    expect(overCeiling(entries)).toEqual([
      { shells: ["console"], name: "over", length: TOOL_TEXT_CEILING + 1, headroom: -1 },
    ]);
  });

  it("returns nothing when every text is within budget", () => {
    expect(overCeiling(budgetEmittedTexts([{ shell: "console", name: "a", text: "ok" }]))).toEqual(
      [],
    );
  });
});
