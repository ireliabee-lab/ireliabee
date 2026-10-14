import { describe, expect, it } from "vitest";
import { callApp, dayLabel, sessionForMeeting, templateFor, timing, withWhom, type CalEvent } from "./calendar";

const at = (min: number, from = Date.parse("2026-09-21T09:00:00Z")) => new Date(from + min * 60000).toISOString();
const NOW = Date.parse("2026-09-21T09:00:00Z");

describe("calendar (roadmap 3.2)", () => {
  it("says where a meeting is relative to now", () => {
    expect(timing({ start: at(4), end: at(34), all_day: false }, NOW)).toEqual({ state: "soon", label: "In 4 min" });
    expect(timing({ start: at(-5), end: at(25), all_day: false }, NOW).state).toBe("now");
    expect(timing({ start: at(-60), end: at(-30), all_day: false }, NOW)).toEqual({ state: "past", label: "Ended" });
    expect(timing({ start: at(90), end: at(120), all_day: false }, NOW)).toEqual({ state: "later", label: "In 1 h 30 min" });
    expect(timing({ start: at(0), end: at(24 * 60), all_day: true }, NOW).label).toBe("All day");
  });

  it("names days relative to today", () => {
    const now = new Date(2026, 8, 21, 10);
    expect(dayLabel(new Date(2026, 8, 21, 18).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 22, 8).toISOString(), now)).toBe("Tomorrow");
  });

  it("picks the live coach that fits the meeting", () => {
    expect(templateFor({ title: "Globex — technical interview", description: "" })).toMatch(/interview|academic|residency|scholarship|thesis/);
    expect(templateFor({ title: "1:1 with Sam", description: "" })).toBe("one-on-one");
    expect(templateFor({ title: "Q3 roadmap review", description: "" })).toBe("work-meeting");
  });

  it("says who a meeting is with in one line", () => {
    const ev = {
      organizer: { name: "Kofi Mensah", email: "kofi@acme.com" },
      attendees: [{ name: "", email: "me@x.com", self: true }, { name: "Ama", email: "ama@acme.com" },
        { name: "", email: "lee@acme.com" }, { name: "Jo", email: "jo@acme.com" }],
    } as unknown as CalEvent;
    expect(withWhom(ev)).toBe("Kofi Mensah · Ama, lee +1");
  });

  it("names the app a join link opens", () => {
    expect(callApp("https://teams.microsoft.com/l/meetup-join/19%3a")).toBe("Teams");
    expect(callApp("https://acme.zoom.us/j/123?pwd=x")).toBe("Zoom");
    expect(callApp("https://meet.google.com/abc-defg-hij")).toBe("Meet");
    expect(callApp("https://example.com/room")).toBe("call");
  });
});

describe("sessionForMeeting", () => {
  const now = Date.parse("2026-10-01T19:00:00Z");
  const s = (id: number, setup: object, updated = "2026-10-01T18:00:00Z", status = "draft") =>
    ({ id, status, updated_at: updated, setup });

  it("opens the session started from this meeting", () => {
    expect(sessionForMeeting([s(1, { plan_id: 6 }), s(2, { event_id: 9 })], { eventId: 9, planId: 6 }, now)?.id).toBe(2);
  });

  it("otherwise opens a recent session made from the meeting's plan", () => {
    expect(sessionForMeeting([s(1, { plan_id: 6 }), s(3, { plan_id: 7 })], { eventId: 9, planId: 6 }, now)?.id).toBe(1);
  });

  it("never reuses an ended session, an old one, or another meeting's", () => {
    const sessions = [
      s(1, { event_id: 9 }, "2026-10-01T18:00:00Z", "ended"),
      s(2, { plan_id: 6 }, "2026-09-28T18:00:00Z"),
      s(3, { plan_id: 6, event_id: 4 }),
    ];
    expect(sessionForMeeting(sessions, { eventId: 9, planId: 6 }, now)).toBeNull();
  });

  it("prefers the most recently used", () => {
    expect(sessionForMeeting([s(1, { event_id: 9 }, "2026-10-01T10:00:00Z"), s(2, { event_id: 9 }, "2026-10-01T18:30:00Z")],
      { eventId: 9 }, now)?.id).toBe(2);
  });
});
