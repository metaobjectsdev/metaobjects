import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import type { Change, ColumnDescriptor, TableDescriptor, SchemaSnapshot, SnapshotMeta } from "../../src/types.js";

const ALLOWED = { state: "allowed" as const };

function table(name: string, cols: ColumnDescriptor[], pk: string[] = []): TableDescriptor {
  return { name, columns: cols, indexes: [], foreignKeys: [], primaryKey: pk, checks: [] };
}
function norm(s: string): string {
  return s.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
}

describe("renderSqlite — create-table", () => {
  test("simple table with INTEGER PK AUTOINCREMENT", () => {
    const cols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "email", sqlType: { kind: "text" }, nullable: false },
      { name: "is_active", sqlType: { kind: "boolean" }, nullable: false,
        default: { kind: "literal", value: "1" } },
    ];
    const changes: Change[] = [{ kind: "create-table", table: table("users", cols, ["id"]), status: ALLOWED }];
    const { up } = emit(changes, { dialect: "sqlite" });
    // NOTE: was `DEFAULT '1'`. A quoted literal on a BOOLEAN column (NUMERIC affinity)
    // only worked by accident — SQLite coerces the numeric-looking string '1' to 1. The
    // same path emitted `DEFAULT 'false'` for a boolean false, which is NOT coercible and
    // got stored as TEXT, silently breaking `col = 0`. Defaults are now rendered per the
    // column's SQL type; see emit-sqlite-typed-defaults.test.ts.
    expect(norm(up)).toBe(norm(`
      CREATE TABLE "users" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        "email" TEXT NOT NULL,
        "is_active" BOOLEAN NOT NULL DEFAULT 1
      );
    `));
  });

  test("uuid identity uses TEXT + DEFAULT (uuid())", () => {
    const cols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "uuid" }, nullable: false, identity: "uuid" },
    ];
    const { up } = emit([{ kind: "create-table", table: table("u", cols, ["id"]), status: ALLOWED }], { dialect: "sqlite" });
    expect(up).toContain("TEXT");
    // SQLite has no native uuid(); we emit a placeholder hex(randomblob(16))-style default.
    expect(up).toMatch(/DEFAULT \(/);
  });

  test("composite PK rendered as table-level constraint", () => {
    const cols: ColumnDescriptor[] = [
      { name: "a", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      { name: "b", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    ];
    const { up } = emit([{ kind: "create-table", table: table("t", cols, ["a", "b"]), status: ALLOWED }], { dialect: "sqlite" });
    expect(up).toContain('PRIMARY KEY ("a", "b")');
  });
});

describe("renderSqlite — table-level + indexes", () => {
  test("drop-table", () => {
    const { up } = emit([{ kind: "drop-table", table: "old", status: ALLOWED }], { dialect: "sqlite" });
    expect(norm(up)).toBe(`DROP TABLE "old";`);
  });
  test("rename-table", () => {
    const { up } = emit([{ kind: "rename-table", from: "p", to: "a", status: ALLOWED }], { dialect: "sqlite" });
    expect(norm(up)).toBe(`ALTER TABLE "p" RENAME TO "a";`);
  });
  test("add-index unique", () => {
    const { up } = emit([{
      kind: "add-index", table: "u",
      index: { name: "u_e_uniq", columns: ["e"], unique: true },
      status: ALLOWED,
    }], { dialect: "sqlite" });
    expect(norm(up)).toBe(`CREATE UNIQUE INDEX "u_e_uniq" ON "u" ("e");`);
  });
  test("drop-index", () => {
    const { up } = emit([{ kind: "drop-index", table: "u", index: "i", status: ALLOWED }], { dialect: "sqlite" });
    expect(norm(up)).toBe(`DROP INDEX "i";`);
  });
});

