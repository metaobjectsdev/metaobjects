// The JSON Schema `pattern` of a field.duration is DURATION_PATTERN spelled without lookaround (not
// I-Regexp; RE2-based validators refuse it). The two must give the same verdict on every duration
// vector, and on shapes around each lookahead the plain pattern replaces.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DURATION_PATTERN } from "@metaobjectsdev/metadata";
import { DURATION_JSON_SCHEMA_PATTERN } from "../../src/contract/field-schema.js";

interface Vectors { parse: Array<{ in: string; out: string }>; refused: string[] }
const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "..", "fixtures", "duration-wire", "vectors.json"), "utf8"),
) as Vectors;

const lookahead = new RegExp(DURATION_PATTERN);
const plain = new RegExp(DURATION_JSON_SCHEMA_PATTERN);

/** Shapes the vectors do not spell, around each lookahead the plain pattern replaces. */
const EXTRA = [
  "P1D", "P1DT1H", "P1DT1M", "P1DT1S", "P1DT1H1M1S", "PT1H1M", "PT1M1.5S", "PT1H1.000000001S",
  "P1DT", "PT", "P", "PT1", "P1", "P1DT1", "PT1H1", "PT1HM", "PTH", "P1D1H", "-P", "+PT", "PT1H1M1S1",
];

describe("the JSON Schema duration pattern", () => {
  test("has no lookaround, no \\d and no non-capturing group", () => {
    expect(DURATION_JSON_SCHEMA_PATTERN).not.toMatch(/\(\?/);
    expect(DURATION_JSON_SCHEMA_PATTERN).not.toContain("\\d");
  });

  for (const v of [...vectors.parse.map((p) => p.in), ...vectors.refused, ...EXTRA]) {
    test(`${JSON.stringify(v)}: the same verdict as DURATION_PATTERN`, () => {
      expect(plain.test(v)).toBe(lookahead.test(v));
    });
  }
  for (const v of vectors.parse) {
    test(`accepts ${v.in}`, () => expect(plain.test(v.in)).toBe(true));
  }
  for (const v of vectors.refused) {
    test(`refuses ${JSON.stringify(v)}`, () => expect(plain.test(v)).toBe(false));
  }
});
