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

// SP-A: sub-second canonicalization at millisecond resolution. The rule (shared
// across all five ports): carry up to 3 fractional digits, strip trailing zeros,
// and OMIT the `.` and fractional part entirely when the sub-second is zero — so
// whole-second values stay byte-identical to the pre-SP-A corpus.
describe("temporal canonical parsers — fractional milliseconds", () => {
  test("TIMESTAMPTZ carries milliseconds and converts to UTC Z", () => {
    expect(canonicalTimestamptz("2026-05-31 14:30:00.123+00")).toBe("2026-05-31T14:30:00.123Z");
    // non-UTC offset + fractional → shifted to UTC, fractional preserved
    expect(canonicalTimestamptz("2026-05-31 10:30:00.123-04")).toBe("2026-05-31T14:30:00.123Z");
  });

  test("TIMESTAMPTZ strips trailing zeros and omits the dot when zero", () => {
    expect(canonicalTimestamptz("2026-05-31 14:30:00.120+00")).toBe("2026-05-31T14:30:00.12Z");
    expect(canonicalTimestamptz("2026-05-31 14:30:00.000+00")).toBe("2026-05-31T14:30:00Z");
  });

  test("TIMESTAMP carries milliseconds (no Z), strips trailing zeros, omits dot when zero", () => {
    expect(canonicalTimestamp("2026-05-31 14:30:00.123")).toBe("2026-05-31T14:30:00.123");
    expect(canonicalTimestamp("2026-05-31 14:30:00.120")).toBe("2026-05-31T14:30:00.12");
    expect(canonicalTimestamp("2026-05-31 14:30:00.000")).toBe("2026-05-31T14:30:00");
  });

  test("TIMESTAMP truncates beyond milliseconds (microsecond column rounds to ms on the wire)", () => {
    // Postgres stores microseconds; the pinned contract is millisecond resolution.
    expect(canonicalTimestamp("2026-05-31 14:30:00.123456")).toBe("2026-05-31T14:30:00.123");
  });

  test("TIMESTAMPTZ truncates beyond milliseconds (and converts to UTC Z)", () => {
    // SP-A close-out: the corpus seeds .123456 here; the pinned contract truncates to ms.
    expect(canonicalTimestamptz("2026-05-31 10:30:00.123456-04")).toBe("2026-05-31T14:30:00.123Z");
  });

  test("TIME carries milliseconds, strips trailing zeros, omits dot when zero", () => {
    expect(canonicalTime("14:30:00.123")).toBe("14:30:00.123");
    expect(canonicalTime("14:30:00.120")).toBe("14:30:00.12");
    expect(canonicalTime("14:30:00.000")).toBe("14:30:00");
  });

  test("TIME truncates beyond milliseconds", () => {
    // SP-A close-out: the corpus seeds .123456 here; truncate to ms (not round, not passthrough).
    expect(canonicalTime("14:30:00.123456")).toBe("14:30:00.123");
  });
});
