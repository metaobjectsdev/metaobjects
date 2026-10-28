import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor, CheckDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";

const CHK = (name: string, expression: string): CheckDescriptor => ({ name, expression });
function tbl(checks: CheckDescriptor[]): TableDescriptor {
  return { name: "orders", columns: [{ name: "qty", sqlType: { kind: "integer", bits: 32 }, nullable: false }],
    indexes: [], foreignKeys: [], checks, primaryKey: ["qty"] };
}
const snap = (checks: CheckDescriptor[]): SchemaSnapshot => ({ tables: [tbl(checks)], views: [] });
const C0 = CHK("orders_qty_numeric_chk", "qty >= 1");
const C0b = CHK("orders_qty_numeric_chk", "qty >= 5"); // changed bound, same name
const C1 = CHK("orders_qty_max_chk", "qty <= 100");

describe("diffTableChecks — postgres existing-table evolution", () => {
  test("added check on an existing table → add-check", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]), dialect: "postgres" });
    expect(r.changes.filter((c) => c.kind === "add-check").map((c) => (c as any).check.name)).toEqual(["orders_qty_max_chk"]);
  });
  test("removed check → drop-check (gated, so blocked without allow)", async () => {
    const r = await diff({ expected: snap([C0]), actual: snap([C0, C1]), dialect: "postgres" });
    const drop = r.changes.find((c) => c.kind === "drop-check");
    expect(drop && (drop as any).check).toBe("orders_qty_max_chk");
    expect(drop!.status.state).toBe("blocked"); // no allow.dropCheck
  });
  test("changed expression (same name) → drop + add", async () => {
    const r = await diff({ expected: snap([C0b]), actual: snap([C0]), dialect: "postgres", allow: { dropCheck: true } });
    expect(r.changes.some((c) => c.kind === "drop-check")).toBe(true);
    expect(r.changes.some((c) => c.kind === "add-check" && (c as any).check.expression === "qty >= 5")).toBe(true);
  });
  test("PG-rewritten actual expression equal to expected → NO change (idempotent)", async () => {
    const r = await diff({ expected: snap([CHK("orders_qty_numeric_chk", "qty >= 1")]),
      actual: snap([CHK("orders_qty_numeric_chk", "(qty >= 1)")]), dialect: "postgres" });
    expect(r.changes.some((c) => c.kind.endsWith("-check"))).toBe(false);
  });
  // INVERTED (adversarial-review fix): this test used to assert that sqlite
  // produces NO check changes — which ENCODED the bug that an evolved
  // `field.enum @values` never migrated on sqlite (the diff said "No schema
  // changes" while production INSERTs violated the stale CHECK; nothing ever
  // triggered the claimed table recreate). sqlite now evolves checks like
  // postgres does; the emitter routes them through recreate-and-copy, and the
  // real-engine gate (test/integration/sqlite-check-evolution.test.ts) proves
  // apply + insert-new-member + re-diff-empty against live libsql.
  test("sqlite evolves checks too (emitter recreates the table)", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]), dialect: "sqlite" });
    expect(r.changes.filter((c) => c.kind === "add-check").map((c) => (c as any).check.name)).toEqual(["orders_qty_max_chk"]);
  });
  test("no dialect passed → no check evolution (back-compat)", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]) });
    expect(r.changes.some((c) => c.kind.endsWith("-check"))).toBe(false);
  });
});

