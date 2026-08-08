/**
 * Adopting MetaObjects metadata onto an EXISTING Postgres table whose PK was
 * created as `serial` (Drizzle's `serial().primaryKey()`, Prisma's
 * `autoincrement()`, Rails, SQLAlchemy, or plain `id SERIAL PRIMARY KEY` — the
 * single most common pre-adoption shape) made `meta migrate --from-db` propose:
 *
 *   ALTER TABLE "work_item" ALTER COLUMN "id" DROP DEFAULT;
 *
 * with NO replacement generation mechanism emitted in the same migration.
 * Applying it leaves `id` NOT NULL with nothing to populate it, so every insert
 * that does not explicitly supply `id` starts failing — destructive against a
 * live table, and it fires on the first thing a new adopter does.
 *
 * Root cause: the expected side (identity: "increment") deliberately declares
 * no `@default` (identity generation is modeled via `identity`, not `default` —
 * see the sibling uuid comment in diff/index.ts), but a live legacy Postgres
 * `serial` column IS backed by a genuine `DEFAULT nextval(...)` clause — unlike
 * SQLite AUTOINCREMENT or a modern `GENERATED ... AS IDENTITY` column, neither of
 * which has any DEFAULT at all. The default-diff guard was blind to that
 * distinction and reported the live `nextval(...)` default as drift.
 *
 * Reported against an adopting project.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import type { ColumnDescriptor, SchemaSnapshot } from "../../src/types.js";

function snap(col: ColumnDescriptor): SchemaSnapshot {
  return {
    tables: [{ name: "work_item", columns: [col], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }],
    views: [],
  };
}

const expectedIncrementPk: ColumnDescriptor = {
  name: "id", sqlType: { kind: "integer", bits: 32 }, nullable: false, identity: "increment",
};

async function defaultChanges(expected: ColumnDescriptor, actual: ColumnDescriptor) {
  const r = await diff(snap(expected), snap(actual));
  return r.changes.filter((c) => c.kind === "change-column-default");
}

describe("diff — legacy Postgres serial PK default is not diffed as drift", () => {
  test("live nextval(...) default on an increment PK: no change-column-default (no DROP DEFAULT)", async () => {
    const actual: ColumnDescriptor = {
      ...expectedIncrementPk,
      default: { kind: "expr", value: "nextval('work_item_id_seq'::regclass)" },
    };
    const changes = await defaultChanges(expectedIncrementPk, actual);
    expect(changes).toEqual([]);
  });

  test("an already-adopted serial-PK table is a total no-op (the real-world symptom)", async () => {
    const actual: ColumnDescriptor = {
      ...expectedIncrementPk,
      default: { kind: "expr", value: "nextval('work_item_id_seq'::regclass)" },
    };
    const r = await diff(snap(expectedIncrementPk), snap(actual));
    expect(r.changes).toEqual([]);
  });

  test("qualified sequence name (schema-qualified nextval target) is still recognized", async () => {
    const actual: ColumnDescriptor = {
      ...expectedIncrementPk,
      default: { kind: "expr", value: "nextval('public.work_item_id_seq'::regclass)" },
    };
    const changes = await defaultChanges(expectedIncrementPk, actual);
    expect(changes).toEqual([]);
  });

  test("regression guard: a genuinely wrong NON-sequence default on an increment PK is still reported", async () => {
    const actual: ColumnDescriptor = {
      ...expectedIncrementPk,
      default: { kind: "literal", value: "0" },
    };
    const changes = await defaultChanges(expectedIncrementPk, actual);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "change-column-default",
      column: "id",
      from: { kind: "literal", value: "0" },
    });
  });

  test("regression guard: a wrong FUNCTION-CALL default (not nextval) on an increment PK is still reported", async () => {
    const actual: ColumnDescriptor = {
      ...expectedIncrementPk,
      default: { kind: "expr", value: "some_other_function()" },
    };
    const changes = await defaultChanges(expectedIncrementPk, actual);
    expect(changes).toHaveLength(1);
  });

  test("no-churn: increment PK with no live default at all (SQLite AUTOINCREMENT / modern IDENTITY shape) still no-ops", async () => {
    const changes = await defaultChanges(expectedIncrementPk, expectedIncrementPk);
    expect(changes).toEqual([]);
  });
});
