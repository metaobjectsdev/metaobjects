/**
 * buildExpectedSchema applies the project's schema conventions to the objects no code
 * addresses, and the Postgres emitter renders what they decide. A metadata override
 * (`@constraintName`, an index node's name) still wins, and the `default` conventions
 * leave the expected schema exactly as it has always been.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { efcoreConventions } from "../../src/schema-conventions.js";
import { UnknownSchemaConventionsError } from "../../src/errors.js";
import { emit } from "../../src/emit/index.js";
import { diff } from "../../src/diff/index.js";

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
        { "field.long": { name: "replacesOrderId", "@column": "ReplacesOrderId" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.reference": { name: "order", "@fields": ["orderId"], "@references": "Order" } },
        { "identity.reference": { name: "replaces", "@fields": ["replacesOrderId"], "@references": "Order", "@constraintName": "FK_Legacy_Name" } },
      ] } },
      { "object.entity": { name: "Region", children: [
        { "source.rdb": { "@table": "Regions" } },
        { "field.long": { name: "id", "@column": "Id" } },
        { "field.string": { name: "code", "@column": "Code" } },
        { "field.string": { name: "name", "@column": "Name" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.secondary": { name: "AK_Regions_Code", "@fields": ["code"] } },
        { "identity.secondary": { name: "IX_Regions_Name", "@fields": ["name"] } },
      ] } },
      { "object.entity": { name: "Store", children: [
        { "source.rdb": { "@table": "Stores" } },
        { "field.long": { name: "id", "@column": "Id" } },
        { "field.string": { name: "regionCode", "@column": "RegionCode" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "index.lookup": { name: "IX_Stores_RegionCode_Id", "@fields": ["regionCode", "id"] } },
        { "identity.reference": { name: "region", "@fields": ["regionCode"], "@references": "Region.code" } },
      ] } },
    ],
  },
};

async function load() {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
  expect(errors).toHaveLength(0);
  return root;
}

const table = (s: ReturnType<typeof buildExpectedSchema>, name: string) => s.tables.find((t) => t.name === name)!;

describe("buildExpectedSchema with the efcore conventions", () => {
  test("PK and FK names follow EF Core; a declared @constraintName still wins", async () => {
    const s = buildExpectedSchema(await load(), { conventions: efcoreConventions });

    expect(table(s, "Orders").primaryKeyName).toBe("PK_Orders");
    expect(table(s, "OrderLines").foreignKeys.map((f) => f.name).sort()).toEqual(["FK_Legacy_Name", "FK_OrderLines_Orders_OrderId"]);
  });

  test("an FK gets an IX_ index unless an existing index already starts with its columns", async () => {
    const s = buildExpectedSchema(await load(), { conventions: efcoreConventions });

    expect(table(s, "OrderLines").indexes.map((i) => [i.name, i.columns, i.unique])).toEqual([
      ["IX_OrderLines_OrderId", ["OrderId"], false],
      ["IX_OrderLines_ReplacesOrderId", ["ReplacesOrderId"], false],
    ]);
    // IX_Stores_RegionCode_Id already leads with RegionCode
    expect(table(s, "Stores").indexes.map((i) => i.name)).toEqual(["IX_Stores_RegionCode_Id"]);
  });

  test("a unique key an FK references is a constraint; another stays an index", async () => {
    const s = buildExpectedSchema(await load(), { conventions: efcoreConventions });
    const kinds = Object.fromEntries(table(s, "Regions").indexes.map((i) => [i.name, i.constraint ?? "index"]));

    expect(kinds).toEqual({ AK_Regions_Code: "unique", IX_Regions_Name: "index" });
  });

  test("the Postgres emitter renders the PK name and the unique constraint", async () => {
    const s = buildExpectedSchema(await load(), { conventions: efcoreConventions });
    const { changes } = await diff(s, { tables: [], views: [] }, { dialect: "postgres" });
    const { up, down } = emit(changes, { dialect: "postgres" });

    expect(up).toContain('CONSTRAINT "PK_Orders" PRIMARY KEY ("Id")');
    expect(up).toContain('ALTER TABLE "Regions" ADD CONSTRAINT "AK_Regions_Code" UNIQUE ("Code");');
    expect(up).toContain('CREATE UNIQUE INDEX "IX_Regions_Name" ON "Regions" ("Name");');
    expect(up).toContain('CREATE INDEX "IX_OrderLines_OrderId" ON "OrderLines" ("OrderId");');
    expect(down).toContain('ALTER TABLE "Regions" DROP CONSTRAINT "AK_Regions_Code";');
  });
});

describe("buildExpectedSchema with the default conventions", () => {
  test("is exactly what it was without any conventions", async () => {
    const root = await load();

    expect(buildExpectedSchema(root, { conventions: undefined })).toEqual(buildExpectedSchema(root));
    const s = buildExpectedSchema(root);
    expect(table(s, "Orders").primaryKeyName).toBeUndefined();
    expect(table(s, "OrderLines").foreignKeys.map((f) => f.name).sort()).toEqual(["FK_Legacy_Name", "OrderLines_OrderId_fk"]);
    expect(table(s, "OrderLines").indexes).toEqual([]);
    expect(table(s, "Regions").indexes.every((i) => i.constraint === undefined)).toBe(true);
  });
});

describe("the conventions the project-aware load put on the root", () => {
  test("are used when the caller passes none", async () => {
    const root = await load();
    (root as { schemaConventions?: unknown }).schemaConventions = "efcore";

    expect(table(buildExpectedSchema(root), "Orders").primaryKeyName).toBe("PK_Orders");
    // `conventions: undefined` is "not given", so it does not mask the root
    expect(table(buildExpectedSchema(root, { conventions: undefined }), "Orders").primaryKeyName).toBe("PK_Orders");
  });

  test("an unknown preset name is refused, naming the ones that exist", async () => {
    const root = await load();
    (root as { schemaConventions?: unknown }).schemaConventions = "hibernate";

    expect(() => buildExpectedSchema(root)).toThrow(UnknownSchemaConventionsError);
    expect(() => buildExpectedSchema(root)).toThrow(/migrate\.conventions "hibernate".*default, efcore/);
  });
});
