/** Swappable clock so tests can move time without sleeping. */
export const clock = {
  now: (): Date => new Date(),
};

export function nowIso(): string {
  return clock.now().toISOString();
}

/** Minutes after local midnight in the given timezone. */
export function localMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  return hour * 60 + minute;
}

/** "Tue 28 Oct 2026, 14:32 (Europe/London)" — what the agent sees as "now". */
export function formatLocal(date: Date, timezone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${text} (${timezone})`;
}

/** Local calendar date (YYYY-MM-DD) in the given timezone. */
export function localDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

export function inQuietHours(date: Date, timezone: string, quiet?: { start: number; end: number }): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  const m = localMinutes(date, timezone);
  return quiet.start < quiet.end ? m >= quiet.start && m < quiet.end : m >= quiet.start || m < quiet.end;
}

/** Offset (minutes east of UTC) of a timezone at an instant. */
export function tzOffsetMinutes(date: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map(p => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Parse "2026-10-30T09:00" (or a date, or a full ISO string with offset) as wall-clock time in `timezone`. */
export function parseLocal(value: string, timezone: string): Date {
  const v = value.trim();
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(v)) return new Date(v);
  const [d, t = '00:00'] = v.split(/[T ]/);
  const time = t.length === 5 ? `${t}:00` : t;
  const guess = new Date(`${d}T${time}Z`);
  if (isNaN(guess.getTime())) throw new Error(`Invalid date/time "${value}"`);
  let result = new Date(guess.getTime() - tzOffsetMinutes(guess, timezone) * 60_000);
  const corrected = tzOffsetMinutes(result, timezone);
  result = new Date(guess.getTime() - corrected * 60_000);
  return result;
}

/** "Tue 28 Oct, 10:00" in the given timezone. */
export function formatShort(date: Date, timezone: string, withDay = true): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
