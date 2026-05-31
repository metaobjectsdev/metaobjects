// temporal-parsers.test.ts — pure-function checks for the canonical temporal
// wire forms (no DB). The OID-keyed pg parsers built on these are exercised
// end-to-end by the normalization-wire-types persistence scenario.

import { describe, expect, test } from "bun:test";

import {
  canonicalDate,
  canonicalTime,
  canonicalTimestamp,
  canonicalTimestamptz,
} from "../src/temporal-parsers.ts";

describe("temporal canonical parsers", () => {
  test("TIMESTAMPTZ converts a non-UTC offset to UTC Z", () => {
    // 10:30:00-04 and 14:30:00+00 are the same instant → both render UTC Z.
    expect(canonicalTimestamptz("2026-05-31 10:30:00-04")).toBe("2026-05-31T14:30:00Z");
    expect(canonicalTimestamptz("2026-05-31 14:30:00+00")).toBe("2026-05-31T14:30:00Z");
  });

  test("TIMESTAMP passes wall-clock through with no Z and no host-tz shift", () => {
    expect(canonicalTimestamp("2026-05-31 14:30:00")).toBe("2026-05-31T14:30:00");
  });

  test("DATE is a passthrough YYYY-MM-DD", () => {
    expect(canonicalDate("2026-05-31")).toBe("2026-05-31");
  });

  test("TIME is a passthrough HH:MM:SS (whole seconds)", () => {
    expect(canonicalTime("14:30:00")).toBe("14:30:00");
  });
});
