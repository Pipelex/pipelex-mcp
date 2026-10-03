import { describe, expect, it } from "vitest";

import {
  CLAUDE_MD_CEILING,
  RULE_CEILING,
  budgetInstructionFiles,
  failingEntries,
  hasPathsFrontmatter,
  isRulePath,
} from "./instruction-budget.js";

const SCOPED_RULE = ["---", "paths:", '  - "src/capabilities/x.ts"', "---", "", "# A rule"].join(
  "\n",
);

describe("isRulePath", () => {
  it("tells a rule from CLAUDE.md", () => {
    expect(isRulePath(".claude/rules/manifests.md")).toBe(true);
    expect(isRulePath("CLAUDE.md")).toBe(false);
  });
});

describe("hasPathsFrontmatter", () => {
  it("accepts a frontmatter paths list", () => {
    expect(hasPathsFrontmatter(SCOPED_RULE)).toBe(true);
  });

  it("accepts an unindented block list and a flow list", () => {
    expect(hasPathsFrontmatter('---\npaths:\n- "src/capabilities/x.ts"\n---\n# A rule\n')).toBe(
      true,
    );
    expect(hasPathsFrontmatter('---\npaths: ["src/capabilities/x.ts"]\n---\n# A rule\n')).toBe(
      true,
    );
  });

  it("accepts the comma-separated string form", () => {
    expect(hasPathsFrontmatter('---\npaths: "src/**/*.ts, lib/**/*.ts"\n---\n# A rule\n')).toBe(
      true,
    );
  });

  it("refuses an empty flow list", () => {
    expect(hasPathsFrontmatter("---\npaths: []\n---\n# A rule\n")).toBe(false);
  });

  it("refuses frontmatter that does not parse, which Claude Code ignores", () => {
    expect(hasPathsFrontmatter("---\npaths: [foo\n---\n# A rule\n")).toBe(false);
  });

  it("refuses a list whose only item is a comment or blank", () => {
    expect(hasPathsFrontmatter("---\npaths:\n  - # TODO\n---\n# A rule\n")).toBe(false);
    expect(hasPathsFrontmatter('---\npaths:\n  - ""\n---\n# A rule\n')).toBe(false);
  });

  it("refuses a rule with no frontmatter", () => {
    expect(hasPathsFrontmatter("# A rule\n\npaths:\n  - x\n")).toBe(false);
  });

  it("refuses frontmatter without a paths key", () => {
    expect(hasPathsFrontmatter("---\ndescription: x\n---\n# A rule\n")).toBe(false);
  });

  it("refuses an empty paths list", () => {
    expect(hasPathsFrontmatter("---\npaths:\n---\n# A rule\n")).toBe(false);
  });

  it("does not read a paths list from the body", () => {
    expect(hasPathsFrontmatter("---\ntitle: x\n---\npaths:\n  - x\n")).toBe(false);
  });
});

describe("budgetInstructionFiles", () => {
  it("holds CLAUDE.md and each rule to their own ceilings", () => {
    const [claude, rule] = budgetInstructionFiles([
      { path: "CLAUDE.md", text: "abc" },
      { path: ".claude/rules/x.md", text: SCOPED_RULE },
    ]);

    expect(claude).toMatchObject({
      ceiling: CLAUDE_MD_CEILING,
      length: 3,
      headroom: CLAUDE_MD_CEILING - 3,
      isRule: false,
      scoped: true,
    });
    expect(rule).toMatchObject({ ceiling: RULE_CEILING, isRule: true, scoped: true });
  });

  it("counts code points, not UTF-16 code units", () => {
    const [entry] = budgetInstructionFiles([{ path: "CLAUDE.md", text: "𝄞 —" }]);
    expect(entry?.length).toBe(3);
  });
});

describe("failingEntries", () => {
  it("passes a file exactly at its ceiling and fails one a code point over", () => {
    const ruleAt = (length: number): string =>
      SCOPED_RULE + "a".repeat(length - [...SCOPED_RULE].length);
    const entries = budgetInstructionFiles([
      { path: "CLAUDE.md", text: "a".repeat(CLAUDE_MD_CEILING) },
      { path: ".claude/rules/at.md", text: ruleAt(RULE_CEILING) },
      { path: "CLAUDE.md", text: "a".repeat(CLAUDE_MD_CEILING + 1) },
      { path: ".claude/rules/over.md", text: ruleAt(RULE_CEILING + 1) },
    ]);

    expect(entries.map((entry) => entry.headroom)).toEqual([0, 0, -1, -1]);
    expect(failingEntries(entries).map((entry) => entry.path)).toEqual([
      "CLAUDE.md",
      ".claude/rules/over.md",
    ]);
  });

  it("fails a rule that is not path-scoped, whatever its size", () => {
    const entries = budgetInstructionFiles([{ path: ".claude/rules/loose.md", text: "# Loose" }]);

    expect(failingEntries(entries)).toHaveLength(1);
    expect(failingEntries(entries)[0]?.scoped).toBe(false);
  });
});
