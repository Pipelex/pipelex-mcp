import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { readHiddenLine } from "./paste.js";
import type { HiddenInput } from "./paste.js";

/** A terminal's standard input a test types into, recording its raw mode. */
class FakeTerminal extends EventEmitter implements HiddenInput {
  readonly modes: boolean[] = [];
  paused = true;

  constructor(
    readonly isTTY: boolean = true,
    private readonly refuseRawMode = false,
  ) {
    super();
  }

  setRawMode(mode: boolean): this {
    if (this.refuseRawMode) throw new Error("not a real terminal");
    this.modes.push(mode);
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  get raw(): boolean {
    return this.modes.at(-1) ?? false;
  }

  type(...chunks: string[]): void {
    for (const chunk of chunks) this.emit("data", chunk);
  }
}

function output(): { write: (text: string) => void; text: () => string } {
  let written = "";
  return { write: (text) => (written += text), text: () => written };
}

describe("readHiddenLine", () => {
  it("reads a line in raw mode without echoing it, then restores the terminal", async () => {
    const terminal = new FakeTerminal();
    const out = output();

    const reading = readHiddenLine(terminal, out.write, "Key: ");
    expect(terminal.raw).toBe(true);
    expect(terminal.paused).toBe(false);
    terminal.type("plx_sk_", "secret", "\r");

    expect(await reading).toEqual({ status: "entered", value: "plx_sk_secret" });
    expect(terminal.modes).toEqual([true, false]);
    expect(terminal.paused).toBe(true);
    expect(terminal.listenerCount("data")).toBe(0);
    expect(out.text()).toBe("Key: \n");
  });

  it("handles backspace, Ctrl-U and a paste arriving with its Enter in one chunk", async () => {
    const terminal = new FakeTerminal();

    const reading = readHiddenLine(terminal, () => undefined, "");
    terminal.type("wrong", "\u0015", "plx_sk_abx", "\u007f", "\b", "c", "\n");

    expect(await reading).toEqual({ status: "entered", value: "plx_sk_ac" });
  });

  it("skips escape sequences, such as arrow keys and a bracketed paste's markers", async () => {
    const terminal = new FakeTerminal();

    const reading = readHiddenLine(terminal, () => undefined, "");
    terminal.type("\u001b[200~plx_sk_", "\u001b[D", "key\u001b[201~", "\u001bOA", "\r");

    expect(await reading).toEqual({ status: "entered", value: "plx_sk_key" });
  });

  it("ignores what follows the Enter in the same chunk", async () => {
    const terminal = new FakeTerminal();

    const reading = readHiddenLine(terminal, () => undefined, "");
    terminal.type("plx_sk_one\rplx_sk_two\r");

    expect(await reading).toEqual({ status: "entered", value: "plx_sk_one" });
  });

  it("stops at Ctrl-C and restores the terminal", async () => {
    const terminal = new FakeTerminal();

    const reading = readHiddenLine(terminal, () => undefined, "");
    terminal.type("plx_sk_half", "\u0003");

    expect(await reading).toEqual({ status: "interrupted" });
    expect(terminal.modes).toEqual([true, false]);
    expect(terminal.paused).toBe(true);
  });

  it("ends on Ctrl-D on an empty line, and on the end of the input, restoring the terminal", async () => {
    const ctrlD = new FakeTerminal();
    const readingD = readHiddenLine(ctrlD, () => undefined, "");
    ctrlD.type("\u0004");

    const closed = new FakeTerminal();
    const readingClosed = readHiddenLine(closed, () => undefined, "");
    closed.type("plx_sk_partial");
    closed.emit("end");

    expect(await readingD).toEqual({ status: "ended" });
    expect(await readingClosed).toEqual({ status: "ended" });
    expect(ctrlD.modes).toEqual([true, false]);
    expect(closed.modes).toEqual([true, false]);
  });

  it("restores the terminal when the input fails", async () => {
    const terminal = new FakeTerminal();

    const reading = readHiddenLine(terminal, () => undefined, "");
    terminal.emit("error", new Error("EIO"));

    expect(await reading).toEqual({ status: "failed", reason: "EIO" });
    expect(terminal.modes).toEqual([true, false]);
    expect(terminal.listenerCount("error")).toBe(0);
  });

  it("refuses a standard input that is not a terminal, before reading anything", async () => {
    const piped = new FakeTerminal(false);
    const out = output();

    expect(await readHiddenLine(piped, out.write, "Key: ")).toEqual({ status: "not_a_terminal" });
    expect(piped.modes).toEqual([]);
    expect(piped.paused).toBe(true);
    expect(out.text()).toBe("");
  });

  it("reports a terminal that refuses raw mode, without reading", async () => {
    const terminal = new FakeTerminal(true, true);

    const read = await readHiddenLine(terminal, () => undefined, "");

    expect(read).toEqual({ status: "failed", reason: "not a real terminal" });
    expect(terminal.listenerCount("data")).toBe(0);
  });
});
