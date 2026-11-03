// The field.duration wire rule: a fixed-length span of time on the wire is an ISO-8601
// duration, and every port answers the same canonical form for it. The rule and its
// cross-port vectors are in fixtures/duration-wire/. Shared by runtime-ts (reads, writes,
// filters, validation) and migrate-ts (a declared @default); generated code carries its own
// copy, held to the same vectors.
//
// Canonical: `[-]PT[<h>H][<m>M][<s>[.<f>]S]` — hours never folded into days, zero components
// left out, zero is `PT0S`, at most six fractional digits (a Postgres interval's precision;
// more are truncated toward zero), one leading `-` for a negative span. A value is held as a
// bigint count of microseconds so a span of any length is exact.

/** The accepted ISO-8601 duration form: an optional sign, `P`, optional days, then an optional
 *  `T` with hours, minutes and seconds in that order. At least one component; no years, months
 *  or weeks (a calendar span has no fixed length). */
export const DURATION_PATTERN = "^[-+]?P(?!$)(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+(\\.\\d{1,9})?S)?)?$";
export const DURATION_RE = new RegExp(DURATION_PATTERN);

const DURATION_PARTS_RE = /^([-+])?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?)?$/;

// The default (`IntervalStyle = postgres`) text of an interval: signed year / mon / day parts,
// then an optionally signed `H:MM:SS[.ffffff]`. Years and months are matched so they can be
// refused by name rather than as unreadable text.
const PG_INTERVAL_RE =
  /^(?:([-+]?\d+) years? ?)?(?:([-+]?\d+) mons? ?)?(?:([-+]?\d+) days? ?)?(?:([-+])?(\d+):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/;

const MICROS_PER_SECOND = 1_000_000n;
const MICROS_PER_MINUTE = 60n * MICROS_PER_SECOND;
const MICROS_PER_HOUR = 60n * MICROS_PER_MINUTE;
const MICROS_PER_DAY = 24n * MICROS_PER_HOUR;

/** The largest magnitude a duration may have: 256204778 hours, the largest whole hour a .NET
 *  TimeSpan holds, so a span any port accepts every port can read back. One microsecond more is
 *  refused on input and on read. */
export const DURATION_MAX_HOURS = 256204778n;
const MAX_MICROS = DURATION_MAX_HOURS * MICROS_PER_HOUR;

function withinBound(micros: bigint): boolean {
  return micros <= MAX_MICROS && micros >= -MAX_MICROS;
}

function bounded(micros: bigint, what: string): bigint {
  if (!withinBound(micros)) {
    throw new Error(`${what} is longer than ${DURATION_MAX_HOURS} hours, the longest field.duration every port can hold`);
  }
  return micros;
}

/** Up to nine fractional-second digits as microseconds, truncated toward zero. */
function fractionMicros(digits: string | undefined): bigint {
  if (digits === undefined || digits.length === 0) return 0n;
  return BigInt(digits.padEnd(6, "0").slice(0, 6));
}

/** The microseconds an accepted ISO-8601 duration spans, or undefined when `text` is not one. */
export function parseDurationLiteral(text: string): bigint | undefined {
  if (!DURATION_RE.test(text)) return undefined;
  const m = DURATION_PARTS_RE.exec(text);
  if (m === null) return undefined;
  const [, sign, d, h, min, s, f] = m;
  const magnitude =
    BigInt(d ?? "0") * MICROS_PER_DAY +
    BigInt(h ?? "0") * MICROS_PER_HOUR +
    BigInt(min ?? "0") * MICROS_PER_MINUTE +
    BigInt(s ?? "0") * MICROS_PER_SECOND +
    fractionMicros(f);
  if (magnitude > MAX_MICROS) return undefined;
  return sign === "-" ? -magnitude : magnitude;
}

/** The canonical wire form of a span of `micros` microseconds. */
export function formatDuration(micros: bigint): string {
  const negative = micros < 0n;
  let rest = negative ? -micros : micros;
  const h = rest / MICROS_PER_HOUR;
  rest %= MICROS_PER_HOUR;
  const m = rest / MICROS_PER_MINUTE;
  rest %= MICROS_PER_MINUTE;
  const s = rest / MICROS_PER_SECOND;
  const frac = rest % MICROS_PER_SECOND;
  let out = "PT";
  if (h > 0n) out += `${h}H`;
  if (m > 0n) out += `${m}M`;
  if (s > 0n || frac > 0n) {
    out += String(s);
    if (frac > 0n) out += "." + String(frac).padStart(6, "0").replace(/0+$/, "");
    out += "S";
  }
  if (out === "PT") return "PT0S";
  return negative ? "-" + out : out;
}

/**
 * A span as the text Postgres reads as interval input AND writes back for it: `[-]HH:MM:SS[.f]`,
 * hours unbounded, no day part. Postgres refuses an ISO-8601 duration with a leading sign
 * (`-PT1M30S`), so a value bound as text, and a declared column default, use this form; an
 * interval written this way reads back in this exact spelling, so a default does not drift.
 */
export function formatPostgresInterval(micros: bigint): string {
  const negative = micros < 0n;
  let rest = negative ? -micros : micros;
  const h = rest / MICROS_PER_HOUR;
  rest %= MICROS_PER_HOUR;
  const m = rest / MICROS_PER_MINUTE;
  rest %= MICROS_PER_MINUTE;
  const s = rest / MICROS_PER_SECOND;
  const frac = rest % MICROS_PER_SECOND;
  const two = (n: bigint): string => String(n).padStart(2, "0");
  let out = `${two(h)}:${two(m)}:${two(s)}`;
  if (frac > 0n) out += "." + String(frac).padStart(6, "0").replace(/0+$/, "");
  return negative && micros !== 0n ? "-" + out : out;
}

/** The canonical form of an accepted ISO-8601 duration, or undefined when `text` is not one. */
export function canonicalDuration(text: string): string | undefined {
  const micros = parseDurationLiteral(text);
  return micros === undefined ? undefined : formatDuration(micros);
}

/** Write side: a caller's value as the canonical string to bind, or undefined when it is not a
 *  duration. Postgres reads the canonical ISO form as interval input; a text column stores it, so
 *  equal spans are equal strings. */
export function parseDurationInput(value: unknown): string | undefined {
  return typeof value === "string" ? canonicalDuration(value) : undefined;
}

/** The microseconds of the default-style text of a Postgres interval. Throws for an interval
 *  with a year or month part (not a fixed length) and for text that is not an interval. */
export function parsePostgresInterval(text: string): bigint {
  const m = text.length === 0 ? null : PG_INTERVAL_RE.exec(text);
  if (m === null) throw new Error(`not a Postgres interval: ${JSON.stringify(text)}`);
  const [, years, months, days, timeSign, h, min, s, f] = m;
  if ((years !== undefined && BigInt(years) !== 0n) || (months !== undefined && BigInt(months) !== 0n)) {
    throw new Error(`the interval ${JSON.stringify(text)} has a year or month part, so it is not a fixed-length field.duration`);
  }
  let time = 0n;
  if (h !== undefined) {
    time = BigInt(h) * MICROS_PER_HOUR + BigInt(min!) * MICROS_PER_MINUTE + BigInt(s!) * MICROS_PER_SECOND + fractionMicros(f);
    if (timeSign === "-") time = -time;
  }
  return bounded(BigInt(days ?? "0") * MICROS_PER_DAY + time, `the interval ${JSON.stringify(text)}`);
}

/** The fields node-postgres's default interval parser (`postgres-interval`) hands back. */
interface PostgresIntervalLike {
  years?: number; months?: number; days?: number;
  hours?: number; minutes?: number; seconds?: number; milliseconds?: number;
}

function isIntervalObject(value: unknown): value is PostgresIntervalLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return ["days", "hours", "minutes", "seconds", "milliseconds", "years", "months"].some((k) => k in value)
    || typeof (value as { toPostgres?: unknown }).toPostgres === "function";
}

