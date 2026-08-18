/**
 * Per-command scope (`migrate.scope`) — the EMPTY-MATCH case.
 *
 * Narrowing the expected side must never WIDEN what the diff governs. It could,
 * through one mechanism: `diff` derives its schema scope from the schemas the
 * EXPECTED side mentions, and falls back to "no schema scoping at all" when
 * expected is empty (the legacy whole-DB path for a project with no model). A
 * scope matching nothing empties `expected.tables`, hits that fallback, and every
 * actual table in every schema becomes a drop candidate — including another
 * owner's, which was never in `expected`, so it carries no provenance and is not
 * in `outOfScope` either.
 *
 * So the declaration whose entire purpose is to stop migrate touching another
 * owner's tables would CAUSE migrate to propose dropping one, whenever the scope
 * is wrong (a typo'd or stale package pattern), silently.
 *
 * The fix is structural: `scopeExpectedSchema` reports the schemas the UNSCOPED
 * model declares, and every caller threads that into `diff`'s `scopeSchemas`, so
 * the schema scope is a property of the whole model and `migrate.scope` cannot
 * move it in either direction. An unscoped project is untouched — no scope, no
 * `declaredSchemas`, and `diff` derives its own exactly as before.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, buildExpectedSchemaWithProvenance } from "../src/expected-schema.js";
import { scopeExpectedSchema } from "../src/scope.js";
import { planOffline } from "../src/snapshot/plan.js";
import { computeDriftFromActual } from "../src/drift/drift.js";
import type { Change, SchemaSnapshot, TableDescriptor } from "../src/types.js";

/** One entity, in its own database schema — so "the schemas the model declares"
 *  is a proper subset of what the database holds. */
const PLATFORM = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [
      {
        "object.entity": {
          name: "Job",
          children: [
            { "source.rdb": { name: "src", "@table": "jobs", "@schema": "acme" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadPlatform(): Promise<MetaRoot> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(PLATFORM)]);
  expect(loaded.errors).toHaveLength(0);
  return loaded.root;
}

/** Another owner's table, in the default schema this model never mentions. */
const OTHER_APP_TABLE: TableDescriptor = {
  name: "other_app_table",
  schema: "public",
  columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
  indexes: [],
  foreignKeys: [],
  checks: [],
  primaryKey: ["id"],
};

/** The live database: this consumer's table exactly as declared, plus a table
 *  belonging to someone else entirely. */
async function actualSchema(root: MetaRoot): Promise<SchemaSnapshot> {
  const mine = buildExpectedSchema(root, { dialect: "postgres" });
  return { ...mine, tables: [...mine.tables, OTHER_APP_TABLE] };
}

/** A `migrate.scope` that matches nothing — a typo'd or stale package pattern. */
const matchesNothing = (): boolean => false;

/** The proposed `DROP TABLE` names, by table name — the whole point of the probe.
 *  Narrowed on the discriminant so `table` is the string arm, never a descriptor. */
const dropped = (changes: readonly Change[]): string[] =>
  changes.filter((c) => c.kind === "drop-table").map((c) => c.table);

describe("migrate.scope matching nothing", () => {
  test("CONTROL — with no scope at all, another owner's table in an undeclared schema is left alone", async () => {
    const root = await loadPlatform();
    const plan = await planOffline({
      metadata: root,
      dialect: "postgres",
      snapshot: await actualSchema(root),
      allow: { dropTable: true },
    });
    expect(dropped(plan.diff.changes)).toEqual([]);
  });

  test("a scope that matches nothing must NOT propose dropping it either", async () => {
    const root = await loadPlatform();
    const plan = await planOffline({
      metadata: root,
      dialect: "postgres",
      snapshot: await actualSchema(root),
      inScope: matchesNothing,
      allow: { dropTable: true },
    });
    // The consumer's own table left the expected side, as declared...
    expect(plan.outOfScope).toEqual(["acme.jobs"]);
    // ...and nothing at all is proposed for the schema the model never mentions.
    expect(dropped(plan.diff.changes)).toEqual([]);
  });

  test("verify --db sees the same thing — no phantom drift for another owner's table", async () => {
    const root = await loadPlatform();
    const drift = await computeDriftFromActual(
      await actualSchema(root),
      "postgres",
      root,
      { inScope: matchesNothing },
    );
    expect(drift.outOfScope).toEqual(["acme.jobs"]);
    expect(drift.changes).toEqual([]);
  });

  test("the schema scope reported is the UNSCOPED model's, so narrowing can never widen it", async () => {
    const root = await loadPlatform();
    const built = buildExpectedSchemaWithProvenance(root, { dialect: "postgres" });

    // Unscoped: nothing reported, so `diff` derives its own exactly as before —
    // an unscoped project reaches the diff through byte-identical arguments.
    expect(scopeExpectedSchema(built, undefined).declaredSchemas).toBeUndefined();

    // Scoped: the full model's schemas, not the survivors'.
    expect(scopeExpectedSchema(built, matchesNothing).declaredSchemas).toEqual(["acme"]);
    expect(scopeExpectedSchema(built, () => true).declaredSchemas).toEqual(["acme"]);
  });
});
