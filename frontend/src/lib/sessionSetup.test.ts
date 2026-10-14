import { describe, expect, it } from "vitest";
import { draftFromSession, setupOf } from "./sessionSetup";
import type { SessionDraft } from "../components/CreateSessionWizard";

const defaults: SessionDraft = {
  title: "", subtitle: "", tags: [], cvId: null, documentIds: [], peopleIds: [], template: "work-meeting",
  model: "", language: "en", aiInstructions: "", responseTone: "advanced", autoAnswer: false,
};

describe("a saved session opens as it was set up", () => {
  it("takes its coach, language, files, people, instructions and style from the session", () => {
    const d = draftFromSession({
      title: "PhD fit call", mode: "academic-phd", language: "en",
      setup: { cv_id: 1, document_ids: [6], people_ids: [3], ai_instructions: "Keywords.", response_tone: "basic", auto_answer: true },
    }, defaults);
    expect(d).toMatchObject({
      title: "PhD fit call", template: "academic-phd", cvId: 1, documentIds: [6], peopleIds: [3],
      aiInstructions: "Keywords.", responseTone: "basic", autoAnswer: true,
    });
  });

  it("a session from before the setup was kept opens with the defaults, apart from its coach", () => {
    const d = draftFromSession({ title: "Old", mode: "general", setup: {} }, defaults);
    expect(d).toMatchObject({ template: "general", documentIds: [], responseTone: "advanced", autoAnswer: false });
  });

  it("with nothing read back, it opens with the defaults", () => {
    expect(draftFromSession(null, defaults)).toBe(defaults);
  });

  it("what the session screen saves uses the names the service keeps", () => {
    expect(setupOf({ planId: 5, cvId: null, documentIds: [6], peopleIds: [3], aiInstructions: "x", responseTone: "basic", autoAnswer: true }))
      .toEqual({ plan_id: 5, cv_id: null, document_ids: [6], people_ids: [3], ai_instructions: "x", response_tone: "basic", auto_answer: true });
  });
});

describe("Auto Answer for you", () => {
  const base = { title: "", subtitle: "", tags: [], cvId: null, documentIds: [], peopleIds: [], template: "general",
    model: "", language: "en", aiInstructions: "", responseTone: "advanced", autoAnswer: false };

  it("follows the old single switch for a session saved before there were two", () => {
    expect(draftFromSession({ setup: { auto_answer: true } }, base)).toMatchObject({ autoAnswer: true, autoAnswerYou: true });
    expect(draftFromSession({ setup: { auto_answer: true, auto_answer_you: false } }, base)).toMatchObject({ autoAnswer: true, autoAnswerYou: false });
  });

  it("is saved with the session when set", () => {
    const s = setupOf({ planId: null, cvId: null, documentIds: [], peopleIds: [], aiInstructions: "", responseTone: "basic", autoAnswer: false, autoAnswerYou: true });
    expect(s).toMatchObject({ auto_answer: false, auto_answer_you: true });
  });
});
