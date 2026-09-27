/**
 * `npm run check:instructions` — the size gate on this repository's agent
 * instruction files: `CLAUDE.md` and each rule under `.claude/rules/`.
 *
 * `scripts/instruction-budget.ts` says why the gate exists and where the
 * ceilings sit, and owns the arithmetic, which the hermetic suite tests. This
 * script reads the files, prints each one's length and headroom, and fails
 * when a file is over its ceiling or a rule is not path-scoped.
 *
 * Exit code: 0 when every file passes, 1 otherwise, naming each failure.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { budgetInstructionFiles, failingEntries } from "./instruction-budget.js";
import type { InstructionFile } from "./instruction-budget.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RULES_DIR = ".claude/rules";

// `no-console` is an error in this repo's eslint config; the report is this
// script's whole output. `scripts/check-tool-texts.ts` writes the same way.
const say = (text = ""): void => {
  process.stdout.write(`${text}\n`);
};

function readInstructionFiles(): InstructionFile[] {
  const read = (relative: string): InstructionFile => ({
    path: relative,
    text: readFileSync(path.join(REPO_ROOT, relative), "utf8"),
  });
  const rules = readdirSync(path.join(REPO_ROOT, RULES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `${RULES_DIR}/${entry.name}`)
    .sort();
  return [read("CLAUDE.md"), ...rules.map(read)];
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function main(): void {
  const entries = budgetInstructionFiles(readInstructionFiles());

  say("Agent instruction files, in Unicode code points:");
  say();
  say(`${"length".padStart(7)}  ${"ceiling".padStart(7)}  ${"headroom".padStart(8)}  file`);
  for (const entry of entries) {
    say(
      `${formatCount(entry.length).padStart(7)}  ${formatCount(entry.ceiling).padStart(7)}  ` +
        `${formatCount(entry.headroom).padStart(8)}  ${entry.path}`,
    );
  }

  const failing = failingEntries(entries);
  if (failing.length === 0) {
    say();
    say("Every instruction file is within its ceiling, and every rule is path-scoped.");
    return;
  }

  say();
  for (const entry of failing) {
    if (entry.headroom < 0) {
      say(
        `FAIL ${entry.path} is ${formatCount(-entry.headroom)} code points over its ceiling of ` +
          `${formatCount(entry.ceiling)}. Move the detail to docs/, SPEC.md, a code comment or ` +
          `a path-scoped rule rather than raising the ceiling.`,
      );
    }
    if (!entry.scoped) {
      say(
        `FAIL ${entry.path} has no paths: list in its frontmatter, so it would load into every ` +
          `session. Scope it to the files it is about.`,
      );
    }
  }
  process.exitCode = 1;
}

main();
