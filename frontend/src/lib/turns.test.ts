import { describe, expect, it } from "vitest";
import { keepPartialReply } from "./turns";

describe("an answer whose stream broke", () => {
  it("keeps the words that arrived, instead of the card vanishing", () => {
    expect(keepPartialReply({ partialReply: "CUES:\n- Lead with the migration" })).toEqual({
      loading: false, partialReply: undefined, superseded: false,
      reply: "CUES:\n- Lead with the migration", incomplete: true,
    });
  });

  it("stops claiming to be coaching", () => {
    expect(keepPartialReply({ partialReply: "half an answer" }).partialReply).toBeUndefined();
  });

  it("marks it, because a kept partial is on screen and nowhere else", () => {
    expect(keepPartialReply({ partialReply: "half" }).incomplete).toBe(true);
  });

  it("keeps a whole earlier answer rather than replacing it with a cut-off retry", () => {
    // Relies on the call site spreading this over the turn: leaving `reply` out
    // is how the answer already there survives.
    const out = keepPartialReply({ reply: "the whole answer", partialReply: "half a" });
    expect(out.reply).toBeUndefined();
    expect(out.incomplete).toBeUndefined();
  });

  it("stops a failed retry sitting dimmed for ever", () => {
    expect(keepPartialReply({ reply: "whole", partialReply: "half" }).superseded).toBe(false);
  });

  it("leaves nothing behind when it broke before the first word", () => {
    const empty = { loading: false, partialReply: undefined, superseded: false };
    expect(keepPartialReply({ partialReply: "   " })).toEqual(empty);
    expect(keepPartialReply({})).toEqual(empty);
  });
});
