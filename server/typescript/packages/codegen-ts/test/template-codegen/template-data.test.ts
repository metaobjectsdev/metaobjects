import { describe, test, expect } from "bun:test";
import { buildEntityTemplateData, buildModelTemplateData } from "../../src/template-codegen/template-data.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { resolve } from "node:path";

async function load(path: string) {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(path)]);
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("buildEntityTemplateData", () => {
  test("emits neutral structural fields (subtype, required, isArray)", async () => {
    const root = await load(resolve(import.meta.dir, "../fixtures/single-entity.json"));
    const entity = root.objects()[0]!;
    const data = buildEntityTemplateData(entity);
    expect(data.name).toBe(entity.name);
    expect(data.package).toBe(entity.package ?? "");
    expect(Array.isArray(data.fields)).toBe(true);
    for (const f of data.fields) {
      expect(typeof f.type).toBe("string");
      expect(f.type).not.toContain("[]");           // isArray carries arrayness
      expect(typeof f.required).toBe("boolean");
      expect(typeof f.isArray).toBe("boolean");
    }
    // the `title` field carries @required + @maxLength=200 in the fixture
    const title = data.fields.find((f) => f.name === "title");
    expect(title?.required).toBe(true);
    expect(title?.maxLength).toBe(200);
    for (const id of data.identities) {
      expect(typeof id.kind).toBe("string");
      expect(Array.isArray(id.fields)).toBe(true);
    }
  });
});

describe("buildModelTemplateData", () => {
  test("groups by package ascending; abstracts excluded", async () => {
    const root = await load(resolve(import.meta.dir, "../fixtures/single-entity.json"));
    const model = buildModelTemplateData(root);
    const pkgs = model.packages.map((p) => p.package);
    expect(pkgs).toEqual([...pkgs].sort());
    const names = model.packages.flatMap((p) => p.entities.map((e) => e.name)).sort();
    const concrete = root.objects().filter((o) => o.isAbstract !== true).map((o) => o.name).sort();
    expect(names).toEqual(concrete);
  });
});
