import { describe, expect, it } from "vitest";

import {
  MAX_TEMPLATE_FILE_BYTES,
  MAX_TEMPLATE_FILES,
  MAX_TEMPLATE_FILES_TOTAL_BYTES,
  REQUEST_ENVELOPE_ALLOWANCE_BYTES,
  isTemplateFilePath,
  planTemplateFiles,
  templateBudgetRefusals,
  templateFilesNamedBy,
  templateKeyOf,
} from "./template-files.js";
import type { LocatedTemplate, NamedTemplate } from "./template-files.js";
import { GATEWAY_REQUEST_LIMIT_BYTES, base64EncodedLength } from "./upload-ceiling.js";

const MIB = 1024 * 1024;

describe("isTemplateFilePath", () => {
  it("reads the suffix case-insensitively, and nothing else", () => {
    expect(isTemplateFilePath("templates/Report.HTML")).toBe(true);
    expect(isTemplateFilePath("deck.pptx")).toBe(true);
    expect(isTemplateFilePath("bundle.mthds")).toBe(false);
    expect(isTemplateFilePath(".env")).toBe(false);
    expect(isTemplateFilePath("notes.html.txt")).toBe(false);
  });
});

describe("templateFilesNamedBy", () => {
  it("lists the template_file of every PipeDocGen step, as written", () => {
    const content = [
      'domain = "invoice"',
      "",
      "[pipe.render]",
      'type = "PipeDocGen"',
      'template_file = "./templates/invoice.xlsx"',
      "",
      "[pipe.letter]",
      'type = "PipeDocGen"',
      'template_file = "letter.docx"',
      "",
      "[pipe.summarize]",
      'type = "PipeLLM"',
      'template_file = "not-a-docgen.html"',
      "",
      "[pipe.no_template]",
      'type = "PipeDocGen"',
      "",
      "[pipe.not_a_string]",
      'type = "PipeDocGen"',
      "template_file = 3",
    ].join("\n");

    expect(templateFilesNamedBy(content)).toEqual(["./templates/invoice.xlsx", "letter.docx"]);
  });

  it("names nothing from a file that does not parse, or that holds no pipe table", () => {
    expect(templateFilesNamedBy('[pipe.render\ntype = "PipeDocGen"')).toEqual([]);
    expect(templateFilesNamedBy('domain = "invoice"')).toEqual([]);
    expect(templateFilesNamedBy('pipe = "flat"')).toEqual([]);
  });
});

describe("templateKeyOf", () => {
  it("collapses the dot segments and repeated slashes of a path inside the bundle", () => {
    expect(templateKeyOf("templates/invoice.xlsx")).toBe("templates/invoice.xlsx");
    expect(templateKeyOf("./templates//invoice.xlsx")).toBe("templates/invoice.xlsx");
    expect(templateKeyOf("templates/./invoice.xlsx/")).toBe("templates/invoice.xlsx");
  });

  it("has no key for a path no file inside the bundle can have", () => {
    for (const refused of [
      "",
      "   ",
      ".",
      "./",
      "/etc/invoice.xlsx",
      "../invoice.xlsx",
      "templates/../../invoice.xlsx",
      "templates\\invoice.xlsx",
      "C:invoice.xlsx",
      "invoice\0.xlsx",
    ]) {
      expect(templateKeyOf(refused), refused).toBeUndefined();
    }
  });
});

