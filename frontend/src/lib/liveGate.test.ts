import { describe, expect, it } from "vitest";
import { fallbackTitle, isLiveShortcut, lastUsed, meetingForQuickStart, quickStartDraft } from "./liveGate";
import type { SessionDraft } from "../components/CreateSessionWizard";

const NOW = Date.parse("2026-09-28T13:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const ev = (title: string, startMin: number, endMin: number, extra: Record<string, unknown> = {}) =>
  ({ title, start: at(startMin), end: at(endMin), all_day: false, ...extra });

const BASE: SessionDraft = {
  title: "", subtitle: "", tags: [], cvId: null, documentIds: [], peopleIds: [], template: "general",
  model: "claude-haiku-4-5", language: "en", aiInstructions: "", responseTone: "advanced", autoAnswer: false,
};

describe("which meeting a Quick start is named after", () => {
  it("one starting within 15 minutes", () => {
    expect(meetingForQuickStart([ev("Acme final round", 10, 70)], NOW)?.title).toBe("Acme final round");
  });

  it("one already running", () => {
    expect(meetingForQuickStart([ev("Standup", -5, 10)], NOW)?.title).toBe("Standup");
  });

  it("not one further off, finished, all day or untitled", () => {
    expect(meetingForQuickStart([
      ev("Later", 16, 60), ev("Done", -60, -1), ev("Holiday", -600, 600, { all_day: true }), ev("  ", 1, 30),
    ], NOW)).toBeNull();
  });

  it("the one about to start beats one that began long ago and runs on", () => {
    expect(meetingForQuickStart([ev("Workshop", -90, 90), ev("Interview", 5, 50)], NOW)?.title).toBe("Interview");
  });

  it("no calendar is no meeting", () => {
    expect(meetingForQuickStart(null, NOW)).toBeNull();
  });
});

describe("the last session's setup", () => {
  const live = new Set(["general", "tech-interview", "work-meeting"]);

  it("comes from the most recent live session", () => {
    expect(lastUsed([
      { mode: "general", language: "fr", updated_at: "2026-09-20T10:00:00", setup: { cv_id: 2 } },
      { mode: "tech-interview", language: "en-GB", updated_at: "2026-09-27T10:00:00", setup: { cv_id: 5 } },
    ], live)).toEqual({ template: "tech-interview", language: "en-GB", cvId: 5 });
  });

  it("skips practice runs, which are saved as sessions too", () => {
    expect(lastUsed([
      { mode: "tech-interview", tags: ["mock", "tech"], updated_at: "2026-09-28T10:00:00" },
      { mode: "voice-mock", updated_at: "2026-09-28T11:00:00" },
      { mode: "work-meeting", language: "de", updated_at: "2026-09-01T10:00:00" },
    ], live)?.template).toBe("work-meeting");
  });

  it("is nothing when there has been no live session", () => {
    expect(lastUsed([], live)).toBeNull();
    expect(lastUsed([{ mode: "ielts-practice" }], live)).toBeNull();
  });
});

describe("the session Quick start makes", () => {
  const now = new Date("2026-09-28T13:00:00");

  it("uses the last template, language and CV, titled after the meeting", () => {
    const { draft, prefill } = quickStartDraft(BASE, {
      last: { template: "tech-interview", language: "en-GB", cvId: 4 },
      meeting: { title: "Acme final round", plan_id: 9 }, now,
    });
    expect(draft).toMatchObject({ title: "Acme final round", template: "tech-interview", language: "en-GB", cvId: 4, model: BASE.model });
    expect(prefill).toEqual({ title: "Acme final round", planId: 9 });
  });

  it("falls back to the defaults and a dated title", () => {
    const { draft, prefill } = quickStartDraft(BASE, { now });
    expect(draft.template).toBe("general");
    expect(draft.language).toBe("en");
    expect(draft.title).toBe(fallbackTitle(now));
    expect(draft.title).toMatch(/^Session, /);
    expect(prefill.planId).toBeNull();
  });

  it("names itself after a plan waiting from Use in session, and brings it", () => {
    const { draft, prefill } = quickStartDraft(BASE, { plan: { id: 3, title: "Acme — Backend interview" }, now });
    expect(draft.title).toBe("Acme — Backend interview");
    expect(prefill.planId).toBe(3);
  });

  it("a meeting's name wins over a waiting plan's, but the chosen plan comes along", () => {
    const { draft, prefill } = quickStartDraft(BASE, { plan: { id: 3, title: "Plan" }, meeting: { title: "Standup", plan_id: 7 }, now });
    expect(draft.title).toBe("Standup");
    expect(prefill.planId).toBe(3);
  });
});

describe("live keys with no session", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods }) as KeyboardEvent;

  it("the live screen's own keys are recognised", () => {
    for (const k of ["r", "R", "y", "l", "a", "c", "C", "x", "p", "t", "o", "e", "g", "Enter"]) expect(isLiveShortcut(key(k)), k).toBe(true);
    expect(isLiveShortcut(key("s", { ctrlKey: true }))).toBe(true);
  });

  it("app-wide keys are left alone", () => {
    expect(isLiveShortcut(key("n"))).toBe(false);                    // New session
    expect(isLiveShortcut(key("b", { ctrlKey: true }))).toBe(false); // sidebar
    expect(isLiveShortcut(key("r", { altKey: true }))).toBe(false);
    expect(isLiveShortcut(key("Escape"))).toBe(false);
  });
});
