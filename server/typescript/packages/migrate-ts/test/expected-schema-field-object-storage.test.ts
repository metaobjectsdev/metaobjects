import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

async function loadDoc(doc: unknown) {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(doc)),
  ]);
  return result.root;
}

describe("buildExpectedSchema — field.object @storage", () => {
  test('@storage "flattened" emits one column per nested field, prefixed by parent field name', async () => {
    const root = await loadDoc({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Address", children: [
            { "field.string": { name: "street", "@required": true } },
            { "field.string": { name: "city", "@required": true } },
            { "field.string": { name: "postalCode" } },
          ]}},
          { "object.entity": { name: "Customer", children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long":   { name: "id" } },
            { "field.object": { name: "shippingAddress", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const customers = snap.tables.find((t) => t.name === "customers");
    const cols = customers?.columns.map((c) => c.name) ?? [];
    expect(cols).toContain("shipping_address_street");
    expect(cols).toContain("shipping_address_city");
    expect(cols).toContain("shipping_address_postal_code");
    // The parent field.object itself must NOT also appear as a jsonb column.
    expect(cols).not.toContain("shipping_address");
  });

  test("@storage \"flattened\" preserves nested @required per column", async () => {
    const root = await loadDoc({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Address", children: [
            { "field.string": { name: "street", "@required": true } },
            { "field.string": { name: "city",   "@required": true } },
            { "field.string": { name: "postalCode" } },
          ]}},
          { "object.entity": { name: "Customer", children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long":   { name: "id" } },
            { "field.object": { name: "shippingAddress", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const customers = snap.tables.find((t) => t.name === "customers")!;
    const street = customers.columns.find((c) => c.name === "shipping_address_street");
    const postal = customers.columns.find((c) => c.name === "shipping_address_postal_code");
    expect(street?.nullable).toBe(false);
    expect(postal?.nullable).toBe(true);
  });

  test('@storage "jsonb" emits a single jsonb (kind: json) column', async () => {
    const root = await loadDoc({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "ContactInfo", children: [
            { "field.string": { name: "email" } },
          ]}},
          { "object.entity": { name: "Patient", children: [
            { "source.rdb": { "@table": "patients" } },
            { "field.long":   { name: "id" } },
            { "field.object": { name: "contactInfos", isArray: true, "@objectRef": "ContactInfo", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const patients = snap.tables.find((t) => t.name === "patients")!;
    const contactInfos = patients.columns.find((c) => c.name === "contact_infos");
    expect(contactInfos?.sqlType.kind).toBe("json");
  });

  test("@storage absent on field.object defaults to jsonb behavior (back-compat)", async () => {
    const root = await loadDoc({
      "metadata.root": {
        package: "test",
        children: [
          { "object.value": { name: "Blob", children: [
            { "field.string": { name: "data" } },
          ]}},
          { "object.entity": { name: "Item", children: [
            { "source.rdb": { "@table": "items" } },
            { "field.long":   { name: "id" } },
            { "field.object": { name: "payload", "@objectRef": "Blob" } },
            { "identity.primary": { "@fields": "id" } },
          ]}},
        ],
      },
    });
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const items = snap.tables.find((t) => t.name === "items")!;
    const payload = items.columns.find((c) => c.name === "payload");
    expect(payload?.sqlType.kind).toBe("json");
  });
});
