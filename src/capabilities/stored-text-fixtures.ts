import type { RunResults } from "@pipelex/sdk";

/**
 * Run results carrying stored texts, for the tests of `stored-texts.ts`,
 * `mthds_run_results` and `mthds_download_artifacts`. Only tests import this
 * file. The shapes are the runtime's: a stored `Text`, `Markdown`, `Html` or
 * `JSON` value is `{ url, size, mime_type, preview }` with no value field, the
 * working memory names the main output's concept under the `main_stuff`
 * alias, and the output-form descriptors carry each position's concept.
 */

export const RUN_ID = "01JRUN0000000000000000TEST";

export const REPORT_TEXT_URI = "pipelex-storage://org/runs/01JRUN/generated/9f2c41/value.md";
export const PAGE_TEXT_URI = "pipelex-storage://org/runs/01JRUN/generated/77ab01/value.txt";
export const DOCUMENT_URI = "pipelex-storage://org/runs/01JRUN/outputs/notes.txt";
export const PICTURE_URI = "pipelex-storage://org/runs/01JRUN/outputs/cover.png";

/** A stored Markdown value, as the runtime serializes one. */
export const STORED_REPORT = {
  url: REPORT_TEXT_URI,
  size: 48213,
  mime_type: "text/markdown",
  preview: "# Quarterly report\n\nThe first few hundred characters…",
};

/** A stored plain text, as the runtime serializes one. */
export const STORED_PAGE = {
  url: PAGE_TEXT_URI,
  size: 9120,
  mime_type: "text/plain",
  preview: "Page one begins here…",
};

/** A document that is `text/plain` too: a file, by its concept, whatever its MIME type. */
export const NOTES_DOCUMENT = {
  url: DOCUMENT_URI,
  public_url: "https://signed.example/notes.txt?X-Amz-Expires=3600",
  mime_type: "text/plain",
  filename: "notes.txt",
};

/** A working memory whose main output is one stuff of `concept`. */
export function workingMemoryFor(concept: string, content: unknown): RunResults["working_memory"] {
  return {
    root: { report: { concept, content } },
    aliases: { main_stuff: "report" },
  } as unknown as RunResults["working_memory"];
}

/**
 * The output-form descriptors of a small library: a structured `Dossier`
 * holding a Markdown report, a refining `Memo`, a list of pages of text, a
 * description-only `Summary`, a document and an image.
 */
export const OUTPUT_FORM = {
  "dossier.compile": {
    field: {
      kind: "object",
      name: "output",
      concept_ref: "dossier.Dossier",
      required: true,
      fields: [
        { kind: "text", name: "title", required: true },
        { kind: "prose", name: "report", concept_ref: "native.Markdown", required: true },
        {
          kind: "prose",
          name: "memo",
          concept_ref: "dossier.Memo",
          refines: ["native.Text"],
          required: false,
        },
        {
          kind: "list",
          name: "pages",
          concept_ref: "native.Text",
          required: true,
          item: { kind: "prose", concept_ref: "native.Text", required: true },
        },
        { kind: "document", name: "notes", concept_ref: "native.Document", required: false },
        { kind: "image", name: "cover", concept_ref: "native.Image", required: false },
        { kind: "prose", name: "summary", concept_ref: "dossier.Summary", required: false },
      ],
    },
  },
  "dossier.write_memo": {
    field: {
      kind: "prose",
      name: "output",
      concept_ref: "dossier.Memo",
      refines: ["native.Text"],
      required: true,
    },
  },
  "dossier.split_pages": {
    field: {
      kind: "list",
      name: "output",
      concept_ref: "native.Text",
      required: true,
      item: { kind: "prose", concept_ref: "native.Text", required: true },
    },
  },
} as unknown as RunResults["output_form"];

/** A structured output holding stored texts, an inline one, a text document and an image. */
export const DOSSIER = {
  title: "Q3",
  report: STORED_REPORT,
  memo: { text: "A short memo stays inline." },
  pages: [STORED_PAGE, { text: "A short page." }],
  notes: NOTES_DOCUMENT,
  cover: { url: PICTURE_URI },
  summary: { text: "Inline summary." },
};

/** Results of a run whose output is the dossier above, with the facts to read it. */
export function dossierResults(): RunResults {
  return {
    pipeline_run_id: RUN_ID,
    main_stuff: DOSSIER,
    working_memory: workingMemoryFor("dossier.Dossier", DOSSIER),
    output_form: OUTPUT_FORM,
  };
}

/** Results of a run whose whole output is one stored Markdown text. */
export function storedReportResults(): RunResults {
  return {
    pipeline_run_id: RUN_ID,
    main_stuff: STORED_REPORT,
    working_memory: workingMemoryFor("native.Markdown", STORED_REPORT),
    output_form: OUTPUT_FORM,
  };
}
