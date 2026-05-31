// temporal-parsers.ts — pg type parsers that map Postgres temporal types to the
// canonical wire strings pinned in fixtures/persistence-conformance/normalization.md.
//
// WHY parse at the driver level instead of in normalizeValue():
//   node-postgres hands TIMESTAMP and TIMESTAMPTZ to JS as the SAME `Date`
//   object, so a value-only normalizer cannot tell the two apart — and a plain
//   TIMESTAMP gets silently shifted by the *host* timezone on the way into the
//   Date. Parsing the raw on-wire text keyed by the column's type OID removes
//   both hazards: we see the exact bytes Postgres sent and the OID tells us
//   which canonical rule applies.
//
// Canonical forms (whole-second; Phase B seeds no fractional seconds):
//   TIMESTAMPTZ (OID 1184) → "YYYY-MM-DDTHH:MM:SSZ" (always UTC)
//   TIMESTAMP   (OID 1114) → "YYYY-MM-DDTHH:MM:SS"  (no Z)
//   DATE        (OID 1082) → "YYYY-MM-DD"
//   TIME        (OID 1083) → "HH:MM:SS"

import pg from "pg";

// Postgres temporal type OIDs (stable across versions; see pg_type.dat).
export const PG_OID_DATE = 1082;
export const PG_OID_TIME = 1083;
export const PG_OID_TIMESTAMP = 1114;
export const PG_OID_TIMESTAMPTZ = 1184;

// All callers pass non-negative integer getUTC* components, so a fixed 2-digit
// zero-pad is sufficient.
const pad = (n: number): string => n.toString().padStart(2, "0");

/**
 * TIMESTAMPTZ → canonical UTC `...Z`. The on-wire text always carries an
 * explicit offset (e.g. `2026-05-31 14:30:00+00` under a UTC session, or
 * `2026-05-31 10:30:00-04` under another). We convert any offset to UTC so the
 * asserted read proves normalization, not just formatting.
 */
export function canonicalTimestamptz(raw: string): string {
  // ISO-ify: space → 'T', and expand a bare `±HH` offset to `±HH:MM` so the
  // JS Date parser accepts it.
  const iso = raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`canonicalTimestamptz: unparseable timestamptz "${raw}"`);
  }
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * TIMESTAMP (no tz) → `YYYY-MM-DDTHH:MM:SS` (no Z). The on-wire text has no
 * offset; we just swap the space separator for `T` and pass the literal
 * wall-clock value through unshifted (no host-timezone interpretation).
 */
export function canonicalTimestamp(raw: string): string {
  return raw.replace(" ", "T");
}

/** DATE → `YYYY-MM-DD` (passthrough; Postgres already emits this form). */
export function canonicalDate(raw: string): string {
  return raw;
}

/** TIME → `HH:MM:SS` (whole-second passthrough; Phase B seeds no fractional part). */
export function canonicalTime(raw: string): string {
  return raw;
}

/**
 * Register the temporal type parsers on the shared `pg` module. node-postgres
 * type parsers are process-global, so this is idempotent and safe to call from
 * each runner's module scope. After registration every pg-backed read (Kysely
 * included) returns the canonical strings above for temporal columns.
 */
export function registerTemporalParsers(): void {
  pg.types.setTypeParser(PG_OID_TIMESTAMPTZ, canonicalTimestamptz);
  pg.types.setTypeParser(PG_OID_TIMESTAMP, canonicalTimestamp);
  pg.types.setTypeParser(PG_OID_DATE, canonicalDate);
  pg.types.setTypeParser(PG_OID_TIME, canonicalTime);
}
