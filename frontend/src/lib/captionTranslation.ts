/**
 * Live caption translation (docs/translation.md, T2): a turn is several finished caption lines joined,
 * and each line's translation arrives on its own. A turn's translation is its lines' translations in
 * the order they were spoken; null until at least one has arrived.
 */
export function translatedTurn(transcript: string, translations: Record<string, string>): string | null {
  const found: { at: number; text: string }[] = [];
  for (const [original, translation] of Object.entries(translations)) {
    const at = transcript.indexOf(original);
    if (at >= 0) found.push({ at, text: translation });
  }
  if (!found.length) return null;
  return found.sort((a, b) => a.at - b.at).map(f => f.text).join(" ");
}
