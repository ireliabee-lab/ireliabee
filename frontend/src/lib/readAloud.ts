/**
 * Reading an answer out loud, without losing your place.
 *
 * Two jobs, both pure so they can be tested without a microphone:
 *
 * 1. `breathLines` cuts an answer into short lines a person can say in one
 *    breath. Short lines are what stop someone stumbling: the eye never has to
 *    travel far, and a line break falls where a breath belongs anyway.
 * 2. `readUpTo` says how much of the answer has already been said, by matching
 *    the user's own speech (from the microphone) against the text in front of
 *    them. It is deliberately forgiving — nobody reads an answer word for word,
 *    and speech-to-text mishears — so it skips filler, tolerates a paraphrase,
 *    and simply doesn't move when it can't tell.
 *
 * The rule throughout: never move the marker somewhere it doesn't belong. A
 * marker that races ahead is worse than one that lags, because a reader who
 * has lost their line in front of an interviewer is exactly the person this is
 * meant to help.
 */

/** Sounds, not words: they never count as reading. */
const FILLERS = new Set([
  "um", "umm", "uh", "uhh", "erm", "er", "ah", "ahh", "mm", "mmm", "mhm", "hmm", "huh",
]);

/**
 * Words too common to be evidence of anything. Hearing "the" only counts when
 * "the" is the very next word; otherwise every "the" in a long answer would
 * pull the marker forward through text nobody has said.
 */
const COMMON = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had",
  "has", "have", "he", "her", "his", "i", "in", "is", "it", "its", "me", "my", "not",
  "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "then", "they",
  "this", "to", "was", "we", "were", "with", "you", "your",
]);

/** Said aloud and written down differently — "5" and "five" are the same word. */
const NUMBERS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
};

/** How far ahead a heard word may be found. Enough to step over a few words
 *  that were skipped or misheard; short enough not to jump to the next line. */
const LOOKAHEAD = 6;

/** One word, stripped to what two people saying it would have in common. */
export function plain(word: string): string {
  const bare = word
    .toLowerCase()
    .replace(/[‘’']/g, "")          // don't → dont, it's → its
    .replace(/[^a-z0-9]+/g, "");
  return NUMBERS[bare] ?? bare;
}

/** The words of a line of speech, in order, punctuation and all. */
export function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Two words are the same word, allowing for an ending: manage / managed / manages. */
function same(said: string, written: string): boolean {
  if (!said || !written) return false;
  if (said === written) return true;
  return said.length >= 4 && written.length >= 4
    && (said.startsWith(written) || written.startsWith(said));
}

/**
 * How many of `written` have been said, given everything heard since the answer
 * appeared. Counts from the start every time — speech-to-text rewrites what it
 * thought it heard, so a marker kept incrementally would inherit those mistakes.
 */
export function readUpTo(heard: string, written: string[]): number {
  const words = written.map(plain);
  let at = 0;
  for (const raw of wordsOf(heard)) {
    const said = plain(raw);
    if (!said || FILLERS.has(said)) continue;
    // A common word is only believed where it stands; anything else may be
    // found a few words ahead, which is how a skipped or misheard word is
    // stepped over rather than stopping the whole line.
    const reach = COMMON.has(said) ? 0 : LOOKAHEAD;
    for (let i = at; i <= Math.min(words.length - 1, at + reach); i++) {
      if (same(said, words[i])) { at = i + 1; break; }
    }
  }
  return at;
}

/** A line ends naturally after these: the punctuation is already a breath. */
const BREAK = /[.!?…;:,—–)\]"]$/;
/** Only the ends of sentences: for lines as wide as the window, where a comma is not worth a new line. */
const SENTENCE_END = /[.!?…;:]["')\]]?$/;
/** …but not after an abbreviation or an initial, which only look like an ending. */
const NOT_A_BREAK = /^(?:[A-Z]\.|e\.g\.|i\.e\.|etc\.|Mr\.|Mrs\.|Ms\.|Dr\.|vs\.|approx\.)$/;

/**
 * Cut an answer into lines short enough to say in one breath.
 *
 * Breaks land on punctuation where there is some, and a clause longer than
 * `max` is split evenly rather than leaving one word stranded on its own line.
 * Takes the words already split, so the indices it returns are the caller's.
 */
export function breathLines(words: string[], max = 7, { sentences = false }: { sentences?: boolean } = {}): string[][] {
  const ends = sentences ? SENTENCE_END : BREAK;
  const lines: string[][] = [];
  let clause: string[] = [];
  const flush = () => {
    if (!clause.length) return;
    // Evenly sized pieces: 9 words at 7 a line is 5 + 4, never 7 + 2.
    const pieces = Math.ceil(clause.length / max);
    const size = Math.ceil(clause.length / pieces);
    for (let i = 0; i < clause.length; i += size) lines.push(clause.slice(i, i + size));
    clause = [];
  };
  for (const word of words) {
    clause.push(word);
    if (ends.test(word) && !NOT_A_BREAK.test(word)) flush();
  }
  flush();
  return lines;
}

/**
 * How long the rest of the answer takes to say, in seconds, at the pace the
 * user is actually speaking (their own average, when there is one).
 */
export function secondsLeft(wordsLeft: number, wpm: number | null): number {
  const pace = wpm && wpm >= 60 && wpm <= 260 ? wpm : 140;
  return Math.round((wordsLeft / pace) * 60);
}
