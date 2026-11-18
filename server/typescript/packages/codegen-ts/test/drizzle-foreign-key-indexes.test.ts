// `migrate.foreignKeyIndexes`: the Drizzle table declares the index `meta migrate` gives each
// foreign key nothing else indexes, under migrate's name. Without the setting the table is
// what it was.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { defaultConventions, efcoreConventions } from "@metaobjectsdev/migrate-ts";
import { renderDrizzleSchema } from "../src/templates/drizzle-schema.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { Dialect } from "../src/metaobjects-config.js";
import type { SchemaBuildSettings } from "@metaobjectsdev/migrate-ts";

const DOC = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Customer", children: [
    { "source.rdb": { "@table": "customers" } },
    { "field.long": { name: "id" } },
    { "identity.primary": { name: "pk", "@fields": ["id"] } },
  ] } },
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "orders" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "customerId" } },
    { "field.long": { name: "billToId" } },
    { "identity.primary": { name: "pk", "@fields": ["id"] } },
    { "identity.reference": { name: "customer", "@fields": ["customerId"], "@references": "Customer" } },
    { "identity.reference": { name: "billTo", "@fields": ["billToId"], "@references": "Customer" } },
    { "index.lookup": { name: "orders_bill_to", "@fields": ["billToId"] } },
  ] } },
] } });

async function emit(dialect: Dialect, schemaSettings?: SchemaBuildSettings): Promise<string> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(DOC)]);
  expect(res.errors).toEqual([]);
  const ctx = makeRenderContext({
    dialect, loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root),
    ...(schemaSettings !== undefined ? { schemaSettings } : {}),
  });
  return renderDrizzleSchema(res.root.findObject("Order")!, ctx).toString();
}

const ON: SchemaBuildSettings = { conventions: defaultConventions, skipRedundantChecks: false, foreignKeyIndexes: true };

describe("Drizzle: foreign-key indexes", () => {
  test("off: no index beyond the ones the model declares", async () => {
    const off = await emit("postgres", { ...ON, foreignKeyIndexes: false });
    expect(off).not.toContain("customer_id_idx");
    expect(off).toBe(await emit("postgres"));
  });

  test("on: migrate's index for each uncovered foreign key, on the column's key", async () => {
    for (const dialect of ["postgres", "sqlite"] as const) {
      const on = await emit(dialect, ON);
      expect(on).toContain('index("orders_customer_id_idx").on(table.customerId)');
      // billToId is already led by the declared orders_bill_to index.
      expect(on).not.toContain("orders_bill_to_id_idx");
    }
  });

  test("on, efcore preset: the preset's IX_ names, which are the indexes migrate creates", async () => {
    const on = await emit("postgres", { ...ON, conventions: efcoreConventions });
    expect(on).toContain('index("IX_orders_customer_id").on(table.customerId)');
    expect(on).not.toContain("orders_customer_id_idx");
  });

  test("MySQL: none, since InnoDB indexes every foreign key itself", async () => {
    expect(await emit("mysql", ON)).not.toContain("customer_id_idx");
  });
});
