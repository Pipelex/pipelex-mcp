/**
 * The height a view lays itself out in when the host states no `maxHeight`
 * Skybridge reads, and the floor of the viewport's reading in fullscreen.
 */
export const FALLBACK_FRAME_HEIGHT_PX = 600;

/**
 * The height, in pixels, of the frame a view lays itself out in: what its root
 * may fill in fullscreen, and what the graph's explicit pixel height is carved
 * from.
 *
 * A `maxHeight` the host states is the room, inline and in fullscreen alike:
 * it is a frame that grows with the content up to that bound, so the viewport
 * measures only how tall the view is now, and a view sized from it would never
 * grow.
 *
 * With none stated, the fullscreen frame is the view's own viewport. Skybridge's
 * `maxHeight` carries only the `maxHeight` arm of the MCP Apps
 * `containerDimensions`, never the fixed `height` arm, and on claude.ai's
 * fullscreen frame it is `undefined`, so the views laid themselves out in the
 * fallback, cut off above an empty frame. A fixed height is one the MCP Apps
 * spec tells an app to fill (`100vh`), which is the viewport's height. The
 * fallback stays the floor, so a host that states nothing and grows its frame
 * with the content still gives the view the room it had before, rather than
 * holding it at the height it was inline.
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
  if (maxHeight !== undefined) {
    return maxHeight;
  }
  return isFullscreen
    ? Math.max(viewportHeight, FALLBACK_FRAME_HEIGHT_PX)
    : FALLBACK_FRAME_HEIGHT_PX;
}
