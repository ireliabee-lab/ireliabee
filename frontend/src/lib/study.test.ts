import { describe, expect, it } from "vitest";
import { comesBack } from "./study";

const now = new Date("2026-10-08T09:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

describe("comesBack", () => {
  it("says when a review is due in plain words", () => {
    expect(comesBack(at(10 * 60_000), now)).toBe("in 10 minutes");
    expect(comesBack(at(3 * 3_600_000), now)).toBe("in 3 hours");
    expect(comesBack(at(86_400_000), now)).toBe("tomorrow");
    expect(comesBack(at(4 * 86_400_000), now)).toBe("in 4 days");
    expect(comesBack(at(90 * 86_400_000), now)).toBe("in 3 months");
    expect(comesBack(at(-5000), now)).toBe("now");
  });
});