describe("renderSqlite — column changes (native, modern SQLite)", () => {
  test("add-column nullable text", () => {
    const { up } = emit([{
      kind: "add-column", table: "u",
      column: { name: "phone", sqlType: { kind: "text" }, nullable: true },
      status: ALLOWED,
    }], { dialect: "sqlite" });
    expect(norm(up)).toBe(`ALTER TABLE "u" ADD COLUMN "phone" TEXT;`);
  });

  test("drop-column native (assumes SQLite ≥ 3.35)", () => {
    const { up } = emit([{
      kind: "drop-column", table: "u", column: "legacy",
      status: ALLOWED,
    }], { dialect: "sqlite" });
    expect(norm(up)).toBe(`ALTER TABLE "u" DROP COLUMN "legacy";`);
  });

  test("rename-column native (assumes SQLite ≥ 3.25)", () => {
    const { up } = emit([{
      kind: "rename-column", table: "u", from: "old", to: "new",
      status: ALLOWED,
    }], { dialect: "sqlite" });
    expect(norm(up)).toBe(`ALTER TABLE "u" RENAME COLUMN "old" TO "new";`);
  });
});

describe("renderSqlite — recreate-and-copy", () => {
  test("change-column-type triggers recreate", () => {
    const newCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "amount", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    ];
    const expectedSchema: SchemaSnapshot = {
      tables: [table("orders", newCols, ["id"])],
      views: [],
    };
    const changes: Change[] = [{
      kind: "change-column-type", table: "orders", column: "amount",
      from: { kind: "real" }, to: { kind: "integer", bits: 64 },
      status: ALLOWED,
    }];
    const { up } = emit(changes, { dialect: "sqlite", expectedSchema });
    expect(up).toContain("PRAGMA foreign_keys = OFF;");
    expect(up).toContain("BEGIN TRANSACTION;");
    expect(up).toContain('CREATE TABLE "__new_orders"');
    expect(up).toMatch(/INSERT INTO "__new_orders" \("id", "amount"\) SELECT "id", "amount" FROM "orders";/);
    expect(up).toContain('DROP TABLE "orders";');
    expect(up).toContain('ALTER TABLE "__new_orders" RENAME TO "orders";');
    expect(up).toContain("COMMIT;");
    expect(up).toContain("PRAGMA foreign_keys = ON;");
    expect(up).toContain("PRAGMA foreign_key_check;");
  });

  test("multiple changes on same table bundled into ONE recreate", () => {
    const newCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "amount", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      { name: "currency", sqlType: { kind: "text" }, nullable: false },
    ];
    const expectedSchema: SchemaSnapshot = {
      tables: [table("orders", newCols, ["id"])],
      views: [],
    };
    const changes: Change[] = [
      { kind: "change-column-type", table: "orders", column: "amount",
        from: { kind: "real" }, to: { kind: "integer", bits: 64 }, status: ALLOWED },
      { kind: "change-column-nullable", table: "orders", column: "currency",
        from: true, to: false, status: ALLOWED },
    ];
    const { up } = emit(changes, { dialect: "sqlite", expectedSchema });
    // Should appear once.
    const recreateCount = (up.match(/CREATE TABLE "__new_orders"/g) ?? []).length;
    expect(recreateCount).toBe(1);
  });

  test("column-rename in recreate maps old → new in INSERT/SELECT", () => {
    const newCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "first_name", sqlType: { kind: "text" }, nullable: false },
    ];
    const expectedSchema: SchemaSnapshot = {
      tables: [table("users", newCols, ["id"])],
      views: [],
    };
    const changes: Change[] = [
      { kind: "rename-column", table: "users", from: "firstname", to: "first_name", status: ALLOWED },
      // Trigger a recreate via a default change on the same table:
      { kind: "change-column-default", table: "users", column: "first_name",
        to: { kind: "literal", value: "anonymous" }, status: ALLOWED },
    ];
    const { up } = emit(changes, { dialect: "sqlite", expectedSchema });
    // INSERT target uses new name "first_name"; SELECT source uses old name "firstname".
    expect(up).toMatch(/INSERT INTO "__new_users" \("id", "first_name"\) SELECT "id", "firstname" FROM "users";/);
  });

  test("recreate without expectedSchema throws helpful error", () => {
    const changes: Change[] = [{
      kind: "change-column-type", table: "x", column: "c",
      from: { kind: "text" }, to: { kind: "integer", bits: 64 }, status: ALLOWED,
    }];
    expect(() => emit(changes, { dialect: "sqlite" })).toThrow(/expectedSchema required/);
  });
});

