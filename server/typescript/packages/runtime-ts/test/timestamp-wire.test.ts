/**
 * The wire spelling of a field.timestamp — `fixtures/persistence-conformance/normalization.md`
 * applied where the generated routes SEND rows.
 *
 * Codegen maps a Postgres `field.timestamp` to `timestamp(…, { mode: "string" })`, and in
 * string mode Drizzle hands back whatever text node-postgres received — Postgres' own output
 * format, `2026-09-20 12:00:00+00`, rendered in the SESSION time zone. A strict ISO 8601
 * parser rejects the space separator, and the other four ports answer the same row as
 * `2026-09-20T12:00:00Z`. These are the pure-function and column-discovery halves; the
 * real-Postgres half (both adapters, both entry points) is `timestamp-wire-pg.test.ts`.
 */

import { describe, test, expect } from "bun:test";
import { pgTable, pgView, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sqliteTable, integer, text as sqliteText } from "drizzle-orm/sqlite-core";
import { canonicalTimestamp, timestampWire } from "../src/timestamp-wire.js";

describe("canonicalTimestamp — tz-aware (the default field.timestamp)", () => {
  const tz = (v: unknown) => canonicalTimestamp(v, true);

  test("Postgres text under a UTC session → T separator and a literal Z", () => {
    expect(tz("2026-09-20 12:00:00+00")).toBe("2026-09-20T12:00:00Z");
  });

  test("a non-UTC session offset is converted to UTC, not relabelled", () => {
    expect(tz("2026-03-04 00:06:07.12-05")).toBe("2026-03-04T05:06:07.12Z");
    expect(tz("2026-03-04 05:30:07+05:30")).toBe("2026-03-04T00:00:07Z");
  });

  test("an offset that crosses midnight and the year rolls the date", () => {
    expect(tz("2026-12-31 23:00:00-02")).toBe("2027-01-01T01:00:00Z");
  });

  test("a local-mean-time offset with seconds (pre-1900 rows) still converts", () => {
    expect(tz("1883-11-18 12:00:00-04:56:02")).toBe("1883-11-18T16:56:02Z");
  });

  test("the fraction is TRUNCATED to milliseconds, never rounded", () => {
    expect(tz("2026-03-04 05:06:07.123456+00")).toBe("2026-03-04T05:06:07.123Z");
    expect(tz("2026-03-04 05:06:07.9999+00")).toBe("2026-03-04T05:06:07.999Z");
  });

  test("trailing fractional zeros are stripped, and a zero fraction is omitted", () => {
    expect(tz("2026-03-04 05:06:07.120+00")).toBe("2026-03-04T05:06:07.12Z");
    expect(tz("2026-03-04 05:06:07.000+00")).toBe("2026-03-04T05:06:07Z");
    expect(tz("2026-03-04 05:06:07.0004+00")).toBe("2026-03-04T05:06:07Z");
  });

  test("an already-canonical value is unchanged; a padded one is trimmed", () => {
    expect(tz("2026-09-20T12:00:00Z")).toBe("2026-09-20T12:00:00Z");
    expect(tz("2026-09-20T12:00:00.000Z")).toBe("2026-09-20T12:00:00Z");
  });

  test("a value with no offset is read as UTC", () => {
    expect(tz("2026-09-20T12:00:00")).toBe("2026-09-20T12:00:00Z");
  });

  test("a Date (timestampMode: \"date\") drops toISOString's `.000`", () => {
    expect(tz(new Date("2026-03-04T05:06:07Z"))).toBe("2026-03-04T05:06:07Z");
    expect(tz(new Date("2026-03-04T05:06:07.120Z"))).toBe("2026-03-04T05:06:07.12Z");
  });

  test("a year below 100 is not shifted into the 1900s", () => {
    expect(tz("0042-01-01 00:00:00+00")).toBe("0042-01-01T00:00:00Z");
  });

  test("anything it cannot read passes through untouched", () => {
    for (const v of ["infinity", "-infinity", "2026-03-04 05:06:07+00 BC", "not a time", "", 42, null, undefined]) {
      expect(tz(v)).toBe(v);
    }
    const bad = new Date(Number.NaN);
    expect(tz(bad)).toBe(bad);
  });
});

