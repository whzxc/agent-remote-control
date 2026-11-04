import type { Locale } from "../i18nMessage";

const units: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]];

/** Compact relative time for observation timestamps. Under a minute reads justNow; invalid input returns an empty string. */
export function relativeTime(value: string | null | undefined, now: number, locale: Locale, justNow: string) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return "";
  const delta = time - now;
  if (Math.abs(delta) < 60_000) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  for (const [unit, size] of units) if (Math.abs(delta) >= size || unit === "minute") return format.format(Math.round(delta / size), unit);
  return "";
}

/** Local calendar day key, used to group journal rows under Today, Yesterday or a date. */
export function dayKey(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : "";
}
