/**
 * Every CHECK shape `meta migrate` generates must read as clean on Postgres once applied.
 *
 * The gate that was missing: migrate → apply → `verify --db` (computeDrift, the same path the
 * CLI runs) must report NO drift. Postgres rewrites a stored CHECK (`IN ('x')` → `= 'x'`,
 * `IS NOT DISTINCT FROM` → `NOT (… IS DISTINCT FROM …)`, `IN (a, b)` → `= ANY (ARRAY[…])`,
 * casts, parentheses), so the oracle is the live engine: a shape that is not in this model is a
 * shape nothing proves round-trips. One-value enums and `presentIff` drifted forever because no
 * integration model declared either.
 *
 * Every `buildChecks` branch in expected-schema.ts is declared once below, each on the column
 * type it really lands on. Add a new generated CHECK shape to the model, not to a new test.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectPostgres } from "../../src/introspect/postgres.js";
import { computeDrift } from "../../src/drift/drift.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];
const TABLE = "check_shapes";

const model = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "CheckShape",
          children: [
            { "source.rdb": { "@table": TABLE } },
            { "field.long": { name: "id" } },
            // Enum membership: string-backed and int-backed, one value and several.
            { "field.enum": { name: "oneValue", "@values": ["SPACE"] } },
            { "field.enum": { name: "twoValues", "@values": ["PRINCIPAL", "GROUP"] } },
            { "field.enum": { name: "mixedCase", "@values": ["Open", "CLOSED"] } },
            { "field.enum": { name: "oneInt", "@values": ["ONLY"], "@intValueMap": { ONLY: 3 } } },
            { "field.enum": { name: "manyInts", "@values": ["A", "B", "C"], "@intValueMap": { A: 0, B: 5, C: 9 } } },
            // Single-field validators.
            { "field.int": { name: "qty", children: [{ "validator.numeric": { name: "range", "@min": 1, "@max": 100 } }] } },
            { "field.int": { name: "floor", children: [{ "validator.numeric": { name: "min", "@min": 0 } }] } },
            { "field.string": { name: "code", children: [{ "validator.length": { name: "len", "@min": 2, "@max": 8 } }] } },
            { "field.string": { name: "slug", "@maxLength": 64, children: [{ "validator.regex": { name: "re", "@pattern": "^[a-z0-9][a-z0-9-]*$" } }] } },
            { "field.string": { name: "tag", children: [{ "validator.regex": { name: "re", "@pattern": "^[A-Z]+'s$" } }] } },
            // comparison: every operator. The constraint name is keyed on the LEFT column, so
            // each operator gets its own left column.
            { "field.int": { name: "lo" } },
            { "field.int": { name: "hi" } },
            { "field.int": { name: "cmpGt" } },
            { "field.int": { name: "cmpGte" } },
            { "field.int": { name: "cmpLt" } },
            { "field.int": { name: "cmpLte" } },
            { "field.int": { name: "cmpNe" } },
            { "field.int": { name: "cmpEq" } },
            { "validator.comparison": { name: "gt", "@left": "cmpGt", "@op": "gt", "@right": "lo" } },
            { "validator.comparison": { name: "gte", "@left": "cmpGte", "@op": "gte", "@right": "lo" } },
            { "validator.comparison": { name: "lt", "@left": "cmpLt", "@op": "lt", "@right": "hi" } },
            { "validator.comparison": { name: "lte", "@left": "cmpLte", "@op": "lte", "@right": "hi" } },
            { "validator.comparison": { name: "ne", "@left": "cmpNe", "@op": "ne", "@right": "hi" } },
            { "validator.comparison": { name: "eq", "@left": "cmpEq", "@op": "eq", "@right": "hi" } },
            // requiredWhen / presentIff gated on a string, a boolean, an enum and a number.
            { "field.string": { name: "kind" } },
            { "field.boolean": { name: "flag" } },
            { "field.int": { name: "level" } },
            // A varchar(n) gate: PG casts such a column to text inside the stored expression.
            { "field.string": { name: "region", "@maxLength": 16 } },
            { "field.string": { name: "regionNote" } },
            { "field.string": { name: "regionAudit" } },
            { "field.string": { name: "shortCode", "@maxLength": 8, children: [{ "validator.length": { name: "len", "@min": 2, "@max": 8 } }] } },
            { "field.string": { name: "nameA", "@maxLength": 8 } },
            { "field.string": { name: "nameB", "@maxLength": 8 } },
            { "validator.comparison": { name: "names", "@left": "nameA", "@op": "lt", "@right": "nameB" } },
            { "validator.requiredWhen": { name: "rwVarchar", "@field": "regionAudit", "@when": "region", "@equals": "us" } },
            { "field.string": { name: "principalId" } },
            { "field.string": { name: "groupId" } },
            { "field.timestamp": { name: "usedAt" } },
            { "field.timestamp": { name: "resolvedAt" } },
            { "field.string": { name: "levelNote" } },
            { "field.string": { name: "enumNote" } },
            { "field.string": { name: "enumNote2" } },
            { "validator.presentIff": { name: "piString", "@field": "principalId", "@when": "kind", "@equals": "principal" } },
            { "validator.presentIff": { name: "piBool", "@field": "usedAt", "@when": "flag", "@equals": "true" } },
            { "validator.presentIff": { name: "piBoolFalse", "@field": "groupId", "@when": "flag", "@equals": "false" } },
            { "validator.presentIff": { name: "piVarchar", "@field": "regionNote", "@when": "region", "@equals": "eu" } },
            { "validator.presentIff": { name: "piNumber", "@field": "levelNote", "@when": "level", "@equals": "3" } },
            { "validator.presentIff": { name: "piEnum", "@field": "enumNote", "@when": "oneValue", "@equals": "SPACE" } },
            { "validator.requiredWhen": { name: "rwString", "@field": "resolvedAt", "@when": "kind", "@equals": "group" } },
            { "validator.requiredWhen": { name: "rwBool", "@field": "enumNote2", "@when": "flag", "@equals": "true" } },
            { "validator.requiredWhen": { name: "rwEnum", "@field": "tag", "@when": "twoValues", "@equals": "GROUP" } },
            { "validator.atLeastOne": { name: "any", "@fields": ["principalId", "groupId"] } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

describe("every generated CHECK shape round-trips clean on live Postgres", () => {
  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  let pool: Pool;
  let kysely: Kysely<Record<string, unknown>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    kysely = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool }) });
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(kysely);
  });
  afterAll(async () => {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`).execute(kysely);
    await pool.end();
  });

  test("migrate → apply → verify --db reports no CHECK drift for any generated shape", async () => {
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(model)]);
    expect(loaded.errors).toEqual([]);

    const expected = buildExpectedSchema(loaded.root, { dialect: "postgres" });
    const checks = expected.tables.find((t) => t.name === TABLE)!.checks;
    // The gate is not vacuous: every shape this model names was really generated.
    expect(checks.map((c) => c.name).sort()).toEqual([
      "check_shapes_cmp_eq_cmp_chk",
      "check_shapes_cmp_gt_cmp_chk",
      "check_shapes_cmp_gte_cmp_chk",
      "check_shapes_cmp_lt_cmp_chk",
      "check_shapes_cmp_lte_cmp_chk",
      "check_shapes_cmp_ne_cmp_chk",
      "check_shapes_code_length_chk",
      "check_shapes_enum_note2_reqwhen_chk",
      "check_shapes_enum_note_presentiff_chk",
      "check_shapes_floor_numeric_chk",
      "check_shapes_group_id_presentiff_chk",
      "check_shapes_level_note_presentiff_chk",
      "check_shapes_many_ints_chk",
      "check_shapes_mixed_case_chk",
      "check_shapes_name_a_cmp_chk",
      "check_shapes_one_int_chk",
      "check_shapes_one_value_chk",
      "check_shapes_principal_id_atleastone_chk",
      "check_shapes_principal_id_presentiff_chk",
      "check_shapes_qty_numeric_chk",
      "check_shapes_region_audit_reqwhen_chk",
      "check_shapes_region_note_presentiff_chk",
      "check_shapes_resolved_at_reqwhen_chk",
      "check_shapes_short_code_length_chk",
      "check_shapes_slug_regex_chk",
      "check_shapes_tag_regex_chk",
      "check_shapes_tag_reqwhen_chk",
      "check_shapes_two_values_chk",
      "check_shapes_used_at_presentiff_chk",
    ]);

    const initial = await diff({ expected, actual: await introspectPostgres(kysely), dialect: "postgres" });
    expect(initial.blocked).toEqual([]);
    const { up } = emit(initial.changes, { dialect: "postgres" });
    await sql.raw(up).execute(kysely);

    const drift = await computeDrift(kysely, "postgres", loaded.root);
    const checkDrift = drift.changes.filter((c) => c.kind.endsWith("-check"));
    if (checkDrift.length > 0) {
      console.error("CHECK DRIFT after apply:");
      for (const c of checkDrift) console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
    }
    expect(checkDrift).toEqual([]);
    expect(drift.changes).toEqual([]);
  });
});
