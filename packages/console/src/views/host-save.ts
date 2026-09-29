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
import { collectStuffFiles, planFileSave, planStuffSave } from "@pipelex/mthds-ui/form";
import type {
  RunField,
  SaveFile,
  SaveFiles,
  SavePlanOptions,
  SaveResult,
} from "@pipelex/mthds-ui/form";
import type { DownloadDisplay } from "@pipelex/mthds-ui/form/react";

import type { ReadStoredFile } from "./stored-file-bytes.js";

/**
 * How many bytes of stored files one download request embeds, since they
 * travel base64 in a single message to the host. The files are read in plan
 * order, and each one past what is left goes as its link.
 */
export const INLINE_SAVE_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * One entry of a `ui/download-file` request, as Skybridge's `useDownload`
 * takes it: a link the host fetches, or content carried inline.
 */
export type HostDownloadContent =
  | { type: "resource_link"; uri: string; name: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

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
 * The request entry for one planned file. Everything the view holds goes
 * embedded, under a `file:` URI whose last segment is the planned name,
 * because an embedded resource has no name field and that segment is what a
 * host names the saved file after: inline content (the JSON copy, an HTML
 * page) as text, and a stored file as the bytes the view read from its fresh
 * link (`blob`, base64), since claude.ai saves embedded content but not a link
 * (`stored-file-bytes.ts`). A stored file the view could not read, or did not
 * for the request's {@link INLINE_SAVE_BUDGET_BYTES}, goes as the link, for a
 * host that fetches one itself.
 */
export function downloadContentOf(file: SaveFile, blob?: string): HostDownloadContent {
  const uri = `file:///${encodeURIComponent(file.name)}`;
  if (file.url === undefined) {
    return { type: "resource", resource: { uri, mimeType: file.mimeType, text: file.text } };
  }
  if (blob !== undefined) {
    return { type: "resource", resource: { uri, mimeType: file.mimeType, blob } };
  }
  return { type: "resource_link", uri: file.url, name: file.name, mimeType: file.mimeType };
}

/**
 * Delivers every planned file in one `ui/download-file` request, so the reader
 * answers one confirmation for a whole result. The host reports one verdict
 * for the request, so a declined request fails every file in it, and so does a
 * request that never got an answer: the bridge rejects on a lost connection or
 * after its timeout, which a reader who leaves the host's confirmation open
 * for a minute reaches. The kernel reads a rejection the same way, but
 * `saveWholeOutput` calls a delivery directly, so each one keeps the kernel's
 * contract of reporting a file rather than throwing. The stored files are read
 * first, one after another, so their bytes can go embedded
 * (`downloadContentOf`) and the frame never holds more than the budget.
 */
export function saveThroughHostDownload(
  download: HostDownload,
  readStoredFile: ReadStoredFile,
): SaveFiles {
  return async (files) => {
    if (files.length === 0) return { failed: [] };
    const failAll = (reason: string): SaveResult => ({
      failed: files.map((file) => ({ file, reason })),
    });
    try {
      const contents: HostDownloadContent[] = [];
      let budget = INLINE_SAVE_BUDGET_BYTES;
      for (const file of files) {
        const read =
          file.url === undefined || budget <= 0
            ? undefined
            : await readStoredFile(file.url, budget);
        if (read !== undefined) budget -= read.byteLength;
        contents.push(downloadContentOf(file, read?.blob));
      }
      const { isError } = await download({ contents });
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
 * Every stored file an output holds, planned the way each one's own Download
 * button plans it: the kernel's reader, the file's place in the output and the
 * output's base name, one file at a time, so a file reached through its link
 * is named as its button names it. The planner walks a payload nothing
 * validated, so a throw plans nothing, and a click then falls back to the
 * link's own name (`linkedSaveFile`).
 */
export function plannedFilesOf(
  field: RunField,
  value: unknown,
  options: SavePlanOptions,
): SaveFile[] {
  try {
    return collectStuffFiles(field, value).flatMap((file) => planFileSave(file, options) ?? []);
  } catch {
    return [];
  }
}

/**
 * The file a click on a stored file's link saves: the planned file the link
 * belongs to, so a click on an image preview or a file's name saves what the
 * Download button beside it saves, under the same name. A link none of
 * `planned` holds, such as a file in the executed graph's data panel, saves
 * under the last segment of its path, which the kernel plans and types as it
 * would a file of that name. `undefined` for a link the kernel's gate refuses.
 */
export function linkedSaveFile(href: string, planned: readonly SaveFile[]): SaveFile | undefined {
  const key = linkKey(href);
  const known = planned.find((file) => file.url !== undefined && linkKey(file.url) === key);
  if (known !== undefined) return known;
  const own = planFileSave(
    { kind: "document", path: "", url: href, filename: lastSegmentOf(href) },
    { baseName: "file" },
  );
  if (own === undefined) return undefined;
  return { ...own, kind: own.mimeType.startsWith("image/") ? "image" : "document" };
}

/** A link as the browser writes it, so the gate's string and a DOM anchor's `href` compare equal. */
function linkKey(href: string): string {
  try {
    return new URL(href).href;
  } catch {
    return href;
  }
}

/** The last segment of a link's path, decoded, or `""` when it has none. */
function lastSegmentOf(href: string): string {
  try {
    return decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

/**
 * What a click on a stored file's link does on this host, given the planned
 * files of the output it landed in. A host that downloads is sent the file's
 * bytes in one download request, named as its Download button names it
 * (`linkedSaveFile`), so the host asks the reader to confirm a named file:
 * opening the link there had claude.ai ask them to confirm the relay page's
 * long link instead (seen on the Dev console on 2026-09-29). The bytes are read
 * before anything is sent, because a file the view cannot read, past
 * {@link INLINE_SAVE_BUDGET_BYTES} or refused, would go as a link, which
 * claude.ai fails at once (`stored-file-bytes.ts`); such a file opens through
 * `openLink`, as it does on a host that only opens links and in a view that
 * does not know its host yet. A request the host declines or leaves unanswered
 * shows nothing, since cancelling its confirmation is a decline too. A click on
 * a link whose last click is still being read or answered is ignored, as the
 * kernel's own button disables itself while it saves: a double-click is two
 * clicks, and each would read the file again and send the host a second
 * request. Never rejects: a click has nowhere to report.
 */
export function storedFileOpener(
  support: HostSaveSupport,
  download: HostDownload,
  readStoredFile: ReadStoredFile,
  openLink: HostOpenLink,
): (href: string, planned: readonly SaveFile[]) => Promise<void> {
  const inFlight = new Set<string>();
  return async (href, planned) => {
    if (inFlight.has(href)) return;
    inFlight.add(href);
    try {
      const file = support === "download" ? linkedSaveFile(href, planned) : undefined;
      const read =
        file?.url === undefined
          ? undefined
          : await readStoredFile(file.url, INLINE_SAVE_BUDGET_BYTES);
      if (file === undefined || read === undefined) {
        openLink(href);
        return;
      }
      await download({ contents: [downloadContentOf(file, read.blob)] });
    } catch {
      // A lost bridge or a host that refused to open the link: nothing to say.
    } finally {
      inFlight.delete(href);
    }
  };
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
