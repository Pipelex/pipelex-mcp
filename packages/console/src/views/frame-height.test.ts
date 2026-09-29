import { describe, expect, it } from "vitest";

import { FALLBACK_FRAME_HEIGHT_PX, frameHeightFor } from "./frame-height.js";

describe("frameHeightFor", () => {
  it("fills the fullscreen frame when the host states no maxHeight, as claude.ai does", () => {
    // Skybridge's `maxHeight` is `undefined` there: the view used to lay
    // itself out in the fallback, cut off above an empty frame.
    expect(frameHeightFor({ maxHeight: undefined, viewportHeight: 1100, isFullscreen: true })).toBe(
      1100,
    );
  });

  it("takes a stated maxHeight as the room in fullscreen, whatever the viewport measures", () => {
    // A stated maxHeight is a frame that grows with the content, so the
    // viewport is the view's current height: sizing from it would hold the
    // view at its inline height for good.
    expect(frameHeightFor({ maxHeight: 900, viewportHeight: 470, isFullscreen: true })).toBe(900);
    expect(frameHeightFor({ maxHeight: 900, viewportHeight: 1100, isFullscreen: true })).toBe(900);
  });

  it("never gives a fullscreen view with no stated bound less room than the fallback", () => {
    // A host stating nothing whose frame follows the content measures the
    // view's inline height; the fallback is what such a host got before.
    expect(frameHeightFor({ maxHeight: undefined, viewportHeight: 470, isFullscreen: true })).toBe(
      FALLBACK_FRAME_HEIGHT_PX,
    );
    expect(frameHeightFor({ maxHeight: undefined, viewportHeight: 0, isFullscreen: true })).toBe(
      FALLBACK_FRAME_HEIGHT_PX,
    );
  });

  it("ignores the viewport inline, where the frame follows the content", () => {
    expect(frameHeightFor({ maxHeight: 500, viewportHeight: 180, isFullscreen: false })).toBe(500);
    expect(
      frameHeightFor({ maxHeight: undefined, viewportHeight: 1100, isFullscreen: false }),
    ).toBe(FALLBACK_FRAME_HEIGHT_PX);
  });
});
