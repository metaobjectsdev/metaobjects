/**
 * A constraint or index whose definition is unchanged and whose NAME differs is renamed,
 * not dropped and re-created — on a table that is not itself renamed, too.
 *
 * Switching a project's schema conventions (default → efcore) renames every FK. Before
 * this, each one became a gated `drop-fk` plus an `add-fk`: the migration was blocked
 * behind `--allow drop-fk`, and allowing it dropped and rebuilt every foreign key on a
 * live database. On Postgres the pair is one `ALTER TABLE … RENAME CONSTRAINT`, the same
 * fold a table rename already gets. SQLite cannot rename a constraint, so it keeps the
 * rebuild there.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { defaultConventions, efcoreConventions } from "../../src/schema-conventions.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const DOC = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Order", children: [
        { "source.rdb": { "@table": "Orders" } },
        { "field.long": { name: "id", "@column": "Id" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "OrderLine", children: [
        { "source.rdb": { "@table": "OrderLines" } },
        { "field.long": { name: "id", "@column": "Id" } },
        { "field.long": { name: "orderId", "@column": "OrderId" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "index.lookup": { name: "IX_OrderLines_OrderId", "@fields": ["orderId"] } },
        { "identity.reference": { name: "order", "@fields": ["orderId"], "@references": "Order" } },
      ] } },
    ],
  },
};

async function schemas() {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
  expect(errors).toHaveLength(0);
  return {
    live: buildExpectedSchema(root, { conventions: defaultConventions }),
    wanted: buildExpectedSchema(root, { conventions: efcoreConventions }),
  };
}

describe("an FK whose only change is its name", () => {
  test("Postgres: one rename-constraints change per table, no drop-fk / add-fk", async () => {
    const { live, wanted } = await schemas();
    const { changes } = await diff(wanted, live, { dialect: "postgres" });

    expect(changes.filter((c) => c.kind === "drop-fk" || c.kind === "add-fk")).toEqual([]);
    const renames = changes.filter((c) => c.kind === "rename-constraints");
    expect(renames.map((r) => r.table).sort()).toEqual(["OrderLines", "Orders"]);
    expect(renames.find((r) => r.table === "OrderLines")).toMatchObject({
      constraintRenames: [
        { from: "OrderLines_OrderId_fk", to: "FK_OrderLines_Orders_OrderId" },
        { from: "OrderLines_pkey", to: "PK_OrderLines" },
      ],
    });
    expect(renames.find((r) => r.table === "Orders")).toMatchObject({
      constraintRenames: [{ from: "Orders_pkey", to: "PK_Orders" }],
    });
  });

  test("Postgres: rendered as RENAME CONSTRAINT, and the down renames it back", async () => {
    const { live, wanted } = await schemas();
    const { changes } = await diff(wanted, live, { dialect: "postgres" });
    const { up, down } = emit(changes, { dialect: "postgres" });

    expect(up).toContain('ALTER TABLE "OrderLines" RENAME CONSTRAINT "OrderLines_OrderId_fk" TO "FK_OrderLines_Orders_OrderId";');
    expect(down).toContain('ALTER TABLE "OrderLines" RENAME CONSTRAINT "FK_OrderLines_Orders_OrderId" TO "OrderLines_OrderId_fk";');
    expect(up).toContain('ALTER TABLE "Orders" RENAME CONSTRAINT "Orders_pkey" TO "PK_Orders";');
    expect(down).toContain('ALTER TABLE "Orders" RENAME CONSTRAINT "PK_Orders" TO "Orders_pkey";');
    expect(up).not.toContain("DROP CONSTRAINT");
  });

  test("after the rename, the database matches and nothing is proposed", async () => {
    const { wanted } = await schemas();
    const { changes } = await diff(wanted, structuredClone(wanted), { dialect: "postgres" });
    expect(changes).toEqual([]);
  });

  test("a primary key the database truncated is compared as stored", async () => {
    const { live } = await schemas();
    const long = "T".repeat(60);
    const want = structuredClone(live);
    want.tables.find((t) => t.name === "Orders")!.name = long;
    const actual = structuredClone(want);
    actual.tables.find((t) => t.name === long)!.primaryKeyName = `${long}_pk`;
    const { changes } = await diff(want, actual, { dialect: "postgres" });
    expect(changes.filter((c) => c.kind === "rename-constraints")).toEqual([]);
  });

  test("an FK whose definition also changed is still dropped and re-added", async () => {
    const { live, wanted } = await schemas();
    const actual = structuredClone(live);
    actual.tables.find((t) => t.name === "OrderLines")!.foreignKeys[0]!.onDelete = "cascade";
    const { changes } = await diff(wanted, actual, { dialect: "postgres" });

    expect(changes.some((c) => c.kind === "drop-fk")).toBe(true);
    // Only the primary keys are renamed; the changed FK is not folded into a rename.
    const renamed = changes.flatMap((c) => (c.kind === "rename-constraints" ? c.constraintRenames ?? [] : []));
    expect(renamed.map((r) => r.to).sort()).toEqual(["PK_OrderLines", "PK_Orders"]);
  });

  test("SQLite does not fold (it cannot rename a constraint)", async () => {
    const { live, wanted } = await schemas();
    const { changes } = await diff(wanted, live, { dialect: "sqlite" });

    expect(changes.some((c) => c.kind === "rename-constraints")).toBe(false);
  });
});
