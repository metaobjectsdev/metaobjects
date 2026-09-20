// Rule 6 — the relations tier had no oracle rule, which is why a cardinality-one
// relationship declared on a TPH subtype could vanish from the generated
// relations() block with no error and no output.
//
// The oracle restates, independently of codegen, WHICH module renders a given
// belongs-to: `storingObject`, not the declaring entity. This test drives the
// oracle and codegen's own `buildRelationMap` from the same model and asserts
// they agree — codegen keying that map by the declaring entity is exactly the
// disagreement this catches.
//
// No database: the relation map and the oracle are both pure functions of the
// loaded model.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildRelationMap } from "@metaobjectsdev/codegen-ts";
import { expectedRelations } from "../src/independent-oracle.js";

const TPH_WITH_BELONGS_TO = {
  "metadata.root": {
    package: "oracle",
    children: [
      { "object.entity": { name: "Author", children: [
        { "source.rdb": { "@table": "authors" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Doc", "@discriminator": "kind", children: [
        { "source.rdb": { "@table": "docs" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "kind", "@values": ["Draft", "Final"] } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "DraftDoc", extends: "Doc", "@discriminatorValue": "Draft", children: [
        { "field.long": { name: "authorId" } },
        { "identity.reference": { name: "fkAuthor", "@fields": "authorId", "@references": "Author" } },
        { "relationship.association": { name: "author", "@cardinality": "one", "@objectRef": "Author" } },
      ]}},
      { "object.entity": { name: "FinalDoc", extends: "Doc", "@discriminatorValue": "Final", children: [] }},
    ],
  },
};

async function load(model: unknown): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model)),
  ]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("; "));
  return result.root;
}

describe("independent oracle — relations tier (rule 6)", () => {
  test("a subtype-declared belongs-to is expected on the DISCRIMINATOR BASE's module", async () => {
    const expected = expectedRelations(await load(TPH_WITH_BELONGS_TO));
    const author = expected.find((e) => e.name === "author");
    expect(author).toBeDefined();
    // The declaring entity is DraftDoc, but DraftDoc emits no module of its own.
    expect(author!.onEntity).toBe("Doc");
    expect(author!.targetEntity).toBe("Author");
  });

  test("codegen's relation map agrees with the oracle about where each belongs-to renders", async () => {
    const root = await load(TPH_WITH_BELONGS_TO);
    const expected = expectedRelations(root);
    const actual = buildRelationMap(root);

    const missing = expected.filter((e) => {
      const entries = actual.get(e.onEntity) ?? [];
      return !entries.some((a) => a.name === e.name && a.targetEntity === e.targetEntity);
    });
    expect(
      missing.map((m) => `${m.onEntity}.${m.name} -> ${m.targetEntity} (${m.why})`),
    ).toEqual([]);
  });
});