describe("diffTableChecks — regex check on a text-family column", () => {
  const generated = CHK("spaces_key_regex_chk", `"key" ~ '^[a-z0-9][a-z0-9-]*$'`);
  const stored = CHK("spaces_key_regex_chk", `(((key)::text ~ '^[a-z0-9][a-z0-9-]*$'::text))`);
  const withKey = (udtName: string | undefined, checks: CheckDescriptor[]): SchemaSnapshot => ({
    tables: [{ name: "spaces", columns: [{ name: "key", sqlType: { kind: "text" }, nullable: false, ...(udtName ? { udtName } : {}) }],
      indexes: [], foreignKeys: [], checks, primaryKey: [] }],
    views: [],
  });
  const checkChanges = async (udtName: string | undefined) => {
    const r = await diff({ expected: withKey(undefined, [generated]), actual: withKey(udtName, [stored]), dialect: "postgres" });
    return r.changes.filter((c) => c.kind.endsWith("-check"));
  };
  test.each(["text", "varchar"])("%s column: Postgres's rewrite is no drift", async (udt) => {
    expect(await checkChanges(udt)).toEqual([]);
  });
  // char(n) is NOT in the family: `~(bpchar, text)` is bpcharregexeq, which sees the blank
  // padding that `(col)::text` trims, so an explicit cast is a different constraint. Postgres
  // never adds the cast on a bpchar column, so its own rewrite arrives uncast and stays clean.
  test("bpchar column: an explicit ::text cast is drift against the uncast check", async () => {
    expect((await checkChanges("bpchar")).map((c) => c.kind).sort()).toEqual(["add-check", "drop-check"]);
  });
  test("bpchar column: the uncast form Postgres stores is clean", async () => {
    const uncast = CHK("spaces_key_regex_chk", `(key ~ '^[a-z0-9][a-z0-9-]*$'::text)`);
    const r = await diff({ expected: withKey(undefined, [generated]), actual: withKey("bpchar", [uncast]), dialect: "postgres" });
    expect(r.changes.filter((c) => c.kind.endsWith("-check"))).toEqual([]);
  });
  test("bpchar column: a stored length((col)::text) is drift against the uncast length()", async () => {
    const expected = CHK("spaces_key_length_chk", `length("key") >= 2`);
    const cast = CHK("spaces_key_length_chk", `((length((key)::text) >= 2))`);
    const uncast = CHK("spaces_key_length_chk", `(length(key) >= 2)`);
    const kinds = async (udt: string, actual: CheckDescriptor) =>
      (await diff({ expected: withKey(undefined, [expected]), actual: withKey(udt, [actual]), dialect: "postgres" }))
        .changes.filter((c) => c.kind.endsWith("-check")).map((c) => c.kind).sort();
    expect(await kinds("bpchar", cast)).toEqual(["add-check", "drop-check"]);
    expect(await kinds("bpchar", uncast)).toEqual([]);
    expect(await kinds("varchar", cast)).toEqual([]);
  });
  test("citext column: cast vs uncast is drift", async () => {
    expect((await checkChanges("citext")).map((c) => c.kind).sort()).toEqual(["add-check", "drop-check"]);
  });
});

describe("renames keep the (col)::text fold", () => {
  const col = (name: string) => ({ name, sqlType: { kind: "text" as const }, nullable: false, udtName: "varchar" });
  const table = (name: string, column: string, check: CheckDescriptor): TableDescriptor =>
    ({ name, columns: [col(column)], indexes: [], foreignKeys: [], checks: [check], primaryKey: [] });
  const s = (t: TableDescriptor): SchemaSnapshot => ({ tables: [t], views: [] });

  test("table rename: a varchar length check Postgres stores cast is folded into the rename", async () => {
    const r = await diff({
      expected: s(table("members", "code", CHK("members_code_chk", `length("code") >= 2`))),
      actual: s(table("users", "code", CHK("users_code_chk", `(length((code)::text) >= 2)`))),
      dialect: "postgres",
      renames: [{ kind: "table", from: "users", to: "members" }],
    });
    expect(r.changes.filter((c) => c.kind.endsWith("-check"))).toEqual([]);
    expect(r.changes).toEqual([expect.objectContaining({
      kind: "rename-table", constraintRenames: [{ from: "users_code_chk", to: "members_code_chk" }],
    })]);
  });

  test("column rename: the check follows the renamed varchar column without drop+add", async () => {
    const r = await diff({
      expected: s(table("users", "handle", CHK("users_handle_chk", `length("handle") >= 2`))),
      actual: s(table("users", "code", CHK("users_code_chk", `(length((code)::text) >= 2)`))),
      dialect: "postgres",
      renames: [{ kind: "column", table: "users", from: "code", to: "handle" }],
    });
    expect(r.changes.filter((c) => c.kind.endsWith("-check"))).toEqual([]);
    expect(r.changes).toEqual([expect.objectContaining({
      kind: "rename-column", constraintRenames: [{ from: "users_code_chk", to: "users_handle_chk" }],
    })]);
  });
});