describe("planTemplateFiles", () => {
  function located(index: number, real: string, size = 10): LocatedTemplate {
    return { index, path: `submitted/${index}`, real, size };
  }

  function named(key: string, real: string | null, mthdsPath = "m/bundle.mthds"): NamedTemplate {
    return { key, mthdsPath, real, escapes: false };
  }

  it("plans each submitted file under the key of the step naming it", () => {
    const plan = planTemplateFiles(
      [located(1, "/w/m/templates/a.docx")],
      [named("templates/a.docx", "/w/m/templates/a.docx")],
      0,
    );

    expect(plan.refusals).toEqual([]);
    expect(plan.planned).toEqual([
      {
        key: "templates/a.docx",
        index: 1,
        path: "submitted/1",
        real: "/w/m/templates/a.docx",
        size: 10,
      },
    ]);
  });

  it("plans the same real file once, at its first item", () => {
    const plan = planTemplateFiles(
      [located(1, "/w/m/a.docx"), located(2, "/w/m/a.docx")],
      [named("a.docx", "/w/m/a.docx")],
      0,
    );

    expect(plan.planned.map((entry) => entry.index)).toEqual([1]);
  });

  it("plans a file two steps name under two keys under each key", () => {
    const plan = planTemplateFiles(
      [located(1, "/w/m/templates/a.docx")],
      [
        named("templates/a.docx", "/w/m/templates/a.docx", "m/bundle.mthds"),
        named("a.docx", "/w/m/templates/a.docx", "m/templates/steps.mthds"),
      ],
      0,
    );

    expect(plan.planned.map((entry) => entry.key)).toEqual(["templates/a.docx", "a.docx"]);
  });

  it("refuses a file no step names, listing where the steps look", () => {
    const plan = planTemplateFiles(
      [located(3, "/w/m/method-graph.html")],
      [named("templates/a.docx", "/w/m/templates/a.docx"), named("b.docx", null)],
      0,
    );

    expect(plan.planned).toEqual([]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]?.index).toBe(3);
    expect(plan.refusals[0]?.message).toContain("named by no PipeDocGen step");
    expect(plan.refusals[0]?.message).toContain("m/templates/a.docx, m/b.docx");
  });

  it("refuses a file a step reaches only through a symlink out of its directory", () => {
    const plan = planTemplateFiles(
      [located(1, "/w/shared/a.docx")],
      [{ key: "a.docx", mthdsPath: "m/bundle.mthds", real: "/w/shared/a.docx", escapes: true }],
      0,
    );

    expect(plan.planned).toEqual([]);
    expect(plan.refusals[0]?.message).toContain("only through a symlink");
  });

  it("refuses one key naming two different files beside two .mthds files", () => {
    const plan = planTemplateFiles(
      [located(2, "/w/a/letter.docx")],
      [
        named("letter.docx", "/w/a/letter.docx", "a/a.mthds"),
        named("letter.docx", "/w/b/letter.docx", "b/b.mthds"),
      ],
      0,
    );

    expect(plan.planned).toEqual([]);
    expect(plan.refusals[0]?.index).toBe(2);
    expect(plan.refusals[0]?.message).toContain("a/a.mthds and b/b.mthds");
  });

  it("does not see a conflict in a key whose second file does not exist", () => {
    const plan = planTemplateFiles(
      [located(2, "/w/a/letter.docx")],
      [
        named("letter.docx", "/w/a/letter.docx", "a/a.mthds"),
        named("letter.docx", null, "b/b.mthds"),
      ],
      0,
    );

    expect(plan.refusals).toEqual([]);
    expect(plan.planned.map((entry) => entry.key)).toEqual(["letter.docx"]);
  });

  it("holds what it planned to the budget", () => {
    const names = Array.from({ length: MAX_TEMPLATE_FILES + 1 }, (_, index) => `t${index}.docx`);
    const plan = planTemplateFiles(
      names.map((name, index) => located(index, `/w/m/${name}`)),
      names.map((name) => named(name, `/w/m/${name}`)),
      0,
    );

    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]?.index).toBeUndefined();
  });
});

describe("templateBudgetRefusals", () => {
  function entry(index: number, size: number, key = `t${index}.docx`) {
    return { key, index, path: `m/${key}`, size };
  }

  it("lets through a request inside every bound", () => {
    expect(templateBudgetRefusals([entry(1, MIB), entry(2, MIB)], 10_000)).toEqual([]);
  });

  it("refuses more files than the runner takes at files as a whole", () => {
    const entries = Array.from({ length: MAX_TEMPLATE_FILES + 1 }, (_, index) => entry(index, 1));

    const refusals = templateBudgetRefusals(entries, 0);

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.index).toBeUndefined();
    expect(templateBudgetRefusals(entries.slice(1), 0)).toEqual([]);
  });

  it("refuses a file over the runner's per-file size at the file", () => {
    const refusals = templateBudgetRefusals(
      [entry(1, MAX_TEMPLATE_FILE_BYTES + 1), entry(2, MAX_TEMPLATE_FILE_BYTES)],
      0,
    );

    expect(refusals.map((refusal) => refusal.index)).toEqual([1]);
    expect(refusals[0]?.message).toContain("5.0 MiB");
  });

  it("measures the gateway's quota on the base64 length, with the method's text and an allowance", () => {
    // Two files of the largest size that fits beside `requestBytes` of text,
    // the key and its JSON quoting counted with each.
    const requestBytes = 100_000;
    const room = GATEWAY_REQUEST_LIMIT_BYTES - requestBytes - REQUEST_ENVELOPE_ALLOWANCE_BYTES;
    const size = Math.floor((room / 2 - "t1.docx".length - 8) / 4) * 3;
    expect(2 * (base64EncodedLength(size) + "t1.docx".length + 8)).toBeLessThanOrEqual(room);

    expect(templateBudgetRefusals([entry(1, size), entry(2, size)], requestBytes)).toEqual([]);
    const refusals = templateBudgetRefusals([entry(1, size), entry(2, size + 30)], requestBytes);
    expect(refusals.map((refusal) => refusal.index)).toEqual([2]);
    expect(refusals[0]?.message).toContain("base64-encoded");
    expect(refusals[0]?.hint).toContain("7.4 MiB");
    // Raw bytes the runner would take: the encoded length is what binds.
    expect(2 * size + 30).toBeLessThan(MAX_TEMPLATE_FILES_TOTAL_BYTES);
  });

  it("counts the method's text against the gateway's quota", () => {
    const entries = [entry(1, 3 * MIB), entry(2, 3 * MIB)];

    expect(templateBudgetRefusals(entries, 0)).toEqual([]);
    expect(templateBudgetRefusals(entries, 2 * MIB).map((refusal) => refusal.index)).toEqual([2]);
  });
});
