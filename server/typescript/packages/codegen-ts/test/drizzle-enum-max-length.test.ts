// A string-stored enum with a column length (its @maxLength, else the project's
// enums.maxLength) binds a varchar of that length, the column `meta migrate` creates;
// with none it stays text on Postgres and sizes to the longest member on MySQL, as before.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderDrizzleSchema } from "../src/templates/drizzle-schema.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { Dialect } from "../src/metaobjects-config.js";

async function emit(statusDecl: Record<string, unknown>, dialect: Dialect, maxLength?: number) {
  const json = JSON.stringify({ "metadata.root": { children: [
    { "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", ...statusDecl } },
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ] } },
  ] } });
  const res = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(res.errors).toEqual([]);
  if (maxLength !== undefined) res.root.enumDefaults = { maxLength };
  const ctx = makeRenderContext({
    dialect, loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root),
  });
  return renderDrizzleSchema(res.root.findObject("Order")!, ctx).toString();
}

const VALUES = ["DRAFT", "PUBLISHED"];

describe("Drizzle: a string-stored enum's column length", () => {
  test("Postgres: @maxLength → varchar of that length", async () => {
    expect(await emit({ "@values": VALUES, "@maxLength": 16 }, "postgres")).toContain('varchar("status", { length: 16, enum:');
  });

  test("Postgres: the project default sizes an enum with no @maxLength", async () => {
    expect(await emit({ "@values": VALUES }, "postgres", 32)).toContain('varchar("status", { length: 32, enum:');
  });

  test("Postgres: no length anywhere → text, as before", async () => {
    expect(await emit({ "@values": VALUES }, "postgres")).toContain('text("status", { enum:');
  });

  test("MySQL: @maxLength beats the longest member", async () => {
    expect(await emit({ "@values": VALUES, "@maxLength": 16 }, "mysql")).toContain('varchar("status", { length: 16, enum:');
  });

  test("Postgres: an array enum stays text[] — migrate's column — whatever the length", async () => {
    const own = await emit({ "@values": VALUES, "@maxLength": 16, isArray: true }, "postgres");
    expect(own).not.toContain("varchar(");
    // A member longer than the project default does not refuse an array enum: it has no length.
    const long = await emit({ "@values": ["A_VERY_LONG_MEMBER"], isArray: true }, "postgres", 4);
    expect(long).not.toContain("varchar(");
  });
});
