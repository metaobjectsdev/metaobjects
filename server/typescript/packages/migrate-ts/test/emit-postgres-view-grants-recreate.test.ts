// A recreated view keeps its grants in BOTH directions and at BOTH levels: the DOWN migration's
// recreate carries them over too, and column privileges (pg_attribute.attacl) ride with the
// view's own — re-granted only for columns the new view still has. Runs on real Postgres
// semantics (PGlite): the SQL is applied and the privileges read back.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { emit } from "../src/emit/index.js";
import type { Change, ViewDescriptor } from "../src/types.js";

const ALLOWED = { kind: "allowed" } as unknown as Change extends { status: infer S } ? S : never;
const oldView: ViewDescriptor = { name: "v_r", sql: "SELECT a, b FROM t", dependsOn: [] };
const newView: ViewDescriptor = { name: "v_r", sql: "SELECT a, c FROM t", dependsOn: [] };

// Unproven replace: UP is DROP + CREATE; DOWN (restore present, not restorable) is too.
const change: Change = { kind: "replace-view", view: newView, restore: oldView, status: ALLOWED } as unknown as Change;

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE reader; CREATE ROLE colreader;
    CREATE TABLE t (a int, b int, c int);
    CREATE VIEW v_r AS SELECT a, b FROM t;
    GRANT SELECT ON v_r TO reader;
    GRANT SELECT (a) ON v_r TO colreader;
    GRANT SELECT (b) ON v_r TO colreader;
  `);
  return db;
}

async function grants(db: PGlite): Promise<string[]> {
  const rel = await db.query<{ g: string }>(
    `SELECT pg_get_userbyid(a.grantee) || ':' || a.privilege_type AS g
       FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'v_r'::regclass AND a.grantee <> c.relowner`,
  );
  const col = await db.query<{ g: string }>(
    `SELECT pg_get_userbyid(x.grantee) || ':' || x.privilege_type || '(' || t.attname || ')' AS g
       FROM pg_attribute t, aclexplode(t.attacl) x WHERE t.attrelid = 'v_r'::regclass AND t.attacl IS NOT NULL AND x.grantee <> (SELECT relowner FROM pg_class WHERE oid = 'v_r'::regclass)`,
  );
  return [...rel.rows, ...col.rows].map((r) => r.g).sort();
}

describe("postgres: recreated view grants, column level and the DOWN direction", () => {
  test("UP keeps relation grants and re-grants columns that still exist, dropping the removed one", async () => {
    const db = await setup();
    await db.exec(emit([change], { dialect: "postgres" }).up);
    expect(await grants(db)).toEqual(["colreader:SELECT(a)", "reader:SELECT"]);
  });

  test("DOWN recreates the old view and carries the grants over again", async () => {
    const db = await setup();
    const sql = emit([change], { dialect: "postgres" });
    await db.exec(sql.up);
    await db.exec("GRANT SELECT (c) ON v_r TO colreader");
    await db.exec(sql.down);
    // c no longer exists in the old view: its grant is dropped; a and the relation grant stay.
    expect(await grants(db)).toEqual(["colreader:SELECT(a)", "reader:SELECT"]);
  });

  test("DOWN of a drop-view + create-view pair keeps the grants too", async () => {
    const db = await setup();
    const pair: Change[] = [
      { kind: "drop-view", view: "v_r", restore: oldView, status: ALLOWED } as unknown as Change,
      { kind: "create-view", view: newView, status: ALLOWED } as unknown as Change,
    ];
    const sql = emit(pair, { dialect: "postgres" });
    await db.exec(sql.up);
    expect(await grants(db)).toEqual(["colreader:SELECT(a)", "reader:SELECT"]);
    await db.exec(sql.down);
    expect(await grants(db)).toEqual(["colreader:SELECT(a)", "reader:SELECT"]);
  });

  test("a proven restorable replace needs no capture in DOWN", () => {
    const proven = { ...change, proven: { restorable: true } } as unknown as Change;
    const r = emit([proven], { dialect: "postgres" });
    expect(r.down).not.toContain("aclexplode");
  });
});
