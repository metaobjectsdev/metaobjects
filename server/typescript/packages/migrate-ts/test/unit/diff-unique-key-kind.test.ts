/**
 * A unique key whose definition and name are unchanged but which the schema conventions now
 * want as the other kind (plain unique index vs UNIQUE constraint). Postgres only. Conventions
 * with no preference (the default) accept either kind, so nothing is converted.
 *
 * Index to constraint is done in place (`ADD CONSTRAINT … UNIQUE USING INDEX`), so a foreign
 * key that relies on the index keeps working. Constraint to index has no in-place form: the
 * constraint is dropped and the index re-created, and every foreign key onto the key is
 * dropped first and added back after, because Postgres refuses to drop a key an FK relies on.
 * Those drops are gated like any other.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { defaultConventions, efcoreConventions } from "../../src/schema-conventions.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import type { SchemaSnapshot } from "../../src/types.js";

const DOC = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Account", children: [
        { "source.rdb": { "@table": "Accounts" } },
        { "field.long": { name: "id", "@column": "Id" } },
        { "field.string": { name: "code", "@column": "Code", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.secondary": { name: "IX_Accounts_Code", "@fields": ["code"] } },
      ] } },
      { "object.entity": { name: "Ledger", children: [
        { "source.rdb": { "@table": "Ledgers" } },
        { "field.long": { name: "id", "@column": "Id" } },
        { "field.string": { name: "accountCode", "@column": "AccountCode" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.reference": { name: "account", "@fields": ["accountCode"], "@references": "Account.code" } },
      ] } },
    ],
  },
};

/**
 * The same model with the key as a constraint (efcore), as an index the conventions ask for, and
 * as the default conventions leave it (no preference), with every other name held to the wanted one.
 */
async function schemas(): Promise<{ asIndex: SchemaSnapshot; asConstraint: SchemaSnapshot; asEither: SchemaSnapshot }> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
  expect(errors).toHaveLength(0);
  const asConstraint = buildExpectedSchema(root, { conventions: efcoreConventions });
  const plain = buildExpectedSchema(root, { conventions: defaultConventions });
  const asIndex = structuredClone(asConstraint);
  for (const t of asIndex.tables) {
    for (const ix of t.indexes) {
      const p = plain.tables.find((x) => x.name === t.name)!.indexes.find((x) => x.name === ix.name || x.columns.join() === ix.columns.join());
      if (p !== undefined && p.constraint === undefined) delete ix.constraint;
    }
  }
  const asEither = structuredClone(asIndex);
  for (const t of asIndex.tables) for (const ix of t.indexes) if (ix.unique && ix.constraint === undefined) ix.plainIndex = true;
  return { asIndex, asConstraint, asEither };
}

describe("a unique key that changes only between index and constraint", () => {
  test("the fixture really differs only in the key's kind", async () => {
    const { asIndex, asConstraint } = await schemas();
    const key = (s: SchemaSnapshot) => s.tables.find((t) => t.name === "Accounts")!.indexes.find((i) => i.unique)!;
    expect(key(asConstraint).constraint).toBe("unique");
    expect(key(asIndex).constraint).toBeUndefined();
  });

  test("index to constraint: promoted in place, and the down demotes it", async () => {
    const { asIndex, asConstraint } = await schemas();
    const { changes } = await diff(asConstraint, asIndex, { dialect: "postgres" });
    expect(changes.filter((c) => c.kind !== "rename-constraints")).toEqual([]);
    const name = asConstraint.tables.find((t) => t.name === "Accounts")!.indexes.find((i) => i.unique)!.name;
    const { up, down } = emit(changes, { dialect: "postgres" });
    expect(up).toContain(`ALTER TABLE "Accounts" ADD CONSTRAINT "${name}" UNIQUE USING INDEX "${name}";`);
    expect(down).toContain(`ALTER TABLE "Accounts" DROP CONSTRAINT "${name}";`);
    expect(down).toContain(`CREATE UNIQUE INDEX "${name}" ON "Accounts"`);
  });

  test("constraint to index: the FK onto it is dropped first and added back after", async () => {
    const { asIndex, asConstraint } = await schemas();
    // Both drops are gated like any other: the key and the FK are briefly gone.
    const gated = await diff(asIndex, asConstraint, { dialect: "postgres" });
    expect(gated.changes.filter((c) => c.status.state !== "allowed").map((c) => c.kind).sort()).toEqual(["drop-fk", "drop-index"]);
    const { changes } = await diff(asIndex, asConstraint, { dialect: "postgres", allow: { dropIndex: true, dropFk: true } });
    expect(changes.map((c) => c.kind).sort()).toEqual(["add-fk", "add-index", "drop-fk", "drop-index"]);
    const { up } = emit(changes, { dialect: "postgres" });
    const at = (s: string) => up.indexOf(s);
    expect(at("DROP CONSTRAINT IF EXISTS \"FK_")).toBeLessThan(at("CREATE UNIQUE INDEX"));
    expect(at("CREATE UNIQUE INDEX")).toBeLessThan(at("ADD CONSTRAINT \"FK_"));
  });

  test("no preference (the default conventions): a live constraint is left as it is", async () => {
    const { asEither, asConstraint } = await schemas();
    const { changes } = await diff(asEither, asConstraint, { dialect: "postgres" });
    expect(changes).toEqual([]);
  });

  test("SQLite has no such distinction to compare", async () => {
    const { asIndex, asConstraint } = await schemas();
    const { changes } = await diff(asConstraint, asIndex, { dialect: "sqlite" });
    expect(changes).toEqual([]);
  });
});
