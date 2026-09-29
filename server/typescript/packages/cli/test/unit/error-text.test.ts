// A refused Postgres connection on a dual-stack host rejects with an AggregateError whose
// own `message` is EMPTY — the detail is on its inner errors (ECONNREFUSED ::1 and
// 127.0.0.1). Printing `.message` gave `meta migrate apply-pending: apply failed: ` with
// nothing after it, in the adopter-estate release gate.
import { describe, test, expect } from "bun:test";
import { describeError } from "../../src/lib/error-text.js";

describe("describeError", () => {
  test("an ordinary error is its message", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  test("an AggregateError with no message names its inner errors", () => {
    const inner = (addr: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${addr}:55440`), { code: "ECONNREFUSED" });
    const agg = Object.assign(new AggregateError([inner("::1"), inner("127.0.0.1")], ""), { code: "ECONNREFUSED" });
    const text = describeError(agg);
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("127.0.0.1:55440");
    expect(text).toContain("::1:55440");
  });

  test("an error with no message falls back to its code, then its name", () => {
    expect(describeError(Object.assign(new Error(""), { code: "ETIMEDOUT" }))).toBe("ETIMEDOUT");
    expect(describeError(new TypeError(""))).toBe("TypeError");
  });

  test("a thrown non-Error is stringified", () => {
    expect(describeError("plain string")).toBe("plain string");
    expect(describeError(undefined)).toBe("undefined");
  });
});
