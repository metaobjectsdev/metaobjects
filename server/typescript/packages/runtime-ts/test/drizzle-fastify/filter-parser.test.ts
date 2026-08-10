import { describe, test, expect } from "bun:test";
import qs from "qs";
import { parseFilterParams, likePatternToGlob, FilterParseError } from "../../src/drizzle-fastify/filter-parser.js";
import type { FilterAllowlist, SortAllowlist } from "../../src/drizzle-fastify/filter-allowlist.js";

// Minimal fake table — drizzle-orm operators just need column refs. We use plain
// Symbols as the column identities since the parser only forwards them to
// Drizzle's helpers and we check the output by presence (not exact SQL).
import { sql } from "drizzle-orm";

/**
 * Flatten all `value` strings out of a Drizzle SQL expression's queryChunks
 * tree, recursively. This lets us inspect which operators were generated
 * (e.g. "ilike" vs "like") without depending on a specific Drizzle toSQL API.
 */
function collectSqlText(expr: unknown): string {
  if (!expr || typeof expr !== "object") return "";
  const chunks = (expr as Record<string, unknown>)["queryChunks"];
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((c: unknown) => {
      if (!c || typeof c !== "object") return typeof c === "string" ? c : "";
      const v = (c as Record<string, unknown>)["value"];
      const nested = collectSqlText(c);
      return (v !== undefined ? String(v) : "") + nested;
    })
    .join("");
}

