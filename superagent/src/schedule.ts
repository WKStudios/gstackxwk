/**
 * Schedule strings:
 *   "0 18 * * 5"          cron (5 fields) in the owner's timezone
 *   "2026-10-30T09:00"    one-off, local time (an explicit offset also works)
 *   "every:30"            every N minutes (watchers)
 *   "in:20"               one-off, N minutes from now (resolved to a local datetime when saved)
 */

import { Cron } from 'croner';
import { formatLocal } from './clock';

export class ScheduleError extends Error {}

export function nextRunFor(schedule: string, timezone: string, from: Date): Date | null {
  const s = schedule.trim();
  const every = s.match(/^every:(\d+)$/);
  if (every) {
    const minutes = parseInt(every[1], 10);
    if (minutes < 5) throw new ScheduleError('Checks run at most every 5 minutes');
    return new Date(from.getTime() + minutes * 60_000);
  }
  try {
    const cron = new Cron(s, { timezone, paused: true });
    const next = cron.nextRun(from);
    cron.stop();
    return next ?? null;
  } catch (err) {
    throw new ScheduleError(
      `Couldn't read schedule "${schedule}". Use a 5-field cron like "0 18 * * 5", a local datetime like "2026-10-30T09:00", or "every:30".`,
    );
  }
}

/** Turn "in:N" into a one-off local datetime; anything else passes through. */
export function resolveRelative(schedule: string, timezone: string, now: Date): string {
  const m = schedule.trim().match(/^in:(\d+)$/);
  if (!m) return schedule;
  const minutes = parseInt(m[1], 10);
  if (minutes < 1) throw new ScheduleError('Use at least "in:1"');
  const at = new Date(now.getTime() + minutes * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map(p => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function isOneOff(schedule: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(schedule.trim());
}

export function validateSchedule(schedule: string, timezone: string, from: Date): Date {
  const next = nextRunFor(schedule, timezone, from);
  if (!next) throw new ScheduleError(`"${schedule}" never runs again (is the date in the past?)`);
  const fields = schedule.trim().split(/\s+/);
  if (fields.length === 5 && fields[0].includes('*') && !fields[0].includes('/')) {
    throw new ScheduleError('That cron runs every minute. Pick a minute, e.g. "0 9 * * 1-5".');
  }
  return next;
}

/** "Fri 31 Oct 2026, 18:00 (Europe/London); then Fri 7 Nov…" — so the agent can confirm it in words. */
export function previewRuns(schedule: string, timezone: string, from: Date, count = 3): string {
  const runs: string[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = nextRunFor(schedule, timezone, cursor);
    if (!next) break;
    runs.push(formatLocal(next, timezone));
    if (isOneOff(schedule)) break;
    cursor = new Date(next.getTime() + 1000);
  }
  return runs.join('; then ');
}
