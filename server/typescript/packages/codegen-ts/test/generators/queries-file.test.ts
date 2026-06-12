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

function entityWithPk(name: string) {
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

  test("default filter keeps every object.entity", async () => {
    const root = await loadRoot([entityWithPk("Post"), entityWithPk("Comment"), valueShape("Stamp")]);
    const gen = queriesFile();
    const filtered = root.objects().filter(gen.filter!);
    expect(filtered.map((e) => e.name).sort()).toEqual(["Comment", "Post"]);
  });

  test("user-supplied filter is composed with the value-skip default via AND", async () => {
    const root = await loadRoot([entityWithPk("Post"), entityWithPk("Comment"), valueShape("Stamp")]);
    const gen = queriesFile({ filter: (e) => e.name === "Comment" });
    const filtered = root.objects().filter(gen.filter!);
    expect(filtered.map((e) => e.name)).toEqual(["Comment"]);
  });
});
