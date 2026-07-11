/**
 * Slate-day helpers. MLB slates are calendar days in US Eastern time; game
 * start times arrive as UTC ISO strings, so a Saturday night ET game carries
 * a Sunday UTC date. Every "which day is this game" decision goes through
 * the ET calendar day, never a UTC string prefix.
 */

const ET_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function easternCalendarDay(isoUtc: string): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`unparseable timestamp: ${isoUtc}`);
  }
  return ET_DAY_FORMAT.format(date);
}

export function isValidSlateDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Tomorrow's date relative to the current moment, as an ET calendar day. */
export function tomorrowEastern(now: Date): string {
  const todayEt = ET_DAY_FORMAT.format(now);
  const [y, m, d] = todayEt.split('-').map((part) => Number.parseInt(part, 10));
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`unexpected ET day format: ${todayEt}`);
  }
  const noonUtc = Date.UTC(y, m - 1, d, 12);
  const tomorrow = new Date(noonUtc + 24 * 60 * 60 * 1000);
  const yyyy = tomorrow.getUTCFullYear();
  const mm = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
