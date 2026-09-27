import type { SaveFiles } from "@pipelex/mthds-ui/form";
import type { DownloadDisplay } from "@pipelex/mthds-ui/form/react";
import { useEffect, useMemo, useState } from "react";
import { McpAppBridge, useDownload, useOpenExternal } from "skybridge/web";

import { downloadDisplayFor, saveThroughHostDownload, saveThroughOpenLink } from "./host-save.js";
import type { HostSaveSupport } from "./host-save.js";

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
 * download controls hand their files to, and which of those controls to draw.
 */
export function useHostSave(): { saveFiles: SaveFiles; downloads: DownloadDisplay } {
  const support = useHostSaveSupport();
  const { download } = useDownload();
  const openExternal = useOpenExternal();
  return useMemo(() => {
    // A stored file's link is presigned, and its signature covers every query
    // parameter. ChatGPT appends `redirectUrl=<the conversation>` to a link it
    // opens unless told not to, whatever `redirect_domains` says, and S3 then
    // answers SignatureDoesNotMatch (measured 2026-09-28). An MCP Apps host
    // ignores the option.
    const openLink = (href: string) => openExternal(href, { redirectUrl: false });
    return {
      saveFiles:
        support === "download" ? saveThroughHostDownload(download) : saveThroughOpenLink(openLink),
      downloads: downloadDisplayFor(support),
    };
  }, [support, download, openExternal]);
}
