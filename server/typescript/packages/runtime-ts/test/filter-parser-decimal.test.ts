// A decimal filter operand is exact text (ADR-0019 Amendment 1, W2): parsed with the JSON-number
// grammar, bound as its canonical string, never turned into a double. Drizzle's own parameter
// serialization runs over the expression, so what is asserted is what reaches the driver.

import { describe, test, expect } from "bun:test";
import { pgTable, bigserial, numeric, PgDialect } from "drizzle-orm/pg-core";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { FilterAllowlist } from "../src/drizzle-fastify/filter-allowlist.js";
import { parseFilterParams, FilterParseError } from "../src/drizzle-fastify/filter-parser.js";

const table = pgTable("entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  amount: numeric("amount", { precision: 28, scale: 10 }),
});
const allowlist: FilterAllowlist = {
  amount: { ops: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"], subType: "number", format: "decimal", leadingWildcard: false },
};

function params(dialect: "postgres" | "mysql" | "sqlite", query: Record<string, unknown>): unknown[] {
  const { where } = parseFilterParams({ query: { filter: query }, table, allowlist, sortAllowlist: {}, dialect });
  if (where === undefined) throw new Error("expected a WHERE expression");
  const d = dialect === "postgres" ? new PgDialect() : dialect === "mysql" ? new MySqlDialect() : new SQLiteSyncDialect();
  return d.sqlToQuery(where.getSQL()).params;
}

describe("decimal filter operand", () => {
  test("Postgres: the operand is bound as its canonical string, digits intact", () => {
    expect(params("postgres", { amount: { eq: "12345678901234567.89" } })).toEqual(["12345678901234567.89"]);
    expect(params("postgres", { amount: { gt: "100.500" } })).toEqual(["100.5"]);
    expect(params("postgres", { amount: { eq: "1.005e2" } })).toEqual(["100.5"]);
    expect(params("postgres", { amount: { in: "0.10,0.2" } })).toEqual(["0.1", "0.2"]);
  });

  test("MySQL: the operand is cast to a wide DECIMAL so the comparison is not made as doubles", () => {
    const { where } = parseFilterParams({ query: { filter: { amount: { eq: "12345678901234567.89" } } }, table, allowlist, sortAllowlist: {}, dialect: "mysql" });
    const q = new MySqlDialect().sqlToQuery(where!.getSQL());
    expect(q.sql).toContain("CAST(");
    expect(q.sql).toContain("DECIMAL(65,30)");
    expect(q.params).toEqual(["12345678901234567.89"]);
  });

  test("SQLite: a decimal is a double (W4), so the operand is bound as a number, not text", () => {
    expect(params("sqlite", { amount: { gt: "0.25" } })).toEqual([0.25]);
  });

  test("a bad operand is refused, naming the field", () => {
    for (const bad of ["abc", "1e", "0x10", "", " 1", "1,5"]) {
      expect(() => params("postgres", { amount: { eq: bad } })).toThrow(FilterParseError);
    }
  });
});
