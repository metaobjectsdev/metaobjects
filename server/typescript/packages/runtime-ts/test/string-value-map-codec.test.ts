// rc.21 — a string-stored field.enum with @stringValueMap: the ObjectManager writes the member's
// stored string, reads the member back, and binds the stored string in a filter.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaData } from "@metaobjectsdev/metadata";
import { coerceRowOnRead, coerceRowOnWrite } from "../src/type-coercer.js";
import { compileFilter } from "../src/query-builder.js";

async function upload(): Promise<MetaData> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Article", children: [
      { "source.rdb": { "@table": "articles" } },
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["Draft", "Published"], "@stringValueMap": { Draft: "draft", Published: "published" } } },
      { "identity.primary": { name: "id", "@fields": "id" } } ] } } ] } }))]);
  expect(errors).toEqual([]);
  return root.findObject("Article")!;
}

describe("@stringValueMap — ObjectManager codec", () => {
  test("writes the stored string and reads the member", async () => {
    const entity = await upload();
    expect(coerceRowOnWrite(entity, { id: 1, status: "Published" }, "postgres")["status"]).toBe("published");
    expect(coerceRowOnRead(entity, { id: 1, status: "published" }, "postgres")["status"]).toBe("Published");
  });

  test("an unmapped stored string read back throws", async () => {
    const entity = await upload();
    expect(() => coerceRowOnRead(entity, { id: 1, status: "lost" }, "postgres")).toThrow(/no member in @stringValueMap/);
  });

  test("a filter binds the stored string", async () => {
    const entity = await upload();
    expect(JSON.stringify(compileFilter(entity, { status: "Draft" }))).toContain('"draft"');
  });
});

describe("@stringValueMap — an unmapped member", () => {
  test("is refused on write, naming the field", async () => {
    const entity = await upload();
    expect(() => coerceRowOnWrite(entity, { id: 1, status: "Archived" }, "postgres")).toThrow(/cannot write 'Archived'/);
  });

  // rc.21 part B (N4): a filter refuses it too, in every port. Passed through, a symbol can equal
  // another member's stored string ({ A: "B", B: "C" } filtering "B" would match member A's rows).
  test("is refused in a filter, naming the field", async () => {
    const entity = await upload();
    expect(() => compileFilter(entity, { status: "Archived" })).toThrow(/filter on field.enum 'status': "Archived" has no stored string/);
    expect(() => compileFilter(entity, { status: { $in: ["Draft", "Archived"] } })).toThrow(/"Archived" has no stored string/);
  });
});