describe("renderSqlite — version-aware fallback", () => {
  test("SQLite 3.20 (no DROP COLUMN, no RENAME COLUMN): drop-column falls back to recreate", () => {
    const newCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
    ];
    const expectedSchema: SchemaSnapshot = { tables: [table("u", newCols, ["id"])], views: [] };
    const { up } = emit(
      [{ kind: "drop-column", table: "u", column: "legacy", status: ALLOWED }],
      { dialect: "sqlite", expectedSchema, actualMeta: { sqliteVersion: "3.20.1" } },
    );
    expect(up).toContain("BEGIN TRANSACTION;");
    expect(up).toContain('CREATE TABLE "__new_u"');
    // Native ALTER should NOT be emitted.
    expect(up).not.toMatch(/ALTER TABLE "u" DROP COLUMN/);
  });

  test("SQLite 3.30 (has RENAME COLUMN, no DROP COLUMN): rename native, drop falls back", () => {
    const newCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "new_name", sqlType: { kind: "text" }, nullable: true },
    ];
    const expectedSchema: SchemaSnapshot = { tables: [table("u", newCols, ["id"])], views: [] };
    const { up } = emit(
      [{ kind: "rename-column", table: "u", from: "old_name", to: "new_name", status: ALLOWED }],
      { dialect: "sqlite", expectedSchema, actualMeta: { sqliteVersion: "3.30.0" } },
    );
    expect(up).toContain('RENAME COLUMN "old_name" TO "new_name"');
  });

  test("Modern SQLite (3.44): both native, no recreate", () => {
    const { up } = emit(
      [{ kind: "drop-column", table: "u", column: "legacy", status: ALLOWED }],
      { dialect: "sqlite", actualMeta: { sqliteVersion: "3.44.2" } },
    );
    expect(up).toContain('ALTER TABLE "u" DROP COLUMN "legacy"');
    expect(up).not.toContain("BEGIN TRANSACTION;");
  });

  test("No actualMeta given: assume modern SQLite (libsql/Turso default)", () => {
    const { up } = emit(
      [{ kind: "drop-column", table: "u", column: "x", status: ALLOWED }],
      { dialect: "sqlite" },
    );
    expect(up).toContain('ALTER TABLE "u" DROP COLUMN');
  });
});

describe("renderSqlite — down statements (native)", () => {
  test("create-table down → drop-table", () => {
    const cols: ColumnDescriptor[] = [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }];
    const { down } = emit([{ kind: "create-table", table: table("u", cols, ["id"]), status: ALLOWED }], { dialect: "sqlite" });
    expect(down).toContain('DROP TABLE "u"');
  });

  test("rename-column down → reverse rename", () => {
    const { down } = emit([{ kind: "rename-column", table: "u", from: "a", to: "b", status: ALLOWED }], { dialect: "sqlite" });
    expect(down).toContain('RENAME COLUMN "b" TO "a"');
  });

  test("drop-column down → WARNING comment", () => {
    const { down } = emit([{ kind: "drop-column", table: "u", column: "x", status: ALLOWED }], { dialect: "sqlite" });
    expect(down).toContain("WARNING");
  });
});

