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

/** For a `datetime` rule with no `format` (generated before it existed): any of the three. */
export function matchesAnyTemporal(s: string): boolean {
  return isCalendarDate(s) || CHECKS[FIELD_SUBTYPE_TIME](s) || isTimestamp(s);
}
