import { describe, expect, it } from "vitest";
import {
  agendaSuggestionsFromEvent, counterpartyOf, fromJobText, fromJobUrl, meetingForNewPlan, mergeSuggestions,
  planSuggestionsFromEvent, planSuggestionsFromJob, sessionSuggestions, suggestTags,
} from "./prefill";

const NOW = Date.parse("2026-09-28T13:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

describe("suggestions never overwrite what was typed", () => {
  const s = (value: string) => ({ value, source: "x" });

  it("fill empty boxes and remember them", () => {
    const out = mergeSuggestions({ title: "", company: "Typed Ltd" }, { title: s("Suggested"), company: s("Other") }, {});
    expect(out.values).toEqual({ title: "Suggested", company: "Typed Ltd" });
    expect(out.placed).toEqual({ title: "Suggested" });
  });

  it("an untouched suggestion follows its source", () => {
    const first = mergeSuggestions({ title: "" }, { title: s("Acme interview") }, {});
    const again = mergeSuggestions(first.values, { title: s("Acme — Backend Engineer interview") }, first.placed);
    expect(again.values.title).toBe("Acme — Backend Engineer interview");
  });

  it("once edited it is theirs, and is never replaced", () => {
    const first = mergeSuggestions({ title: "" }, { title: s("Acme interview") }, {});
    const edited = { title: "Acme interview, round 2" };
    const again = mergeSuggestions(edited, { title: s("Something else") }, first.placed);
    expect(again.values.title).toBe("Acme interview, round 2");
    expect(again.placed).toEqual({});
  });

  it("a suggestion that goes away takes only its own text with it", () => {
    const first = mergeSuggestions({ title: "", company: "" }, { title: s("T"), company: s("C") }, {});
    const gone = mergeSuggestions({ ...first.values, company: "Mine" }, {}, first.placed);
    expect(gone.values).toEqual({ title: "", company: "Mine" });
  });

  it("other fields of the form are left exactly as they were", () => {
    const plan = { title: "", duration_min: 45, sections: [{ title: "Intro" }] };
    const out = mergeSuggestions(plan, { title: s("X") }, {});
    expect(out.values.duration_min).toBe(45);
    expect(out.values.sections).toBe(plan.sections);
  });
});

describe("New session", () => {
  const profiles = [{ target_role: "Designer", is_active: 0 }, { target_role: "Backend engineer", is_active: 1 }];

  it("title from the meeting on next, role from the active profile", () => {
    const out = sessionSuggestions({
      events: [{ title: "Acme final round", start: at(10), end: at(60), all_day: false }], profiles, now: NOW,
    });
    expect(out.title).toEqual({ value: "Acme final round", source: "your calendar" });
    expect(out.subtitle).toEqual({ value: "Backend engineer", source: "your profile" });
  });

  it("the plan's title and company when there is no meeting", () => {
    const out = sessionSuggestions({ profiles, plan: { title: "Acme — Backend interview", counterparty: "Acme" }, now: NOW });
    expect(out.title?.value).toBe("Acme — Backend interview");
    expect(out.subtitle).toEqual({ value: "Backend engineer · Acme", source: "your profile and the plan" });
  });

  it("nothing to go on is no suggestion", () => {
    expect(sessionSuggestions({ now: NOW })).toEqual({});
  });
});

describe("Plans from a job post", () => {
  it("reads the company and role from job-board links", () => {
    expect(fromJobUrl("https://boards.greenhouse.io/monzo/jobs/5723118")).toEqual({ company: "Monzo", role: undefined });
    expect(fromJobUrl("https://jobs.lever.co/octopus-energy/3f2a1b9c-aaaa-bbbb-cccc-1234567890ab")).toMatchObject({ company: "Octopus Energy" });
    expect(fromJobUrl("https://acme.wd3.myworkdayjobs.com/en-US/careers/job/London/Senior-Backend-Engineer_R-12345"))
      .toEqual({ company: "Acme", role: "Senior Backend Engineer" });
    expect(fromJobUrl("https://careers.bbc.co.uk/job/product-designer-4412")).toEqual({ company: "BBC", role: "Product Designer" });
  });

  it("does not take a job site's own name for the company", () => {
    expect(fromJobUrl("https://www.linkedin.com/jobs/view/3999999999").company).toBeUndefined();
    expect(fromJobUrl("https://uk.indeed.com/viewjob?jk=abc").company).toBeUndefined();
  });

  it("ignores what is not a link", () => {
    expect(fromJobUrl("not a url")).toEqual({});
  });

  it("reads labelled or 'Role at Company' job text", () => {
    expect(fromJobText("Job title: Data Analyst\nCompany: Northwind\nWe are…")).toEqual({ role: "Data Analyst", company: "Northwind" });
    expect(fromJobText("Senior Product Manager at Contoso\n\nAbout the role…")).toEqual({ role: "Senior Product Manager", company: "Contoso" });
    expect(fromJobText("Backend Engineer\n\nAbout Fabrikam\nWe build…")).toEqual({ role: "Backend Engineer", company: "Fabrikam" });
  });

  it("does not take a sentence for a title", () => {
    expect(fromJobText("We are looking for someone who loves building great products and working with people.").role).toBeUndefined();
  });

  it("makes the plan's title and company from them", () => {
    expect(planSuggestionsFromJob({ text: "Senior Product Manager at Contoso" })).toEqual({
      title: { value: "Contoso — Senior Product Manager interview", source: "the job description" },
      counterparty: { value: "Contoso", source: "the job description" },
    });
    expect(planSuggestionsFromJob({ url: "", text: "" })).toEqual({});
  });
});

describe("Plans and agendas from a calendar invite", () => {
  const invite = {
    title: "Q4 roadmap review", description: "1. Where we are\n2. What slips\n3. Hiring",
    organizer: { name: "Priya Shah", email: "priya@contoso.com" },
    attendees: [
      { name: "Me", email: "me@example.com", self: true },
      { name: "Tom Reed", email: "tom@contoso.com" },
      { name: "", email: "sam@gmail.com" },
    ],
  };

  it("names the organisation from work email domains, not free mail", () => {
    expect(counterpartyOf(invite)).toBe("Contoso");
    expect(counterpartyOf({ organizer: { name: "Sam", email: "sam@gmail.com" }, attendees: [] })).toBe("Sam");
  });

  it("title and company for a plan", () => {
    const out = planSuggestionsFromEvent(invite);
    expect(out.title?.value).toBe("Q4 roadmap review");
    expect(out.counterparty?.value).toBe("Contoso");
    expect(out.title?.source).toContain("your calendar");
  });

  it("the agenda and who is coming, never yourself", () => {
    const out = agendaSuggestionsFromEvent(invite);
    expect(out.agenda?.value).toContain("2. What slips");
    expect(out.context?.value).toBe("Meeting with Priya Shah, Tom Reed, sam (Contoso)");
    expect(out.context?.value).not.toMatch(/\bMe\b/);
  });

  it("the next meeting without a plan, today", () => {
    const events = [
      { title: "Has a plan", start: at(10), end: at(40), all_day: false, plan_id: 3 },
      { title: "Tomorrow", start: at(60 * 20), end: at(60 * 21), all_day: false, plan_id: null },
      { title: "Soon", start: at(90), end: at(120), all_day: false, plan_id: null },
    ];
    expect(meetingForNewPlan(events, NOW)?.title).toBe("Soon");
  });
});

describe("Stories: tags from the text", () => {
  it("finds what the story is about", () => {
    const tags = suggestTags("Two teammates stopped replying two weeks before the deadline, so I led the team and we shipped on time.");
    expect(tags).toContain("deadline");
    expect(tags).toContain("leadership");
    expect(tags).toContain("teamwork");
  });

  it("leaves out tags it already has, and stops at four", () => {
    const text = "led team deadline bug customers data presented initiative migrated saved 20%";
    expect(suggestTags(text, ["leadership"])).not.toContain("leadership");
    expect(suggestTags(text).length).toBeLessThanOrEqual(4);
  });

  it("nothing for an empty story", () => {
    expect(suggestTags("")).toEqual([]);
  });
});