describe("renderSqlite — add-fk / drop-fk via recreate", () => {
  test("add-fk triggers recreate-and-copy", () => {
    const newCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "program_id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    ];
    const newTable = {
      name: "weeks", columns: newCols, primaryKey: ["id"],
      indexes: [],
      foreignKeys: [{ name: "weeks_program_id_fk", columns: ["program_id"], refTable: "programs", refColumns: ["id"] }],
      checks: [],
    };
    const expectedSchema: SchemaSnapshot = { tables: [newTable], views: [] };
    const { up } = emit(
      [{ kind: "add-fk", table: "weeks", fk: newTable.foreignKeys[0]!, status: ALLOWED }],
      { dialect: "sqlite", expectedSchema },
    );
    expect(up).toContain('CREATE TABLE "__new_weeks"');
    expect(up).toContain('REFERENCES "programs"');
  });

  test("drop-fk triggers recreate-and-copy (FK must be absent in newTable)", () => {
    const newCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "program_id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    ];
    const expectedSchema: SchemaSnapshot = {
      tables: [table("weeks", newCols, ["id"])],
      views: [],
    };
    const { up } = emit(
      [{ kind: "drop-fk", table: "weeks", fk: "weeks_program_id_fk", status: ALLOWED }],
      { dialect: "sqlite", expectedSchema },
    );
    expect(up).toContain('CREATE TABLE "__new_weeks"');
    expect(up).not.toContain('REFERENCES');
  });

  // #255 — drop-fk + drop-column on the SAME table both fold into ONE
  // recreate-and-copy bundle regardless of STAGE_ORDER (bundling is by table,
  // not by kind order), so the correct outcome — recreated table missing both
  // the FK and the dropped column — already held pre-fix here. This pins that
  // invariant so a future bundling change can't silently regress it.
  test("drop-fk + drop-column on the same table: recreated table has neither (#255)", () => {
    const newCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
    ];
    const expectedSchema: SchemaSnapshot = {
      tables: [table("weeks", newCols, ["id"])],
      views: [],
    };
    const { up } = emit(
      [
        { kind: "drop-column", table: "weeks", column: "program_id", status: ALLOWED },
        { kind: "drop-fk", table: "weeks", fk: "weeks_program_id_fk", status: ALLOWED },
      ],
      { dialect: "sqlite", expectedSchema },
    );
    expect(up).toContain('CREATE TABLE "__new_weeks"');
    expect(up).not.toContain("REFERENCES");
    expect(up).not.toContain("program_id");
  });

  // #255 — the STAGE_ORDER-observable case for SQLite: a drop-fk on table B
  // (always recreate-triggering) must sequence BEFORE a native drop-column on
  // an unrelated table A that the dropped FK used to reference. Pre-fix,
  // drop-column (stage 2) sorted before drop-fk (stage 5), so table A's
  // column drop ran while table B's schema still declared the FK against it.
  test("drop-fk on one table runs before a native drop-column on another table it referenced (#255)", () => {
    const newProgramsCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
    ];
    const newWeeksCols: ColumnDescriptor[] = [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
    ];
    const expectedSchema: SchemaSnapshot = {
      tables: [
        table("programs", newProgramsCols, ["id"]),
        table("weeks", newWeeksCols, ["id"]),
      ],
      views: [],
    };
    const { up } = emit(
      [
        // drop-column on "programs" (native — not recreate-triggering on modern SQLite)
        { kind: "drop-column", table: "programs", column: "code", status: ALLOWED },
        // drop-fk on "weeks" (always recreate-triggering)
        { kind: "drop-fk", table: "weeks", fk: "weeks_program_code_fk", status: ALLOWED },
      ],
      { dialect: "sqlite", expectedSchema },
    );
    const idxWeeksRecreate = up.indexOf('CREATE TABLE "__new_weeks"');
    const idxProgramsDropColumn = up.indexOf('ALTER TABLE "programs" DROP COLUMN "code"');
    expect(idxWeeksRecreate).toBeGreaterThanOrEqual(0);
    expect(idxProgramsDropColumn).toBeGreaterThanOrEqual(0);
    expect(idxWeeksRecreate).toBeLessThan(idxProgramsDropColumn);
  });
});
