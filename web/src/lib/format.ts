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

/** Points sur la note du site (sur 100), une décimale : « 5,2 points », « 1,5 point ». */
export function fmtScorePoints(n: number): string {
  const v = Math.abs(n);
  return `${dec1.format(v)} ${v < 2 ? "point" : "points"}`;
}

/** Accord simple : « 1 page », « 3 pages » (sans le nombre). */
export const pl = (n: number, one: string, many: string) => (n > 1 ? many : one);

const clockFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
/** Heure locale d'un instant, précédée de « demain » ou de la date s'il n'est pas aujourd'hui : « demain à 01:00 ». */
export function fmtWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (day(d) === day(now)) return `aujourd'hui à ${clockFmt.format(d)}`;
  if (day(d) === day(tomorrow)) return `demain à ${clockFmt.format(d)}`;
  return `le ${dateFmt.format(d)} à ${clockFmt.format(d)}`;
}
export const fmtClock = (iso: string) => clockFmt.format(new Date(iso));

/** Montant dans la devise de la propriété Google Analytics ; sans devise connue, le nombre seul. */
export function fmtMoney(n: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);
    } catch {
      /* code de devise inconnu du navigateur : nombre et code */
      return `${int.format(Math.round(n))} ${currency}`;
    }
  }
  return int.format(Math.round(n));
}

const sec = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dec2 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Durée en millisecondes, lisible : « 180 ms », « 2,4 s ». */
export const fmtMs = (ms: number) => (ms < 1000 ? `${int.format(Math.round(ms / 10) * 10)} ms` : `${sec.format(ms / 1000)} s`);
/** Valeur sans unité à deux décimales (stabilité de la mise en page). */
export const fmtDec2 = (n: number) => dec2.format(n);
