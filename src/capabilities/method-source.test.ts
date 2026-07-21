import { describe, expect, it } from "vitest";

import { methodSourceToContents } from "./method-source.js";

describe("methodSourceToContents", () => {
  it("treats a raw MTHDS source string as one bundle", () => {
    const source = 'domain = "demo"\nmain_pipe = "main"';

    expect(methodSourceToContents(source)).toEqual([source]);
  });

  it("yields each file's content from a JSON file array", () => {
    const source = JSON.stringify([
      { name: "bundle.mthds", content: 'domain = "demo"' },
      { name: "pipes.mthds", content: 'main_pipe = "main"' },
    ]);

    expect(methodSourceToContents(source)).toEqual(['domain = "demo"', 'main_pipe = "main"']);
  });

  it("drops blank contents from a file array", () => {
    const source = JSON.stringify([
      { name: "empty.mthds", content: "" },
      { name: "blank.mthds", content: "  \n\t" },
      { name: "bundle.mthds", content: 'domain = "demo"' },
    ]);

    expect(methodSourceToContents(source)).toEqual(['domain = "demo"']);
  });

  it("treats an all-blank file array as no source", () => {
    const source = JSON.stringify([{ name: "empty.mthds", content: "" }]);

    expect(methodSourceToContents(source)).toEqual([]);
  });

  it('treats the webapp\'s empty file array ("[]") as no source, not a bundle', () => {
    expect(methodSourceToContents("[]")).toEqual([]);
  });

  it("treats an empty or whitespace-only string as no source", () => {
    expect(methodSourceToContents("")).toEqual([]);
    expect(methodSourceToContents("   \n")).toEqual([]);
  });

  it("treats a contract-violating null source as no source, not a crash", () => {
    expect(methodSourceToContents(null as unknown as string)).toEqual([]);
    expect(methodSourceToContents(undefined as unknown as string)).toEqual([]);
  });

  it("treats non-array JSON as a raw bundle string", () => {
    // Valid JSON that is not the file-array format IS the source — a method
    // could legally start with a number or a JSON-looking object.
    expect(methodSourceToContents("42")).toEqual(["42"]);
    expect(methodSourceToContents('{"name": "x", "content": "y"}')).toEqual([
      '{"name": "x", "content": "y"}',
    ]);
  });

  it("treats a JSON array of non-file entries as a raw bundle string", () => {
    expect(methodSourceToContents('["a", "b"]')).toEqual(['["a", "b"]']);
  });
});
