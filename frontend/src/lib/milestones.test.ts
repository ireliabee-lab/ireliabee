import { describe, expect, it } from "vitest";
import { calendarWeeks, climbPoints, dayLevel, monthLabels, niceMax } from "./milestones";

const day = (d: string, over: Partial<{ planned: number; done: number; complete: boolean; lessons: number }> = {}) =>
  ({ day: d, planned: 5, done: 0, complete: false, lessons: 0, ...over });

describe("dayLevel", () => {
  it("grades a day from nothing to the whole session", () => {
    expect(dayLevel(undefined)).toBe(0);
    expect(dayLevel(day("2026-09-01"))).toBe(1);
    expect(dayLevel(day("2026-09-01", { done: 1 }))).toBe(2);
    expect(dayLevel(day("2026-09-01", { done: 3 }))).toBe(3);
    expect(dayLevel(day("2026-09-01", { done: 1, lessons: 1 }))).toBe(3);
    expect(dayLevel(day("2026-09-01", { done: 5, complete: true }))).toBe(4);
  });
});

describe("calendarWeeks", () => {
  // 2026-09-26 is a Saturday.
  const a = { today: "2026-09-26", days: [day("2026-09-26", { complete: true, done: 5 }), day("2026-09-21", { done: 2 })] };

  it("lays out Monday-first weeks ending with this one", () => {
    const cols = calendarWeeks(a, 4);
    expect(cols).toHaveLength(4);
    expect(cols.every(c => c.length === 7)).toBe(true);
    expect(cols[3][0].day).toBe("2026-09-21");                  // this week's Monday
    expect(cols[0][0].day).toBe("2026-08-31");
  });

  it("places each day's activity and marks days after today", () => {
    const week = calendarWeeks(a, 1)[0];
    expect(week[0].level).toBe(2);
    expect(week[5]).toMatchObject({ day: "2026-09-26", level: 4, future: false });
    expect(week[6]).toMatchObject({ day: "2026-09-27", future: true });
  });

  it("labels a month once, where it starts", () => {
    const labels = monthLabels(calendarWeeks(a, 8));
    expect(labels.filter(Boolean)).toHaveLength(2);             // August, then September
    expect(labels[0]).not.toBe("");
  });
});

describe("climbPoints", () => {
  it("steps up on each day lessons were finished and runs flat to today", () => {
    const pts = climbPoints({ start: "2026-09-01", today: "2026-09-11",
      climb: [{ day: "2026-08-20", total: 2 }, { day: "2026-09-06", total: 5 }] });
    expect(pts[0]).toEqual({ x: 0, y: 2 });                      // what was done before the window
    expect(pts).toContainEqual({ x: 0.5, y: 5 });
    expect(pts[pts.length - 1]).toEqual({ x: 1, y: 5 });
  });
});

describe("niceMax", () => {
  it("rounds an axis up to a readable ceiling", () => {
    expect(niceMax(0)).toBe(4);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(23)).toBe(25);
    expect(niceMax(41)).toBe(50);
    expect(niceMax(120)).toBe(125);
  });
});
