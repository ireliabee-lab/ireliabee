import { describe, expect, it } from "vitest";
import { countWords, dueIn, mentorEmail, flatDetails, journalDetails, projectText, proposalDetails, replicationDetails, roadmapTheme, scoreLabel, sessionProgress, speakSeconds, supervisorDetails, type Paper, type Project, type Track } from "./research";
import { resolveView } from "./views";

describe("Research Track helpers", () => {
  const now = new Date("2026-09-26T09:00:00Z");

  it("says when a card is due in words", () => {
    expect(dueIn(null, now)).toBe("new");
    expect(dueIn("2026-09-26T08:00:00", now)).toBe("now");
    expect(dueIn("2026-09-26T12:00:00", now)).toBe("in 3 h");
    expect(dueIn("2026-09-27T09:00:00", now)).toBe("in 1 day");
    expect(dueIn("2026-10-02T09:00:00", now)).toBe("in 6 days");
  });

  it("names skill scores and keeps them in range", () => {
    expect(scoreLabel(0)).toBe("Not started");
    expect(scoreLabel(3)).toBe("Independent");
    expect(scoreLabel(9)).toBe("Fluent");
  });

  it("briefs the journal club from the learner's own card, skipping empty fields", () => {
    const p = { question: "Does surprisal predict stuttering?", method: "", result: "Yes, higher surprisal, more stutters.",
      limitation: "", critique: "" } as Paper;
    expect(journalDetails(p)).toBe("Question: Does surprisal predict stuttering?\nResult: Yes, higher surprisal, more stutters.");
  });

  it("briefs the supervisor with the field, project and level", () => {
    const t = { field: "Speech science", brief: "Surprisal and disfluency", level: 1 } as Track;
    expect(supervisorDetails(t)).toBe("Field: Speech science\n\nProject: Surprisal and disfluency\n\nResearch Track level 1");
  });

  it("opens a Research tab from a navigate id", () => {
    expect(resolveView("research")).toEqual({ view: "research" });
    expect(resolveView("research:terms")).toEqual({ view: "research", section: "terms" });
  });

  it("gives the proposal panel the question, hypothesis and each written answer", () => {
    const p = { data: { question: "Does surprisal predict stuttering?", hypothesis: "Yes.", answers: { aim: "Find out.", today: "" } } } as unknown as Project;
    const meta = { heilmeier: [{ id: "aim", question: "What are you trying to do?" }, { id: "today", question: "How is it done today?" }] };
    expect(proposalDetails(p, meta)).toBe("Research question: Does surprisal predict stuttering?\n\nHypothesis: Yes.\n\nWhat are you trying to do?\nFind out.");
  });

  it("counts the words a sprint adds across everything written, but not links", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  one   two\nthree ")).toBe(3);
    const p = { data: { abstract: "Hard words stutter.", code_url: "https://github.com/x", answers: { aim: "Find out why." } } } as unknown as Project;
    expect(countWords(projectText(p))).toBe(6);
  });

  it("gives the panel each written section of a draft under its label", () => {
    const p = { data: { abstract: "We found it.", introduction: "", recommendation: "Accept" } } as unknown as Project;
    const fields = [{ id: "abstract", label: "Abstract" }, { id: "introduction", label: "Introduction" }, { id: "recommendation", label: "Recommendation", options: ["Accept"] }];
    expect(flatDetails(p, fields)).toBe("Abstract:\nWe found it.\n\nRecommendation:\nAccept");
  });

  it("drafts an email to the mentor with their first name, the field and the level", () => {
    const t = { field: "Speech science", level: 2, mentor_name: "Sam Reyes", mentor_email: "eric@example.edu" } as Track;
    const url = mentorEmail(t);
    expect(url.startsWith("mailto:eric%40example.edu?subject=")).toBe(true);
    const body = decodeURIComponent(url.split("&body=")[1]);
    expect(decodeURIComponent(url.split("subject=")[1].split("&")[0])).toBe("My research portfolio: Speech science, level 2");
    expect(body.startsWith("Hello Eric,\n")).toBe(true);
    expect(body).toContain("reached level 2");
  });

  it("gives Reviewer 2 the plan and the milestones done", () => {
    const p = { data: { claim: "Surprisal predicts stuttering.", code_url: "https://github.com/x", steps: { choose: true, data: false } } } as unknown as Project;
    const meta = { steps: [{ id: "choose", label: "Choose the paper" }, { id: "data", label: "Get the data" }] };
    expect(replicationDetails(p, meta)).toBe("Result to reproduce: Surprisal predicts stuttering.\nCode: https://github.com/x\nDone so far: Choose the paper");
  });

  it("paints the roadmap in the app's theme colours", () => {
    const vars: Record<string, string> = { "--base-rgb": " 18, 20, 22", "--raised-rgb": "30, 33, 36", "--ink-rgb": "236, 242, 240",
      "--accent-rgb": "94, 186, 184", "--text": "#e6ebea", "--muted": "#8e9a99" };
    const { tokens, light } = roadmapTheme(name => vars[name] ?? "", false);
    expect(light).toBe(false);
    expect(tokens["--paper"]).toBe("rgb(18, 20, 22)");
    expect(tokens["--card"]).toBe("rgb(30, 33, 36)");
    expect(tokens["--ink"]).toBe("#e6ebea");
    expect(tokens["--ink-2"]).toBe("#8e9a99");
    expect(tokens["--focus"]).toBe("rgb(94, 186, 184)");
    expect(tokens["--shadow"]).toContain("rgba");                 // a theme without its own shadow still gets one
    expect(roadmapTheme(() => "", true).light).toBe(true);
  });

  it("measures today's session by the steps done", () => {
    expect(sessionProgress({ steps: [] })).toEqual({ done: 0, total: 0, pct: 0 });
    const steps = [{ done: true }, { done: true }, { done: false }] as never[];
    expect(sessionProgress({ steps })).toEqual({ done: 2, total: 3, pct: 67 });
  });

  it("times a speaking task by what it asks for", () => {
    expect(speakSeconds("In thirty seconds, tell a peer the one idea.")).toBe(30);
    expect(speakSeconds("In two minutes, explain your question.")).toBe(120);
    expect(speakSeconds("Give a three-minute talk.")).toBe(180);
    expect(speakSeconds("Explain it in 90 seconds.")).toBe(90);
    expect(speakSeconds("Explain it to a friend.")).toBe(60);
  });
});
