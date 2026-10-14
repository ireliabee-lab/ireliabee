import { describe, expect, it } from "vitest";
import { engineTip, shortModel, swapped } from "./engine";

describe("Naming a model in the space of a few words", () => {
  it("shortens the models this app actually runs", () => {
    expect(shortModel("claude-haiku-4-5")).toBe("haiku 4.5");
    expect(shortModel("claude-sonnet-4-5")).toBe("sonnet 4.5");
    expect(shortModel("general-nova-3")).toBe("nova-3");      // what Deepgram calls itself
    expect(shortModel("nova-3")).toBe("nova-3");
    expect(shortModel("whisper-large-v3-turbo")).toBe("whisper v3 turbo");
  });

  it("drops the vendor prefix the relay sends back", () => {
    expect(shortModel("openai/gpt-oss-120b")).toBe("gpt-oss 120b");
    expect(shortModel("models/gemini-2.0-flash")).toBe("gemini-2.0-flash");
  });

  it("drops a date stamp without losing the model", () => {
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
  });

  it("never invents a name it was not given", () => {
    expect(shortModel("some-new-model-9")).toBe("some-new-model-9");
    expect(shortModel("")).toBe("");
  });
});

describe("Noticing the service chose something else", () => {
  it("is the whole point: asked for one, served another", () => {
    expect(swapped({ model: "claude-haiku-4-5", asked: "deepseek-chat" })).toBe(true);
  });

  it("says nothing when the request was honoured", () => {
    expect(swapped({ model: "claude-haiku-4-5", asked: "claude-haiku-4-5" })).toBe(false);
  });

  it("does not call a longer spelling of the same model a swap", () => {
    // The relay answers with the dated name of the model that was asked for.
    expect(swapped({ model: "claude-haiku-4-5-20251001", asked: "claude-haiku-4-5" })).toBe(false);
  });

  it("claims nothing before anything has run", () => {
    expect(swapped({ model: "", asked: "claude-haiku-4-5" })).toBe(false);
    expect(swapped({ model: "claude-haiku-4-5" })).toBe(false);
  });
});

describe("What the mark says when you look at it", () => {
  it("names both halves", () => {
    const tip = engineTip(
      { model: "general-nova-3", confirmed: true },
      { model: "claude-haiku-4-5", confirmed: true, asked: "claude-haiku-4-5" },
      true,
    );
    expect(tip).toContain("Hearing: nova-3");
    expect(tip).toContain("Answering: haiku 4.5");
    expect(tip).not.toContain("assumed");
  });

  it("admits when a name is only what was asked for", () => {
    const tip = engineTip({ model: "nova-3", confirmed: false }, null, true);
    expect(tip).toContain("assumed");
  });

  it("says why a half is empty rather than leaving a gap", () => {
    // What the owner asked on seeing only one name: the transcriber was
    // missing because nothing was listening, and nothing said so.
    const tip = engineTip(null, { model: "deepseek-flash", confirmed: true });
    expect(tip).toContain("Hearing: nothing yet");
    expect(tip).toContain("start listening");
  });

  it("puts a transcriber that has stopped in the past tense", () => {
    // It really did hear this session — worth keeping — but it is not
    // running now, and saying "Hearing" would be the old lie in a new place.
    const tip = engineTip({ model: "nova-3", confirmed: true }, null, false);
    expect(tip).toContain("Heard by: nova-3");
    expect(tip).toContain("not listening now");
  });

  it("says the answer half is empty before anything has been asked", () => {
    const tip = engineTip({ model: "nova-3", confirmed: true }, null, true);
    expect(tip).toContain("Answering: nothing yet");
  });

  it("says plainly when something else answered", () => {
    const tip = engineTip(null, { model: "claude-haiku-4-5", confirmed: true, asked: "deepseek-chat" });
    expect(tip).toContain("You asked for deepseek-chat");
    expect(tip).toContain("haiku 4.5 answered");
  });

  it("does not claim to know which of the two routers chose", () => {
    // The per-turn routing and the service both pick models; the answer names
    // the model, not the chooser, so the tip must not invent one.
    const tip = engineTip(null, { model: "deepseek-flash", confirmed: true, asked: "deepseek-chat" });
    expect(tip).not.toMatch(/service chose|relay chose|we chose/i);
  });

  it("has something to say before anything has run", () => {
    const tip = engineTip(null, null);
    expect(tip).toContain("Hearing: nothing yet");
    expect(tip).toContain("Answering: nothing yet");
  });
});
