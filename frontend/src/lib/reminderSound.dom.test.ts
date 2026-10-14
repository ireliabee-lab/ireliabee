// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { countWhileOpen, listeningNow, reminderSound, setReminderSound } from "./reminderSound";
import { parseReminder, reminderPayload } from "../components/ReminderWindow";

describe("reminder chime", () => {
  it("is on unless turned off", () => {
    localStorage.removeItem("ireliabee.reminderSound");
    expect(reminderSound()).toBe(true);
    setReminderSound(false);
    expect(reminderSound()).toBe(false);
    setReminderSound(true);
    expect(reminderSound()).toBe(true);
  });

  it("knows when an audio socket is open, until it closes", () => {
    const ws = new EventTarget() as WebSocket;
    expect(listeningNow()).toBe(false);
    countWhileOpen(ws);
    expect(listeningNow()).toBe(true);
    ws.dispatchEvent(new Event("close"));
    expect(listeningNow()).toBe(false);
  });

  it("travels to the reminder window with the meeting, long text left behind", () => {
    const ev = { id: 1, title: "Call", start: "2026-10-02T22:00:00Z", end: "2026-10-02T22:30:00Z", all_day: false, description: "long", notes: "secret" };
    const d = parseReminder(decodeURIComponent(reminderPayload(ev as never, 30, true)));
    expect(d?.sound).toBe(true);
    expect(d?.ev.description).toBe("");
    expect((d?.ev as { notes?: string }).notes).toBeUndefined();
    expect(parseReminder(decodeURIComponent(reminderPayload(ev as never, 30)))?.sound).toBe(false);
  });
});
