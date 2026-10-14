import { describe, expect, it } from "vitest";
import { resolveView } from "./views";

describe("resolveView", () => {
  it("sends merged screens to their new home (roadmap 1.2)", () => {
    expect(resolveView("confidence")).toEqual({ view: "history", section: "confidence" });
    expect(resolveView("notes")).toEqual({ view: "history", section: "notes" });
  });

  it("sends Meeting Prep to a new plan from an agenda (roadmap 1.5)", () => {
    expect(resolveView("meetingprep")).toEqual({ view: "plans", section: "agenda" });
    expect(resolveView("people")).toEqual({ view: "plans", section: "people" });
  });

  it("sends Profiles and Stories to About you (roadmap 1.6)", () => {
    expect(resolveView("profiles")).toEqual({ view: "about", section: "profile" });
    expect(resolveView("stories")).toEqual({ view: "about", section: "stories" });
  });

  it("sends 'I have a licence key' to Settings -> Your plan", () => {
    expect(resolveView("plan")).toEqual({ view: "settings", section: "plan" });
  });

  it("sends CVs and Documents to the Library (roadmap 1.7)", () => {
    expect(resolveView("cvs")).toEqual({ view: "library", section: "cvs" });
    expect(resolveView("documents")).toEqual({ view: "library", section: "docs" });
  });

  it("sends Transfer to Settings → Your data (roadmap 1.8)", () => {
    expect(resolveView("transfer")).toEqual({ view: "settings", section: "data" });
  });

  it("opens one session in the session hub", () => {
    expect(resolveView("history:open:12")).toEqual({ view: "history", section: "open:12" });
  });

  it("sends unknown ids home instead of a blank page", () => {
    expect(resolveView("no-such-screen")).toEqual({ view: "session" });
    expect(resolveView("")).toEqual({ view: "session" });
  });
});
