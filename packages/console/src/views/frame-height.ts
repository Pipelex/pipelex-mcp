/**
 * The height a view lays itself out in when the host has said nothing it can
 * read and the frame's own height says nothing either: an inline frame, which
 * follows the content.
 */
export const FALLBACK_FRAME_HEIGHT_PX = 600;

/**
 * The height, in pixels, of the frame a view lays itself out in: what its root
 * may fill in fullscreen, and what the graph's explicit pixel height is carved
 * from.
 *
 * In fullscreen the frame is the view's own viewport, whatever the host said
 * about it. Skybridge's `maxHeight` carries only the `maxHeight` arm of the
 * MCP Apps `containerDimensions`, never the fixed `height` arm, and on
 * claude.ai's fullscreen frame it is `undefined`, so the views laid themselves
 * out in the fallback, cut off above an empty frame. A fixed height is one the
 * MCP Apps spec tells an app to fill (`100vh`), which is the viewport's height,
 * and a `maxHeight` the host does state still bounds it.
 * Inline the frame follows the content, so the viewport measures the view
 * rather than the room it has, and the host's `maxHeight`, else the fallback,
 * is the bound.
 */
export function frameHeightFor({
  maxHeight,
  viewportHeight,
  isFullscreen,
}: {
  /** `useLayout().maxHeight`: the host's stated bound, when it states one Skybridge reads. */
  maxHeight: number | undefined;
  /** `window.innerHeight`, or 0 where there is no window. */
  viewportHeight: number;
  isFullscreen: boolean;
}): number {
  if (isFullscreen && viewportHeight > 0) {
    return maxHeight === undefined ? viewportHeight : Math.min(maxHeight, viewportHeight);
  }
  return maxHeight ?? FALLBACK_FRAME_HEIGHT_PX;
}
