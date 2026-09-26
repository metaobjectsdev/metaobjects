// The wire spelling of a field.timestamp, applied where the Drizzle-direct
// mounts SEND rows.
//
// The spelling is the contract file's, not a comment's:
// `fixtures/persistence-conformance/normalization.md` says what a tz-aware and
// an `@localTime` field.timestamp look like on the wire (and
// `docs/features/api-contract.md` defers to it); this module implements it.
//
// Nothing upstream of here produces that. Codegen maps a Postgres field.timestamp
// to `timestamp(…, { mode: "string" })`, and in string mode Drizzle returns the
// text node-postgres received — Postgres' OUTPUT format, `2026-09-20 12:00:00+00`,
// rendered in whatever time zone the SESSION runs in. A strict ISO 8601 parser
// rejects the space, and the other four ports answer the same row as
// `2026-09-20T12:00:00Z`. Under `timestampMode: "date"` the column yields a Date,
// whose JSON form pads `.000`. Both are canonicalized here, at the HTTP boundary
// (ADR-0019's place for wire canonicalization), so the generated routes — which all
// delegate to these mounts — answer correctly without a regen.
//
// Two doors do NOT pass through here. The ObjectManager-driven `./fastify` mount
// sends what ObjectManager returns and no generated route uses it. A hand-written
// route that sends a row itself is its author's to map, through `timestampWire`
// (the codegen comment at the `mode: "string"` decision says so).
// `packages/integration-tests/src/temporal-parsers.ts` implements the same spelling
// for the persistence-conformance runner; a change to the rules here must be checked
// against it.
//
// Which keys are timestamps comes from the Drizzle column objects themselves
// (`columnType` + `withTimezone`), never from the shape of a value: a text column
// holding timestamp-shaped text is data. A dialect whose columns do not say so —
// SQLite stores a field.timestamp in a plain `text()` column — is left as it is.

import { viewBaseConfig } from "./drizzle-fastify/util.js";

// biome-ignore lint/suspicious/noExplicitAny: a Drizzle table or view, structurally typed
type AnySource = any;

/** The symbol drizzle-orm itself reads for a table's columns — a `Symbol.for` read is
 *  cross-copy-safe, so this works with two physical copies of drizzle-orm loaded. */
const DRIZZLE_COLUMNS = Symbol.for("drizzle:Columns");

/** pg-core's two timestamp column classes: `mode: "string"` and `mode: "date"`. */
const TIMESTAMP_COLUMN_TYPES: ReadonlySet<string> = new Set(["PgTimestampString", "PgTimestamp"]);

/** `YYYY-MM-DD[ T]HH:MM:SS[.f…][Z|±HH[:MM[:SS]]]` — Postgres' output format and ISO 8601 both. */
const TIMESTAMP_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/;

const pad2 = (n: number): string => n.toString().padStart(2, "0");

/** ".fff" with trailing zeros stripped; "" when the millisecond count is zero. */
function msSuffix(ms: number): string {
  return ms === 0 ? "" : `.${ms.toString().padStart(3, "0").replace(/0+$/, "")}`;
}

function format(
  y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, withTimezone: boolean,
): string {
  return `${y.toString().padStart(4, "0")}-${pad2(mo)}-${pad2(d)}` +
    `T${pad2(h)}:${pad2(mi)}:${pad2(s)}${msSuffix(ms)}${withTimezone ? "Z" : ""}`;
}

function formatUtcFields(date: Date, withTimezone: boolean): string | undefined {
  const y = date.getUTCFullYear();
  // NaN is an Invalid Date's year; out-of-range years have no `YYYY` spelling.
  if (!Number.isInteger(y) || y < 0 || y > 9999) return undefined;
  return format(
    y, date.getUTCMonth() + 1, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds(),
    withTimezone,
  );
}

/**
 * One timestamp value in its canonical wire spelling. `withTimezone` is the column's:
 * true for a default (instant) field.timestamp, false for `@localTime`. Anything it
 * cannot read — `infinity`, a BC date, a non-string, an `@localTime` value that carries
 * an offset — is returned unchanged.
 */
