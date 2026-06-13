import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import { MetaSource } from "../src/persistence/source/meta-source.js";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
}
const codesOf = (errors: readonly Error[]) => errors.map((e) => (e as { code?: string }).code);

const meta = { "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Product", children: [
    { "source.rdb": { "@table": "products", "@schema": "catalog" } },
    { "field.long": { name: "id" } },
    { "identity.primary": { "name": "id", "@fields": "id" } },
  ] } },
  // FR-024 (B4b): a view-PRIMARY object is an object.projection (the legacy
  // entity-extends-entity view spelling is removed); the identity passes
  // through via extends, and the projection's key field is extends-bound.
  { "object.projection": { name: "ProductView", children: [
    { "source.rdb": { "@table": "v_product", "@kind": "view" } },
    { "field.long": { name: "id", extends: "Product.id" } },
    { "identity.primary": { "name": "id", extends: "Product.id" } },
  ] } },
] } };

describe("source.rdb registration", () => {
  test("loads with no errors and round-trips @table/@kind/@schema", async () => {
    const { root, errors } = await loadDoc(meta);
    expect(errors).toHaveLength(0);
    const out = canonicalSerialize(root);
    expect(out).toContain('"source.rdb"');
    expect(out).toContain('"@table": "products"');
    expect(out).toContain('"@schema": "catalog"');
    expect(out).toContain('"@kind": "view"');
  });

  test("MetaSource derives read-only from @kind (default table = writable)", async () => {
    const { root } = await loadDoc(meta);
    const product = root.objects().find((o) => o.name === "Product")!;
    const view = root.objects().find((o) => o.name === "ProductView")!;
    const productSrc = product.ownChildren().find((c) => c instanceof MetaSource) as MetaSource;
    const viewSrc = view.ownChildren().find((c) => c instanceof MetaSource) as MetaSource;
    expect(productSrc.effectiveKind).toBe("table");
    expect(productSrc.isReadOnly()).toBe(false);
    expect(productSrc.tableName).toBe("products");
    expect(productSrc.role).toBe("primary");
    expect(viewSrc.effectiveKind).toBe("view");
    expect(viewSrc.isReadOnly()).toBe(true);
  });

  test("bad @kind value → ERR_BAD_ATTR_VALUE", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "X", children: [
        { "source.rdb": { "@table": "x", "@kind": "bogus" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
      ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });
});
