import { describe, expect, it } from "vitest";
import { dictationStep } from "./dictation";

describe("dictationStep", () => {
  it("turns the push-to-talk socket's messages into what the button shows", () => {
    expect(dictationStep({ type: "recording" })).toEqual({ state: "recording" });
    expect(dictationStep({ type: "transcript", text: "  stress does not cause it " })).toEqual({ text: "stress does not cause it", done: true });
    expect(dictationStep({ type: "empty" }).error).toMatch(/Nothing was heard/);
    expect(dictationStep({ type: "error", error: "pro_required" }).error).toMatch(/Pro/);
    expect(dictationStep({ type: "partial", text: "str" })).toEqual({});
  });
});
