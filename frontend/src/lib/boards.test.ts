import { describe, expect, it } from "vitest";
import { angleTo, freeSpot, nextColour, nextPin, place, turnBy, wrapAngle, GRID, NOTE_H, NOTE_W, ROT_STEP, WALL } from "./boards";
import type { Note } from "./boards";

const note = (over: Partial<Note> = {}): Note => ({
  id: 1, text: "", colour: "yellow", pin: "red",
  x: 0, y: 0, w: NOTE_W, h: NOTE_H, z: 1, rot: 0,
  created_at: "", updated_at: "", ...over,
});

describe("where a dropped note lands", () => {
  it("settles onto the grid when the board snaps", () => {
    expect(place(107, true)).toBe(100);
    expect(place(111, true)).toBe(120);
    expect(place(107, false)).toBe(107);
  });
  it("stays on the wall", () => {
    expect(place(-40, false)).toBe(0);
    expect(place(WALL + 500, false)).toBe(WALL);
    expect(place(-40, true)).toBe(0);
  });
  it("rounds to whole points, so a note never sits on half a pixel", () => {
    expect(place(88.6, false)).toBe(89);
  });
});

describe("a free spot for a new note", () => {
  it("uses the spot asked for when nothing is there", () => {
    expect(freeSpot([], { x: 200, y: 120 })).toEqual({ x: 200, y: 120 });
  });
  it("steps aside when a note is already there", () => {
    const taken = note({ x: 200, y: 120 });
    const spot = freeSpot([taken], { x: 200, y: 120 });
    expect(spot).not.toEqual({ x: 200, y: 120 });
    const overlaps = spot.x < taken.x + taken.w - 8 && spot.x + NOTE_W - 8 > taken.x
      && spot.y < taken.y + taken.h - 8 && spot.y + NOTE_H - 8 > taken.y;
    expect(overlaps).toBe(false);
  });
  it("never goes off the top or left of the wall", () => {
    const spot = freeSpot([note({ x: 0, y: 0 })], { x: 0, y: 0 });
    expect(spot.x).toBeGreaterThanOrEqual(0);
    expect(spot.y).toBeGreaterThanOrEqual(0);
  });
});

describe("turning a note on its pin", () => {
  const centre = { x: 100, y: 100 };
  it("reads which way the pointer lies, with straight up as square", () => {
    expect(angleTo(centre, { x: 100, y: 20 })).toBe(0);
    expect(angleTo(centre, { x: 180, y: 100 })).toBe(90);      // to the right
    expect(angleTo(centre, { x: 20, y: 100 })).toBe(-90);      // to the left
    expect(angleTo(centre, { x: 100, y: 180 })).toBe(180);     // upside down
  });

  it("turns by how far the pointer went, so the handle stays under the cursor", () => {
    // The handle sits at a note's corner, not above its middle: a note that
    // jumped to the pointer's own angle would lurch the moment it was grabbed.
    const grabbed = angleTo(centre, { x: 40, y: 40 });          // top-left corner: -45
    expect(turnBy(0, grabbed, grabbed)).toBe(0);                // grabbed, not yet moved
    expect(turnBy(0, grabbed, grabbed + 30)).toBe(30);          // pointer round by 30
    expect(turnBy(-10, grabbed, grabbed - 20)).toBe(-30);       // already leaning
  });

  it("lands on whole steps when Shift is held, so notes can share a lean", () => {
    expect(turnBy(0, 0, 22, ROT_STEP)).toBe(15);
    expect(turnBy(0, 0, 7, ROT_STEP)).toBe(0);
  });

  it("keeps angles inside one turn", () => {
    expect(wrapAngle(370)).toBe(10);
    expect(wrapAngle(-370)).toBe(-10);
    expect(wrapAngle(540)).toBe(180);
    expect(turnBy(170, 0, 30)).toBe(-160);                     // past upside down, not 200
  });
});

describe("what a new note looks like", () => {
  it("takes the next paper colour, so a board is not all one shade", () => {
    expect(nextColour([])).toBe("yellow");
    expect(nextColour([note({ colour: "yellow" })])).toBe("green");
    expect(nextColour([note({ colour: "lined" })])).toBe("yellow");      // round again
  });
  it("takes the least used pin", () => {
    expect(nextPin([note({ pin: "red" })])).not.toBe("red");
    const many = [note({ pin: "red" }), note({ pin: "blue" }), note({ pin: "green" }),
                  note({ pin: "yellow" }), note({ pin: "pink" })];
    expect(nextPin(many)).toBe("white");
  });
});

describe("the grid the app and the server share", () => {
  it("is the same step", () => {
    expect(GRID).toBe(20);
  });
});
