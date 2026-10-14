import { describe, expect, it } from "vitest";
import { wordFit } from "./Shelf";

describe("shelf titles", () => {
  it("keeps full size unless a word is too long for the cover's width", () => {
    expect(wordFit("Machine Learning")).toBe("");
    expect(wordFit("Speech-Induced Suppression and Delayed Auditory Feedback")).toBe("longer-word");
    expect(wordFit("Surprisal and Stuttering: Replication")).toBe("long-word");
    expect(wordFit("")).toBe("");
  });
});

// The cover lettering was always cream, unreadable on the Light and Clean white covers.
describe("cover lettering", () => {
  it("is dark on every light cover and stays cream on the dark ones", async () => {
    const { THEMES } = await import("../../lib/book/themes");
    const { lightCover } = await import("./Shelf");
    const light = THEMES.filter(t => lightCover(t.cover.base)).map(t => t.name).sort();
    expect(light).toEqual(["Clean white", "Light"]);
    expect(lightCover("not a colour")).toBe(false);
  });
});
