import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import {
  isProjection,
  isWriteThrough,
} from "../../src/projection/projection-detector.js";

async function loadObj(objNode: unknown) {
  const json = JSON.stringify({
    "metadata.root": { package: "test", children: [objNode] },
  });
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
  return result.root.ownChildren()[0];
}

describe("isProjection / isWriteThrough", () => {
  test("entity with only source[dbView] → isProjection true, isWriteThrough false", async () => {
    const obj = await loadObj({
      "object.entity": {
        name: "Foo",
        children: [
          { "source.dbView": { "@name": "v_foo" } },
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
          { "source.dbTable": { "@name": "foos" } },
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
          { "source.dbTable": { "@name": "foos" } },
          { "source.dbView": { "@name": "v_foo" } },
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
