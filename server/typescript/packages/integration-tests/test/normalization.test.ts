// Out-of-band float guard — the ONLY normalization case that cannot be a shared
// round-trip scenario (you can't seed a value that must THROW). The happy-path
// float/integer/bigint normalization cases formerly here are now gated end-to-end
// by the shared persistence-conformance round-trip corpus:
//   - REAL/DOUBLE plain-decimal strings  → queries/measurement-floats.yaml
//   - INTEGER stays a JSON number        → queries/projection-aggregates.yaml (min/max)
//   - BIGINT → string                    → queries/projection-aggregates.yaml (weekCount/totalMinutes)
//   - NUMERIC no-trailing-zeros string   → queries/projection-aggregates.yaml (avgMinutes)
// See fixtures/persistence-conformance/normalization.md.

import { describe, test, expect } from "bun:test";
import { normalizeValue, canonicalFloat } from "../src/normalization.ts";

describe("canonicalFloat — out-of-band guard (not round-trippable)", () => {
  test("1.5e-10 throws (exponential notation)", () => {
    expect(() => canonicalFloat(1.5e-10)).toThrow(
      "canonicalFloat: 1.5e-10 is outside the plain-decimal band (exponential notation)",
    );
  });

  test("normalizeValue(1.5e-10) propagates the throw", () => {
    expect(() => normalizeValue(1.5e-10)).toThrow();
  });
});
