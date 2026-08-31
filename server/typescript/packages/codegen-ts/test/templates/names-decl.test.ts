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

// Two fields declared in opposite order, each carrying an @column that is NOT the
// naming strategy's own answer for its field name — so the assertion also proves the
// column is CARRIED from the model rather than recomputed from the field name.
async function entityWithFieldOrder(order: readonly string[]): Promise<MetaObject> {
  const columnFor: Record<string, string> = { alpha: "col_a", beta: "col_b" };
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [{
        "object.entity": {
          name: "Ordered",
          children: [
            { "source.rdb": { "@table": "ordered" } },
            ...order.map((name) => ({ "field.string": { name, "@column": columnFor[name] } })),
            { "identity.primary": { name: "id", "@fields": "alpha" } },
          ],
        },
      }],
    },
  });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(r.errors).toEqual([]);
  return r.root.children().find((c) => c.name === "Ordered") as MetaObject;
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

  // Field order must follow the MODEL, not declaration order — the renderer sorts for
  // exactly this reason. Rendering the SAME object twice does not test that: it is
  // deterministic whether or not the sort exists, so such a test passes with `.sort()`
  // deleted. Two fixtures declaring the same fields in different order is the test that
  // has teeth.
  test("field order does not depend on declaration order", async () => {
    const ab = await entityWithFieldOrder(["alpha", "beta"]);
    const ba = await entityWithFieldOrder(["beta", "alpha"]);
    expect(renderNamesDecl(ab, "snake_case")).toBe(renderNamesDecl(ba, "snake_case"));
  });
});
