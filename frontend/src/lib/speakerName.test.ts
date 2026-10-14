import { describe, expect, it } from "vitest";
import { SPEAKER } from "./sourceText";

// From the audit: any "— text: more" line was shown with "text" as a bold speaker name, and
// YouTube's own speaker turns ("— So the question is: what next?") are common.
describe("a tidied transcript's speaker names", () => {
  it("reads names and generic labels", () => {
    expect(SPEAKER.exec("Dr Amara Mensah: Thanks for having me.")?.[1]).toBe("Dr Amara Mensah");
    expect(SPEAKER.exec("Daniel Reeves: Welcome back.")?.[1]).toBe("Daniel Reeves");
    expect(SPEAKER.exec("Speaker 3: Yes.")?.[1]).toBe("Speaker 3");
    expect(SPEAKER.exec("Host: Hello.")?.[1]).toBe("Host");
  });
  it("leaves ordinary sentences with a colon alone", () => {
    expect(SPEAKER.exec("So the question is: what comes next?")).toBeNull();
    expect(SPEAKER.exec("At 10:30 we started.")).toBeNull();
    expect(SPEAKER.exec("the results: mixed")).toBeNull();
  });
});
