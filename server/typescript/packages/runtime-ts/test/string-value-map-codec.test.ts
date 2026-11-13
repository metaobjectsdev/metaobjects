// rc.21 — a string-stored field.enum with @stringValueMap: the ObjectManager writes the member's
// stored string, reads the member back, and binds the stored string in a filter.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaData } from "@metaobjectsdev/metadata";
import { coerceRowOnRead, coerceRowOnWrite } from "../src/type-coercer.js";
import { compileFilter } from "../src/query-builder.js";

async function upload(): Promise<MetaData> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Upload", children: [
      { "source.rdb": { "@table": "uploads" } },
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["Pending", "Delivered"], "@stringValueMap": { Pending: "pending", Delivered: "delivered" } } },
      { "identity.primary": { name: "id", "@fields": "id" } } ] } } ] } }))]);
  expect(errors).toEqual([]);
  return root.findObject("Upload")!;
}

describe("@stringValueMap — ObjectManager codec", () => {
  test("writes the stored string and reads the member", async () => {
    const entity = await upload();
    expect(coerceRowOnWrite(entity, { id: 1, status: "Delivered" }, "postgres")["status"]).toBe("delivered");
    expect(coerceRowOnRead(entity, { id: 1, status: "delivered" }, "postgres")["status"]).toBe("Delivered");
  });

  test("an unmapped stored string read back throws", async () => {
    const entity = await upload();
    expect(() => coerceRowOnRead(entity, { id: 1, status: "lost" }, "postgres")).toThrow(/no member in @stringValueMap/);
  });

  test("a filter binds the stored string", async () => {
    const entity = await upload();
    expect(JSON.stringify(compileFilter(entity, { status: "Pending" }))).toContain('"pending"');
  });
});
