import { DomainError } from "./errors";

/**
 * Business time = wall-clock time in the stores' timezone, stored as naive ISO strings
 * ('YYYY-MM-DDTHH:MM:SS'). In memory it is a Date whose UTC fields hold that wall-clock time,
 * so date math and hour slots never depend on the server's timezone (Vercel runs in UTC).
 */
export const TZ = "America/Argentina/Buenos_Aires";
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export function toBusiness(instant: Date): Date {
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}

export const businessNow = (): Date => toBusiness(new Date());

export const iso = (d: Date): string => d.toISOString().slice(0, 19);

export const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

export const startOfDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const startOfHour = (d: Date): Date => new Date(Math.floor(d.getTime() / HOUR) * HOUR);

/** ISO 8601 → business time. Naive values are already business time; values with an offset are converted. */
export function parseTs(value: unknown, campo: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?([zZ]|[+-]\d{2}:?\d{2})?$/.test(value)) {
    throw new DomainError(`${campo}: fecha ISO 8601 inválida`);
  }
  const v = value.replace(" ", "T");
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v);
  const d = hasOffset ? toBusiness(new Date(v)) : new Date((v.length === 10 ? `${v}T00:00:00` : v) + "Z");
  if (Number.isNaN(d.getTime())) throw new DomainError(`${campo}: fecha ISO 8601 inválida`);
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

export const fromIso = (s: string): Date => new Date(s + "Z");