export function canonicalTimestamp(value: unknown, withTimezone: boolean): unknown {
  if (value instanceof Date) {
    // Drizzle's PgTimestamp builds a naive value's Date by appending +0000, so the UTC
    // fields ARE the wall clock for @localTime as well as the instant for tz-aware.
    // An Invalid Date fails formatUtcFields' integer-year guard and passes through.
    return formatUtcFields(value, withTimezone) ?? value;
  }
  if (typeof value !== "string") return value;
  const m = TIMESTAMP_TEXT.exec(value);
  if (m === null) return value;
  const [, y, mo, d, h, mi, s, frac, zone, sign, oh, om, os] = m;
  // Truncate to milliseconds (Postgres keeps microseconds; the contract is ms).
  const ms = frac === undefined ? 0 : Number.parseInt(frac.slice(0, 3).padEnd(3, "0"), 10);
  const fields = [y, mo, d, h, mi, s].map(Number) as [number, number, number, number, number, number];
  // An @localTime value is a wall clock. One that carries an offset names two candidate
  // wall clocks, and dropping the offset would silently pick one, so it passes through.
  if (!withTimezone) return zone === undefined ? format(...fields, ms, false) : value;
  // No offset to apply: a value already in UTC, or one with no zone at all (read as UTC —
  // the only reading that means the same instant on every host).
  if (zone === undefined || zone === "Z") return format(...fields, ms, true);
  // Date.parse on an explicit four-digit ISO year avoids Date.UTC's 0–99 → 19xx mapping.
  const local = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  if (Number.isNaN(local)) return value;
  const offsetSeconds = (Number(oh) * 3600 + Number(om ?? 0) * 60 + Number(os ?? 0)) * (sign === "-" ? -1 : 1);
  const utc = formatUtcFields(new Date(local - offsetSeconds * 1000 + ms), true);
  return utc ?? value;
}

/** The Drizzle column objects of a table or view, keyed by the JS property a row uses. */
function columnsOf(source: AnySource): Record<string, unknown> {
  if (source === undefined || source === null) return {};
  try {
    const cols = source[DRIZZLE_COLUMNS];
    if (cols && typeof cols === "object") return cols as Record<string, unknown>;
  } catch {
    // A view is a proxy whose handler may throw on an unexpected key — try the view shape.
  }
  const fields = viewBaseConfig(source)?.["selectedFields"];
  if (fields && typeof fields === "object") return fields as Record<string, unknown>;
  return {};
}

/** Returned for a source with no timestamp columns — rows pass through as they are. */
const IDENTITY: (row: unknown) => unknown = (row) => row;

/**
 * A function that returns a row with every timestamp column in its wire spelling. The
 * keys are read once, from the Drizzle `sources` the rows were selected from (several
 * when a response can come from either, as a write-through entity's does). A source
 * with no timestamp columns yields the identity, so an untouched row costs nothing.
 */
export function timestampWire(...sources: AnySource[]): (row: unknown) => unknown {
  const keys = new Map<string, boolean>();
  for (const source of sources) {
    for (const [key, col] of Object.entries(columnsOf(source))) {
      const c = col as { columnType?: unknown; withTimezone?: unknown } | null;
      if (c && typeof c.columnType === "string" && TIMESTAMP_COLUMN_TYPES.has(c.columnType)) {
        keys.set(key, c.withTimezone === true);
      }
    }
  }
  if (keys.size === 0) return IDENTITY;
  // Freeze the mount-time decision into a plain array; the row closure runs once
  // per row per request and iterating an array beats re-walking the Map.
  const columns: readonly [string, boolean][] = [...keys];
  return (row) => {
    if (row === null || typeof row !== "object") return row;
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const [key, withTimezone] of columns) {
      if (key in out) out[key] = canonicalTimestamp(out[key], withTimezone);
    }
    return out;
  };
}
