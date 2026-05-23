import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";

// The MetaDataLoader returns { root, warnings, errors } — it never throws.
// Errors accumulate in result.errors as Error instances that carry a .code field.
async function load(doc: unknown): Promise<{ ok: boolean; errors: string[] }> {
  const loader = new MetaDataLoader();
  const result = await loader.load([new InMemorySource(JSON.stringify(doc))]);
  const codes = result.errors
    .map((e) => (e as unknown as { code?: string }).code ?? "")
    .filter(Boolean);
  const ok = result.errors.length === 0;
  return { ok, errors: codes };
}

describe("@storage cross-attribute validation", () => {
  test("@storage without @objectRef is rejected with ERR_STORAGE_WITHOUT_OBJECT_REF", async () => {
    const result = await load({
      "metadata.root": {
        package: "test",
        children: [
          { "object.entity": { name: "Order", children: [
            { "source.dbTable": { "@name": "orders" } },
            { "field.object": { name: "addr", "@storage": "flattened" } },
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ERR_STORAGE_WITHOUT_OBJECT_REF");
  });

  test('@storage "flattened" + isArray true is rejected with ERR_STORAGE_FLATTENED_ARRAY', async () => {
    const result = await load({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Address", children: [
            { "field.string": { name: "street" } },
          ]}},
          { "object.entity": { name: "Order", children: [
            { "source.dbTable": { "@name": "orders" } },
            { "field.object": { name: "addrs", isArray: true, "@objectRef": "Address", "@storage": "flattened" } },
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ERR_STORAGE_FLATTENED_ARRAY");
  });

  test('valid @storage "flattened" with @objectRef + isArray false passes', async () => {
    const result = await load({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Address", children: [
            { "field.string": { name: "street" } },
          ]}},
          { "object.entity": { name: "Order", children: [
            { "source.dbTable": { "@name": "orders" } },
            { "field.object": { name: "addr", "@objectRef": "Address", "@storage": "flattened" } },
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  test('valid @storage "jsonb" with @objectRef + isArray true passes', async () => {
    const result = await load({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "ContactInfo", children: [
            { "field.string": { name: "email" } },
          ]}},
          { "object.entity": { name: "Patient", children: [
            { "source.dbTable": { "@name": "patients" } },
            { "field.object": { name: "contactInfos", isArray: true, "@objectRef": "ContactInfo", "@storage": "jsonb" } },
            { "field.long":   { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    expect(result.ok).toBe(true);
  });
});
