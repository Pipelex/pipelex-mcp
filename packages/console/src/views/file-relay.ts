// How a view hands a stored file's link to a host that opens it outside the
// view. Pure, so Node tests reach it.
//
// A stored file's link is presigned, and its signature covers every query
// parameter. ChatGPT appends `redirectUrl=<the conversation>` to any link a
// view opens, although the console declares no `redirect_domains` and although
// the view passes `redirectUrl: false` (both measured on the Dev console on
// 2026-09-28), and S3 then answers SignatureDoesNotMatch. So a link to an app
// bucket goes through `open-file.html`, a static page the views ship with: the
// link rides percent-encoded in its fragment, where no appended parameter
// reaches it and no server logs it, and the page replaces itself with it.
import { RUN_OUTPUT_SOURCES } from "../hosted/app-buckets.js";

/** The relay page, served from the views' assets: `packages/console/public/open-file.html`. */
export const FILE_RELAY_PAGE = "open-file.html";

/**
 * The link to hand the host for `href`: the relay page carrying it when it
 * points to an app bucket, which is where every stored file's fresh link
 * points, and `href` itself otherwise, since a link that is not presigned
 * survives an appended parameter. `serverUrl` is the console's base,
 * `window.skybridge.serverUrl`, under which the views' assets are served.
 */
export function fileRelayLink(serverUrl: string, href: string): string {
  // `new URL` rather than `URL.parse`, which Safari before 18 lacks.
  let origin: string;
  try {
    origin = new URL(href).origin;
  } catch {
    return href;
  }
  if (!RUN_OUTPUT_SOURCES.includes(origin)) return href;
  return `${serverUrl}/assets/${FILE_RELAY_PAGE}#${encodeURIComponent(href)}`;
}
