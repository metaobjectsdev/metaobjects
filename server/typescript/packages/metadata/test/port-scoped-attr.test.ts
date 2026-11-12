// A language-specific attribute is in the shared registry with the ports that act on
// it (`@objectAdapter`, the JVM ObjectAdapter class: ports ["java", "kotlin"]). Every port registers
// and type-checks it, so a model that carries it loads under the strict loader here, and TypeScript,
// a port not named, does nothing with it. Strictness is unchanged: an attribute the registry does
// not carry still fails, and a wrong value type fails.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, composeRegistry, coreProviders } from "../src/index.js";
import { buildVocabularyCatalog } from "../src/vocabulary-catalog.js";

function model(attr: string): string {
  return JSON.stringify(JSON.parse(`{ "metadata.root": { "package": "acme", "children": [
    { "object.entity": { "name": "Diagnosis", ${attr} "children": [
      { "source.rdb": { "@table": "diagnoses" } },
      { "field.long": { "name": "id" } },
      { "identity.primary": { "@fields": "id" } }
    ] } }
  ] } }`));
}

async function codes(json: string): Promise<string[]> {
  const res = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(json)]);
  return res.errors.map((e) => (e as { code?: string }).code ?? "");
}

describe("a JVM-only attribute", () => {
  test("loads under the strict loader", async () => {
    expect(await codes(model(`"@objectAdapter": "com.acme.DiagnosisAdapter",`))).toEqual([]);
  });

  test("is type-checked: a list is not a class name", async () => {
    expect(await codes(model(`"@objectAdapter": ["com.acme.DiagnosisAdapter"],`))).not.toEqual([]);
  });

  test("the never-released @dbSetName is not vocabulary (it is @collectionName)", async () => {
    expect(await codes(model(`"@dbSetName": "Diagnosis",`))).toContain("ERR_UNKNOWN_ATTR");
  });

  test("an attribute the registry does not carry still fails", async () => {
    expect(await codes(model(`"@objectAdapterX": "com.acme.DiagnosisAdapter",`))).toContain("ERR_UNKNOWN_ATTR");
  });

  test("the vocabulary names the ports that act on it", async () => {
    const entity = buildVocabularyCatalog(composeRegistry(coreProviders))
      .types.find((t) => t.type === "object" && t.subType === "entity")!;
    expect(entity.attrs.find((a) => a.name === "objectAdapter")?.ports).toEqual(["java", "kotlin"]);
  });
});

// Cross-port vocabulary only some ports implement so far.
const KIND1 = `{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Product", "@object": "com.acme.Product", "children": [
    { "field.long": { "name": "id" } },
    { "field.string": { "name": "notes", "children": [
      { "view.textarea": { "name": "form", "@rows": 6 } } ] } },
    { "field.string": { "name": "coverKey", "children": [
      { "view.image": { "name": "form", "@aspectRatio": 1.5, "@maxEdge": 2000, "@store": "photos",
                        "@accept": ["image/png"], "@maxBytes": 1048576 } } ] } },
    { "identity.primary": { "@fields": "id" } }
  ] } }
] } }`;

describe("kind-1 vocabulary", () => {
  test("loads under the strict loader", async () => {
    expect(await codes(KIND1)).toEqual([]);
  });

  test("an attribute the registry does not carry on a kind-1 view still fails", async () => {
    expect(await codes(KIND1.replace(`"@maxBytes": 1048576`, `"@cropShape": "circle"`))).toContain("ERR_UNKNOWN_ATTR");
  });

  test("the vocabulary names the ports that implement it so far", async () => {
    const catalog = buildVocabularyCatalog(composeRegistry(coreProviders));
    const image = catalog.types.find((t) => t.type === "view" && t.subType === "image")!;
    expect(image.implementedIn).toEqual(["typescript"]);
    expect(image.crossPort).toBe(true);
    const entity = catalog.types.find((t) => t.type === "object" && t.subType === "entity")!;
    expect(entity.attrs.find((a) => a.name === "object")?.implementedIn).toEqual(["java"]);
    expect(entity.attrs.find((a) => a.name === "objectAdapter")?.ports).toEqual(["java", "kotlin"]);
  });
});
