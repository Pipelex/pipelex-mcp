/**
 * The size budget for this repository's agent instruction files: `CLAUDE.md`,
 * which Claude Code loads into every session opened here or in one of its
 * worktrees, and the path-scoped rules under `.claude/rules/`, which it loads
 * when a file a rule names is read.
 *
 * `CLAUDE.md` grew with nearly every feature pull request, from about 17,000
 * bytes in July 2026 to about 147,000 in September, when every session opened
 * here started with Claude Code's warning that the instruction files it loads
 * together were over its 150,000-character total limit. The growth was never
 * one decision: each change appended the rationale for what it touched,
 * because nothing said where else it should go and nothing measured the file.
 * The file is now a map, the detail lives in `docs/`, `SPEC.md`, code comments
 * and the path-scoped rules, and this budget is what stops the regrowth.
 *
 * The ceilings are not the host's limit. The workspace root's `CLAUDE.md` is
 * loaded into every session here too, and the room under the total limit is
 * shared with it; the ceiling on this file is set to keep it a map, with
 * headroom for a few more invariants, not to use that room up. A rule's
 * ceiling keeps one from becoming the new place a module's whole history
 * accumulates: a rule states what must hold while its files are open and
 * points at `docs/` for why.
 *
 * A rule must also be path-scoped. One without a `paths:` list in its
 * frontmatter loads into every session, which is `CLAUDE.md` growing again
 * under another name.
 *
 * Lengths are Unicode code points, as `tool-text-budget.ts` measures them. The
 * arithmetic lives here, and not in `scripts/check-instructions.ts`, so the
 * hermetic suite covers it; the script only reads the files and reports.
 */

import { textLength } from "./tool-text-budget.js";

/** The ceiling on `CLAUDE.md`, which every session opened here loads. */
export const CLAUDE_MD_CEILING = 12_000;

/** The ceiling on each path-scoped rule under `.claude/rules/`. */
export const RULE_CEILING = 6_000;

/** One instruction file as read from disk, its path relative to the repository root. */
export interface InstructionFile {
  path: string;
  text: string;
}

/** One instruction file measured against its ceiling. */
export interface InstructionBudgetEntry {
  path: string;
  /** Length in Unicode code points. */
  length: number;
  ceiling: number;
  /** `ceiling - length`: negative when the file is over. */
  headroom: number;
  /** Whether the file is a rule, which must be path-scoped. */
  isRule: boolean;
  /** For a rule, whether its frontmatter carries a `paths:` list; always true otherwise. */
  scoped: boolean;
}

/** Whether a path names a rule under `.claude/rules/`, rather than `CLAUDE.md`. */
export function isRulePath(path: string): boolean {
  return path.startsWith(".claude/rules/");
}

/**
 * Whether a rule's frontmatter scopes it to paths: a leading `---` block
 * holding a `paths:` key followed by at least one list item.
 */
export function hasPathsFrontmatter(text: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return false;
  return /^paths:[ \t]*\r?\n[ \t]+- \S/m.test(match[1] ?? "");
}

/** Measure every file against its ceiling, in the order given. */
export function budgetInstructionFiles(
  files: readonly InstructionFile[],
): InstructionBudgetEntry[] {
  return files.map(({ path, text }) => {
    const isRule = isRulePath(path);
    const ceiling = isRule ? RULE_CEILING : CLAUDE_MD_CEILING;
    const length = textLength(text);
    return {
      path,
      length,
      ceiling,
      headroom: ceiling - length,
      isRule,
      scoped: isRule ? hasPathsFrontmatter(text) : true,
    };
  });
}

/** The entries that fail the gate: over their ceiling, or a rule with no `paths:`. */
export function failingEntries(
  entries: readonly InstructionBudgetEntry[],
): InstructionBudgetEntry[] {
  return entries.filter((entry) => entry.headroom < 0 || !entry.scoped);
}
