import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { resourcePath } from "../../src/templates/entity-ui-descriptor.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  const { root } = await loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
  return root;
}

async function entityNamed(name: string) {
  const root = await load({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name,
            children: [
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
              { "field.long": { name: "id" } },
            ],
          },
        },
      ],
    },
  });
  return root.ownChildren().find((c) => c.name === name)!;
}

describe("resourcePath — already-plural entity names", () => {
  it("does not double-pluralize ProgramPurchaseStats", async () => {
    const entity = await entityNamed("ProgramPurchaseStats");
    expect(resourcePath(entity)).toBe("/program_purchase_stats");
  });

  it("still pluralizes an ordinary singular entity name", async () => {
    const entity = await entityNamed("Subscriber");
    expect(resourcePath(entity)).toBe("/subscribers");
  });

  it("does not double-pluralize Settings", async () => {
    const entity = await entityNamed("Settings");
    expect(resourcePath(entity)).toBe("/settings");
  });
});
