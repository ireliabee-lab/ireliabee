import { describe, expect, it } from "vitest";
import { translatedTurn } from "./captionTranslation";

describe("translatedTurn", () => {
  it("joins a turn's line translations in spoken order", () => {
    const tr = { "Parlez-moi de vous.": "Tell me about yourself.", "Bonjour.": "Hello." };
    expect(translatedTurn("Bonjour. Parlez-moi de vous.", tr)).toBe("Hello. Tell me about yourself.");
  });
  it("is null until a translation for the turn has arrived", () => {
    expect(translatedTurn("Bonjour.", {})).toBeNull();
    expect(translatedTurn("Bonjour.", { "Autre chose.": "Something else." })).toBeNull();
  });
});
