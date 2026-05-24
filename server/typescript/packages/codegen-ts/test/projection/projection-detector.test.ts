import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import {
  isProjection,
  isWriteThrough,
} from "../../src/projection/projection-detector.js";

async function loadObj(objNode: unknown) {
  const json = JSON.stringify({
    "metadata.root": { package: "test", children: [objNode] },
  });
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
  return result.root.objects()[0]!;
}

describe("isProjection / isWriteThrough", () => {
  test("entity with only source[dbView] → isProjection true, isWriteThrough false", async () => {
    const obj = await loadObj({
      "object.entity": {
        name: "Foo",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_foo" } },
          { "field.int": { name: "id", } },
          { "identity.primary": { "@fields": "id" } },
        ],
      },
    });
    expect(isProjection(obj)).toBe(true);
    expect(isWriteThrough(obj)).toBe(false);
  });

  test("entity with only source[dbTable] → isProjection false, isWriteThrough false", async () => {
    const obj = await loadObj({
      "object.entity": {
        name: "Foo",
        children: [
          { "source.rdb": { "@table": "foos" } },
          { "field.int": { name: "id", } },
          { "identity.primary": { "@fields": "id" } },
        ],
      },
    });
    expect(isProjection(obj)).toBe(false);
    expect(isWriteThrough(obj)).toBe(false);
  });

  test("entity with both → isProjection false, isWriteThrough true", async () => {
    const obj = await loadObj({
      "object.entity": {
        name: "Foo",
        children: [
          { "source.rdb": { "@table": "foos" } },
          { "source.rdb": { "@kind": "view", "@table": "v_foo" } },
          { "field.int": { name: "id", } },
          { "identity.primary": { "@fields": "id" } },
        ],
      },
    });
    expect(isProjection(obj)).toBe(false);
    expect(isWriteThrough(obj)).toBe(true);
  });

  test("entity with no source → isProjection false, isWriteThrough false (vanilla)", async () => {
    const obj = await loadObj({
      "object.entity": {
        name: "Foo",
        children: [
          { "field.int": { name: "id", } },
          { "identity.primary": { "@fields": "id" } },
        ],
      },
    });
    expect(isProjection(obj)).toBe(false);
    expect(isWriteThrough(obj)).toBe(false);
  });
});
