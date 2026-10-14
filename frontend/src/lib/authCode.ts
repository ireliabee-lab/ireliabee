/**
 * The one-time sign-in code, as it is typed.
 *
 * The service makes it from Crockford's base32 (digits and letters without I,
 * L, O and U), twelve characters, shown in groups of four
 * (website/functions/_shared/auth.js). The field follows the same rules, so
 * what is on the screen is always something the service can accept: letters
 * are upper case, I and L are read as the digit one and O as zero (as the
 * service reads them), anything else is dropped, a dash goes after every
 * four, and nothing past the twelfth character is taken.
 */
export const AUTH_CODE_LENGTH = 12;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The code's characters alone, folded the way the service folds them. */
export function cleanCode(raw: string): string {
  let out = "";
  for (const ch of raw.toUpperCase()) {
    const c = ch === "I" || ch === "L" ? "1" : ch === "O" ? "0" : ch;
    if (ALPHABET.includes(c)) out += c;
  }
  return out.slice(0, AUTH_CODE_LENGTH);
}

/** In groups of four: ABCD-EFGH-JKMN. */
export function formatCode(clean: string): string {
  return clean.replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * The next value and caret after an edit.
 *
 * `raw` is what the field holds now, `caret` where the cursor is in it, and
 * `previous` what it held before. The caret stays after the same character it
 * was after, so an edit in the middle is not thrown to the end. Deleting a
 * dash alone would change nothing (it comes straight back), so it takes the
 * character before it too, which is what the backspace was reaching for.
 */
export function editCode(raw: string, caret: number, previous: string): { value: string; caret: number } {
  let before = cleanCode(raw.slice(0, caret)).length;
  let clean = cleanCode(raw);
  const onlyADash = raw.length < previous.length && clean === cleanCode(previous);
  if (onlyADash && before > 0) {
    clean = clean.slice(0, before - 1) + clean.slice(before);
    before -= 1;
  }
  before = Math.min(before, clean.length);
  const value = formatCode(clean);
  return { value, caret: before === 0 ? 0 : before + Math.floor((before - 1) / 4) };
}

/** Every character of the code is there. */
export const codeComplete = (value: string) => cleanCode(value).length === AUTH_CODE_LENGTH;
