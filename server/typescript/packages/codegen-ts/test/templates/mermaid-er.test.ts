import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderMermaidErBlock } from "../../src/templates/mermaid-er.js";

async function loadRoot(doc: unknown) {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(doc)),
  ]);
  expect(result.errors).toEqual([]);
  return result.root;
}

// The whole-model ER diagram `meta docs` puts on its overview page. (These cases used to run
// through `renderMermaidModel`, the body of the standalone `mermaid-er` generator that 1.1
// removed; the diagram they pin is unchanged and is asserted here directly.)
describe("renderMermaidErBlock", () => {
  test("emits a fenced `erDiagram` block with a box per entity and nothing after it", async () => {
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
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    });
    const md = renderMermaidErBlock(root);
    expect(md).toContain("```mermaid\nerDiagram");
    expect(md).toContain("User {");
    expect(md).toContain("long id PK");
    expect(md).toContain('string email "Primary email."');
    // The block and only the block: entity prose belongs to each entity's own page.
    expect(md.startsWith("```mermaid\nerDiagram")).toBe(true);
    expect(md.endsWith("\n```")).toBe(true);
    expect(md).not.toContain("A registered account holder.");
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
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.long": { name: "userId" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
                {
                  "identity.reference": {
                    "name": "userRef",
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
    const md = renderMermaidErBlock(root);
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
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    });
    const md = renderMermaidErBlock(root);
    expect(md).not.toContain("INTERNAL_SECRET");
  });

  test("abstract entities are excluded from the diagram", async () => {
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
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
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
    const md = renderMermaidErBlock(root);
    // Concrete entity Order present:
    expect(md).toContain("Order {");
    // Abstract BaseRecord NOT present as a diagram box:
    expect(md).not.toContain("BaseRecord {");
  });
});
