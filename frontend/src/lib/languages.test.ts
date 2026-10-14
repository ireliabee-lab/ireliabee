import { describe, expect, it } from "vitest";
import { LANGUAGES, LANGUAGE_OPTIONS, languageLabel, isEnglish } from "./languages";

// The backend's list, read as text: frontend and backend must offer the same languages.
const backend = import.meta.glob("../../../backend/languages.py", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const languagesPy = Object.values(backend)[0];

describe("session languages (roadmap 3.3)", () => {
  it("every language the app offers is known to the backend", () => {
    for (const l of LANGUAGES) expect(languagesPy, l.id).toContain(`"${l.id}":`);
  });

  it("offers the planned languages, once each", () => {
    const ids = LANGUAGES.map(l => l.id);
    for (const id of ["en", "fr", "es", "pt", "de", "ar", "hi"]) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels languages in their own script, with the English name alongside", () => {
    expect(LANGUAGE_OPTIONS.find(o => o.id === "fr")!.label).toBe("Français — French");
    expect(LANGUAGE_OPTIONS.find(o => o.id === "en-GB")!.label).toBe("English (UK)");
    expect(languageLabel("ar")).toBe("Arabic");
    expect(isEnglish("en-US") && !isEnglish("de")).toBe(true);
  });
});
