import { describe, test, expect } from "bun:test";
import qsLib from "qs";
import { buildFilterQs } from "../src/filter-qs.js";

// The shape assertions below read the DECODED query — the bracket grammar is the contract,
// and whether a bracket travels as `[` or `%5B` is transport. The transport is pinned once,
// on its own, in the RFC 3986 block at the bottom.
const decoded = (s: string) => decodeURIComponent(s);

describe("buildFilterQs", () => {
  test("bare value", () => {
    const qs = buildFilterQs({ email: "x@y.com" });
    expect(decoded(qs)).toContain("filter[email]");
    expect(qs).toContain("x%40y.com");
  });

  test("object value with op", () => {
    const qs = buildFilterQs({ email: { like: "%@x.com" } });
    expect(decoded(qs)).toContain("filter[email][like]");
  });

  test("or composition", () => {
    const qs = buildFilterQs({ or: [{ email: { like: "%@x.com" } }, { email: { like: "%@y.com" } }] });
    expect(decoded(qs)).toMatch(/filter\[or\]\[0\]\[email\]\[like\]/);
    expect(decoded(qs)).toMatch(/filter\[or\]\[1\]\[email\]\[like\]/);
  });

  test("and composition", () => {
    const qs = buildFilterQs({ and: [{ status: "active" }, { amountCents: { gte: 100 } }] });
    expect(decoded(qs)).toMatch(/filter\[and\]\[0\]\[status\]/);
    expect(decoded(qs)).toMatch(/filter\[and\]\[1\]\[amountCents\]\[gte\]/);
  });

  test("sort param stays unbracketed", () => {
    const qs = buildFilterQs({ sort: "createdAt:desc" });
    expect(qs).toContain("sort=createdAt%3Adesc");
  });

  test("limit + offset stay unbracketed", () => {
    const qs = buildFilterQs({ limit: 25, offset: 50 });
    expect(qs).toContain("limit=25");
    expect(qs).toContain("offset=50");
    expect(decoded(qs)).not.toContain("filter[limit]");
    expect(decoded(qs)).not.toContain("filter[offset]");
  });

  test("mixed: filter fields + limit + sort", () => {
    const qs = buildFilterQs({
      email: { like: "%@x.com" },
      sort: "createdAt:desc",
      limit: 25,
    });
    expect(decoded(qs)).toContain("filter[email][like]");
    expect(qs).toContain("sort=createdAt");
    expect(qs).toContain("limit=25");
  });

  test("emits withCount as a top-level qs param when present", () => {
    const result = buildFilterQs({ limit: 10, offset: 0, withCount: 1 });
    expect(result).toContain("withCount=1");
    // withCount must not appear nested under filter[]
    expect(decoded(result)).not.toContain("filter[withCount]");
  });

  test("omits withCount when not present (no key, not 'withCount=undefined')", () => {
    const result = buildFilterQs({ limit: 10 });
    expect(result).not.toMatch(/(^|&)withCount(=|&|$)/);
  });

  test("emits search as a top-level qs param when present", () => {
    const result = buildFilterQs({ search: "alpha", limit: 10 });
    expect(result).toContain("search=alpha");
    expect(decoded(result)).not.toContain("filter[search]");
  });

  test("omits search when undefined (no key, not 'search=undefined')", () => {
    const result = buildFilterQs({ limit: 10 });
    expect(result).not.toMatch(/(^|&)search(=|&|$)/);
  });
});

// RFC 3986 §3.4 admits no `[` or `]` in a query component — they are gen-delims — and
// Tomcat, the default server of every Spring Boot app, enforces that: a raw bracket gets
// its own HTML 400 before any application code runs. The generated Java and Kotlin
// controllers therefore could not serve a single filtered request from this client, which
// sent `filter[email][like]=` with the brackets raw (`encodeValuesOnly`). A browser does not
// rescue it: the WHATWG URL parser leaves brackets in a query unencoded too.
describe("buildFilterQs — the URL it produces is RFC 3986-valid", () => {
  const cases: Record<string, unknown>[] = [
    { email: "x@y.com" },
    { email: { like: "%@x.com" } },
    { or: [{ email: { like: "%@x.com" } }, { status: { in: ["a", "b"] } }] },
    { and: [{ status: "active" }, { amountCents: { gte: 100 } }], sort: "createdAt:desc", limit: 5 },
  ];

  test("no raw bracket anywhere in the output", () => {
    for (const c of cases) expect(buildFilterQs(c)).not.toMatch(/[[\]]/);
  });

  test("a server's qs.parse reads back exactly the filter it was given", () => {
    for (const c of cases) {
      const { limit, sort, ...rest } = c as Record<string, unknown>;
      const parsed = qsLib.parse(buildFilterQs(c)) as Record<string, unknown>;
      expect(parsed.filter).toEqual(JSON.parse(JSON.stringify(rest, (_k, v) =>
        typeof v === "number" ? String(v) : v)));
      if (sort !== undefined) expect(parsed.sort).toBe(sort);
      if (limit !== undefined) expect(parsed.limit).toBe(String(limit));
    }
  });
});
