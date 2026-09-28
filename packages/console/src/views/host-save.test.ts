import { buildResultField } from "@pipelex/mthds-ui/form";
import type { SaveFile, SaveFiles } from "@pipelex/mthds-ui/form";
import { describe, expect, it, vi } from "vitest";

import {
  downloadContentOf,
  downloadDisplayFor,
  saveThroughHostDownload,
  saveThroughOpenLink,
  saveWholeOutput,
} from "./host-save.js";
import type { HostDownload } from "./host-save.js";

const IMAGE: SaveFile = {
  name: "report-output-figures-0.png",
  mimeType: "image/png",
  kind: "image",
  path: "output.figures.0",
  url: "https://bucket.example/figure.png?X-Amz-Signature=abc",
};

const JSON_COPY: SaveFile = {
  name: "report.json",
  mimeType: "application/json",
  kind: "data",
  path: "report",
  text: '{"title": "Q3"}',
};

/** A reader that read nothing, so every stored file goes as its link. */
const readNothing = () => Promise.resolve(undefined);

describe("downloadContentOf", () => {
  it("embeds a stored file's bytes under a file URI whose last segment is the planned name", () => {
    expect(downloadContentOf(IMAGE, "iVBORw0KGgo=")).toEqual({
      type: "resource",
      resource: {
        uri: "file:///report-output-figures-0.png",
        mimeType: "image/png",
        blob: "iVBORw0KGgo=",
      },
    });
  });

  it("hands a stored file the view could not read over as its link, under its planned name", () => {
    expect(downloadContentOf(IMAGE)).toEqual({
      type: "resource_link",
      uri: IMAGE.url,
      name: "report-output-figures-0.png",
      mimeType: "image/png",
    });
  });

  it("embeds inline content under a file URI whose last segment is the planned name", () => {
    expect(downloadContentOf(JSON_COPY)).toEqual({
      type: "resource",
      resource: {
        uri: "file:///report.json",
        mimeType: "application/json",
        text: '{"title": "Q3"}',
      },
    });
  });

  it("escapes a planned name that would otherwise break the URI", () => {
    const content = downloadContentOf({ ...JSON_COPY, name: "Q3 report #2.json" });
    expect(content.type === "resource" && content.resource.uri).toBe(
      "file:///Q3%20report%20%232.json",
    );
  });
});

describe("saveThroughHostDownload", () => {
  it("sends the whole plan as one request, a stored file's bytes embedded, and reports nothing failed when the host saves it", async () => {
    const download = vi.fn<HostDownload>().mockResolvedValue({});
    const readStoredFile = vi.fn().mockResolvedValue("iVBORw0KGgo=");
    const result = await saveThroughHostDownload(download, readStoredFile)([IMAGE, JSON_COPY]);
    expect(readStoredFile).toHaveBeenCalledExactlyOnceWith(IMAGE.url);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0].contents).toEqual([
      downloadContentOf(IMAGE, "iVBORw0KGgo="),
      downloadContentOf(JSON_COPY),
    ]);
    expect(result).toEqual({ failed: [] });
  });

  it("hands over the link of a stored file the view could not read", async () => {
    const download = vi.fn<HostDownload>().mockResolvedValue({});
    await saveThroughHostDownload(download, readNothing)([IMAGE]);
    expect(download.mock.calls[0]![0].contents).toEqual([downloadContentOf(IMAGE)]);
  });

  it("fails every file of a request the host declined", async () => {
    const download = vi.fn<HostDownload>().mockResolvedValue({ isError: true });
    const result = await saveThroughHostDownload(download, readNothing)([IMAGE, JSON_COPY]);
    expect(result.failed.map((failure) => failure.file)).toEqual([IMAGE, JSON_COPY]);
  });

  it("fails every file of a request the host never answered, rather than rejecting", async () => {
    const download = vi.fn<HostDownload>().mockRejectedValue(new Error("Request timed out"));
    const result = await saveThroughHostDownload(download, readNothing)([IMAGE, JSON_COPY]);
    expect(result.failed.map((failure) => failure.file)).toEqual([IMAGE, JSON_COPY]);
    expect(result.failed[0]!.reason).toBe("The host did not answer the download request");
  });

  it("sends no request for an empty plan", async () => {
    const download = vi.fn<HostDownload>();
    expect(await saveThroughHostDownload(download, readNothing)([])).toEqual({ failed: [] });
    expect(download).not.toHaveBeenCalled();
  });
});

describe("saveThroughOpenLink", () => {
  it("opens each stored file's link and fails inline content, which has none", async () => {
    const openLink = vi.fn();
    const result = await saveThroughOpenLink(openLink)([IMAGE, JSON_COPY]);
    expect(openLink).toHaveBeenCalledExactlyOnceWith(IMAGE.url);
    expect(result.failed.map((failure) => failure.file)).toEqual([JSON_COPY]);
  });

  it("fails a link the host refused to open and still opens the next", async () => {
    const other = {
      ...IMAGE,
      name: "report-output-figures-1.png",
      url: "https://bucket.example/b.png",
    };
    const openLink = vi.fn().mockImplementationOnce(() => {
      throw new Error("refused");
    });
    const result = await saveThroughOpenLink(openLink)([IMAGE, other]);
    expect(openLink).toHaveBeenCalledTimes(2);
    expect(result.failed.map((failure) => failure.file)).toEqual([IMAGE]);
  });
});

describe("saveWholeOutput", () => {
  const field = buildResultField(
    { field: { name: "report", kind: "prose", concept_ref: "native.Text", required: true } },
    { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  );
  const full = { text: "the whole output, not the bounded copy the panel shows" };

  it("plans the full value and hands the plan to the host's delivery", async () => {
    const saveFiles = vi.fn<SaveFiles>().mockResolvedValue({ failed: [] });
    const missed = await saveWholeOutput(field, full, { baseName: "report", saveFiles });
    expect(missed).toEqual([]);
    const [files] = saveFiles.mock.calls[0]!;
    expect(files.map((file) => file.name)).toEqual(["report.json"]);
    expect(JSON.parse(files[0]!.text!)).toEqual(full);
  });

  it("names every file the delivery did not hand over", async () => {
    const saveFiles: SaveFiles = (files) =>
      Promise.resolve({ failed: files.map((file) => ({ file })) });
    expect(await saveWholeOutput(field, full, { baseName: "report", saveFiles })).toEqual([
      "report.json",
    ]);
  });
});

describe("downloadDisplayFor", () => {
  it("draws every control on a host that downloads", () => {
    expect(downloadDisplayFor("download")).toEqual({ result: true, files: true });
  });

  it("draws only stored files' buttons on a host that only opens links", () => {
    expect(downloadDisplayFor("open-link")).toEqual({
      result: false,
      files: ["image", "document"],
    });
  });

  it("draws nothing before the host's capabilities are known", () => {
    expect(downloadDisplayFor("unknown")).toEqual({ result: false, files: false });
  });
});
