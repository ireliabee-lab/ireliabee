import { describe, expect, it } from "vitest";
import { cleanCode, codeComplete, editCode, formatCode } from "./authCode";

/** Type `keys` one at a time at the end, as a person does. */
function typed(keys: string) {
  let value = "";
  for (const k of keys) value = editCode(value + k, value.length + 1, value).value;
  return value;
}

describe("the sign-in code field", () => {
  it("puts a dash after every four characters as they are typed", () => {
    expect(typed("abcd")).toBe("ABCD");
    expect(typed("abcde")).toBe("ABCD-E");
    expect(typed("abcdefghjkmn")).toBe("ABCD-EFGH-JKMN");
  });

  it("takes nothing past the twelfth character", () => {
    expect(typed("abcdefghjkmnpq")).toBe("ABCD-EFGH-JKMN");
    expect(cleanCode("ABCD-EFGH-JKMN-PQRS")).toBe("ABCDEFGHJKMN");
  });

  it("reads look-alikes the way the service does, and drops what can't be in a code", () => {
    expect(cleanCode("il o")).toBe("110");
    expect(cleanCode("ab-cd u!?")).toBe("ABCD");
  });

  it("a pasted code keeps its characters, whatever separated them", () => {
    expect(editCode("abcd efgh.jkmn", 14, "").value).toBe("ABCD-EFGH-JKMN");
  });

  it("backspace on a dash removes the character before it, instead of sticking", () => {
    // "ABCD-E" with the caret after the dash, and the dash deleted.
    expect(editCode("ABCDE", 4, "ABCD-E")).toEqual({ value: "ABCE", caret: 3 });
  });

  it("an edit in the middle keeps the caret where it was", () => {
    // Typing X after "AB" in "ABCD-EFGH".
    expect(editCode("ABXCD-EFGH", 3, "ABCD-EFGH")).toEqual({ value: "ABXC-DEFG-H", caret: 3 });
  });

  it("knows when the whole code is there", () => {
    expect(codeComplete("ABCD-EFGH-JKM")).toBe(false);
    expect(codeComplete("ABCD-EFGH-JKMN")).toBe(true);
    expect(formatCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});