function expectFilterError(fn: () => unknown, expectedCode: string) {
  try {
    fn();
    throw new Error(`expected FilterParseError "${expectedCode}", got no error`);
  } catch (e) {
    if (!(e instanceof FilterParseError)) {
      throw new Error(`expected FilterParseError "${expectedCode}", got ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
    }
    expect(e.code).toBe(expectedCode);
  }
}
const table = {
  email:      sql.identifier("email")      as any,
  firstName:  sql.identifier("first_name") as any,
  subscribed: sql.identifier("subscribed") as any,
  createdAt:  sql.identifier("created_at") as any,
  id:         sql.identifier("id")         as any,
};

const allowlist: FilterAllowlist = {
  email:      { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string",   leadingWildcard: false },
  firstName:  { ops: ["eq", "ne", "in", "like", "isNull"], subType: "string",   leadingWildcard: false },
  subscribed: { ops: ["eq", "isNull"],                     subType: "boolean",  leadingWildcard: false },
  createdAt:  { ops: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"], subType: "datetime", leadingWildcard: false },
  id:         { ops: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"], subType: "number",   leadingWildcard: false },
};
const sortAllowlist: SortAllowlist = { email: {}, firstName: {}, subscribed: {}, createdAt: { defaultOrder: "desc" } };

function parsedQs(url: string) {
  return qs.parse(url, { ignoreQueryPrefix: true });
}

describe("parseFilterParams — happy path", () => {
  test("bare value is sugar for eq", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[email]=x@y.com"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("explicit eq", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[email][eq]=x@y.com"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("range comparison ops on a datetime field", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[createdAt][gte]=2026-01-01&filter[createdAt][lt]=2026-02-01"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("in operator with comma-list", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[id][in]=1,2,3"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("isNull operator true", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[firstName][isNull]=true"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("isNull operator false", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[firstName][isNull]=false"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("multiple top-level keys = implicit AND", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[subscribed]=true&filter[email][like]=" + encodeURIComponent("@x.com")),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("OR composition via filter[or][N]", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[or][0][email][like]=" + encodeURIComponent("@x.com") + "&filter[or][1][email][like]=" + encodeURIComponent("@y.com")),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("AND composition via filter[and][N]", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[and][0][subscribed]=true&filter[and][1][id][gte]=10"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
  });

  test("sort param maps to asc/desc", () => {
    const r = parseFilterParams({
      query: parsedQs("?sort=createdAt:desc"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.orderBy?.length).toBe(1);
  });

  test("sort default is asc when no order specified", () => {
    const r = parseFilterParams({
      query: parsedQs("?sort=email"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.orderBy?.length).toBe(1);
  });

  test("limit + offset pass through", () => {
    const r = parseFilterParams({
      query: parsedQs("?limit=25&offset=50"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.limit).toBe(25);
    expect(r.offset).toBe(50);
  });

  // Cross-port contract (ADR-0049): the `like` OP is case-SENSITIVE SQL LIKE
  // on every dialect. These two pins previously asserted the opposite
  // (ilike-on-postgres) — that dispatch was the divergence the de-blinded
  // conformance corpora now catch.
  test("like on postgres uses case-sensitive like — never ilike (ADR-0049)", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[email][like]=" + encodeURIComponent("@x.com")),
      table, allowlist, sortAllowlist, dialect: "postgres",
    });
    expect(r.where).toBeDefined();
    // Structural check: Drizzle's like places " like " as a queryChunk value.
    const sqlText = collectSqlText(r.where);
    expect(sqlText).toContain(" like ");
    expect(sqlText).not.toContain("ilike");
  });

  test("like on sqlite lowers to GLOB with a translated pattern (SQLite LIKE folds ASCII case) — ADR-0049", () => {
    const r = parseFilterParams({
      query: parsedQs("?filter[email][like]=" + encodeURIComponent("a%b_c")),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.where).toBeDefined();
    const sqlText = collectSqlText(r.where);
    expect(sqlText).toContain("GLOB");
    expect(sqlText).not.toContain("ilike");
    // The bound param carries the translated pattern.
    expect(sqlText).toContain("a*b?c");
  });

  test("likePatternToGlob translates wildcards and escapes GLOB metacharacters", () => {
    expect(likePatternToGlob("a%b_c")).toBe("a*b?c");
    // Literal GLOB metacharacters must match literally: * ? [ get wrapped in
    // single-char classes; ] is only special inside a class and passes through.
    expect(likePatternToGlob("50*[x]_?%")).toBe("50[*][[]x]?[?]*");
    expect(likePatternToGlob("")).toBe("");
  });

  test("search on postgres dispatches ilike for string fields (the TS-only ?search extension is deliberately case-insensitive)", () => {
    const r = parseFilterParams({
      query: { search: "term" },
      table, allowlist, sortAllowlist, dialect: "postgres",
    });
    expect(r.searchWhere).toBeDefined();
    const sqlText = collectSqlText(r.searchWhere);
    expect(sqlText).toContain("ilike");
    expect(sqlText).not.toContain(" like ");
  });

  test("search on sqlite dispatches like (not ilike) for string fields", () => {
    const r = parseFilterParams({
      query: { search: "term" },
      table, allowlist, sortAllowlist, dialect: "sqlite",
    });
    expect(r.searchWhere).toBeDefined();
    const sqlText = collectSqlText(r.searchWhere);
    expect(sqlText).toContain(" like ");
    expect(sqlText).not.toContain("ilike");
  });
});

describe("parseFilterParams — error paths", () => {
  test("unknown filter field → throws structured error", () => {
    expectFilterError(() => parseFilterParams({
      query: parsedQs("?filter[notReal][eq]=x"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "filter.unknown_field");
  });

  test("disallowed op for subtype → throws", () => {
    expectFilterError(() => parseFilterParams({
      query: parsedQs("?filter[email][gte]=x"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "filter.unsupported_op");
  });

  test("invalid number value → throws", () => {
    expectFilterError(() => parseFilterParams({
      query: parsedQs("?filter[id][eq]=notANumber"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "filter.invalid_value");
  });

  test("invalid boolean value → throws", () => {
    expectFilterError(() => parseFilterParams({
      query: parsedQs("?filter[subscribed][eq]=maybe"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "filter.invalid_value");
  });

  test("in list too large → throws", () => {
    const huge = Array.from({ length: 101 }, (_, i) => i).join(",");
    expectFilterError(() => parseFilterParams({
      query: parsedQs(`?filter[id][in]=${huge}`),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "filter.in_too_large");
  });

  test("leading wildcard like → throws (not opted in)", () => {
    expectFilterError(() => parseFilterParams({
      query: parsedQs("?filter[email][like]=" + encodeURIComponent("%foo")),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "filter.leading_wildcard_disallowed");
  });

  test("excessive nesting → throws", () => {
    // Build a nested filter past depth 5.
    let nested: any = { email: "x@y.com" };
    for (let i = 0; i < 7; i++) nested = { or: [nested] };
    expectFilterError(() => parseFilterParams({
      query: { filter: nested } as any,
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "filter.nesting_too_deep");
  });

  test("unknown sort field → throws", () => {
    expectFilterError(() => parseFilterParams({
      query: parsedQs("?sort=notReal:asc"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "sort.unknown_field");
  });

  test("invalid sort order → throws", () => {
    expectFilterError(() => parseFilterParams({
      query: parsedQs("?sort=email:bogus"),
      table, allowlist, sortAllowlist, dialect: "sqlite",
    }), "sort.invalid_order");
  });
});
