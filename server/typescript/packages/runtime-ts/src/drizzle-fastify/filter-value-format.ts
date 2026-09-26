/**
 * Well-formedness checks for filter values, keyed by the wire format a field's values
 * take (docs/features/api-contract.md, "Type encodings"). The filter parser runs these
 * before a value reaches SQL, so a malformed value is a 400 naming the format rather than
 * a silent empty result (SQLite compares the text and matches nothing) or a driver error
 * (Postgres refuses the cast).
 *
 * Deliberately a little more lenient than the RESPONSE encoding, because a filter bound
 * is written by a person: a time may omit seconds, a timestamp may omit its time part
 * (a day bound) or carry any UTC offset, and fractional seconds may have any precision.
 * What is refused is a value that is not that kind of thing at all.
 */

import {
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_UUID,
} from "@metaobjectsdev/metadata";
import type { FilterValueFormat } from "./filter-allowlist.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/;
// Date, then optionally a `T`/space time, then optionally `Z` or a ±HH[:]MM offset.
const TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?)(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `YYYY-MM-DD` that names a real calendar day (2026-02-30 does not). */
function isCalendarDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

function isTimestamp(s: string): boolean {
  const m = TIMESTAMP_RE.exec(s);
  return m !== null && isCalendarDate(m[1] ?? "");
}

const CHECKS: Readonly<Record<FilterValueFormat, (s: string) => boolean>> = {
  [FIELD_SUBTYPE_DATE]: isCalendarDate,
  [FIELD_SUBTYPE_TIME]: (s) => TIME_RE.test(s),
  [FIELD_SUBTYPE_TIMESTAMP]: isTimestamp,
  [FIELD_SUBTYPE_UUID]: (s) => UUID_RE.test(s),
};

/** The `expected` member of the `invalid_filter_value` envelope, per format. */
export const FORMAT_EXPECTED: Readonly<Record<FilterValueFormat, string>> = {
  [FIELD_SUBTYPE_DATE]: "date (YYYY-MM-DD)",
  [FIELD_SUBTYPE_TIME]: "time (HH:MM[:SS[.fff]])",
  [FIELD_SUBTYPE_TIMESTAMP]: "timestamp (YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH:MM])",
  [FIELD_SUBTYPE_UUID]: "uuid (8-4-4-4-12 hex)",
};

/** `expected` for a temporal rule that does not say WHICH temporal format it is. */
export const ANY_TEMPORAL_EXPECTED = "date, time or timestamp (ISO 8601)";

export function matchesFormat(format: FilterValueFormat, s: string): boolean {
  return CHECKS[format](s);
}

/** A timestamp: a date, then optionally a time part, then optionally a zone (`Z` or `±HH[[:]MM]`). */
const TIMESTAMP_PARTS_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:([Zz])|([+-]\d{2}):?(\d{2})?)?)?$/;

/** Already the canonical UTC spelling: `YYYY-MM-DDTHH:MM:SS[.f…]Z`. Kept byte-for-byte. */
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * A timestamp bound in the canonical UTC spelling of its instant — `YYYY-MM-DDTHH:MM:SS[.fff]Z`,
 * millisecond resolution, no trailing zeros, no fraction when it is zero (the wire form
 * fixtures/persistence-conformance/normalization.md pins). A value already spelled that way
 * is returned as sent; any other value carrying a zone is rewritten; a zoneless or date-only
 * value only when `zonelessIsUtc`, and then read as UTC (a date alone as midnight UTC).
 * Anything else is returned unchanged.
 *
 * The generated insert/update schemas store a `field.timestamp` instant by the same rule
 * (codegen-ts `utcIsoTimestamp`), because SQLite and D1 compare the TEXT column as text: a
 * row sent as `2026-09-21T01:00:00+05:00` (20:00Z) and a bound of `2026-09-20T21:00:00+00:00`
 * only order correctly once both are spelled in UTC. Postgres compares timestamptz instants
 * and reads either spelling the same way. The string handed to `Date.parse` is the
 * ECMAScript date-time format it must accept, so this does not rely on an engine reading
 * `+05`, a six-digit fraction, or a zoneless string (which ECMAScript reads as LOCAL time).
 */
function utcIso(s: string, zonelessIsUtc: boolean): string {
  if (CANONICAL_UTC_RE.test(s)) return s;
  const m = TIMESTAMP_PARTS_RE.exec(s);
  if (m === null) return s;
  const [, date, hm, sec, frac, z, oh, om] = m;
  const zoned = z !== undefined || oh !== undefined;
  if (!zoned && !zonelessIsUtc) return s;
  const ms = (frac ?? "").slice(0, 3).padEnd(3, "0");
  const t = Date.parse(`${date}T${hm ?? "00:00"}:${sec ?? "00"}.${ms}${oh === undefined ? "Z" : `${oh}:${om ?? "00"}`}`);
  return Number.isNaN(t) ? s : new Date(t).toISOString().replace(/\.?0+Z$/, "Z");
}

/** A zoned timestamp bound in UTC; a naive or date-only one unchanged (a wall clock). */
export function utcIsoIfZoned(s: string): string {
  return utcIso(s, false);
}

/**
 * A `field.timestamp` INSTANT bound (not `@localTime`) in UTC: a zoned value at its
 * instant, a zoneless one read as UTC, a date alone as midnight UTC — the rule the
 * generated write schema (codegen-ts `utcIsoTimestamp`) stores the column by. A default
 * timestamp's wire form is "always UTC" (docs/features/api-contract.md, "Type encodings").
 */
export function utcIsoInstant(s: string): string {
  return utcIso(s, true);
}

/**
 * A timestamp bound whose offset arrived as a space: `…T00:00:00+00:00` sent unencoded in a
 * query string, where `+` decodes to a space, reaches the parser as `…T00:00:00 00:00`.
 */
const SPACE_FOR_PLUS_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)? \d{2}(?::?\d{2})?$/;

/** The `hint` for a timestamp bound that fails only because its `+` offset was not encoded. */
export const PLUS_OFFSET_HINT =
  "a \"+\" in a query string decodes to a space: URL-encode the offset's \"+\" as %2B, or use Z for UTC";

export function looksLikeUnencodedPlusOffset(s: string): boolean {
  return SPACE_FOR_PLUS_OFFSET_RE.test(s);
}

/** For a `datetime` rule with no `format` (generated before it existed): any of the three. */
export function matchesAnyTemporal(s: string): boolean {
  return isCalendarDate(s) || CHECKS[FIELD_SUBTYPE_TIME](s) || isTimestamp(s);
}
