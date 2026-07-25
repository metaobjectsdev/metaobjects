/**
 * Three probe-proven holes found by an adversarial review of the fix batch. Each is the
 * SAME failure class the batch was written to close, so each gets a pinned regression:
 *
 *  1. `parseSqliteDefault` classified any paren-bearing value as an expr — BEFORE the
 *     quote-strip. So an ordinary literal `@default "n/a (unknown)"` (stored by SQLite as
 *     `'n/a (unknown)'`) came back as `{expr, "'n/a (unknown)'"}`, which can never equal
 *     the expected `{literal, "n/a (unknown)"}` → `change-column-default` on EVERY run →
 *     on SQLite a destructive recreate-and-copy of the whole table, forever, un-gated.
 *
 *  2. The drop-view recreate-pair exemption was keyed on the bare view NAME. A view being
 *     rebuilt in one schema therefore un-gated a destructive DROP of a different,
 *     hand-written view with the same name in another schema.
 *
 *  3. The FK duplicate-column-set fallback was decided PER SIDE, so one side could key by
 *     column set while the other keyed by name — mis-diffing even the FK that matches.
 */
import { test, expect, describe } from "bun:test";
import { parseSqliteDefault, parseSqliteChecks } from "../../src/introspect/sqlite-shared.js";
import { applyStatus } from "../../src/diff/status.js";
import { diff } from "../../src/diff/index.js";
import type { Change, FkDescriptor, SchemaSnapshot, ViewDescriptor } from "../../src/types.js";

describe("hole 1 — a quoted literal is a literal, even with parens in it", () => {
  test("paren-bearing quoted literal parses as a LITERAL (was: expr, quotes intact)", () => {
    expect(parseSqliteDefault("'n/a (unknown)'")).toEqual({ kind: "literal", value: "n/a (unknown)" });
  });

  test("quote-escaping still un-doubled", () => {
    expect(parseSqliteDefault("'don''t'")).toEqual({ kind: "literal", value: "don't" });
    expect(parseSqliteDefault("'a''b (c) d''e'")).toEqual({ kind: "literal", value: "a'b (c) d'e" });
  });

  test("genuine exprs are still exprs (unquoted)", () => {
    expect(parseSqliteDefault("CURRENT_TIMESTAMP")).toEqual({ kind: "expr", value: "CURRENT_TIMESTAMP" });
    expect(parseSqliteDefault("(lower(hex(randomblob(16))))"))
      .toEqual({ kind: "expr", value: "(lower(hex(randomblob(16))))" });
  });

  test("a bare NULL is NO default (the D1 runner stringifies SQL NULL to \"null\")", () => {
    // `DEFAULT NULL` ≡ no default. A no-default column on D1 arrives as the string
    // "null" — it must NOT become a literal-"null" default (permanent false drift).
    expect(parseSqliteDefault("null")).toBeUndefined();
    expect(parseSqliteDefault("NULL")).toBeUndefined();
    expect(parseSqliteDefault(null)).toBeUndefined();
    // ...but a QUOTED 'null' is a genuine string literal default and is preserved.
    expect(parseSqliteDefault("'null'")).toEqual({ kind: "literal", value: "null" });
  });
});

describe("parseSqliteChecks — anonymous + comment/literal safety", () => {
  test("parses both named and anonymous (unnamed inline) checks", () => {
    const sql = `CREATE TABLE t (a TEXT CHECK (a IN ('x','y')), b INT, CONSTRAINT t_b_chk CHECK (b > 0))`;
    expect(parseSqliteChecks(sql)).toEqual([
      { name: "", expression: "a IN ('x','y')" },
      { name: "t_b_chk", expression: "b > 0" },
    ]);
  });

  test("does NOT parse a CHECK( that lives inside a comment or a string literal", () => {
    // Each of these would produce a PHANTOM anonymous check → a spurious drop-check
    // (recreate-and-copy) on sqlite/d1. The finder masks comments + literals.
    expect(parseSqliteChecks("CREATE TABLE t (id TEXT, -- legacy CHECK (id <> '') dropped\n x INT)")).toEqual([]);
    expect(parseSqliteChecks("CREATE TABLE t (id TEXT /* CHECK (foo) */ NOT NULL)")).toEqual([]);
    expect(parseSqliteChecks("CREATE TABLE t (note TEXT DEFAULT 'see CHECK (docs) here')")).toEqual([]);
    // ...but a real check alongside such a comment/literal is still found.
    expect(parseSqliteChecks("CREATE TABLE t (s TEXT /* note */ CHECK (s IN ('a','b')))")).toEqual([
      { name: "", expression: "s IN ('a','b')" },
    ]);
  });
});

