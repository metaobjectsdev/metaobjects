// The field.duration wire rule: every vector in fixtures/duration-wire/vectors.json against the
// runtime's PRODUCTION helpers, the ones the type coercer, the validator runner and the filter
// parser call. No database.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalDuration, durationToWire, formatDuration, formatPostgresInterval, parseDurationInput,
  parseDurationLiteral, parsePostgresInterval, DURATION_RE,
} from "../src/duration-wire.js";

interface Vectors {
  parse: Array<{ in: string; out: string }>;
  refused: string[];
  postgres: Array<{ in: string; out: string }>;
  postgresRefused: string[];
  postgresText: Array<{ in: string; out: string }>;
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "duration-wire", "vectors.json"), "utf8"),
) as Vectors;

describe("duration wire vectors (production helpers)", () => {
  for (const v of vectors.parse) {
    test(`parse ${v.in} -> ${v.out}`, () => {
      expect(DURATION_RE.test(v.in)).toBe(true);
      expect(canonicalDuration(v.in)).toBe(v.out);
      expect(parseDurationInput(v.in)).toBe(v.out);
      expect(durationToWire(v.in)).toBe(v.out);
      // the canonical form is itself accepted, and is a fixed point
      expect(canonicalDuration(v.out)).toBe(v.out);
    });
  }
  for (const text of vectors.refused) {
    test(`refused ${JSON.stringify(text)}`, () => {
      // The pattern is the syntax; the length bound is the codec's, so an over-long span matches
      // the pattern and is still refused.
      expect(parseDurationLiteral(text)).toBeUndefined();
      expect(canonicalDuration(text)).toBeUndefined();
      expect(parseDurationInput(text)).toBeUndefined();
    });
  }
  for (const v of vectors.postgres) {
    test(`postgres ${JSON.stringify(v.in)} -> ${v.out}`, () => {
      expect(formatDuration(parsePostgresInterval(v.in))).toBe(v.out);
      expect(durationToWire(v.in)).toBe(v.out);
    });
  }
  for (const text of vectors.postgresRefused) {
    test(`postgres refused ${JSON.stringify(text)}`, () => {
      expect(() => durationToWire(text)).toThrow();
    });
  }

  for (const v of vectors.postgresText) {
    test(`postgres text of ${v.in} -> ${JSON.stringify(v.out)}`, () => {
      expect(formatPostgresInterval(parseDurationLiteral(v.in)!)).toBe(v.out);
      // and reading that text back is the canonical form again
      expect(durationToWire(v.out)).toBe(canonicalDuration(v.in) as string);
    });
  }

  test("a node-postgres interval object reads as its canonical form", () => {
    expect(durationToWire({ hours: 1, minutes: 30 })).toBe("PT1H30M");
    expect(durationToWire({ days: 1, hours: 2, seconds: 1, milliseconds: 500.001 })).toBe("PT26H1.500001S");
    expect(durationToWire({ hours: -1, minutes: -30 })).toBe("-PT1H30M");
    expect(() => durationToWire({ months: 1 })).toThrow(/year or month/);
  });

  test("a non-string, non-interval value is not a duration", () => {
    expect(parseDurationInput(90)).toBeUndefined();
    expect(() => durationToWire(90)).toThrow();
  });
});
