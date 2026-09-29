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

  it("keeps a stated maxHeight as the bound in fullscreen", () => {
    expect(frameHeightFor({ maxHeight: 900, viewportHeight: 1100, isFullscreen: true })).toBe(900);
  });

  it("never lays the fullscreen view out taller than its frame", () => {
    expect(frameHeightFor({ maxHeight: 1400, viewportHeight: 1100, isFullscreen: true })).toBe(
      1100,
    );
  });

  it("ignores the viewport inline, where the frame follows the content", () => {
    expect(frameHeightFor({ maxHeight: 500, viewportHeight: 180, isFullscreen: false })).toBe(500);
    expect(frameHeightFor({ maxHeight: undefined, viewportHeight: 180, isFullscreen: false })).toBe(
      FALLBACK_FRAME_HEIGHT_PX,
    );
  });

  it("falls back where there is no viewport to measure", () => {
    expect(frameHeightFor({ maxHeight: undefined, viewportHeight: 0, isFullscreen: true })).toBe(
      FALLBACK_FRAME_HEIGHT_PX,
    );
    expect(frameHeightFor({ maxHeight: 700, viewportHeight: 0, isFullscreen: true })).toBe(700);
  });
});