function intervalObjectMicros(v: PostgresIntervalLike): bigint {
  if ((v.years ?? 0) !== 0 || (v.months ?? 0) !== 0) {
    throw new Error(`the interval ${JSON.stringify(v)} has a year or month part, so it is not a fixed-length field.duration`);
  }
  const whole = (n: number | undefined): bigint => BigInt(Math.trunc(n ?? 0));
  // postgres-interval carries microseconds as a fractional millisecond count.
  const micros = BigInt(Math.round((v.milliseconds ?? 0) * 1000));
  return bounded(whole(v.days) * MICROS_PER_DAY + whole(v.hours) * MICROS_PER_HOUR
    + whole(v.minutes) * MICROS_PER_MINUTE + whole(v.seconds) * MICROS_PER_SECOND + micros, `the interval ${JSON.stringify(v)}`);
}

/** Read side: what a driver hands back for a duration column — an ISO string (a text column, or
 *  Postgres under `IntervalStyle = iso_8601`), the default Postgres interval text, or a
 *  node-postgres interval object — as the canonical wire string. Throws for anything else. */
export function durationToWire(value: unknown): string {
  if (typeof value === "string") {
    const iso = canonicalDuration(value);
    return iso ?? formatDuration(parsePostgresInterval(value));
  }
  if (isIntervalObject(value)) return formatDuration(intervalObjectMicros(value));
  throw new Error(`not a field.duration value: ${JSON.stringify(value)}`);
}
