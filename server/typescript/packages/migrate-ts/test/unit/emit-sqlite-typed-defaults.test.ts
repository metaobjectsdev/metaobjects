/**
 * SQLite literal defaults must be rendered according to the column's declared
 * SQL type — NOT blindly single-quoted.
 *
 * The bug: `renderDefault` quoted every `kind: "literal"` value with no reference
 * to `sqlType`, so a `field.boolean { @default: false }` emitted
 * `... BOOLEAN NOT NULL DEFAULT 'false'`. SQLite cannot coerce the non-numeric
 * string `'false'` under NUMERIC/INTEGER affinity, so any row reaching the column
 * default stores TEXT `'false'` instead of 0 — and a later `col = 0` filter
 * silently misses those rows. Numeric defaults hit the same quoting path
 * (`DEFAULT '0'`) and were merely *invisible*, because affinity happily coerces a
 * numeric-looking string — which is exactly why this sat unnoticed.
 *
 * Reported by a downstream consumer against 0.15.20.
 */
import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import type { Change, ColumnDescriptor, TableDescriptor } from "../../src/types.js";

const ALLOWED = { state: "allowed" as const };

function table(name: string, cols: ColumnDescriptor[], pk: string[] = []): TableDescriptor {
  return { name, columns: cols, indexes: [], foreignKeys: [], primaryKey: pk, checks: [] };
}
function ddl(col: ColumnDescriptor): string {
  const changes: Change[] = [{ kind: "create-table", table: table("t", [col]), status: ALLOWED }];
  return emit(changes, { dialect: "sqlite" }).up;
}

describe("emit sqlite — literal defaults are rendered per the column's SQL type", () => {
  test("boolean @default false → unquoted 0 (a quoted 'false' would be stored as TEXT)", () => {
    const sql = ddl({
      name: "is_primary", sqlType: { kind: "boolean" }, nullable: false,
      default: { kind: "literal", value: "false" },
    });
    expect(sql).toContain("DEFAULT 0");
    expect(sql).not.toContain("DEFAULT 'false'");
  });

  test("boolean @default true → unquoted 1", () => {
    const sql = ddl({
      name: "is_active", sqlType: { kind: "boolean" }, nullable: false,
      default: { kind: "literal", value: "true" },
    });
    expect(sql).toContain("DEFAULT 1");
    expect(sql).not.toContain("DEFAULT 'true'");
  });

  test("integer @default 0 → unquoted numeric (no reliance on affinity coercion)", () => {
    const sql = ddl({
      name: "sort_order", sqlType: { kind: "integer", bits: 64 }, nullable: false,
      default: { kind: "literal", value: "0" },
    });
    expect(sql).toContain("DEFAULT 0");
    expect(sql).not.toContain("DEFAULT '0'");
  });

  test("real/numeric defaults are unquoted too", () => {
    expect(ddl({
      name: "ratio", sqlType: { kind: "real" }, nullable: false,
      default: { kind: "literal", value: "1.5" },
    })).toContain("DEFAULT 1.5");
    expect(ddl({
      name: "amount", sqlType: { kind: "numeric", precision: 10, scale: 2 }, nullable: false,
      default: { kind: "literal", value: "-2.50" },
    })).toContain("DEFAULT -2.50");
  });

  test("text default is still quoted, and embedded quotes still escaped", () => {
    const sql = ddl({
      name: "label", sqlType: { kind: "text" }, nullable: false,
      default: { kind: "literal", value: "it's" },
    });
    expect(sql).toContain("DEFAULT 'it''s'");
  });

  test("expr default is never quoted (unchanged)", () => {
    const sql = ddl({
      name: "created_at", sqlType: { kind: "timestamp", withTimezone: false }, nullable: false,
      default: { kind: "expr", value: "CURRENT_TIMESTAMP" },
    });
    expect(sql).toContain("DEFAULT CURRENT_TIMESTAMP");
  });

  test("defensive: a non-numeric literal on a numeric column falls back to quoting (never emit bare garbage)", () => {
    const sql = ddl({
      name: "weird", sqlType: { kind: "integer", bits: 64 }, nullable: true,
      default: { kind: "literal", value: "not-a-number" },
    });
    expect(sql).toContain("DEFAULT 'not-a-number'");
  });
});