describe("canonicalTimestamp — @localTime (timestamp without time zone)", () => {
  const local = (v: unknown) => canonicalTimestamp(v, false);

  test("the wall clock is kept and no Z is added", () => {
    expect(local("2026-03-04 07:06:07")).toBe("2026-03-04T07:06:07");
    expect(local("2026-03-04 07:06:07.120000")).toBe("2026-03-04T07:06:07.12");
  });

  test("a value carrying an offset is left alone — which wall clock it means is not knowable", () => {
    // Postgres never sends one for `timestamp without time zone`; a hand-written route might.
    // Dropping the offset would silently change the value, so it passes through instead.
    expect(local("2026-03-04 07:06:07-05")).toBe("2026-03-04 07:06:07-05");
    expect(local("2026-03-04T07:06:07Z")).toBe("2026-03-04T07:06:07Z");
  });

  test("a Date reads its UTC fields — the ones Drizzle stored the wall clock in", () => {
    // Drizzle's PgTimestamp maps a naive value to a Date by appending +0000.
    expect(local(new Date("2026-03-04T07:06:07.500Z"))).toBe("2026-03-04T07:06:07.5");
  });
});

describe("timestampWire — which keys it rewrites", () => {
  const events = pgTable("events", {
    id: serial("id").primaryKey(),
    note: text("note"),
    at: timestamp("at", { mode: "string", withTimezone: true }),
    wallClock: timestamp("wall_clock", { mode: "string", withTimezone: false }),
    atDate: timestamp("at_date", { mode: "date", withTimezone: true }),
  });

  test("timestamp columns are rewritten by their JS key, others are left alone", () => {
    const wire = timestampWire(events);
    const row = {
      id: 1,
      // A text column holding timestamp-shaped text is DATA, not a timestamp.
      note: "2026-09-20 12:00:00+00",
      at: "2026-09-20 12:00:00+00",
      wallClock: "2026-09-20 12:00:00",
      atDate: new Date("2026-09-20T12:00:00.000Z"),
    };
    expect(wire(row)).toEqual({
      id: 1,
      note: "2026-09-20 12:00:00+00",
      at: "2026-09-20T12:00:00Z",
      wallClock: "2026-09-20T12:00:00",
      atDate: "2026-09-20T12:00:00Z",
    });
  });

  test("the row Drizzle returned is not mutated", () => {
    const row = { id: 1, at: "2026-09-20 12:00:00+00" };
    timestampWire(events)(row);
    expect(row.at).toBe("2026-09-20 12:00:00+00");
  });

  test("null and absent timestamp values stay as they are", () => {
    expect(timestampWire(events)({ id: 1, at: null })).toEqual({ id: 1, at: null });
  });

  test("a view's declared columns are discovered too", () => {
    const summary = pgView("event_summary", {
      id: serial("id"),
      at: timestamp("at", { mode: "string", withTimezone: true }),
    }).existing();
    expect(timestampWire(summary)({ id: 1, at: "2026-09-20 12:00:00+00" }))
      .toEqual({ id: 1, at: "2026-09-20T12:00:00Z" });
  });

  test("sources are unioned — a write-through response may come from table OR view", () => {
    const view = pgView("events_replica", {
      id: serial("id"),
      derivedAt: timestamp("derived_at", { mode: "string", withTimezone: true }),
    }).existing();
    expect(timestampWire(events, view)({ id: 1, at: "2026-09-20 12:00:00+00", derivedAt: "2026-09-20 13:00:00+00" }))
      .toEqual({ id: 1, at: "2026-09-20T12:00:00Z", derivedAt: "2026-09-20T13:00:00Z" });
  });

  test("a source with no timestamp columns returns rows as they are", () => {
    const tags = sqliteTable("tags", { id: integer("id").primaryKey(), at: sqliteText("at") });
    const row = { id: 1, at: "2026-09-20 12:00:00" };
    expect(timestampWire(tags)(row)).toBe(row);
    expect(timestampWire(undefined)(row)).toBe(row);
  });

  test("a non-object body passes through", () => {
    expect(timestampWire(events)(null)).toBe(null);
  });
});
