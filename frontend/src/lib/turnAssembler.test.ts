import { beforeEach, describe, expect, it } from "vitest";
import { TurnAssembler, dropSuperseded, endingFactor, waitMsFor, type Segment } from "./turnAssembler";

// A deterministic clock: timers only fire when the test advances time.
let now = 0;
let timers: { at: number; fn: () => void; id: number }[] = [];
let nextTimerId = 1;
const clock = {
  now: () => now,
  setTimeout: (fn: () => void, ms: number) => { const id = nextTimerId++; timers.push({ at: now + ms, fn, id }); return id; },
  clearTimeout: (id: unknown) => { timers = timers.filter(t => t.id !== id); },
};
function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const next = timers[0];
    if (!next || next.at > end) break;
    timers.shift();
    now = next.at;
    next.fn();
  }
  now = end;
}

type Event = { kind: "start" | "update" | "flush" | "reopen"; seg?: Segment; text?: string };

function setup(pauseMs = 3000) {
  let turnId = 100;
  const events: Event[] = [];
  const a = new TurnAssembler({
    onStart: (speaker, text) => { events.push({ kind: "start", text: `${speaker}:${text}` }); return ++turnId; },
    onUpdate: seg => events.push({ kind: "update", seg }),
    onFlush: seg => events.push({ kind: "flush", seg }),
    onReopen: seg => events.push({ kind: "reopen", seg }),
  }, () => pauseMs, clock);
  const of = (kind: Event["kind"]) => events.filter(e => e.kind === kind);
  return { a, flushes: () => of("flush").map(e => e.seg!), reopens: () => of("reopen").map(e => e.seg!), starts: () => of("start") };
}

beforeEach(() => { now = 0; timers = []; });

describe("slow speakers", () => {
  it("joins fragments split by pauses into one question, sent once", () => {
    const { a, flushes } = setup(3000);
    a.final("interviewer", "Tell me about");
    advance(2500); a.final("interviewer", "a time you led a team");
    advance(2500); a.final("interviewer", "through a difficult deadline?");
    expect(flushes()).toHaveLength(0);
    advance(3000);
    expect(flushes().map(s => s.text)).toEqual(["Tell me about a time you led a team through a difficult deadline?"]);
  });

  it("answers a clear question sooner (0.6 × pause)", () => {
    const { a, flushes } = setup(3000);
    a.final("interviewer", "How would you design a rate limiter for an API?");
    advance(1700); expect(flushes()).toHaveLength(0);
    advance(200);  expect(flushes()).toHaveLength(1);
  });

  it("waits longer after an unfinished ending (1.6 × pause)", () => {
    const { a, flushes } = setup(3000);
    a.final("interviewer", "I want you to walk me through the architecture and");
    advance(4700); expect(flushes()).toHaveLength(0);
    advance(200);  expect(flushes()).toHaveLength(1);
  });
});

describe("turn boundaries", () => {
  it("sends the open segment at once when the other person speaks", () => {
    const { a, flushes } = setup(5000);
    a.final("interviewer", "What is your biggest weakness?");
    advance(500);
    a.final("user", "Good question, I think");
    expect(flushes().map(s => s.speaker)).toEqual(["interviewer"]);
  });

  it("treats the other person's live words (2+) as the end of the turn", () => {
    const { a, flushes } = setup(5000);
    a.final("interviewer", "Explain eventual consistency to me please.");
    advance(400);
    a.partial("user", "so basically");
    expect(flushes()).toHaveLength(1);
  });
});

describe("holding while the speaker is still talking", () => {
  it("holds while live partials keep arriving", () => {
    const { a, flushes } = setup(1500);
    a.final("interviewer", "Can you describe the project where you");
    for (let i = 0; i < 12; i++) { advance(500); a.partial("interviewer", "used kafka"); }
    expect(flushes()).toHaveLength(0);
    advance(5000);
    expect(flushes()).toHaveLength(1);
  });

  it("releases a segment held by stuck voice activity after 25s", () => {
    const { a, flushes } = setup(1500);
    a.final("interviewer", "Tell me about your background.");
    a.activity("interviewer", true);
    advance(24_000); expect(flushes()).toHaveLength(0);
    advance(3_000);  expect(flushes()).toHaveLength(1);
  });

  it("measures silence from when voice activity stopped (batch providers)", () => {
    const { a, flushes, reopens } = setup(3000);
    a.activity("interviewer", true); advance(2000); a.activity("interviewer", false);
    advance(2700); a.final("interviewer", "So thinking about your last role,");
    advance(1000); a.activity("interviewer", true);
    advance(3000); a.activity("interviewer", false);
    advance(2700);
    expect(flushes()).toHaveLength(0);
    a.final("interviewer", "what would you do differently?");
    advance(3000);
    expect(flushes().map(s => s.text)).toEqual(["So thinking about your last role, what would you do differently?"]);
    expect(reopens()).toHaveLength(0);
  });

  it("gives batch transcription a grace period when speech follows the last text", () => {
    const { a, flushes, reopens } = setup(3000);
    a.final("interviewer", "Let's talk about your last role at the bank.");
    advance(500); a.activity("interviewer", true);
    advance(2000); a.activity("interviewer", false);
    advance(2700);
    expect(flushes()).toHaveLength(0);
    a.final("interviewer", "What was your biggest challenge there?");
    advance(3000);
    expect(flushes()).toHaveLength(1);
    expect(reopens()).toHaveLength(0);
  });

  it("gives no grace to streaming providers (partials seen)", () => {
    const { a, flushes } = setup(3000);
    a.partial("interviewer", "let's talk");
    a.final("interviewer", "Let's talk about your last role at the bank.");
    advance(500); a.activity("interviewer", true); a.partial("interviewer", "um");
    advance(300); a.activity("interviewer", false);
    advance(2600);
    expect(flushes()).toHaveLength(1);
  });
});

