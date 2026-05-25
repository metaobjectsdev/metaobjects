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
    { "identity.primary": { "@fields": "id" } },
  ] } },
  { "object.entity": { name: "ProductView", extends: "Product", children: [
    { "source.rdb": { "@table": "v_product", "@kind": "view" } },
    { "identity.primary": { "@fields": "id" } },
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
        { "identity.primary": { "@fields": "id" } },
      ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });
});
