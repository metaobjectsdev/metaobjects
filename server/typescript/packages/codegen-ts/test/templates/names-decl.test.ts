import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { renderNamesDecl } from "../../src/templates/names-decl.js";
import { GENERATED_HEADER } from "../../src/constants.js";

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

// Two fields declared in opposite order — this fixture backs the order-independence
// test below (field order in the output follows the MODEL, not declaration order).
// Distinct @column values are kept anyway, because a fixture where every column is the
// naming strategy's own answer for its field name would be dishonest about what it
// models — but they do NOT make the assertion below prove column-CARRYING: a mutant
// that recomputes @column from the field name instead of reading it (while still
// sorting) passes `ab === ba` too, since both fixtures produce the same recomputed
// values either way. Column-carrying is pinned separately, at the resolver level in
// ../names.test.ts:65-88 (an inherited @column of "given_name" resolves through
// `extends` rather than the strategy recomputing "first_name" from the field name) and
// at the renderer level in the first test below, where `createdAt: { ..., column:
// "created_at" }` asserts the renderer emits the RESOLVER's column rather than its own.
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

  // Every other emitted TS artifact (entity, queries, routes, barrel, entity-meta,
  // projection) carries the `@generated` header as line 1. `<Entity>.names.ts` was the
  // one exception until this test — the overwrite policy no longer gates writes on the
  // marker (it's informational, not consulted by decideAndWrite), so the omission was
  // cosmetic rather than a refusal risk, but a generated file with no `@generated`
  // marker still reads as hand-written to anyone who opens it.
  test("carries the @generated header as line 1", async () => {
    const out = renderNamesDecl(await subscriber(), "snake_case");
    expect(out.split("\n")[0]).toBe(`// ${GENERATED_HEADER} — DO NOT EDIT.`);
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
