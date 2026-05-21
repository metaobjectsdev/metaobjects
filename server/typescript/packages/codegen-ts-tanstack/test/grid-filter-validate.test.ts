import { describe, test, expect } from "bun:test";
import { validateGridFilter } from "../src/grid-filter-validate.js";
import type { FilterAllowlist } from "../src/grid-filter-validate.js";

const allowlist: FilterAllowlist = {
  email:      { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string",  leadingWildcard: false },
  subscribed: { ops: ["eq", "isNull"],                     subType: "boolean", leadingWildcard: false },
};

describe("validateGridFilter", () => {
  test("valid filter passes", () => {
    const errors = validateGridFilter({ subscribed: true }, allowlist, "Subscriber.active");
    expect(errors).toEqual([]);
  });

  test("valid filter with operator passes", () => {
    const errors = validateGridFilter({ email: { like: "%@x.com" } }, allowlist, "Subscriber.active");
    expect(errors).toEqual([]);
  });

  test("unknown field → error", () => {
    const errors = validateGridFilter({ notReal: "x" }, allowlist, "Subscriber.active");
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("notReal");
    expect(errors[0]).toContain("Subscriber.active");
  });

  test("disallowed op → error", () => {
    const errors = validateGridFilter({ email: { gte: "x" } }, allowlist, "Subscriber.active");
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("email.gte");
  });

  test("OR composition recurses", () => {
    const errors = validateGridFilter(
      { or: [{ subscribed: true }, { notReal: "x" }] },
      allowlist,
      "Subscriber.test",
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("notReal");
  });

  test("AND composition recurses", () => {
    const errors = validateGridFilter(
      { and: [{ subscribed: true }, { email: { gte: "x" } }] },
      allowlist,
      "Subscriber.test",
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("email.gte");
  });
});
