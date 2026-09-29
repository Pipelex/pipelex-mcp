import type { SaveFile, SaveFiles } from "@pipelex/mthds-ui/form";
import type { DownloadDisplay } from "@pipelex/mthds-ui/form/react";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { McpAppBridge, useDownload, useOpenExternal } from "skybridge/web";

import { fileRelayLink, storedFileLinkOf } from "./file-relay.js";
import {
  downloadDisplayFor,
  saveThroughHostDownload,
  saveThroughOpenLink,
  storedFileOpener,
} from "./host-save.js";
import type { HostSaveSupport } from "./host-save.js";
import { storedFileReader } from "./stored-file-bytes.js";

/**
 * Whether the host takes a `ui/download-file` request, read from the
 * capabilities it declared when the view connected. Skybridge's `download`
 * checks the same flag and answers `{ isError: true }` without asking, so
 * reading it up front is what lets the panel draw only controls that work.
 */
function useHostSaveSupport(): HostSaveSupport {
  const [support, setSupport] = useState<HostSaveSupport>("unknown");
  useEffect(() => {
    let live = true;
    McpAppBridge.getInstance()
      .getApp()
      .then((app) => {
        if (live) setSupport(app.getHostCapabilities()?.downloadFile ? "download" : "open-link");
      })
      // A failed handshake resolves with no capabilities and lands on
      // open-link above; this covers a bridge that rejects instead.
      .catch(() => {
        if (live) setSupport("open-link");
      });
    return () => {
      live = false;
    };
  }, []);
  return support;
}

/**
 * The results panel's save seam for this host: the delivery the kernel's
 * download controls hand their files to, which of those controls to draw, and
 * `routeFileLinks`, a click-capture handler for a subtree that renders the
 * kernel's plain links to stored files. It takes a click on one over rather
 * than letting the host open the bare presigned link: a host that downloads
 * saves the file, named as its Download button names it when the subtree's
 * `plannedFiles` hold it, and any other host opens it through the relay.
 * `plannedFiles` is asked for only when such a click lands, which keeps
 * planning off the render path.
 */
export function useHostSave(): {
  saveFiles: SaveFiles;
  downloads: DownloadDisplay;
  routeFileLinks: (event: MouseEvent, plannedFiles?: () => readonly SaveFile[]) => void;
} {
  const support = useHostSaveSupport();
  const { download } = useDownload();
  const openExternal = useOpenExternal();
  return useMemo(() => {
    // A stored file opens through the relay page, since ChatGPT breaks a
    // presigned link it opens directly (`file-relay.ts`). `redirectUrl: false`
    // asks ChatGPT not to append the conversation to the relay link, which
    // would otherwise reach the console's access logs; whether it honours the
    // option is unmeasured, and the relay works either way. An MCP Apps host
    // ignores it.
    const openLink = (href: string) =>
      openExternal(fileRelayLink(window.skybridge.serverUrl, href), { redirectUrl: false });
    const saveFiles =
      support === "download"
        ? saveThroughHostDownload(download, storedFileReader())
        : saveThroughOpenLink(openLink);
    const openStoredFile = storedFileOpener(support, saveFiles, openLink);
    return {
      saveFiles,
      downloads: downloadDisplayFor(support),
      routeFileLinks: (event: MouseEvent, plannedFiles?: () => readonly SaveFile[]) => {
        if (event.button !== 0) return;
        const href = storedFileLinkOf(event.target);
        if (href === undefined) return;
        // The host opens a plain link's click itself, so stopping the event
        // here also keeps a host listener that bubbles, and ignores
        // `defaultPrevented`, from opening the bare link beside the relay.
        event.preventDefault();
        event.stopPropagation();
        openStoredFile(href, plannedFiles?.() ?? []);
      },
    };
  }, [support, download, openExternal]);
}
