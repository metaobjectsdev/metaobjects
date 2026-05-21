import { describe, test, expect } from "bun:test";
import { buildFilterQs } from "../../src/tanstack/filter-builder.js";

describe("buildFilterQs", () => {
  test("bare value", () => {
    const qs = buildFilterQs({ email: "x@y.com" });
    expect(qs).toContain("filter[email]");
    expect(qs).toContain("x%40y.com");
  });

  test("object value with op", () => {
    const qs = buildFilterQs({ email: { like: "%@x.com" } });
    expect(qs).toContain("filter[email][like]");
  });

  test("or composition", () => {
    const qs = buildFilterQs({ or: [{ email: { like: "%@x.com" } }, { email: { like: "%@y.com" } }] });
    expect(qs).toMatch(/filter\[or\]\[0\]\[email\]\[like\]/);
    expect(qs).toMatch(/filter\[or\]\[1\]\[email\]\[like\]/);
  });

  test("and composition", () => {
    const qs = buildFilterQs({ and: [{ status: "active" }, { amountCents: { gte: 100 } }] });
    expect(qs).toMatch(/filter\[and\]\[0\]\[status\]/);
    expect(qs).toMatch(/filter\[and\]\[1\]\[amountCents\]\[gte\]/);
  });

  test("sort param stays unbracketed", () => {
    const qs = buildFilterQs({ sort: "createdAt:desc" });
    expect(qs).toContain("sort=createdAt%3Adesc");
  });

  test("limit + offset stay unbracketed", () => {
    const qs = buildFilterQs({ limit: 25, offset: 50 });
    expect(qs).toContain("limit=25");
    expect(qs).toContain("offset=50");
    expect(qs).not.toContain("filter[limit]");
    expect(qs).not.toContain("filter[offset]");
  });

  test("mixed: filter fields + limit + sort", () => {
    const qs = buildFilterQs({
      email: { like: "%@x.com" },
      sort: "createdAt:desc",
      limit: 25,
    });
    expect(qs).toContain("filter[email][like]");
    expect(qs).toContain("sort=createdAt");
    expect(qs).toContain("limit=25");
  });

  test("emits withCount as a top-level qs param when present", () => {
    const result = buildFilterQs({ limit: 10, offset: 0, withCount: 1 });
    expect(result).toContain("withCount=1");
    // withCount must not appear nested under filter[]
    expect(result).not.toContain("filter%5BwithCount%5D");
    expect(result).not.toContain("filter[withCount]");
  });

  test("omits withCount when not present (no key, not 'withCount=undefined')", () => {
    const result = buildFilterQs({ limit: 10 });
    expect(result).not.toMatch(/(^|&)withCount(=|&|$)/);
  });

  test("emits search as a top-level qs param when present", () => {
    const result = buildFilterQs({ search: "alpha", limit: 10 });
    expect(result).toContain("search=alpha");
    expect(result).not.toContain("filter%5Bsearch%5D");
    expect(result).not.toContain("filter[search]");
  });

  test("omits search when undefined (no key, not 'search=undefined')", () => {
    const result = buildFilterQs({ limit: 10 });
    expect(result).not.toMatch(/(^|&)search(=|&|$)/);
  });
});
