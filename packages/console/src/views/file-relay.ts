// How a view hands a stored file's link to a host that opens it outside the
// view. Pure, so Node tests reach it.
//
// A stored file's link is presigned, and its signature covers every query
// parameter. ChatGPT appends `redirectUrl=<the conversation>` to a link a view
// opens, although the console declares no `redirect_domains`, and it does so
// for a click on a plain link in the view as well as for `openExternal`
// (measured on the Dev console on 2026-09-28: a file's download button, its
// image preview and its name all opened the link with the parameter added), and
// S3 then answers SignatureDoesNotMatch. So a link to an app bucket goes
// through `open-file.html`, a static page the views ship with: the link rides
// percent-encoded in its fragment, where no appended parameter reaches it and
// no server logs it, and the page replaces itself with it.
import { RUN_OUTPUT_SOURCES } from "../hosted/app-buckets.js";

/** The relay page, served from the views' assets: `packages/console/public/open-file.html`. */
export const FILE_RELAY_PAGE = "open-file.html";

/** Whether `href` points to an app bucket, where every stored file's fresh link points. */
export function isStoredFileLink(href: string): boolean {
  // `new URL` rather than `URL.parse`, which Safari before 18 lacks.
  try {
    return RUN_OUTPUT_SOURCES.includes(new URL(href).origin);
  } catch {
    return false;
  }
}

/**
 * The link to hand the host for `href`: the relay page carrying it when it
 * points to an app bucket, and `href` itself otherwise, since a link that is
 * not presigned survives an appended parameter. `serverUrl` is the console's
 * base, `window.skybridge.serverUrl`, under which the views' assets are served.
 */
export function fileRelayLink(serverUrl: string, href: string): string {
  if (!isStoredFileLink(href)) return href;
  return `${serverUrl}/assets/${FILE_RELAY_PAGE}#${encodeURIComponent(href)}`;
}

/**
 * The stored file a click in a view would open, when the click lands in a
 * plain link to one: the kernel wraps each image preview, and names each file,
 * with an `<a target="_blank">` to the file's presigned link, which a host
 * opens with the same damage as `openExternal`. The views take such a click
 * over (`useHostSave().routeFileLinks`): a host that downloads saves the file,
 * and any other opens it through the relay.
 * Duck-typed on `closest`, so Node tests reach it without a DOM.
 */
export function storedFileLinkOf(target: unknown): string | undefined {
  if (typeof target !== "object" || target === null || !("closest" in target)) return undefined;
  const { closest } = target;
  if (typeof closest !== "function") return undefined;
  const anchor: unknown = closest.call(target, "a[href]");
  if (typeof anchor !== "object" || anchor === null || !("href" in anchor)) return undefined;
  const { href } = anchor;
  return typeof href === "string" && isStoredFileLink(href) ? href : undefined;
}
