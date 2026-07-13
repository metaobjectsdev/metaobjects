/**
 * The `@default` footgun: a default SATISFIES `@required`.
 *
 * An absent field carrying a `@default` is filled and classified DEFAULTED — which means
 * it never becomes LOST_REQUIRED. That is defensible (a default IS an answer), but it has
 * a consequence that is easy to miss and expensive to learn:
 *
 *   `@default` switches off loss detection for that field — INCLUDING in generated code.
 *
 * The generated extractor throws on `report.hasLostRequired()`, and Java's
 * `ExtractionResult.dataOrThrow()` does the same. So a required field with a default can
 * never make either fire. Put a `@default` on a shared abstract field and loss detection
 * silently dies for every field that inherits it — a missing value then becomes
 * indistinguishable from a real one, with no exception and a healthy-looking log line.
 *
 * These tests pin BOTH halves: the behavior stays as designed (no silent change for
 * existing adopters), and the condition is now ASKABLE via defaultedRequired().
 */

import { describe, test, expect } from "bun:test";
import { extract } from "../../src/extract/extract.js";
import { FieldExtraction, FieldKind, Format, scalar } from "../../src/extract/types.js";

const schema = {
  format: Format.JSON,
  rootName: "answer",
  fields: [
    // Required, and carries a default → an absent value is silently filled.
    scalar("confirmed", FieldKind.BOOLEAN, true, "false"),
    // Required, no default → an absent value is a genuine loss.
    scalar("reason", FieldKind.STRING, true),
  ],
};

describe("@default satisfies @required — the loss-detection footgun", () => {
  test("an absent REQUIRED field with a @default is DEFAULTED, and hasLostRequired() stays FALSE", () => {
    const { data, report } = extract(`{"reason": "because"}`, schema);

    // The value the caller sees is indistinguishable from a real answer…
    expect(data["confirmed"]).toBe(false);
    expect(report.states().get("confirmed")).toBe(FieldExtraction.DEFAULTED);

    // …and THIS is the sharp edge: the guard the generated extractor (and Java's
    // dataOrThrow) keys on reports everything fine. The document never answered
    // `confirmed`, and nothing in the primary failure signal says so.
    expect(report.hasLostRequired()).toBe(false);
    expect(report.lostRequired()).toEqual([]);
  });

  test("but the condition is now ASKABLE — defaultedRequired() names it", () => {
    const { report } = extract(`{"reason": "because"}`, schema);
    expect(report.hasDefaultedRequired()).toBe(true);
    expect(report.defaultedRequired()).toEqual(["confirmed"]);
    expect(report.defaulted()).toEqual(["confirmed"]);
  });

  test("a required field WITHOUT a default is still a real loss (behavior unchanged)", () => {
    const { report } = extract(`{"confirmed": true}`, schema);
    expect(report.hasLostRequired()).toBe(true);
    expect(report.lostRequired()).toEqual(["reason"]);
    // …and it is NOT reported as defaulted — the two are disjoint.
    expect(report.hasDefaultedRequired()).toBe(false);
  });

  test("an OPTIONAL field filled from its default is defaulted, but NOT defaultedRequired", () => {
    // Only a REQUIRED field being silently answered is the dangerous case: an optional
    // field was never going to raise a loss signal anyway.
    const optional = {
      format: Format.JSON,
      rootName: "answer",
      fields: [scalar("note", FieldKind.STRING, false, "n/a")],
    };
    const { report } = extract(`{}`, optional);
    expect(report.defaulted()).toEqual(["note"]);
    expect(report.defaultedRequired()).toEqual([]);
    expect(report.hasDefaultedRequired()).toBe(false);
  });

  test("a document that answers everything reports neither loss nor default", () => {
    const { report } = extract(`{"confirmed": true, "reason": "because"}`, schema);
    expect(report.hasLostRequired()).toBe(false);
    expect(report.hasDefaultedRequired()).toBe(false);
  });
});
