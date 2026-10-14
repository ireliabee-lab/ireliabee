import { describe, expect, it } from "vitest";
import { daysUntil, dueFollowUps, dueLabel, dueReminders, fromNoteText, offsetLabel, partsIn, reminderLabel, reminderText, smsPages, textCost, theirTime, timeIn, zoneChoiceLabel, zoneLabel, type Channel, type Reminder } from "./meetings";
import type { CalEvent } from "./calendar";

describe("meeting times", () => {
  const start = "2026-10-02T15:00:00Z";      // 11:00 in New York, 15:00 in Accra

  it("shows a UTC time as the date and clock of a zone", () => {
    expect(partsIn(start, "America/New_York")).toEqual({ date: "2026-10-02", time: "11:00" });
    expect(partsIn(start, "Africa/Accra")).toEqual({ date: "2026-10-02", time: "15:00" });
  });

  it("says the time for the other side, with the day only when it differs", () => {
    expect(theirTime({ start, their_timezone: "America/New_York" }, "Africa/Accra")).toBe("11:00 am in New York");
    expect(theirTime({ start: "2026-10-02T23:30:00Z", their_timezone: "Asia/Tokyo" }, "Africa/Accra"))
      .toBe("8:30 am, Sat 3 Oct in Tokyo");
    expect(theirTime({ start, their_timezone: "Africa/Accra" }, "Africa/Accra")).toBeNull();
    expect(theirTime({ start, their_timezone: null }, "Africa/Accra")).toBeNull();
  });

  it("writes a time with its day", () => {
    expect(timeIn(start, "Africa/Accra")).toBe("3:00 pm, Fri 2 Oct");
  });

  it("labels your own zone as your time, with its offset", () => {
    const oct = new Date("2026-10-02T12:00:00Z");
    expect(offsetLabel("Africa/Accra", oct)).toBe("GMT");
    expect(offsetLabel("America/New_York", oct)).toBe("GMT-4");
    expect(zoneChoiceLabel("Africa/Sao_Tome", "Africa/Sao_Tome")).toBe("Your time (GMT)");
    expect(zoneChoiceLabel("Asia/Tokyo", "Africa/Accra")).toBe("Tokyo (GMT+9)");
  });

  it("reads a zero offset as GMT whatever the engine calls it", () => {
    const real = Intl.DateTimeFormat;
    for (const name of ["GMT", "GMT+0", "UTC", "UTC+00:00", "GMT-0"]) {
      (Intl as any).DateTimeFormat = function () { return { formatToParts: () => [{ type: "timeZoneName", value: name }] }; };
      try { expect(offsetLabel("Africa/Accra", new Date())).toBe("GMT"); } finally { (Intl as any).DateTimeFormat = real; }
    }
  });

  it("names zones by their city", () => {
    expect(zoneLabel("America/Indiana/Indianapolis")).toBe("Indianapolis");
    expect(zoneLabel("America/New_York")).toBe("New York");
    expect(zoneLabel("UTC")).toBe("UTC");
  });
});

describe("reminders and notes", () => {
  it("labels how long before", () => {
    expect([15, 30, 60, 120, 1440, 2880].map(reminderLabel)).toEqual(["15 min", "30 min", "1 h", "2 h", "1 day", "2 days"]);
  });

  it("turns a note into a title and topics", () => {
    expect(fromNoteText("Call with Dr. Patel\n- funding news\n\n• lab rotation\n")).toEqual({
      title: "Call with Dr. Patel", topics: ["funding news", "lab rotation"],
    });
    expect(fromNoteText("")).toEqual({ title: "", topics: [] });
  });
});

