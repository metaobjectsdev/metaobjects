/**
 * A `@required` field whose value is PRESENT but unusable (an enum member the schema does not
 * declare, text where an int belongs) is classified MALFORMED, not LOST_REQUIRED. Before this
 * was pinned, the strict gate — the generated extractor and `orThrow` — keyed on
 * `hasLostRequired()` alone, so a garbled required value passed it and came back as `null`
 * inside a type that says the field is present.
 *
 * The classification stays MALFORMED (it is the louder signal: the model tried and failed);
 * what changes is that the report NAMES the required subset, and the strict gate fails on it.
 */

import { describe, test, expect } from "bun:test";
import { extract } from "../../src/extract/extract.js";
import {
  ExtractError,
  FieldExtraction,
  FieldKind,
  Format,
  enumField,
  orThrow,
  scalar,
} from "../../src/extract/types.js";

const schema = {
  format: Format.JSON,
  rootName: "verdict",
  fields: [
    enumField("verdict", true, ["RELEASE", "AGE_MORE", "DUMP"], null),
    scalar("confidence", FieldKind.INT, true),
    scalar("rationale", FieldKind.STRING, true),
    scalar("abv", FieldKind.DOUBLE, false),
  ],
};

const BAD = `{"verdict":"MAYBE","confidence":"high","rationale":"?","abv":"strong"}`;

describe("a malformed @required field is unusable, not merely noted", () => {
  test("classification is unchanged: MALFORMED, and hasLostRequired() stays false", () => {
    const { report } = extract(BAD, schema);
    expect(report.states().get("verdict")).toBe(FieldExtraction.MALFORMED);
    expect(report.states().get("confidence")).toBe(FieldExtraction.MALFORMED);
    expect(report.hasLostRequired()).toBe(false);
  });

  test("malformedRequired() names exactly the required MALFORMED fields", () => {
    const { report } = extract(BAD, schema);
    expect(report.hasMalformedRequired()).toBe(true);
    expect(report.malformedRequired().sort()).toEqual(["confidence", "verdict"]);
    // an optional malformed field is noted in malformed() but is not a strict failure
    expect(report.malformed()).toContain("abv");
    expect(report.malformedRequired()).not.toContain("abv");
  });

  test("orThrow fails on a malformed required field and names it", () => {
    const result = extract(BAD, schema);
    let caught: unknown;
    try {
      orThrow(result);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtractError);
    const err = caught as ExtractError;
    expect(err.lostRequired).toEqual([]);
    expect([...err.malformedRequired].sort()).toEqual(["confidence", "verdict"]);
    expect(err.message).toContain("malformed");
    expect(err.message).toContain("verdict");
  });

  test("an optional malformed field alone does not make orThrow fail", () => {
    const result = extract(`{"verdict":"DUMP","confidence":3,"rationale":"sour","abv":"strong"}`, schema);
    expect(result.report.hasMalformedRequired()).toBe(false);
    expect(orThrow(result)).toEqual({ verdict: "DUMP", confidence: 3, rationale: "sour" });
  });

  test("a lost required field still fails with the unchanged message", () => {
    const result = extract(`{"verdict":"DUMP","confidence":3}`, schema);
    expect(() => orThrow(result)).toThrow("extract: required field(s) lost: rationale");
  });
});
