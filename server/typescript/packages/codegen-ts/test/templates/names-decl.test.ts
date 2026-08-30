import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { renderNamesDecl } from "../../src/templates/names-decl.js";

async function subscriber(): Promise<MetaObject> {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [{
        "object.entity": {
          name: "Subscriber",
          children: [
            { "source.rdb": { "@table": "subscribers" } },
            { "field.int": { name: "id" } },
            { "field.timestamp": { name: "createdAt", "@column": "created_at" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      }],
    },
  });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(r.errors).toEqual([]);
  return r.root.children().find((c) => c.name === "Subscriber") as MetaObject;
}

describe("renderNamesDecl", () => {
  test("emits a const object carrying the physical name and both field names", async () => {
    const out = renderNamesDecl(await subscriber(), "snake_case");
    expect(out).toContain("export const SubscriberNames = {");
    expect(out).toContain(`name: "subscribers"`);
    expect(out).toContain(`kind: "table"`);
    expect(out).toContain("readOnly: false");
    expect(out).toContain(`createdAt: { name: "createdAt", column: "created_at" }`);
    expect(out).toContain("} as const;");
  });

  test("omits schema entirely when undeclared, rather than emitting undefined", async () => {
    expect(renderNamesDecl(await subscriber(), "snake_case")).not.toContain("schema");
  });

  test("is deterministic — same input, byte-identical output", async () => {
    const s = await subscriber();
    expect(renderNamesDecl(s, "snake_case")).toBe(renderNamesDecl(s, "snake_case"));
  });
});