describe("which reminders are due", () => {
  const start = Date.parse("2026-10-02T15:00:00Z");
  const own = {
    id: 1, uid: "ireliabee-1", calendar_kind: "ireliabee", start: "2026-10-02T15:00:00Z", end: "2026-10-02T15:25:00Z", all_day: false,
    title: "Call with Dr. Reyes", reminders: [{ minutes: 30, channels: ["desktop"] }, { minutes: 15, channels: ["desktop", "sms"] }],
    topics: ["Research plan"], prep: "Send the plan", join_url: "https://example.zoom.us/j/1", their_timezone: "America/New_York",
  } as unknown as CalEvent;
  const invite = { ...own, uid: "abc", calendar_kind: "google", reminders: null } as unknown as CalEvent;
  const at = (min: number) => start - min * 60_000;
  const none = () => false;

  it("fires your 30 and 15 minute reminders at their moments", () => {
    expect(dueReminders([own], at(31), none)).toEqual([]);
    expect(dueReminders([own], at(30), none).map(d => d.minutes)).toEqual([30]);
    expect(dueReminders([own], at(15), none).map(d => d.minutes)).toEqual([15]);
    expect(dueReminders([own], at(20), none)).toEqual([]);                  // between the two, and too late for 30
  });

  it("never fires the same reminder twice", () => {
    const key = dueReminders([own], at(30), none)[0].key;
    expect(dueReminders([own], at(29), k => k === key)).toEqual([]);
  });

  it("keeps a synced invite's reminder 5 minutes before", () => {
    expect(dueReminders([invite], at(6), none)).toEqual([]);
    expect(dueReminders([invite], at(5), none).map(d => d.minutes)).toEqual([5]);
  });

  it("gives nothing for a meeting that has started, or with no desktop reminder", () => {
    expect(dueReminders([own], start + 2 * 60_000, none)).toEqual([]);
    const smsOnly = { ...own, reminders: [{ minutes: 15, channels: ["sms"] }] } as unknown as CalEvent;
    expect(dueReminders([smsOnly], at(15), none)).toEqual([]);
  });

  it("says when, the other side's time, topics, what to prepare and the link", () => {
    const { title, body } = reminderText(own as never, 15);
    expect(title).toBe("Call with Dr. Reyes");
    expect(body).toMatch(/^In 15 minutes, at /);
    expect(body).toContain("11:00 am in New York");
    expect(body).toContain("Topics: Research plan");
    expect(body).toContain("Prepare: Send the plan");
    expect(body).toContain("Join: https://example.zoom.us/j/1");
  });
});

describe("what text reminders cost", () => {
  const price = { credits_per_text: 0.0015, max_texts_per_reminder: 2, about_pesewas: 4 };
  it("counts a text of up to 160 characters as one, longer as two at most", () => {
    expect(smsPages("x".repeat(160))).toBe(1);
    expect(smsPages("x".repeat(161))).toBe(2);
    expect(smsPages("x".repeat(900))).toBe(2);
  });
  it("adds up only the reminders that are texts", () => {
    const reminders = [{ minutes: 30, channels: ["desktop", "email"] }, { minutes: 15, channels: ["sms"] }] as Reminder[];
    expect(textCost(reminders, price, 2)).toEqual({ texts: 2, credits: 0.003 });
    expect(textCost([{ minutes: 30, channels: ["sms"] }, { minutes: 15, channels: ["sms"] }] as Reminder[], price, 1)).toEqual({ texts: 2, credits: 0.003 });
  });
});

describe("follow-ups", () => {
  const now = new Date(2026, 8, 30, 10, 0);          // Wed 30 Sep, 10:00 on this computer
  const f = (due: string | null, extra = {}) => ({
    id: "a1", text: "Send the research plan", kind: "promised" as const, due, done: false, remind: ["desktop"] as Channel[],
    meeting_id: 3, meeting_title: "Call with Dr. Reyes", meeting_start: "2026-09-25T15:00:00Z", timezone: "Africa/Accra", ...extra,
  });
  it("says when a follow-up is due", () => {
    expect(dueLabel("2026-09-30", now)).toBe("Due today");
    expect(dueLabel("2026-10-01", now)).toBe("Due tomorrow");
    expect(dueLabel("2026-09-28", now)).toBe("Overdue by 2 days");
    expect(daysUntil("2026-10-06", now)).toBe(6);
  });
  it("reminds on the due day from 9, once, and not for one done or without a desktop reminder", () => {
    expect(dueFollowUps([f("2026-09-30")], now, () => false).map(x => x.key)).toEqual(["fu:3:a1:2026-09-30"]);
    expect(dueFollowUps([f("2026-09-30")], new Date(2026, 8, 30, 8, 59), () => false)).toEqual([]);
    expect(dueFollowUps([f("2026-09-30")], now, () => true)).toEqual([]);
    expect(dueFollowUps([f("2026-09-30", { done: true }), f("2026-09-30", { remind: ["email"] }), f(null)], now, () => false)).toEqual([]);
  });
});
