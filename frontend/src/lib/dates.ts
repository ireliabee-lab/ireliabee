/** A time from the backend as a Date. Most rows are naive UTC ("2026-10-07T08:52:28"), but
 *  some carry a zone ("…Z", "…+00:00"); adding a "Z" to those made "Invalid Date". */
export function serverDate(iso: string): Date {
  return new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : iso + "Z");
}
