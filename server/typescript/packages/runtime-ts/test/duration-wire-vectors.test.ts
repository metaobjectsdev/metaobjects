// The field.duration wire rule: fixtures/duration-wire/vectors.json against the runtime's
// PRODUCTION helpers, the ones the type coercer, the validator runner and the filter parser call.
// TypeScript holds microseconds (precision 6) and has every codec: it reads and binds Postgres
// interval text and stores microseconds on SQLite, D1 and MySQL. No database.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalDuration, durationToWire, formatDuration, formatPostgresInterval, parseDurationInput,
  parseDurationLiteral, parsePostgresInterval, durationToStoredMicros, DURATION_RE,
} from "../src/duration-wire.js";

interface Vectors {
  wire: {
    parse: Array<{ in: string; out: string }>;
    precision: Array<{ in: string; out: Record<string, string> }>;
    refused: string[];
  };
  codecs: {
    postgres: Array<{ in: string; out: string }>;
    postgresRefused: string[];
    postgresText: Array<{ in: string; out: string }>;
    storedMicros: Array<{ in: string; out: string }>;
  };
}
const { wire, codecs } = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "duration-wire", "vectors.json"), "utf8"),
) as Vectors;
/** TypeScript holds a duration as microseconds. */
const PRECISION = "6";

describe("duration wire vectors (production helpers)", () => {
  for (const v of [...wire.parse, ...wire.precision.map((p) => ({ in: p.in, out: p.out[PRECISION]! }))]) {
    test(`parse ${v.in} -> ${v.out}`, () => {
      expect(DURATION_RE.test(v.in)).toBe(true);
      expect(canonicalDuration(v.in)).toBe(v.out);
      expect(parseDurationInput(v.in)).toBe(v.out);
      expect(durationToWire(v.in)).toBe(v.out);
      // the canonical form is itself accepted, and is a fixed point
      expect(canonicalDuration(v.out)).toBe(v.out);
    });
  }
  for (const text of wire.refused) {
    test(`refused ${JSON.stringify(text)}`, () => {
      expect(DURATION_RE.test(text)).toBe(false);
      expect(parseDurationLiteral(text)).toBeUndefined();
      expect(canonicalDuration(text)).toBeUndefined();
      expect(parseDurationInput(text)).toBeUndefined();
    });
  }
  for (const v of codecs.postgres) {
    test(`postgres ${JSON.stringify(v.in)} -> ${v.out}`, () => {
      expect(formatDuration(parsePostgresInterval(v.in))).toBe(v.out);
      expect(durationToWire(v.in)).toBe(v.out);
    });
  }
  for (const text of codecs.postgresRefused) {
    test(`postgres refused ${JSON.stringify(text)}`, () => {
      expect(() => durationToWire(text)).toThrow();
    });
  }

  for (const v of codecs.postgresText) {
    test(`postgres text of ${v.in} -> ${JSON.stringify(v.out)}`, () => {
      expect(formatPostgresInterval(parseDurationLiteral(v.in)!)).toBe(v.out);
      // and reading that text back is the canonical form again
      expect(durationToWire(v.out)).toBe(canonicalDuration(v.in) as string);
    });
  }

  for (const v of codecs.storedMicros) {
    test(`stored micros of ${v.in} -> ${v.out}`, () => {
      expect(String(durationToStoredMicros(parseDurationLiteral(v.in)!))).toBe(v.out);
      // a driver may return the integer as a number, a bigint or a digit string
      const canonical = canonicalDuration(v.in)!;
      expect(durationToWire(BigInt(v.out))).toBe(canonical);
      expect(durationToWire(v.out)).toBe(canonical);
      if (Number.isSafeInteger(Number(v.out))) expect(durationToWire(Number(v.out))).toBe(canonical);
    });
  }

  test("past the 64-bit microsecond column, binding to it is refused (and only there)", () => {
    const huge = parseDurationLiteral("PT2562047789H")!;
    expect(() => durationToStoredMicros(huge)).toThrow(/64-bit microsecond column/);
    expect(formatDuration(huge)).toBe("PT2562047789H");
  });

  test("a Postgres session not on the default IntervalStyle is refused, never misread", () => {
    // iso_8601 (a negative span's per-component signs), sql_standard and postgres_verbose
    for (const text of ["PT-1M-30S", "1 2:00:00", "@ 1 day 2 hours", "1-2"]) {
      expect(() => durationToWire(text)).toThrow();
    }
    // an unsigned iso_8601 value is plain ISO-8601, so it reads as the span it is
    expect(durationToWire("P1DT2H")).toBe("PT26H");
  });

  test("a node-postgres interval object reads as its canonical form", () => {
    expect(durationToWire({ hours: 1, minutes: 30 })).toBe("PT1H30M");
    expect(durationToWire({ days: 1, hours: 2, seconds: 1, milliseconds: 500.001 })).toBe("PT26H1.500001S");
    expect(durationToWire({ hours: -1, minutes: -30 })).toBe("-PT1H30M");
    expect(() => durationToWire({ months: 1 })).toThrow(/year or month/);
  });

  test("a number is not a duration a caller can send; read back from an integer column it is microseconds", () => {
    expect(parseDurationInput(90)).toBeUndefined();
    expect(durationToWire(90)).toBe("PT0.00009S");
    expect(() => durationToWire(1.5)).toThrow();
    expect(() => durationToWire(true)).toThrow();
  });
});
