// The JSON Schema `pattern` of a field.duration is DURATION_PATTERN spelled without lookaround (not
// I-Regexp; RE2-based validators refuse it). The two must give the same verdict on every duration
// vector, and on shapes around each lookahead the plain pattern replaces.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DURATION_PATTERN } from "@metaobjectsdev/metadata";
import { DURATION_JSON_SCHEMA_PATTERN } from "../../src/contract/field-schema.js";

interface Vectors {
  wire: {
    parse: Array<{ in: string; out: string }>;
    precision: Array<{ in: string; out: Record<string, string> }>;
    refused: string[];
  };
}
const { wire } = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "..", "fixtures", "duration-wire", "vectors.json"), "utf8"),
) as Vectors;
/** Every duration the wire accepts: the parse ins and the precision ins (a fraction of any length). */
const accepted = [...wire.parse.map((p) => p.in), ...wire.precision.map((p) => p.in)];

const lookahead = new RegExp(DURATION_PATTERN);
const plain = new RegExp(DURATION_JSON_SCHEMA_PATTERN);

/** Shapes the vectors do not spell, around each lookahead the plain pattern replaces. */
const EXTRA = [
  "P1D", "P1DT1H", "P1DT1M", "P1DT1S", "P1DT1H1M1S", "PT1H1M", "PT1M1.5S", "PT1H1.000000001S",
  "P1DT", "PT", "P", "PT1", "P1", "P1DT1", "PT1H1", "PT1HM", "PTH", "P1D1H", "-P", "+PT", "PT1H1M1S1",
  "P1W1D", "P1WT1H", "P1W1DT1M1.5S", "P1WT", "P1W1DT", "P1WD", "PW", "P1W1W", "P1W1", "-P1W1DT1S",
];

describe("the JSON Schema duration pattern", () => {
  test("has no lookaround, no \\d and no non-capturing group", () => {
    expect(DURATION_JSON_SCHEMA_PATTERN).not.toMatch(/\(\?/);
    expect(DURATION_JSON_SCHEMA_PATTERN).not.toContain("\\d");
  });

  for (const v of [...accepted, ...wire.refused, ...EXTRA]) {
    test(`${JSON.stringify(v)}: the same verdict as DURATION_PATTERN`, () => {
      expect(plain.test(v)).toBe(lookahead.test(v));
    });
  }
  for (const v of accepted) {
    test(`accepts ${v}`, () => expect(plain.test(v)).toBe(true));
  }
  for (const v of wire.refused) {
    test(`refuses ${JSON.stringify(v)}`, () => expect(plain.test(v)).toBe(false));
  }
});
