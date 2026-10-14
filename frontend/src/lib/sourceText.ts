/** How the source panel's Text view lays out a page (components/notebook/PdfSource.tsx). */

/** A page's text as paragraphs (one per line), grouped into bands for the wide layout. */
export function textBands(text: string, bandChars: number): string[][] {
  const bands: string[][] = [];
  let band: string[] = [], size = 0;
  for (const line of text.split("\n").map(l => l.trim()).filter(Boolean)) {
    if (size && size + line.length > bandChars) { bands.push(band); band = []; size = 0; }
    band.push(line); size += line.length;
  }
  if (band.length) bands.push(band);
  return bands;
}

/**
 * A PDF page's text breaks at every printed line; a saved transcript or article, at every
 * paragraph. Printed lines sit together as they do on the page; paragraphs get space between them.
 */
export function printedLines(text: string): boolean {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const average = lines.reduce((n, l) => n + l.length, 0) / lines.length;
  return average < 140;
}

/** A tidied transcript's speaker at the start of a turn: "Dr Amara Mensah: …", "Speaker 2: …". */
export const SPEAKER = /^((?:Dr|Prof|Mr|Mrs|Ms)?\.?\s?(?:[A-Z][\p{L}'’-]*\.?)(?:\s[A-Z][\p{L}'’-]*\.?){0,3}|Host|Guest|Interviewer|Speaker \d{1,2}):\s+(.*)$/u;
