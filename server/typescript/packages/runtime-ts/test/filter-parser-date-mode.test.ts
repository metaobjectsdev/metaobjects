// Date-mode timestamp filtering — behavioral pins.
//
// Under codegen-ts's `timestampMode: "date"` a Drizzle pg `timestamp({ mode: "date" })`
// column binds a JS `Date` and calls `.toISOString()` on whatever it is given. The filter
// parser used to hand it the raw query-string value, so EVERY op except `isNull` threw
// `TypeError: value.toISOString is not a function` at request time — a documented
// limitation that `meta gen` could only warn about.
//
// The generated allowlist now carries `dateValues: true` for exactly those columns and the
// parser coerces with `new Date(...)`. These tests drive the REAL Drizzle column through
// `parseFilterParams` and let Drizzle actually serialize the bound parameter, rather than
// asserting on the shape of the returned expression tree — the failure being fixed lived
// inside Drizzle's own binding step, so anything short of that would not have caught it.

import { describe, test, expect } from "bun:test";
import { pgTable, bigserial, timestamp, PgDialect } from "drizzle-orm/pg-core";
import { gte as drizzleGte } from "drizzle-orm";
import type { FilterAllowlist } from "../src/drizzle-fastify/filter-allowlist.js";
import { parseFilterParams, FilterParseError } from "../src/drizzle-fastify/filter-parser.js";

// `mode: "date"` is exactly what codegen emits under timestampMode: "date".
const dateModeTable = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }),
});

// The default mode: a string-typed column, unchanged behavior.
const stringModeTable = pgTable("events_s", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  occurredAt: timestamp("occurred_at", { mode: "string", withTimezone: true }),
});

const TS_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"] as const;

const dateModeAllowlist: FilterAllowlist = {
  occurredAt: { ops: TS_OPS, subType: "datetime", leadingWildcard: false, dateValues: true },
};

const stringModeAllowlist: FilterAllowlist = {
  occurredAt: { ops: TS_OPS, subType: "datetime", leadingWildcard: false },
};

const pg = new PgDialect();

/**
 * Build the WHERE expression and run Drizzle's REAL parameter serialization over it —
 * `sqlToQuery` applies each column's `mapToDriverValue`, which is precisely where a
 * string bound to a date-mode column blew up. Returns the driver-bound params.
 */
function boundParams(
  table: typeof dateModeTable | typeof stringModeTable,
  allowlist: FilterAllowlist,
  query: Record<string, unknown>,
): unknown[] {
  const { where } = parseFilterParams({ query, table, allowlist, sortAllowlist: {}, dialect: "postgres" });
  if (where === undefined) throw new Error("expected a WHERE expression");
  return pg.sqlToQuery(where.getSQL()).params;
}

describe('timestampMode: "date" — filtering no longer throws at request time', () => {
  test("CONTROL: binding a raw string to a date-mode column really does throw", () => {
    // Proves these tests are not vacuous — this is the exact reported failure,
    // reproduced directly against Drizzle, and it is what the parser used to hand over.
    expect(() =>
      pg.sqlToQuery(
        drizzleGte(dateModeTable.occurredAt, "2026-06-03T14:30:00.123Z" as never).getSQL(),
      ),
    ).toThrow(/toISOString is not a function/);
  });

  test("gte binds an ISO wire value cleanly against a date-mode column", () => {
    const params = boundParams(dateModeTable, dateModeAllowlist, {
      filter: { occurredAt: { gte: "2026-06-03T14:30:00.123Z" } },
    });
    expect(params.length).toBe(1);
    // The driver value for a date-mode pg timestamp is the ISO string it derived
    // from the Date we bound — i.e. mapToDriverValue ran instead of throwing.
    expect(params[0]).toBe("2026-06-03T14:30:00.123Z");
  });

  test("every comparison op survives the bind, not just gte", () => {
    for (const op of ["eq", "ne", "gt", "gte", "lt", "lte"] as const) {
      const params = boundParams(dateModeTable, dateModeAllowlist, {
        filter: { occurredAt: { [op]: "2026-06-03T14:30:00.000Z" } },
      });
      expect(`${op}:${params[0]}`).toBe(`${op}:2026-06-03T14:30:00.000Z`);
    }
  });

  test("in coerces every member of the list", () => {
    const params = boundParams(dateModeTable, dateModeAllowlist, {
      filter: { occurredAt: { in: "2026-06-03T00:00:00.000Z,2026-06-04T00:00:00.000Z" } },
    });
    expect(params).toEqual(["2026-06-03T00:00:00.000Z", "2026-06-04T00:00:00.000Z"]);
  });

  test("a date-only value is accepted (midnight UTC)", () => {
    const params = boundParams(dateModeTable, dateModeAllowlist, {
      filter: { occurredAt: { gte: "2026-06-03" } },
    });
    expect(params[0]).toBe("2026-06-03T00:00:00.000Z");
  });

  test("a malformed value is rejected at the boundary, not bound as an Invalid Date", () => {
    // `new Date("garbage")` yields an Invalid Date rather than throwing; binding one
    // would emit NaN-shaped SQL instead of a 400.
    expect(() =>
      boundParams(dateModeTable, dateModeAllowlist, {
        filter: { occurredAt: { gte: "not-a-date" } },
      }),
    ).toThrow(FilterParseError);
  });

  test("isNull still coerces as a boolean, unaffected by dateValues", () => {
    const { where } = parseFilterParams({
      query: { filter: { occurredAt: { isNull: "true" } } },
      table: dateModeTable,
      allowlist: dateModeAllowlist,
      sortAllowlist: {},
      dialect: "postgres",
    });
    expect(where).toBeDefined();
  });
});

describe('default "string" mode is unchanged', () => {
  test("without dateValues the value stays a string", () => {
    const params = boundParams(stringModeTable, stringModeAllowlist, {
      filter: { occurredAt: { gte: "2026-06-03T14:30:00.123Z" } },
    });
    expect(params).toEqual(["2026-06-03T14:30:00.123Z"]);
  });

  test("a value string mode would accept is not newly rejected", () => {
    // String mode does no well-formedness check — that stays true, so an allowlist
    // generated before `dateValues` existed behaves exactly as it did.
    const params = boundParams(stringModeTable, stringModeAllowlist, {
      filter: { occurredAt: { eq: "whatever-the-db-wants" } },
    });
    expect(params).toEqual(["whatever-the-db-wants"]);
  });
});
