// A committed chain must apply to a VIRGIN database (#313). `CREATE TABLE "s"."x"`
// fails there unless the schema exists, and no migration has ever created one —
// `CREATE SCHEMA` appears nowhere in the emitters, only in the ledger's own setup.
import { describe, test, expect } from "bun:test";
import { renderPostgres } from "../src/emit/postgres.js";
import type { ChangeStatus, TableDescriptor, ViewDescriptor } from "../src/types.js";

const ALLOWED: ChangeStatus = { state: "allowed" };

const t = (name: string, schema?: string): TableDescriptor => ({
  name,
  ...(schema !== undefined ? { schema } : {}),
  columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
  indexes: [],
  foreignKeys: [],
  checks: [],
  primaryKey: ["id"],
});

const v = (name: string, schema?: string): ViewDescriptor => ({
  name,
  ...(schema !== undefined ? { schema } : {}),
  sql: "SELECT 1 AS one",
  columns: [{ name: "one", sqlType: { kind: "integer", bits: 32 } }],
});

describe("a chain that creates an object in a non-default schema creates the schema first", () => {
  test("emits CREATE SCHEMA IF NOT EXISTS before the table", () => {
    const { up } = renderPostgres([{ kind: "create-table", table: t("x", "reporting"), status: ALLOWED }]);
    expect(up).toContain('CREATE SCHEMA IF NOT EXISTS "reporting";');
    expect(up.indexOf('CREATE SCHEMA IF NOT EXISTS "reporting";')).toBeLessThan(up.indexOf("CREATE TABLE"));
  });

  // The spec says "the first OBJECT", not "the first table": a chain whose first
  // migration creates only a view in a non-default schema fails identically.
  test("emits it for a create-view too", () => {
    const { up } = renderPostgres([{ kind: "create-view", view: v("v_x", "reporting"), status: ALLOWED }]);
    expect(up).toContain('CREATE SCHEMA IF NOT EXISTS "reporting";');
    expect(up.indexOf('CREATE SCHEMA IF NOT EXISTS "reporting";')).toBeLessThan(up.indexOf("CREATE VIEW"));
  });

  // `create-view` carries the schema in two places; the change's own key wins, the
  // same precedence renderCreateView already uses.
  test("a create-view's own schema key wins over the descriptor's", () => {
    const { up } = renderPostgres([
      { kind: "create-view", view: v("v_x", "descriptor_schema"), schema: "change_schema", status: ALLOWED },
    ]);
    expect(up).toContain('CREATE SCHEMA IF NOT EXISTS "change_schema";');
    expect(up).not.toContain('CREATE SCHEMA IF NOT EXISTS "descriptor_schema";');
  });

  test("emits it once for several objects in the same schema", () => {
    const { up } = renderPostgres([
      { kind: "create-table", table: t("x", "reporting"), status: ALLOWED },
      { kind: "create-table", table: t("y", "reporting"), status: ALLOWED },
      { kind: "create-view", view: v("v_x", "reporting"), status: ALLOWED },
    ]);
    expect(up.match(/CREATE SCHEMA IF NOT EXISTS "reporting";/g)).toHaveLength(1);
  });

  test("emits one per distinct schema, in sorted order", () => {
    const { up } = renderPostgres([
      { kind: "create-table", table: t("x", "zeta"), status: ALLOWED },
      { kind: "create-table", table: t("y", "alpha"), status: ALLOWED },
    ]);
    expect(up.indexOf('CREATE SCHEMA IF NOT EXISTS "alpha";'))
      .toBeLessThan(up.indexOf('CREATE SCHEMA IF NOT EXISTS "zeta";'));
  });

  test("emits nothing for the default schema", () => {
    const { up } = renderPostgres([{ kind: "create-table", table: t("x"), status: ALLOWED }]);
    expect(up).not.toContain("CREATE SCHEMA");
  });

  test("emits nothing for an explicit 'public'", () => {
    const { up } = renderPostgres([{ kind: "create-table", table: t("x", "public"), status: ALLOWED }]);
    expect(up).not.toContain("CREATE SCHEMA");
  });

  // Not filler: dropping a schema on rollback would destroy objects this tool does
  // not own and cannot restore.
  test("the down does NOT drop the schema", () => {
    const { down } = renderPostgres([{ kind: "create-table", table: t("x", "reporting"), status: ALLOWED }]);
    expect(down).not.toContain("DROP SCHEMA");
  });

  // A migration that only DROPS from a schema must not resurrect it.
  test("a drop-only migration emits no CREATE SCHEMA", () => {
    const { up } = renderPostgres([
      { kind: "drop-table", table: "x", schema: "reporting", status: ALLOWED },
    ]);
    expect(up).not.toContain("CREATE SCHEMA");
  });
});
