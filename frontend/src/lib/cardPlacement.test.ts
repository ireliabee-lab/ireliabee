import { describe, expect, it } from "vitest";
import { placeBeside } from "./cardPlacement";

const host = { width: 1400, height: 900 };

describe("a card beside the selected words", () => {
  it("opens below words near the top, centred on them", () => {
    const p = placeBeside({ left: 900, top: 180, right: 1000, bottom: 200 }, host, 520);
    expect(p).toMatchObject({ side: "below", top: 210, left: 690 });
    expect(p.maxHeight).toBe(900 - 200 - 10 - 8);
  });

  it("opens above words low on the page, and never covers them", () => {
    const p = placeBeside({ left: 300, top: 760, right: 380, bottom: 780 }, host, 520);
    expect(p.side).toBe("above");
    expect(p.bottom).toBe(900 - 760 + 10);                  // its lower edge sits above the words
  });

  it("stays inside the book at the edges", () => {
    expect(placeBeside({ left: 5, top: 100, right: 40, bottom: 120 }, host, 520).left).toBe(8);
    expect(placeBeside({ left: 1380, top: 100, right: 1395, bottom: 120 }, host, 520).left).toBe(1400 - 8 - 520);
  });
});
