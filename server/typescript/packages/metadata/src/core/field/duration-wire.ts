// The field.duration wire rule: a fixed-length span of time on the wire is an ISO-8601
// duration, and every port answers the same canonical form for it. The rule and its
// cross-port vectors are in fixtures/duration-wire/. Shared by runtime-ts (reads, writes,
// filters, validation) and migrate-ts (a declared @default); generated code carries its own
// copy, held to the same vectors.
//
// Canonical: `[-]PT[<h>H][<m>M][<s>[.<f>]S]` — hours never folded into days, zero components
// left out, zero is `PT0S`, one leading `-` for a negative span. TypeScript holds a value as a
// bigint count of microseconds, so a span of any length is exact and a longer fraction is
// truncated toward zero to six digits (the `precision` vectors' "6" entries).

/** The accepted ISO-8601 duration form: an optional sign, `P`, optional weeks (7 days) and days,
 *  then an optional `T` with hours, minutes and seconds in that order; the seconds may have a
 *  fraction of any length. At least one component; no years or months (a calendar span has no
 *  fixed length). */
export const DURATION_PATTERN = "^[-+]?P(?!$)(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+(\\.\\d+)?S)?)?$";
export const DURATION_RE = new RegExp(DURATION_PATTERN);

const DURATION_PARTS_RE = /^([-+])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?)?$/;

// The default (`IntervalStyle = postgres`) text of an interval: signed year / mon / day parts,
// then an optionally signed `H:MM:SS[.ffffff]`. Years and months are matched so they can be
// refused by name rather than as unreadable text.
const PG_INTERVAL_RE =
  /^(?:([-+]?\d+) years? ?)?(?:([-+]?\d+) mons? ?)?(?:([-+]?\d+) days? ?)?(?:([-+])?(\d+):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/;

const MICROS_PER_SECOND = 1_000_000n;
const MICROS_PER_MINUTE = 60n * MICROS_PER_SECOND;
const MICROS_PER_HOUR = 60n * MICROS_PER_MINUTE;
const MICROS_PER_DAY = 24n * MICROS_PER_HOUR;

/** A 64-bit integer column (SQLite, D1, MySQL `BIGINT`) stores a duration as microseconds; it holds
 *  this range either way. A database's own limit, so it is checked only when binding to one. */
export const DURATION_MICROS_MIN = -9223372036854775808n;
export const DURATION_MICROS_MAX = 9223372036854775807n;

/** Fractional-second digits as microseconds, truncated toward zero. */
function fractionMicros(digits: string | undefined): bigint {
  if (digits === undefined || digits.length === 0) return 0n;
  return BigInt(digits.padEnd(6, "0").slice(0, 6));
}

/** The microseconds an accepted ISO-8601 duration spans, or undefined when `text` is not one. */
export function parseDurationLiteral(text: string): bigint | undefined {
  if (!DURATION_RE.test(text)) return undefined;
  const m = DURATION_PARTS_RE.exec(text);
  if (m === null) return undefined;
  const [, sign, w, d, h, min, s, f] = m;
  const magnitude =
    BigInt(w ?? "0") * 7n * MICROS_PER_DAY +
    BigInt(d ?? "0") * MICROS_PER_DAY +
    BigInt(h ?? "0") * MICROS_PER_HOUR +
    BigInt(min ?? "0") * MICROS_PER_MINUTE +
    BigInt(s ?? "0") * MICROS_PER_SECOND +
    fractionMicros(f);
  return sign === "-" ? -magnitude : magnitude;
}

/** The magnitude of a span split into hours, minutes, seconds and microseconds of a second. */
function splitMicros(micros: bigint): { negative: boolean; h: bigint; m: bigint; s: bigint; frac: bigint } {
  const negative = micros < 0n;
  let rest = negative ? -micros : micros;
  const h = rest / MICROS_PER_HOUR;
  rest %= MICROS_PER_HOUR;
  const m = rest / MICROS_PER_MINUTE;
  rest %= MICROS_PER_MINUTE;
  const s = rest / MICROS_PER_SECOND;
  return { negative, h, m, s, frac: rest % MICROS_PER_SECOND };
}

/** `.` and the microseconds with trailing zeros trimmed, or `""` when there is no fraction. */
function fractionSuffix(frac: bigint): string {
  return frac > 0n ? "." + String(frac).padStart(6, "0").replace(/0+$/, "") : "";
}

/** The canonical wire form of a span of `micros` microseconds. */
export function formatDuration(micros: bigint): string {
  const { negative, h, m, s, frac } = splitMicros(micros);
  let out = "PT";
  if (h > 0n) out += `${h}H`;
  if (m > 0n) out += `${m}M`;
  if (s > 0n || frac > 0n) out += `${s}${fractionSuffix(frac)}S`;
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
  const { negative, h, m, s, frac } = splitMicros(micros);
  const two = (n: bigint): string => String(n).padStart(2, "0");
  const out = `${two(h)}:${two(m)}:${two(s)}${fractionSuffix(frac)}`;
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
  return BigInt(days ?? "0") * MICROS_PER_DAY + time;
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
  return whole(v.days) * MICROS_PER_DAY + whole(v.hours) * MICROS_PER_HOUR
    + whole(v.minutes) * MICROS_PER_MINUTE + whole(v.seconds) * MICROS_PER_SECOND + micros;
}

/**
 * Write side, for a 64-bit integer column (SQLite, D1, MySQL): the span as the microsecond count the
 * column stores — a number when it is a safe integer, else a bigint. Throws past the 64-bit range,
 * which is that column's limit and no other database's.
 */
export function durationToStoredMicros(micros: bigint): number | bigint {
  if (micros > DURATION_MICROS_MAX || micros < DURATION_MICROS_MIN) {
    throw new Error(`a span of ${formatDuration(micros)} does not fit the 64-bit microsecond column this database stores a field.duration in`);
  }
  const n = Number(micros);
  return Number.isSafeInteger(n) ? n : micros;
}

/** Read side: what a driver hands back for a duration column — the microsecond integer of a SQLite,
 *  D1 or MySQL column, an ISO string (Postgres under `IntervalStyle = iso_8601`), the default
 *  Postgres interval text, or a node-postgres interval object — as the canonical wire string.
 *  Throws for anything else. */
export function durationToWire(value: unknown): string {
  // A 64-bit integer column (SQLite, D1, MySQL) holds microseconds; a driver may return it as a
  // number, a bigint or a digit string.
  if (typeof value === "bigint") return formatDuration(value);
  if (typeof value === "number" && Number.isInteger(value)) return formatDuration(BigInt(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return formatDuration(BigInt(value));
  if (typeof value === "string") {
    const iso = canonicalDuration(value);
    return iso ?? formatDuration(parsePostgresInterval(value));
  }
  if (isIntervalObject(value)) return formatDuration(intervalObjectMicros(value));
  throw new Error(`not a field.duration value: ${JSON.stringify(value)}`);
}
