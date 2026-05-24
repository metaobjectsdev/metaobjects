import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { renderMermaidModel } from "../../src/templates/mermaid-er.js";

async function loadRoot(doc: unknown) {
  const result = await new MetaDataLoader().load([
    new InMemorySource(JSON.stringify(doc)),
  ]);
  expect(result.errors).toEqual([]);
  return result.root;
}

describe("renderMermaidModel", () => {
  test("emits an `erDiagram` block plus entity prose sections", async () => {
    const root = await loadRoot({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "User",
              "@description": "A registered account holder.",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "email", "@description": "Primary email." } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    });
    const md = renderMermaidModel(root);
    expect(md).toContain("```mermaid\nerDiagram");
    expect(md).toContain("User {");
    expect(md).toContain("long id PK");
    expect(md).toContain('string email "Primary email."');
    expect(md).toContain("## User");
    expect(md).toContain("A registered account holder.");
  });

  test("emits FK relationship line for identity.reference", async () => {
    const root = await loadRoot({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "User",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.long": { name: "userId" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } },
                {
                  "identity.reference": {
                    "@fields": "userId",
                    "@references": "User",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const md = renderMermaidModel(root);
    expect(md).toMatch(/User \|\|--o\{ Order/);
    expect(md).toContain("long userId FK");
  });

  test("does NOT emit @notes content (D5)", async () => {
    const root = await loadRoot({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "U",
              "@description": "Public.",
              "@notes": "INTERNAL_SECRET",
              children: [
                { "field.long": { name: "id", "@notes": "INTERNAL_SECRET" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    });
    const md = renderMermaidModel(root);
    expect(md).not.toContain("INTERNAL_SECRET");
  });

  test("abstract entities are excluded from the diagram and prose", async () => {
    // Abstract entities (e.g. BaseEntity) have no physical table — they must not
    // appear as a diagram box. Mirrors migrate-ts's same filter.
    const root = await loadRoot({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "BaseRecord",
              "abstract": true,
              "@description": "Should not appear.",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Order",
              "extends": "BaseRecord",
              children: [
                { "source.rdb": { name: "src", "@table": "orders" } },
              ],
            },
          },
        ],
      },
    });
    const md = renderMermaidModel(root);
    // Concrete entity Order present:
    expect(md).toContain("Order {");
    expect(md).toContain("## Order");
    // Abstract BaseRecord NOT present as a diagram box or a prose heading:
    expect(md).not.toContain("BaseRecord {");
    expect(md).not.toContain("## BaseRecord");
  });
});
