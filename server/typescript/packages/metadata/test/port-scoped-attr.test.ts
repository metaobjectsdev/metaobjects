// Ruling R40: a language-specific attribute is in the shared registry with the ports that act on
// it (`@dbSetName`, the C# EF DbSet property name: ports ["csharp"]). Every port registers and
// type-checks it, so a model that carries it loads under the strict loader here, and TypeScript,
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
  return res.errors.map((e) => e.code);
}

describe("a C#-only attribute (R40)", () => {
  test("loads under the strict loader", async () => {
    expect(await codes(model(`"@dbSetName": "Diagnosis",`))).toEqual([]);
  });

  test("is type-checked: a list is not a DbSet name", async () => {
    expect(await codes(model(`"@dbSetName": ["Diagnosis"],`))).not.toEqual([]);
  });

  test("an attribute the registry does not carry still fails", async () => {
    expect(await codes(model(`"@dbSetNameX": "Diagnosis",`))).toContain("ERR_UNKNOWN_ATTR");
  });

  test("the vocabulary names the ports that act on it", async () => {
    const entity = buildVocabularyCatalog(composeRegistry(coreProviders))
      .types.find((t) => t.type === "object" && t.subType === "entity")!;
    expect(entity.attrs.find((a) => a.name === "dbSetName")?.ports).toEqual(["csharp"]);
  });
});
