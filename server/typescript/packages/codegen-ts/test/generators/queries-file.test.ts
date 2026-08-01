import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { queriesFile } from "../../src/generators/queries-file.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::shop", children } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

// #248 R2: persistability derives from declared source, never subtype — a
// "normal, queryable entity" fixture must declare a source.rdb (any kind; bare
// is enough, physical naming is unaffected — see source-detect.ts).
function entityWithPk(name: string) {
  return {
    "object.entity": {
      name,
      children: [
        { "source.rdb": {} },
        { "field.string": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
      ],
    },
  };
}

// A sourceless object.entity — loads clean (zero sources = "not persisted",
// per validate-source-roles), but must NOT be queryable (the actual #248 bug:
// a queries file importing Drizzle table exports that were never generated).
function sourcelessEntityWithPk(name: string) {
  return {
    "object.entity": {
      name,
      children: [
        { "field.string": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
      ],
    },
  };
}

function valueShape(name: string) {
  return {
    "object.value": {
      name,
      children: [{ "field.string": { name: "label" } }],
    },
  };
}

describe("queriesFile() factory", () => {
  test("returns a Generator named 'queries-file' with a filter", () => {
    const gen = queriesFile();
    expect(gen.name).toBe("queries-file");
    expect(typeof gen.filter).toBe("function");
  });

  test("default filter excludes object.value entities", async () => {
    const root = await loadRoot([entityWithPk("Post"), valueShape("Stamp")]);
    const gen = queriesFile();
    const filtered = root.objects().filter(gen.filter!);
    expect(filtered.map((e) => e.name)).toEqual(["Post"]);
  });

  test("default filter keeps every source-backed object.entity", async () => {
    const root = await loadRoot([entityWithPk("Post"), entityWithPk("Comment"), valueShape("Stamp")]);
    const gen = queriesFile();
    const filtered = root.objects().filter(gen.filter!);
    expect(filtered.map((e) => e.name).sort()).toEqual(["Comment", "Post"]);
  });

  // #248 R2: persistability derives from source presence, not subtype — a
  // sourceless object.entity is excluded exactly like a value object, even
  // though it declares a primary identity.
  test("default filter excludes a sourceless object.entity (not just object.value)", async () => {
    const root = await loadRoot([entityWithPk("Post"), sourcelessEntityWithPk("Ghost"), valueShape("Stamp")]);
    const gen = queriesFile();
    const filtered = root.objects().filter(gen.filter!);
    expect(filtered.map((e) => e.name)).toEqual(["Post"]);
  });

  test("user-supplied filter is composed with the value-skip default via AND", async () => {
    const root = await loadRoot([entityWithPk("Post"), entityWithPk("Comment"), valueShape("Stamp")]);
    const gen = queriesFile({ filter: (e) => e.name === "Comment" });
    const filtered = root.objects().filter(gen.filter!);
    expect(filtered.map((e) => e.name)).toEqual(["Comment"]);
  });
});
