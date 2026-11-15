/**
 * The agent's working calendar, as rules (no table):
 * one agent, Monday–Saturday, 10:00–18:00 Dubai time, 1-hour viewings, at least 1 hour notice,
 * at most 60 days ahead.
 * Dubai is UTC+4 all year (no daylight saving), so a fixed offset is correct.
 */
export const DUBAI_OFFSET = "+04:00";
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
export const FIRST_START_HOUR = 10;
export const LAST_START_HOUR = 17; // last viewing 17:00–18:00
export const CLOSED_WEEKDAYS = new Set([0]); // Sunday
export const MIN_NOTICE_MS = 60 * 60 * 1000;
export const MAX_DAYS_AHEAD = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Wall-clock parts of an instant in Dubai. */
export function dubaiParts(instant: Date) {
  const d = new Date(instant.getTime() + DUBAI_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),
    weekday: d.getUTCDay(),
    day: d.getUTCDate(),
    month: d.getUTCMonth(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    ms: d.getUTCMilliseconds(),
  };
}

/** "YYYY-MM-DD" + n days. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** All slot start instants on a Dubai date (empty on closed days). */
export function slotStartsOn(date: string): Date[] {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (CLOSED_WEEKDAYS.has(weekday)) return [];
  const starts: Date[] = [];
  for (let hour = FIRST_START_HOUR; hour <= LAST_START_HOUR; hour++) {
    starts.push(new Date(`${date}T${pad(hour)}:00:00${DUBAI_OFFSET}`));
  }
  return starts;
}

/**
 * How a slot is shown to the model: ISO with Dubai offset + a readable label.
 * The label always includes the year, so a booking can never be confirmed for the wrong year.
 */
export function formatSlot(instant: Date) {
  const p = dubaiParts(instant);
  const year = p.date.slice(0, 4);
  return {
    startsAt: `${p.date}T${pad(p.hour)}:${pad(p.minute)}:00${DUBAI_OFFSET}`,
    label: `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month]} ${year}, ${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** Last Dubai date a viewing may be booked on. */
export function lastBookableDate(now: Date): string {
  return dubaiParts(new Date(now.getTime() + MAX_DAYS_AHEAD * DAY_MS)).date;
}

/** null if a viewing can start at `instant`, otherwise the reason it can't (for the model to read). */
export function whyNotBookable(instant: Date, now: Date): string | null {
  const p = dubaiParts(instant);
  if (p.minute !== 0 || p.second !== 0 || p.ms !== 0) {
    return "Viewings start on the hour (e.g. 10:00, 11:00).";
  }
  if (CLOSED_WEEKDAYS.has(p.weekday)) {
    return "The agent does not work on Sundays.";
  }
  if (p.hour < FIRST_START_HOUR || p.hour > LAST_START_HOUR) {
    return `Viewings run from ${FIRST_START_HOUR}:00 to 18:00 Dubai time (last start ${LAST_START_HOUR}:00).`;
  }
  if (instant.getTime() < now.getTime() + MIN_NOTICE_MS) {
    return "That time is in the past or less than 1 hour from now.";
  }
  if (p.date > lastBookableDate(now)) {
    return `Viewings can be booked at most ${MAX_DAYS_AHEAD} days ahead (until ${lastBookableDate(now)}).`;
  }
  return null;
}
