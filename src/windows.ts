/**
 * No-trade windows: times of day (US Eastern, the same clock as the daily limits) when a bot may not open new trades.
 * Positions already open are still managed (stop loss, take profit) during a window.
 * A window that ends earlier than it starts runs past midnight (for example 22:00 to 01:00).
 */

export interface TimeWindow {
  start: string; // "HH:MM", 24-hour, Eastern
  end: string;
}

export const MAX_WINDOWS = 12;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(s: string): number | null {
  const m = HHMM.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes since midnight, US Eastern, at the given moment. */
export function etMinutesOfDay(now: number, tz = "America/New_York"): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(now));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return g("hour") * 60 + g("minute");
}

/** The window the moment falls inside, or null. */
export function activeWindow(windows: TimeWindow[], now: number): TimeWindow | null {
  if (!windows.length) return null;
  const m = etMinutesOfDay(now);
  for (const w of windows) {
    const s = parseHHMM(w.start);
    const e = parseHHMM(w.end);
    if (s === null || e === null || s === e) continue;
    if (s < e ? m >= s && m < e : m >= s || m < e) return w;
  }
  return null;
}

/** "1:30 PM" style text for a "HH:MM" value. */
export function clock12(hhmm: string): string {
  const n = parseHHMM(hhmm);
  if (n === null) return hhmm;
  const h = Math.floor(n / 60);
  const mm = String(n % 60).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

export function windowText(w: TimeWindow): string {
  return `${clock12(w.start)} to ${clock12(w.end)} Eastern`;
}