describe("hole 2 — drop-view exemption is keyed by (schema, name), not name", () => {
  const view = (name: string, schema?: string): ViewDescriptor =>
    ({ name, sql: "SELECT 1", ...(schema !== undefined ? { schema } : {}) }) as ViewDescriptor;

  test("a rebuild of reporting.summary must NOT un-gate dropping public.summary", () => {
    const changes: Change[] = [
      { kind: "create-view", view: view("summary", "reporting"), schema: "reporting", status: { state: "allowed" } },
      { kind: "drop-view", view: "summary", schema: "public", status: { state: "allowed" } },
    ];
    applyStatus(changes, {}); // no allow.dropView
    const drop = changes.find((c) => c.kind === "drop-view")!;
    expect(drop.status.state).toBe("blocked");
  });

  test("the genuine recreate pair (same schema+name) is still exempt", () => {
    const changes: Change[] = [
      { kind: "drop-view", view: "summary", schema: "reporting", status: { state: "allowed" } },
      { kind: "create-view", view: view("summary", "reporting"), schema: "reporting", status: { state: "allowed" } },
    ];
    applyStatus(changes, {});
    expect(changes.find((c) => c.kind === "drop-view")!.status.state).toBe("allowed");
  });

  test("an unpaired drop-view is still blocked without allow.dropView, and allowed with it", () => {
    const mk = (): Change[] => [
      { kind: "drop-view", view: "gone", schema: "public", status: { state: "allowed" } },
    ];
    const blocked = mk(); applyStatus(blocked, {});
    expect(blocked[0]!.status.state).toBe("blocked");
    const allowed = mk(); applyStatus(allowed, { dropView: true });
    expect(allowed[0]!.status.state).toBe("allowed");
  });
});

describe("hole 3 — FK keying mode is decided jointly across both sides", () => {
  const fk = (name: string, columns: string[], refTable: string): FkDescriptor =>
    ({ name, columns, refTable, refColumns: ["id"] }) as FkDescriptor;

  function snap(fks: FkDescriptor[]): SchemaSnapshot {
    return {
      tables: [{
        name: "t",
        columns: [{ name: "a", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [], foreignKeys: fks, primaryKey: [], checks: [],
      }],
      views: [],
    };
  }

  test("actual side has duplicate column sets: the MATCHING fk must not phantom-diff", async () => {
    // The model declares one FK on (a). The live sqlite DB has two FKs on (a) — a shape a
    // hand-written table can genuinely have. Per-side keying made expected key structurally
    // while actual keyed by name, so even the matching FK produced a phantom add-fk.
    const expected = snap([fk("t_a_fk", ["a"], "other")]);
    const actual = snap([fk("t_a_fk", ["a"], "other"), fk("t_a_fk_2", ["a"], "another")]);
    const r = await diff(expected, actual, { dialect: "sqlite", allow: { dropFk: true } });
    // The matching FK must NOT be re-added.
    expect(r.changes.filter((c) => c.kind === "add-fk")).toEqual([]);
  });

  test("the normal sqlite case still converges (composite FK, name mismatch)", async () => {
    // sqlite synthesizes FK names, so expected/actual names differ — column-set keying
    // is what makes this a no-op instead of a phantom drop+add forever.
    const expected = snap([fk("custom_name", ["a", "b"], "other")]);
    const actual = snap([fk("t_a_b_fk", ["a", "b"], "other")]);
    const r = await diff(expected, actual, { dialect: "sqlite" });
    expect(r.changes).toEqual([]);
  });
});
