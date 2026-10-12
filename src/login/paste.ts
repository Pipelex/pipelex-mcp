/**
 * The hidden prompt of `login --paste`: one line read from a terminal without
 * echoing it, for a key created in the Pipelex app on a machine whose browser
 * cannot reach the login's listener.
 *
 * It reads standard input in raw mode, so it handles the keys itself: Enter
 * ends the line, Backspace removes the last character, Ctrl-U clears the line,
 * Ctrl-C interrupts, Ctrl-D on an empty line ends the input, and an escape
 * sequence (an arrow key, a function key, a bracketed paste's markers) is
 * skipped rather than typed. Nothing typed is ever written back. The terminal
 * is restored on every way out, an interrupt, the end of the input and an
 * error included.
 *
 * Hidden input needs a terminal, so a standard input that is not one, which
 * includes Claude Code's `!`, is refused before anything is read.
 */

/** The slice of a TTY read stream the prompt uses, so a test can drive it. */
export interface HiddenInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "end", listener: () => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** What the prompt read. */
export type HiddenLine =
  | { status: "entered"; value: string }
  | { status: "interrupted" }
  | { status: "ended" }
  | { status: "not_a_terminal" }
  | { status: "failed"; reason: string };

const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set(["\u007f", "\b"]);
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const CTRL_U = "\u0015";
const ESCAPE = "\u001b";

/**
 * Write `prompt`, then read one line from `input` without echoing it. Never
 * throws: every failure is a status, and the terminal is restored first.
 */
export async function readHiddenLine(
  input: HiddenInput,
  write: (text: string) => void,
  prompt: string,
): Promise<HiddenLine> {
  if (input.isTTY !== true || typeof input.setRawMode !== "function") {
    return { status: "not_a_terminal" };
  }
  const setRawMode = input.setRawMode.bind(input);

  return new Promise<HiddenLine>((resolve) => {
    let value = "";
    let escape: "none" | "start" | "sequence" = "none";
    let settled = false;

    const settle = (result: HiddenLine): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      try {
        setRawMode(false);
      } catch {
        // A terminal that is already gone has no mode to restore.
      }
      input.pause();
      // The Enter that ended the line was not echoed, so the cursor is still
      // on the prompt's line.
      write("\n");
      resolve(result);
    };

    const onData = (chunk: string | Buffer): void => {
      for (const char of String(chunk)) {
        if (settled) return;
        if (escape === "start") {
          // `ESC [` and `ESC O` open a sequence that runs to its final byte;
          // any other character after ESC is a two-character sequence.
          escape = char === "[" || char === "O" ? "sequence" : "none";
          continue;
        }
        if (escape === "sequence") {
          if (char >= "@" && char <= "~") escape = "none";
          continue;
        }
        if (ENTER.has(char)) {
          settle({ status: "entered", value });
        } else if (char === CTRL_C) {
          settle({ status: "interrupted" });
        } else if (char === CTRL_D) {
          if (value === "") settle({ status: "ended" });
        } else if (BACKSPACE.has(char)) {
          value = Array.from(value).slice(0, -1).join("");
        } else if (char === CTRL_U) {
          value = "";
        } else if (char === ESCAPE) {
          escape = "start";
        } else if (char >= " ") {
          value += char;
        }
      }
    };
    const onEnd = (): void => settle({ status: "ended" });
    const onError = (err: Error): void => settle({ status: "failed", reason: err.message });

    try {
      setRawMode(true);
    } catch (err) {
      settled = true;
      resolve({
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    write(prompt);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}
