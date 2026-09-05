/** Convert a local wall-clock time (YYYY-MM-DD + HH:MM in tz) to a UTC Date, DST-safe. */
export function localToUtc(date: string, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const offset = tzOffsetMs(new Date(guess), tz);
  const first = guess - offset;
  // second pass in case the offset differs at the corrected instant (DST edge)
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

function tzOffsetMs(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - at.getTime();
}

/** Today's date string (YYYY-MM-DD) in tz, optionally shifted by days. */
export function localDate(tz: string, plusDays = 0): string {
  const d = new Date(Date.now() + plusDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function localWeekday(tz: string, date?: string): string {
  const d = date ? new Date(date + "T12:00:00Z") : new Date();
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
}
