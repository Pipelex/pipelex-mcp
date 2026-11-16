import { collectArtifacts } from "@pipelex/sdk";
import type { RunResults } from "@pipelex/sdk";
import { describe, expect, it } from "vitest";

import {
  DOCUMENT_URI,
  DOSSIER,
  OUTPUT_FORM,
  PAGE_TEXT_URI,
  PICTURE_URI,
  REPORT_TEXT_URI,
  RUN_ID,
  STORED_PAGE,
  STORED_REPORT,
  dossierResults,
  storedReportResults,
  workingMemoryFor,
} from "./stored-text-fixtures.js";
import { renderPath, storedFilesOf, storedTextsOf, withoutStoredTexts } from "./stored-texts.js";

function results(concept: string, mainStuff: unknown, outputForm = OUTPUT_FORM): RunResults {
  return {
    pipeline_run_id: RUN_ID,
    main_stuff: mainStuff,
    working_memory: workingMemoryFor(concept, mainStuff),
    output_form: outputForm,
  };
}

describe("storedTextsOf", () => {
  it("finds a main output that is itself a stored text, with its size, MIME type and preview", () => {
    expect(storedTextsOf(storedReportResults())).toEqual([
      {
        uri: REPORT_TEXT_URI,
        found_at: ["$.url"],
        segments: [["url"]],
        size: 48213,
        mime_type: "text/markdown",
        preview: STORED_REPORT.preview,
      },
    ]);
  });

  it("finds nothing in an inline text", () => {
    expect(storedTextsOf(results("native.Text", { text: "short" }))).toEqual([]);
  });

  it("tells stored texts from stored files by concept, at every depth", () => {
    const texts = storedTextsOf(dossierResults());

    expect(texts.map((text) => [text.uri, text.found_at])).toEqual([
      [REPORT_TEXT_URI, ["$.report.url"]],
      [PAGE_TEXT_URI, ["$.pages[0].url"]],
    ]);
    // The document is text/plain too, and stays a file: its concept is native.Document.
    expect(texts.map((text) => text.uri)).not.toContain(DOCUMENT_URI);
    expect(storedFilesOf(DOSSIER, texts)).toEqual([DOCUMENT_URI, PICTURE_URI]);
  });

  it("reads a concept refining a storable native, and a description-only concept, as text", () => {
    const memo = storedTextsOf(results("dossier.Memo", STORED_PAGE));
    expect(memo.map((text) => text.found_at)).toEqual([["$.url"]]);

    const summaryForm = {
      "dossier.summarize": {
        field: { kind: "prose", name: "output", concept_ref: "dossier.Summary", required: true },
      },
    } as unknown as RunResults["output_form"];
    const summary = storedTextsOf(results("dossier.Summary", STORED_PAGE, summaryForm));
    expect(summary.map((text) => text.uri)).toEqual([PAGE_TEXT_URI]);
  });

  it("walks a plural output's items against its element concept", () => {
    const pages = { items: [STORED_PAGE, { text: "inline" }, STORED_REPORT] };
    const texts = storedTextsOf(results("native.Text", pages));

    expect(texts.map((text) => text.found_at)).toEqual([["$.items[0].url"], ["$.items[2].url"]]);
  });

  it("gathers every path of a reference the output repeats", () => {
    const pages = { items: [STORED_PAGE, STORED_PAGE] };
    const [text, ...rest] = storedTextsOf(results("native.Text", pages));

    expect(rest).toEqual([]);
    expect(text?.found_at).toEqual(["$.items[0].url", "$.items[1].url"]);
  });

  it("recognizes a storable native with no descriptor, and nothing else without one", () => {
    expect(storedTextsOf(results("native.Markdown", STORED_REPORT, null))).toHaveLength(1);
    expect(storedTextsOf(results("dossier.Dossier", DOSSIER, null))).toEqual([]);
  });

  it("reads every reference as a file when the run's facts are missing", () => {
    const bare: RunResults = { pipeline_run_id: RUN_ID, main_stuff: DOSSIER };
    expect(storedTextsOf(bare)).toEqual([]);
    expect(storedFilesOf(DOSSIER, storedTextsOf(bare))).toEqual(collectArtifacts(DOSSIER));

    // A runtime older than pipelex 0.60.0 wrote the concept as an object.
    const legacy: RunResults = {
      pipeline_run_id: RUN_ID,
      main_stuff: STORED_REPORT,
      working_memory: {
        root: { main_stuff: { concept: { code: "Markdown" }, content: STORED_REPORT } },
        aliases: {},
      } as unknown as RunResults["working_memory"],
      output_form: OUTPUT_FORM,
    };
    expect(storedTextsOf(legacy)).toEqual([]);
  });

  it("finds the main output stored under the main_stuff name itself, with no alias", () => {
    const direct: RunResults = {
      pipeline_run_id: RUN_ID,
      main_stuff: STORED_REPORT,
      working_memory: {
        root: { main_stuff: { concept: "native.Markdown", content: STORED_REPORT } },
        aliases: {},
      } as unknown as RunResults["working_memory"],
    };
    expect(storedTextsOf(direct).map((text) => text.uri)).toEqual([REPORT_TEXT_URI]);
  });

  it("leaves a value holding both its value and a url to the runtime's rule: not stored", () => {
    const both = { ...STORED_PAGE, text: "loaded" };
    expect(storedTextsOf(results("native.Text", both))).toEqual([]);
  });
});

describe("withoutStoredTexts", () => {
  it("removes each stored text's reference and nothing else, leaving the input untouched", () => {
    const texts = storedTextsOf(dossierResults());
    const filesOnly = withoutStoredTexts(DOSSIER, texts) as typeof DOSSIER;

    expect(filesOnly.report).toEqual({
      size: 48213,
      mime_type: "text/markdown",
      preview: STORED_REPORT.preview,
    });
    expect(filesOnly.notes).toEqual(DOSSIER.notes);
    expect(DOSSIER.report.url).toBe(REPORT_TEXT_URI);
  });

  it("returns the output itself when it holds no stored text", () => {
    expect(withoutStoredTexts(DOSSIER, [])).toBe(DOSSIER);
  });
});

describe("renderPath", () => {
  it("writes the SDK's found_at notation", () => {
    expect(renderPath([])).toBe("$");
    expect(renderPath(["rooms", 3, "a key", "url"])).toBe('$.rooms[3]["a key"].url');
  });
});