describe("speaker carries on after an answer was sent", () => {
  it("reopens the same turn and re-sends the whole question with `replaces`", () => {
    const { a, flushes, reopens } = setup(3000);
    a.final("interviewer", "Why do you want to work here?");
    advance(2000);
    expect(flushes()).toHaveLength(1);
    advance(1500);
    a.final("interviewer", "And why now, at this point in your career?");
    expect(reopens()[0]).toMatchObject({ id: flushes()[0].id, replaces: "Why do you want to work here?" });
    advance(5000);
    expect(flushes()[1]).toMatchObject({
      text: "Why do you want to work here? And why now, at this point in your career?",
      replaces: "Why do you want to work here?",
    });
  });

  it("names the latest sent text when the speaker continues twice", () => {
    const { a, flushes, reopens } = setup(3000);
    a.final("interviewer", "Tell me about a project you're proud of?");
    advance(2000); a.final("interviewer", "Something with real users?");
    advance(2000); a.final("interviewer", "And what you'd change now?");
    advance(3000);
    expect(reopens()).toHaveLength(2);
    expect(reopens()[1].replaces).toBe("Tell me about a project you're proud of? Something with real users?");
    expect(flushes()[flushes().length - 1]?.text).toBe("Tell me about a project you're proud of? Something with real users? And what you'd change now?");
  });

  it("starts a new turn once the continuation window has passed", () => {
    const { a, reopens } = setup(3000);
    a.final("interviewer", "Tell me about yourself.");
    advance(3000 + 4600);
    a.final("interviewer", "Actually, start with your current role.");
    expect(reopens()).toHaveLength(0);
  });

  it("never reopens once the other person has spoken", () => {
    const { a, reopens } = setup(3000);
    a.final("interviewer", "Tell me about yourself.");
    advance(2600); a.final("user", "Sure, I'm a backend engineer.");
    advance(500);  a.final("interviewer", "Great, go on.");
    expect(reopens()).toHaveLength(0);
  });
});

describe("controls", () => {
  it("Respond now includes the live partial and ignores its later final", () => {
    const { a, flushes, starts } = setup(5000);
    a.final("interviewer", "Walk me through");
    expect(a.flushNow("interviewer", "your last system design")).toBe(true);
    expect(flushes().map(s => s.text)).toEqual(["Walk me through your last system design"]);
    a.final("interviewer", "your last system design.");
    expect(starts()).toHaveLength(1);
  });

  it("stop() sends what's open; reset() drops it", () => {
    const sent = setup(5000);
    sent.a.final("user", "I led the migration");
    sent.a.stop();
    expect(sent.flushes()).toHaveLength(1);

    const dropped = setup(5000);
    dropped.a.final("user", "I led the migration");
    dropped.a.reset();
    advance(20_000);
    expect(dropped.flushes()).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("endingFactor reads how finished a sentence sounds", () => {
    expect(endingFactor("How does TCP handle packet loss?")).toBe(0.6);
    expect(endingFactor("we moved to kubernetes so")).toBe(1.6);
    expect(endingFactor("First, we profiled it,")).toBe(1.6);
    expect(endingFactor("Okay.")).toBe(1.3);
  });

  it("waitMsFor stays within bounds", () => {
    expect(waitMsFor("Okay?", 1500)).toBeGreaterThanOrEqual(900);
    expect(waitMsFor("and", 8000)).toBeLessThanOrEqual(12_000);
  });

  describe("dropSuperseded", () => {
    const history = [
      { role: "user", content: "[INTERVIEWER] Tell me more" },
      { role: "assistant", content: "A0" },
      { role: "user", content: "[INTERVIEWER] [§2: Leadership] Why do you want" },
      { role: "assistant", content: "A1" },
    ];
    it("removes the latest exchange when the new question starts with it", () => {
      expect(dropSuperseded(history, "Why do you want  this job?").map(h => h.content))
        .toEqual(["[INTERVIEWER] Tell me more", "A0"]);
    });
    it("leaves unrelated and older questions alone", () => {
      expect(dropSuperseded(history, "Something unrelated")).toHaveLength(4);
      expect(dropSuperseded(history, "Tell me more about X")).toHaveLength(4);
    });
    it("handles a question that has no answer yet", () => {
      expect(dropSuperseded([{ role: "user", content: "[YOU] I led" }], "I led the team")).toHaveLength(0);
    });
  });
});
