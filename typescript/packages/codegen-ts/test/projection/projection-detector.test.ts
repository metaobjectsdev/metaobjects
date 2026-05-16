import { describe, test, expect } from "bun:test";
import { Loader } from "@metaobjects/metadata";
import {
  isProjection,
  isWriteThrough,
} from "../../src/projection/projection-detector.js";

function loadObj(objNode: unknown) {
  const loader = new Loader();
  const json = JSON.stringify({
    "metadata.root": { package: "test", children: [objNode] },
  });
  const result = loader.loadJson(json);
  return result.root.children()[0];
}

describe("isProjection / isWriteThrough", () => {
  test("entity with only source[dbView] → isProjection true, isWriteThrough false", () => {
    const obj = loadObj({
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

  test("entity with only source[dbTable] → isProjection false, isWriteThrough false", () => {
    const obj = loadObj({
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

  test("entity with both → isProjection false, isWriteThrough true", () => {
    const obj = loadObj({
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

  test("entity with no source → isProjection false, isWriteThrough false (vanilla)", () => {
    const obj = loadObj({
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
