import { useSyncExternalStore } from "react";
import { useLayout } from "skybridge/web";

import { frameHeightFor } from "./frame-height.js";

function subscribeToResize(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const viewportHeight = () => window.innerHeight;

const noViewport = () => 0;

/**
 * The height of the frame the view lays itself out in (`frameHeightFor`),
 * following the viewport as the host resizes the frame: entering fullscreen,
 * leaving it, or the window around it being resized.
 */
export function useFrameHeight(isFullscreen: boolean): number {
  const { maxHeight } = useLayout();
  const viewport = useSyncExternalStore(subscribeToResize, viewportHeight, noViewport);
  return frameHeightFor({ maxHeight, viewportHeight: viewport, isFullscreen });
}
