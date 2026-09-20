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

// A view-backed projection may carry a belongs-to of ITS OWN — its object-level
// `extends` may only target another projection, so nothing is inherited from an
// entity. It renders a view declaration, never a Drizzle table, so no module of
// its own carries a relations() block.
const PROJECTION_WITH_OWN_BELONGS_TO = {
  "metadata.root": {
    package: "oracle",
    children: [
      { "object.entity": { name: "Author", children: [
        { "source.rdb": { "@table": "authors" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Doc", children: [
        { "source.rdb": { "@table": "docs" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "authorId" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "fkAuthor", "@fields": "authorId", "@references": "Author" } },
        { "relationship.association": { name: "author", "@cardinality": "one", "@objectRef": "Author" } },
      ]}},
      { "object.projection": { name: "DocSummary", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_doc_summary" } },
        { "field.long": { name: "id", extends: "Doc.id" } },
        { "field.long": { name: "authorId", extends: "Doc.authorId" } },
        { "identity.reference": { name: "fkAuthor", extends: "Doc.fkAuthor" } },
        { "relationship.association": { name: "author", "@cardinality": "one", "@objectRef": "Author" } },
      ]}},
    ],
  },
};

// A TPH hierarchy whose discriminator BASE is abstract: the base renders a
// value-object shape (abstract ⇒ no table, even with a source), and each
// subtype renders a per-subtype read schema. No module in the hierarchy emits
// a table, so none emits a relations() block.
const ABSTRACT_DISCRIMINATOR_BASE = {
  "metadata.root": {
    package: "oracle",
    children: [
      { "object.entity": { name: "Author", children: [
        { "source.rdb": { "@table": "authors" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Doc", abstract: true, "@discriminator": "kind", children: [
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

  test("a view-backed projection's own belongs-to is not over-expected", async () => {
    const expected = expectedRelations(await load(PROJECTION_WITH_OWN_BELONGS_TO));
    // The projection renders a view declaration, not a table, so no module of
    // its own carries a relations() block for the oracle to demand anything of.
    expect(expected.filter((e) => e.onEntity === "DocSummary")).toEqual([]);
    // The exclusion is not a blanket drop: the real entity's belongs-to is
    // still expected on the module that renders it.
    expect(expected.find((e) => e.onEntity === "Doc" && e.name === "author")).toBeDefined();
  });

  test("a hierarchy whose discriminator base is ABSTRACT expects no relations() block", async () => {
    // Nothing in this model emits a Drizzle table, so the expectation set is
    // empty — not keyed on the abstract base, whose module is a value-object
    // shape.
    expect(expectedRelations(await load(ABSTRACT_DISCRIMINATOR_BASE))).toEqual([]);
  });
});
