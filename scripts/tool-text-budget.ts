/**
 * The length budget for the texts a host puts in front of the model: each
 * server's `instructions` and each tool's `description`.
 *
 * Claude Code cuts MCP server instructions and each tool description at 2,048
 * characters. That is not a documented figure we took on trust: at dev
 * `c5e4652` the workshop's live `initialize` result reached the model cut at
 * character 2,048, mid-word ("…for the project you are in — TypeSc"), because
 * every campaign had appended its tool's usage to the instructions and nothing
 * measured the result.
 *
 * The ceiling sits below that cap on purpose. The difference is room for one
 * more sentence before anything is lost, and a margin for the hosts whose cap
 * nobody has measured (claude.ai, ChatGPT) — nothing here assumes theirs.
 *
 * Lengths are counted in Unicode code points (`[...text].length`), which is
 * how the cut was measured. The arithmetic lives here, and not in
 * `scripts/check-tool-texts.ts`, so the hermetic suite covers it; the script
 * only builds both servers, reads what they emit, and reports.
 */

/** Where Claude Code cuts a server's instructions and each tool description. */
export const HOST_TEXT_CAP = 2048;

/** The budget every model-facing text is held to, with headroom under the cap. */
export const TOOL_TEXT_CEILING = 1800;

/** One text as a shell emitted it, before shells that emit it identically are merged. */
export interface EmittedText {
  /** The shell that emitted it: `console` or `workshop`. */
  shell: string;
  /** What the text is: `instructions`, or the name of the tool it describes. */
  name: string;
  text: string;
}

/** One distinct text, measured against the ceiling. */
export interface TextBudgetEntry {
  /** Every shell that emits this exact text, in first-seen order. */
  shells: string[];
  name: string;
  /** Length in Unicode code points. */
  length: number;
  /** `ceiling - length`: negative when the text is over. */
  headroom: number;
}

export function textLength(text: string): number {
  return [...text].length;
}

/**
 * Measure every emitted text against the ceiling, largest first.
 *
 * A text two shells emit identically — the description of a tool both shells
 * register, while their two tables still word it alike — is one entry naming
 * both shells, so the report does not list it twice. The same name with different texts stays two
 * entries: that is the case for the two shells' instructions.
 */
export function budgetEmittedTexts(
  texts: readonly EmittedText[],
  ceiling: number = TOOL_TEXT_CEILING,
): TextBudgetEntry[] {
  const merged = new Map<string, { shells: string[]; name: string; text: string }>();
  for (const { shell, name, text } of texts) {
    const key = JSON.stringify([name, text]);
    const existing = merged.get(key);
    if (existing) {
      if (!existing.shells.includes(shell)) existing.shells.push(shell);
    } else {
      merged.set(key, { shells: [shell], name, text });
    }
  }

  return [...merged.values()]
    .map(({ shells, name, text }) => {
      const length = textLength(text);
      return { shells, name, length, headroom: ceiling - length };
    })
    .sort(
      (a, b) =>
        b.length - a.length ||
        a.name.localeCompare(b.name) ||
        a.shells.join().localeCompare(b.shells.join()),
    );
}

/** The entries over the ceiling. A text exactly at it is within budget. */
export function overCeiling(entries: readonly TextBudgetEntry[]): TextBudgetEntry[] {
  return entries.filter((entry) => entry.headroom < 0);
}
