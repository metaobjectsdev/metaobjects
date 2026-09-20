// A `@cardinality: one` relationship declared on a TPH SUBTYPE (or on an
// abstract mid level) never reached the generated relations() block.
//
// buildRelationMap keys its map by the DECLARING entity's name (`ensure(obj.name)`),
// but a TPH subtype has no module of its own — it is folded into the discriminator
// base's single table, and the relations() block renders on the BASE's module. So an
// entry filed under "DraftDoc" was looked up under "Doc" and silently never emitted:
// no error, no output, just a missing belongs-to navigation.
//
// The TARGET side of this same file already resolves through `tphStorageName`
// (relations-block.ts) — only the SOURCE side was keyed raw. M:N entries go through
// the same `ensure(obj.name)` and had the same gap.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildRelationMap } from "../src/relation-resolver.js";

const MODEL = {
  "metadata.root": {
    package: "repro",
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
      // 1:1/N:1 declared on a CONCRETE SUBTYPE.
      { "object.entity": { name: "DraftDoc", extends: "Doc", "@discriminatorValue": "Draft", children: [
        { "field.long": { name: "authorId" } },
        { "identity.reference": { name: "fkAuthor", "@fields": "authorId", "@references": "Author" } },
        { "relationship.association": { name: "author", "@cardinality": "one", "@objectRef": "Author" } },
      ]}},
      { "object.entity": { name: "FinalDoc", extends: "Doc", "@discriminatorValue": "Final", children: [
        { "field.string": { name: "approver", "@maxLength": 80 } },
      ]}},
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

describe("buildRelationMap — cardinality-one declared inside a TPH hierarchy", () => {
  test("a subtype-declared belongs-to is filed under the discriminator BASE, which is where the block renders", async () => {
    const map = buildRelationMap(await load(MODEL));

    // The block renders on the base's module, so the entry must be reachable there.
    const onBase = map.get("Doc") ?? [];
    const author = onBase.find((e) => e.name === "author");
    expect(author).toBeDefined();
    expect(author!.cardinality).toBe("one");
    expect(author!.targetEntity).toBe("Author");
    expect(author!.fkField).toBe("authorId");

    // And it must NOT be stranded under the subtype, which emits no module.
    expect(map.get("DraftDoc") ?? []).toHaveLength(0);
  });

  test("an inherited belongs-to is filed once, not once per subtype", async () => {
    // The relationship is declared on the BASE, so the resolving walk reaches it
    // again through every subtype. All of those map to the same storage key, so the
    // entry must appear ONCE — a duplicate would emit a duplicate object-literal key.
    const map = buildRelationMap(await load({
      "metadata.root": { package: "repro", children: [
        { "object.entity": { name: "Author", children: [
          { "source.rdb": { "@table": "authors" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
        ]}},
        { "object.entity": { name: "Doc", "@discriminator": "kind", children: [
          { "source.rdb": { "@table": "docs" } },
          { "field.long": { name: "id" } },
          { "field.long": { name: "authorId" } },
          { "field.enum": { name: "kind", "@values": ["Draft", "Final"] } },
          { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
          { "identity.reference": { name: "fkAuthor", "@fields": "authorId", "@references": "Author" } },
          { "relationship.association": { name: "author", "@cardinality": "one", "@objectRef": "Author" } },
        ]}},
        { "object.entity": { name: "DraftDoc", extends: "Doc", "@discriminatorValue": "Draft", children: [] }},
        { "object.entity": { name: "FinalDoc", extends: "Doc", "@discriminatorValue": "Final", children: [] }},
      ]},
    }));
    const onBase = (map.get("Doc") ?? []).filter((e) => e.name === "author");
    expect(onBase).toHaveLength(1);
  });

  test("two subtypes claiming the same relation name with DIFFERENT targets warns, never silently overwrites", async () => {
    // The base renders ONE relations() block, which cannot hold two different
    // `author` navigations. Silently keeping the first would make a navigation
    // resolve to another subtype's target — the worse failure, so it is reported.
    const warnings: string[] = [];
    const map = buildRelationMap(await load({
      "metadata.root": { package: "repro", children: [
        { "object.entity": { name: "Author", children: [
          { "source.rdb": { "@table": "authors" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
        ]}},
        { "object.entity": { name: "Editor", children: [
          { "source.rdb": { "@table": "editors" } },
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
          { "relationship.association": { name: "byline", "@cardinality": "one", "@objectRef": "Author" } },
        ]}},
        { "object.entity": { name: "FinalDoc", extends: "Doc", "@discriminatorValue": "Final", children: [
          { "field.long": { name: "editorId" } },
          { "identity.reference": { name: "fkEditor", "@fields": "editorId", "@references": "Editor" } },
          { "relationship.association": { name: "byline", "@cardinality": "one", "@objectRef": "Editor" } },
        ]}},
      ]},
    }), (m) => warnings.push(m));

    const bylines = (map.get("Doc") ?? []).filter((e) => e.name === "byline");
    expect(bylines).toHaveLength(1); // the block can only carry one
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"byline"');
    expect(warnings[0]).toContain("cannot hold both");
  });
});

// An abstract level's belongs-to reaches the base's block only through a CONCRETE
// @discriminatorValue descendant: the FK column folds into the base's single table
// per concrete subtype, and that subtype's resolving relationships() walk re-files
// the entry. With no concrete descendant beneath the abstract level, the column
// never folds — an entry would make the base's relations() block name a column the
// table does not have (generated code that fails tsc while `meta gen` exits 0).
describe("buildRelationMap — cardinality-one declared on an ABSTRACT level", () => {
  const AUTHOR = { "object.entity": { name: "Author", children: [
    { "source.rdb": { "@table": "authors" } },
    { "field.long": { name: "id" } },
    { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
  ]}};
  const PARTY = { "object.entity": { name: "Party", "@discriminator": "kind", children: [
    { "source.rdb": { "@table": "parties" } },
    { "field.long": { name: "id" } },
    { "field.enum": { name: "kind", "@values": ["Company"] } },
    { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
  ]}};
  const ORGANIZATION = { "object.entity": { name: "Organization", abstract: true, extends: "Party", children: [
    { "field.long": { name: "authorId" } },
    { "identity.reference": { name: "fkAuthor", "@fields": "authorId", "@references": "Author" } },
    { "relationship.association": { name: "author", "@cardinality": "one", "@objectRef": "Author" } },
  ]}};

  test("with NO concrete descendant, the base's key carries no entry — the FK column never folds", async () => {
    const map = buildRelationMap(await load({
      "metadata.root": { package: "repro", children: [AUTHOR, PARTY, ORGANIZATION] },
    }));
    expect((map.get("Party") ?? []).find((e) => e.name === "author")).toBeUndefined();
  });

  test("with a concrete descendant, the resolving walk still files it on the base", async () => {
    const map = buildRelationMap(await load({
      "metadata.root": { package: "repro", children: [
        AUTHOR,
        PARTY,
        ORGANIZATION,
        { "object.entity": { name: "Company", extends: "Organization", "@discriminatorValue": "Company", children: [] }},
      ]},
    }));
    const author = (map.get("Party") ?? []).find((e) => e.name === "author");
    expect(author).toBeDefined();
    expect(author!.cardinality).toBe("one");
    expect(author!.targetEntity).toBe("Author");
    expect(author!.fkField).toBe("authorId");
  });
});

// A TPH hierarchy whose discriminator BASE is abstract renders no module with a
// relations() block — the base emits a value-object shape (abstract ⇒ no table)
// and each subtype a per-subtype read schema — so nothing may be filed for it
// under ANY key: an entry would only document, in `meta docs`/api-model, an
// export that exists nowhere in the hierarchy.
describe("buildRelationMap — abstract DISCRIMINATOR BASE", () => {
  test("a concrete subtype's belongs-to files nothing: no module in the hierarchy renders a block", async () => {
    const map = buildRelationMap(await load({
      "metadata.root": { package: "repro", children: [
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
      ]},
    }));
    expect(map.get("Doc") ?? []).toHaveLength(0);
    expect([...map.values()].flat().filter((e) => e.name === "author")).toHaveLength(0);
  });
});
