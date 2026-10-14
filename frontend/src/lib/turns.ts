/**
 * What is left of a coach answer whose stream broke part-way.
 *
 * Keep the words that did arrive. Half an answer is worth reading in a live
 * interview, and throwing it away did not leave a blank card — the coach pane
 * only shows turns that have something to show, so the card *vanished*
 * mid-sentence, and if it was the only one the screen went back to "Your coach
 * is listening". The one thing that had just failed was the one thing with no
 * trace on screen.
 *
 * What is kept moves out of `partialReply` into `reply`, because `partialReply`
 * is what the card means by "still coaching": left there it would say
 * COACHING… for the rest of the session.
 *
 * And it is marked. The backend writes an answer to the sessions database only
 * once the stream has finished (routers/coach.py returns early on an error), so
 * a kept partial lives on this screen and nowhere else. Reopen the session and
 * it is gone — the card has to say so, or keeping it is just a quieter lie.
 */
export interface KeptPartial {
  loading: false;
  partialReply: undefined;
  superseded: false;
  reply?: string;
  incomplete?: true;
}

export function keepPartialReply(turn: { reply?: string; partialReply?: string }): KeptPartial {
  const kept = (turn.partialReply ?? "").trim();
  const cleared: KeptPartial = { loading: false, partialReply: undefined, superseded: false };
  // An answer already on the card stays: it is whole, and a retry that broke
  // off is not an improvement on it. `superseded` clears either way, so a
  // failed retry stops the card sitting dimmed under "UPDATING — THEY KEPT
  // TALKING" for good.
  if (!kept || turn.reply) return cleared;
  return { ...cleared, reply: kept, incomplete: true };
}
