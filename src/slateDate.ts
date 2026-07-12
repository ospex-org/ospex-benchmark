/**
 * Slate-date rules — the single home for UTC/ET reasoning.
 *
 * THE RULE: store UTC, reason in ET, always. A slate's date is the US Eastern
 * calendar date of first pitch. A single MLB slate legitimately spans two UTC
 * dates (a 9:40 pm ET game on Jul 11 starts at 01:40 UTC on Jul 12), so a
 * game's slate day must NEVER be derived from the UTC string prefix — only
 * from the instant converted into America/New_York, which also absorbs
 * EST/EDT transitions.
 */

const ET_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The US Eastern calendar day (YYYY-MM-DD) of a UTC instant. */
export function easternCalendarDay(isoUtc: string): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`unparseable timestamp: ${isoUtc}`);
  }
  return ET_DAY_FORMAT.format(date);
}

/** True only for a well-formed, actually-existing calendar day. */
export function isValidSlateDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (y === undefined || m === undefined || d === undefined) return false;
  // Round-trip: Date.UTC rolls impossible days forward (Feb 30 → Mar 2),
  // so the reconstructed components must match the input exactly.
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/** Tomorrow relative to the given instant, as an ET calendar day. */
export function tomorrowEastern(now: Date): string {
  const todayEt = ET_DAY_FORMAT.format(now);
  const [y, m, d] = todayEt.split('-').map((part) => Number.parseInt(part, 10));
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`unexpected ET day format: ${todayEt}`);
  }
  // Noon UTC is DST-safe: adding 24h can never skip or repeat an ET day.
  const noonUtc = Date.UTC(y, m - 1, d, 12);
  const tomorrow = new Date(noonUtc + 24 * 60 * 60 * 1000);
  const yyyy = tomorrow.getUTCFullYear();
  const mm = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
