/** Mise en forme française des nombres et des dates. */
const int = new Intl.NumberFormat("fr-FR");
const dec1 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat("fr-FR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const dayLongFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const dateFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const rtf = new Intl.RelativeTimeFormat("fr-FR", { numeric: "auto" });

export const fmtInt = (n: number) => int.format(n);
export const fmtDec = (n: number) => dec1.format(n);
export const fmtCompact = (n: number) => (Math.abs(n) < 10_000 ? int.format(n) : compact.format(n));
export const fmtPct = (r: number) => pct.format(r);
export const fmtPosition = (p: number) => dec1.format(p);

/** "2026-11-25" → Date locale à midi (évite les décalages de fuseau). */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12);
}
export const fmtDay = (day: string) => dayFmt.format(parseDay(day));
export const fmtDayLong = (day: string) => dayLongFmt.format(parseDay(day));
export const fmtDate = (iso: string) => dateFmt.format(new Date(iso));
export const fmtDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));
export const fmtPeriod = (p: { start: string; end: string }) => `du ${dateFmt.format(parseDay(p.start))} au ${dateFmt.format(parseDay(p.end))}`;

export function fmtRelative(iso: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "à l'instant";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return `le ${dateFmt.format(new Date(iso))}`;
}

export function fmtDuration(startIso: string, endIso: string): string {
  const s = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

export function plural(n: number, one: string, many: string) {
  return `${fmtInt(n)} ${n > 1 ? many : one}`;
}

/** Retire le protocole et le "www." pour afficher une adresse. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}
