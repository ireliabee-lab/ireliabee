import { describe, expect, it } from "vitest";
import { clampHeight } from "./useDragHeight";

describe("dragging a height", () => {
  it("stays within its limits", () => {
    expect(clampHeight(250, 300, 900)).toBe(300);
    expect(clampHeight(1200, 300, 900)).toBe(900);
    expect(clampHeight(512.6, 300, 900)).toBe(513);
  });
  it("on a window smaller than the minimum, the minimum wins", () => {
    expect(clampHeight(500, 420, 380)).toBe(420);
  });
});
