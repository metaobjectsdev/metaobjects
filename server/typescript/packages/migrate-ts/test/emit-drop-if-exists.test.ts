// Forward drops must tolerate an absent object so a committed chain replays into
// an empty database (#313). Down statements must NOT — `rollbackTo` runs down.sql
// and the ledger delete in one transaction, so a silently-no-op down would record
// the rollback as done.
import { describe, test, expect } from "bun:test";
import { renderPostgres } from "../src/emit/postgres.js";
import { renderSqlite } from "../src/emit/sqlite.js";
import type { ChangeStatus, SchemaSnapshot, TableDescriptor } from "../src/types.js";

const ALLOWED: ChangeStatus = { state: "allowed" };

const GONE: TableDescriptor = {
  name: "gone",
  columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
  indexes: [],
  foreignKeys: [],
  checks: [],
  primaryKey: ["id"],
};

describe("forward drops tolerate an absent object (#313)", () => {
  test("postgres drop-table", () => {
    const { up } = renderPostgres([{ kind: "drop-table", table: "gone", status: ALLOWED }]);
    expect(up).toContain('DROP TABLE IF EXISTS "gone";');
  });

  test("postgres drop-view", () => {
    const { up } = renderPostgres([{ kind: "drop-view", view: "v_gone", status: ALLOWED }]);
    expect(up).toContain('DROP VIEW IF EXISTS "v_gone";');
  });

  test("postgres drop-index, plain", () => {
    const { up } = renderPostgres([
      { kind: "drop-index", table: "t", index: "idx_gone", status: ALLOWED },
    ]);
    expect(up).toContain('DROP INDEX IF EXISTS "idx_gone";');
  });

  test("postgres drop-index, constraint-backed (#285)", () => {
    const { up } = renderPostgres([
      {
        kind: "drop-index",
        table: "t",
        index: "uq_gone",
        status: ALLOWED,
        restore: { name: "uq_gone", columns: ["a"], unique: true, constraint: "unique" },
      },
    ]);
    expect(up).toContain('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "uq_gone";');
  });

  test("postgres drop-fk", () => {
    const { up } = renderPostgres([{ kind: "drop-fk", table: "t", fk: "fk_gone", status: ALLOWED }]);
    expect(up).toContain('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "fk_gone";');
  });

  // drop-check IS produced by the diff (diff/index.ts:579, :592) — an evolved
  // `field.enum @values` is a live producer. The `renderUp` comment that claimed
  // otherwise is deleted by this change.
  test("postgres drop-check", () => {
    const { up } = renderPostgres([
      { kind: "drop-check", table: "t", check: "t_qty_chk", status: ALLOWED },
    ]);
    expect(up).toContain('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "t_qty_chk";');
  });

  test("sqlite drop-table", () => {
    const { up } = renderSqlite([{ kind: "drop-table", table: "gone", status: ALLOWED }]);
    expect(up).toContain('DROP TABLE IF EXISTS "gone";');
  });

  test("sqlite drop-index", () => {
    const { up } = renderSqlite([
      { kind: "drop-index", table: "t", index: "idx_gone", status: ALLOWED },
    ]);
    expect(up).toContain('DROP INDEX IF EXISTS "idx_gone";');
  });

  // Already guarded before this change; pinned so a later sweep cannot un-guard it.
  test("sqlite drop-view was already guarded", () => {
    const { up } = renderSqlite([{ kind: "drop-view", view: "v_gone", status: ALLOWED }]);
    expect(up).toContain('DROP VIEW IF EXISTS "v_gone";');
  });
});

describe("down statements stay bare — a rollback must fail loudly", () => {
  test("postgres create-table down", () => {
    const { down } = renderPostgres([{ kind: "create-table", table: GONE, status: ALLOWED }]);
    expect(down).toContain('DROP TABLE "gone";');
    expect(down).not.toContain("DROP TABLE IF EXISTS");
  });

  test("postgres create-view down", () => {
    const { down } = renderPostgres([
      {
        kind: "create-view",
        status: ALLOWED,
        view: {
          name: "v",
          sql: "SELECT 1 AS one",
          columns: [{ name: "one", sqlType: { kind: "integer", bits: 32 } }],
        },
      },
    ]);
    expect(down).toContain('DROP VIEW "v";');
    expect(down).not.toContain("DROP VIEW IF EXISTS");
  });

  test("sqlite create-table down", () => {
    const { down } = renderSqlite([{ kind: "create-table", table: GONE, status: ALLOWED }]);
    expect(down).toContain('DROP TABLE "gone";');
    expect(down).not.toContain("DROP TABLE IF EXISTS");
  });
});

describe("the recreate-and-copy rebuild drop stays bare — deliberately", () => {
  test("sqlite recreate emits a bare DROP TABLE for the table it just copied from", () => {
    const expectedSchema: SchemaSnapshot = {
      tables: [
        {
          name: "orders",
          columns: [
            { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
            { name: "amount", sqlType: { kind: "integer", bits: 64 }, nullable: false },
          ],
          indexes: [],
          foreignKeys: [],
          checks: [],
          primaryKey: ["id"],
        },
      ],
      views: [],
    };
    const { up } = renderSqlite(
      [
        {
          kind: "change-column-type",
          table: "orders",
          column: "amount",
          from: { kind: "real" },
          to: { kind: "integer", bits: 64 },
          status: ALLOWED,
        },
      ],
      expectedSchema,
    );
    // IF EXISTS here would turn a caught corruption into a silent one: the recipe
    // just INSERT…SELECTed out of this exact table.
    expect(up).toContain('DROP TABLE "orders";');
    expect(up).not.toContain('DROP TABLE IF EXISTS "orders";');
  });
});
