// How a view hands a saved result to the host. Pure, so Node tests reach it:
// the host bridges arrive as injected functions, and `use-host-save.ts` wires
// them from Skybridge.
//
// The kernel plans what a download saves (`planStuffSave`: each file named,
// typed, and either the URL its gate admitted or inline text) and asks a
// delivery to hand the files over. Its default delivery saves in the browser
// tab, through an object URL and a clicked link, which a host's sandboxed view
// frame refuses. So the views deliver through the host instead: the MCP Apps
// `ui/download-file` request where the host advertises `downloadFile`, and the
// host's open-link request for a stored file where it does not.
import { planStuffSave } from "@pipelex/mthds-ui/form";
import type {
  RunField,
  SaveFile,
  SaveFiles,
  SavePlanOptions,
  SaveResult,
} from "@pipelex/mthds-ui/form";
import type { DownloadDisplay } from "@pipelex/mthds-ui/form/react";

/**
 * One entry of a `ui/download-file` request, as Skybridge's `useDownload`
 * takes it: a link the host fetches, or content carried inline.
 */
export type HostDownloadContent =
  | { type: "resource_link"; uri: string; name: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; text: string } };

/** Skybridge's `download`: `{ isError: true }` when the host declined or cannot. */
export type HostDownload = (params: {
  contents: HostDownloadContent[];
}) => Promise<{ isError?: boolean }>;

/** Skybridge's `openExternal`: the host opens the link outside the view. */
export type HostOpenLink = (href: string) => void;

/**
 * How the host can take a file, read once from its capabilities: `download`
 * when it advertises `downloadFile`, `open-link` when it does not, and
 * `unknown` until the view has connected.
 */
export type HostSaveSupport = "download" | "open-link" | "unknown";

/**
 * The request entry for one planned file. A stored file goes as a link, which
 * the host fetches itself, since the frame cannot make that cross-origin fetch;
 * the fresh link the panel resolved is what the plan carries. Inline content,
 * the JSON copy and an HTML page, goes embedded, under a `file:` URI whose last
 * segment is the planned name, because an embedded resource has no name field
 * and that segment is what a host names the saved file after.
 */
export function downloadContentOf(file: SaveFile): HostDownloadContent {
  if (file.url !== undefined) {
    return { type: "resource_link", uri: file.url, name: file.name, mimeType: file.mimeType };
  }
  return {
    type: "resource",
    resource: {
      uri: `file:///${encodeURIComponent(file.name)}`,
      mimeType: file.mimeType,
      text: file.text,
    },
  };
}

/**
 * Delivers every planned file in one `ui/download-file` request, so the reader
 * answers one confirmation for a whole result. The host reports one verdict
 * for the request, so a declined request fails every file in it, and so does a
 * request that never got an answer: the bridge rejects on a lost connection or
 * after its timeout, which a reader who leaves the host's confirmation open
 * for a minute reaches. The kernel reads a rejection the same way, but
 * `saveWholeOutput` calls a delivery directly, so each one keeps the kernel's
 * contract of reporting a file rather than throwing.
 */
export function saveThroughHostDownload(download: HostDownload): SaveFiles {
  return async (files) => {
    if (files.length === 0) return { failed: [] };
    const failAll = (reason: string): SaveResult => ({
      failed: files.map((file) => ({ file, reason })),
    });
    try {
      const { isError } = await download({ contents: files.map(downloadContentOf) });
      return isError ? failAll("The host did not save the file") : { failed: [] };
    } catch {
      return failAll("The host did not answer the download request");
    }
  };
}

/**
 * Hands each stored file to the host to open outside the view, for a host
 * that takes no download request. Inline content has no link to open, so it
 * fails, named, and the controls that could only save inline content are not
 * drawn on such a host (`downloadDisplayFor`).
 */
export function saveThroughOpenLink(openLink: HostOpenLink): SaveFiles {
  return (files) => {
    const failed: SaveResult["failed"] = [];
    for (const file of files) {
      if (file.url === undefined) {
        failed.push({ file, reason: "This host cannot save inline content" });
        continue;
      }
      try {
        openLink(file.url);
      } catch {
        failed.push({ file, reason: "The host did not open the link" });
      }
    }
    return Promise.resolve({ failed });
  };
}

/**
 * Saves an output the panel does not render, which the kernel's own Download
 * cannot reach, since that control belongs to the rendered viewer: an output
 * past the view's render budget is shown as a bounded JSON copy. The kernel
 * plans the save from the full value, never the bounded copy on screen, and the
 * host's delivery carries it out. Resolves to the name of every file that did
 * not go out, those the plan found no link for included, so the panel can say
 * which.
 */
export async function saveWholeOutput(
  field: RunField,
  value: unknown,
  options: SavePlanOptions & { saveFiles: SaveFiles },
): Promise<string[]> {
  const { saveFiles, ...planOptions } = options;
  const plan = planStuffSave(field, value, planOptions);
  const { failed } = await saveFiles(plan.files);
  return [
    ...plan.unavailable.map((file) => file.name),
    ...failed.map((failure) => failure.file.name),
  ];
}

/**
 * Which download controls the panel draws for a host. A host that downloads
 * gets the kernel's defaults, the whole-result Download and a button on every
 * file. A host that only opens links gets a button on each stored file kind,
 * and no whole-result Download, since that one always carries the JSON copy,
 * which has no link. Before the view knows, nothing is drawn, so no control
 * appears that would fail.
 */
export function downloadDisplayFor(support: HostSaveSupport): DownloadDisplay {
  switch (support) {
    case "download":
      return { result: true, files: true };
    case "open-link":
      return { result: false, files: ["image", "document"] };
    case "unknown":
      return { result: false, files: false };
  }
}
