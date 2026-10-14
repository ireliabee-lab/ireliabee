import { describe, expect, it } from "vitest";
import { cameraPosition, CAMERA_SIZE } from "./compact";

describe("near-the-camera strip", () => {
  it("docks centred under the top edge of the screen the app is on", () => {
    expect(cameraPosition({ x: 0, y: 0, width: 1920 })).toEqual({ x: (1920 - CAMERA_SIZE.width) / 2, y: 0 });
    // A second monitor to the right, and one placed above the main one.
    expect(cameraPosition({ x: 1920, y: 0, width: 2560 })).toEqual({ x: 1920 + (2560 - CAMERA_SIZE.width) / 2, y: 0 });
    expect(cameraPosition({ x: 0, y: -1080, width: 1920 }, 600)).toEqual({ x: 660, y: -1080 });
  });
});

import { fitsOnScreen } from "./compact";

describe("a compact view reopens where it was left", () => {
  const laptop = { x: 0, y: 0, width: 1920, height: 1080 };
  it("uses the saved size and place when it is still on a connected screen", () => {
    expect(fitsOnScreen({ x: 300, y: 40, width: 700, height: 180 }, [laptop])).toBe(true);
  });
  it("falls back when the screen it was on has been unplugged, or the size makes no sense", () => {
    expect(fitsOnScreen({ x: 2200, y: 40, width: 700, height: 180 }, [laptop])).toBe(false);
    expect(fitsOnScreen({ x: 10, y: 10, width: 50, height: 20 }, [laptop])).toBe(false);
    expect(fitsOnScreen(null, [laptop])).toBe(false);
  });
});

import { nextCompact } from "./compact";

describe("O steps through the views", () => {
  it("goes full, then the overlay, then the strip under the camera, then full again", () => {
    expect(nextCompact(null)).toBe("overlay");
    expect(nextCompact("overlay")).toBe("camera");
    expect(nextCompact("camera")).toBe(null);
  });
});
