/**
 * Real Postgres: the CHECKs the cross-field validator extensions emit (atLeastOne @max, a
 * @condition with every node kind, an int-backed enum member in a condition) apply, and a
 * second diff proposes nothing. The diff here runs WITHOUT the expression-canonicalisation
 * probe, so this is the fallback normaliser a read-only `verify --db` role gets: Postgres
 * rewrites a BETWEEN and re-parenthesises every comparison, and a spelling the normaliser
 * cannot match would drift on every run.
 *
 * Gated on MIGRATE_TS_PG_URL; skips cleanly when unset.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const realDescribe = PG_URL ? describe : describe.skip;
const TABLE = "xfield_checks_rt";

const META = JSON.stringify({ "metadata.root": { package: "acme", children: [{ "object.entity": { name: "Note", children: [
  { "source.rdb": { "@table": TABLE } },
  { "field.long": { name: "id" } },
  { "field.long": { name: "a" } }, { "field.long": { name: "b" } }, { "field.long": { name: "c" } },
  { "field.boolean": { name: "flag" } },
  { "field.string": { name: "label" } },
  { "field.enum": { name: "kind", "@values": ["Owned", "Shared"], "@intValueMap": { Owned: 1, Shared: 2 } } },
  { "field.duration": { name: "wait" } },
  { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
  { "validator.atLeastOne": { name: "few", "@fields": ["a", "b", "c"], "@max": 2, "@constraintName": "CK_Note_Few" } },
  { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@max": 1, "@constraintName": "CK_Note_One",
    "@condition": { op: "eq", left: { field: "kind" }, right: { value: "Owned" } } } },
  { "validator.comparison": { name: "cmp", "@left": "a", "@op": "lt", "@right": "b", "@constraintName": "CK_Note_Cmp",
    "@condition": { op: "and", args: [
      { op: "isNotNull", arg: { field: "label" } },
      { op: "not", arg: { op: "eq", left: { field: "flag" }, right: { value: true } } },
      { op: "eq", left: { op: "isNull", arg: { field: "c" } }, right: { field: "flag" } },
    ] } } },
  { "validator.requiredWhen": { name: "rw", "@field": "c", "@when": "label", "@equals": "x",
    "@condition": { op: "gte", left: { fn: "coalesce", args: [{ field: "a" }, { field: "b" }] }, right: { value: 10 } } } },
  // A duration literal is rendered in the interval spelling: Postgres refuses a signed ISO-8601 one.
  { "validator.comparison": { name: "waitCmp", "@left": "a", "@op": "lt", "@right": "b", "@constraintName": "CK_Note_Wait",
    "@condition": { op: "gt", left: { field: "wait" }, right: { value: "-PT90S" } } } },
  { "validator.requiredWhen": { name: "hourly", "@field": "label", "@when": "wait", "@equals": "PT1H", "@constraintName": "CK_Note_Hourly" } },
] } }] } });

let k: Kysely<Record<string, unknown>>;
let pool: Pool;

if (PG_URL) {
  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL });
    k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(k);
    await k.destroy();
  });
}

const ours = (changes: readonly unknown[]) =>
  changes.filter((c) => JSON.stringify(c).includes(TABLE));

realDescribe("cross-field CHECK extensions — apply, then re-diff with no probe", () => {
  test("every emitted CHECK reads back as itself", async () => {
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(k);
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
    expect(errors.map((e) => e.message)).toEqual([]);
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const first = await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" });
    const { up } = emit(ours(first.changes) as typeof first.changes, { dialect: "postgres", expectedSchema: expected });
    for (const stmt of up.split(";").map((s) => s.trim()).filter(Boolean)) await sql.raw(stmt).execute(k);

    const followup = ours((await diff({ expected, actual: await introspectPostgres(k), dialect: "postgres" })).changes);
    if (followup.length > 0) for (const c of followup) console.error("  -", JSON.stringify(c));
    expect(followup).toEqual([]);
  });

  test("the guarded rule is enforced only when the condition holds", async () => {
    await sql.raw(`DELETE FROM "${TABLE}"`).execute(k);
    // kind = Shared (2): the exactly-one rule does not apply, so two present is fine.
    await sql.raw(`INSERT INTO "${TABLE}" ("a", "b", "kind") VALUES (1, 2, 2)`).execute(k);
    // kind = Owned (1): exactly one of a, b.
    await expect(sql.raw(`INSERT INTO "${TABLE}" ("a", "b", "kind") VALUES (1, 2, 1)`).execute(k)).rejects.toThrow(/CK_Note_One/);
    await sql.raw(`INSERT INTO "${TABLE}" ("a", "kind") VALUES (1, 1)`).execute(k);
    // @max 2: three present is refused.
    await expect(sql.raw(`INSERT INTO "${TABLE}" ("a", "b", "c", "kind") VALUES (1, 2, 3, 2)`).execute(k)).rejects.toThrow(/CK_Note_Few/);
  });

  test("a duration literal in a condition or @equals compares as the span", async () => {
    await sql.raw(`DELETE FROM "${TABLE}"`).execute(k);
    // wait <= -PT90S: the a < b rule does not apply.
    await sql.raw(`INSERT INTO "${TABLE}" ("a", "b", "wait") VALUES (2, 1, '-00:05:00')`).execute(k);
    await expect(sql.raw(`INSERT INTO "${TABLE}" ("a", "b", "wait") VALUES (2, 1, '00:00:10')`).execute(k)).rejects.toThrow(/CK_Note_Wait/);
    // label is required when wait is exactly an hour, however it is spelled.
    await expect(sql.raw(`INSERT INTO "${TABLE}" ("a", "wait") VALUES (1, '60 minutes')`).execute(k)).rejects.toThrow(/CK_Note_Hourly/);
    await sql.raw(`INSERT INTO "${TABLE}" ("a", "wait", "label") VALUES (1, '01:00:00', 'set')`).execute(k);
  });
});
