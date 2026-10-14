import { describe, expect, it } from "vitest";
import { TYPING_GRACE_MS, isTypingTarget, liveKeyAction, nothingToAnswer, planRespond } from "./liveKeys";
import { latestOf } from "./autoAnswer";

const key = (k: string, mods: Record<string, boolean> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });
const idle = { typing: false, sinceTyped: Infinity, hasWaiting: false, pickerOpen: false };

describe("R answers them, Shift+R answers you", () => {
  it("the two keys are two actions", () => {
    expect(liveKeyAction(key("r"), idle)).toBe("respond-them");
    expect(liveKeyAction(key("R", { shiftKey: true }), idle)).toBe("respond-you");
  });

  it("the other keys are unchanged", () => {
    const got = ["y", "l", "a", "c", "x", "p", "t", "o", "e"].map(k => liveKeyAction(key(k), idle));
    expect(got).toEqual(["toggle-mic", "toggle-system", "both", "capture", "context", "plan", "type", "next-view", "camera"]);
    expect(liveKeyAction(key("C", { shiftKey: true }), idle)).toBe("capture-choose");
    expect(liveKeyAction(key("g"), { ...idle, hasWaiting: true })).toBe("answer-waiting");
    expect(liveKeyAction(key("Enter"), { ...idle, hasWaiting: true })).toBe("answer-waiting");
    expect(liveKeyAction(key("Enter"), idle)).toBeNull();
  });
});

describe("what responding to one side answers", () => {
  const w = (id: number, speaker: "user" | "interviewer") => ({ id, speaker, text: `turn ${id}` });
  const none = { open: null, partial: { speaker: "interviewer" as const, text: "" }, waiting: [], typed: "" };

  it("their turn still being spoken is sent now, never yours", () => {
    expect(planRespond("interviewer", { ...none, open: "interviewer" })).toEqual({ kind: "flush", withPartial: false, otherFirst: false });
    // You are mid-sentence: R leaves your words alone and finds nothing of theirs.
    expect(planRespond("interviewer", { ...none, open: "user", partial: { speaker: "user", text: "so I think" } }).kind).toBe("nothing");
  });

  it("your words go only with Shift+R, closing their open turn the ordinary way first", () => {
    expect(planRespond("user", { ...none, open: "interviewer", partial: { speaker: "user", text: "so I think" } }))
      .toEqual({ kind: "flush", withPartial: true, otherFirst: true });
  });

  it("with Auto Answer off, the latest waiting turn from that side — not the latest overall", () => {
    const waiting = [w(1, "interviewer"), w(2, "user")];
    expect(planRespond("interviewer", { ...none, waiting })).toEqual({ kind: "waiting", turn: waiting[0] });
    expect(planRespond("user", { ...none, waiting })).toEqual({ kind: "waiting", turn: waiting[1] });
    expect(latestOf(waiting, "interviewer")?.id).toBe(1);
  });

  it("a turn from that side still being answered is not asked again as a new one", () => {
    // The owner's report: R on a turn stuck answering added a second card.
    expect(planRespond("interviewer", { ...none, answering: ["interviewer"] })).toEqual({ kind: "busy" });
    expect(planRespond("user", { ...none, answering: ["interviewer"] }).kind).toBe("nothing");
    // A failed turn waits again, and is what R answers, ahead of one still answering.
    const waiting = [w(3, "interviewer")];
    expect(planRespond("interviewer", { ...none, waiting, answering: ["interviewer"] })).toEqual({ kind: "waiting", turn: waiting[0] });
    // Typed text is a new turn the user asked for.
    expect(planRespond("interviewer", { ...none, typed: "hi", answering: ["interviewer"] }).kind).toBe("typed");
  });

  it("typed text goes as that side; otherwise a clear toast", () => {
    expect(planRespond("interviewer", { ...none, typed: "What's your notice period?" }).kind).toBe("typed");
    expect(planRespond("user", none).kind).toBe("nothing");
    expect(nothingToAnswer("interviewer", "Interviewer")).toMatch(/^Nothing from interviewer to answer yet/);
    expect(nothingToAnswer("user", "Interviewer")).toMatch(/^Nothing from you/);
  });
});

describe("letters never fire while typing", () => {
  it("every kind of text box counts", () => {
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", getAttribute: (n: string) => (n === "role" ? "textbox" : null) })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("in a box, O and E do nothing to the view", () => {
    for (const k of ["o", "e", "r", "y", "l"]) expect(liveKeyAction(key(k), { ...idle, typing: true })).toBeNull();
  });

  it("submitting a typed turn then typing o or e keeps typing, even if focus was lost", () => {
    // The e2e run: Enter submitted a turn, the screen re-rendered, focus left
    // the box, and "o" / "e" switched to the overlay and the camera strip.
    const justSubmitted = { ...idle, sinceTyped: 120 };
    expect(liveKeyAction(key("o"), justSubmitted)).toBe("keep-typing");
    expect(liveKeyAction(key("e"), justSubmitted)).toBe("keep-typing");
    expect(liveKeyAction(key("o"), { ...idle, sinceTyped: TYPING_GRACE_MS + 1 })).toBe("next-view");
  });

  it("an IME mid-word is never a shortcut; Escape still leaves the box and Ctrl+S still saves", () => {
    expect(liveKeyAction({ ...key("o"), isComposing: true }, idle)).toBeNull();
    expect(liveKeyAction(key("Escape"), { ...idle, typing: true })).toBe("blur");
    expect(liveKeyAction(key("s", { ctrlKey: true }), { ...idle, typing: true })).toBe("save");
  });
});

// Focus after a typed turn, rendered: components/SessionView.dom.test.tsx.
