// Shared metadata input for the old-vs-new codegen comparison tests.
// Four entities exercise: a plain entity, extends-inheritance, @autoSet,
// a secondary-unique identity, and a one-side FK relationship.

import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import type { MetaData, MetaRoot, MetaObject } from "@metaobjects/metadata";

export const COMPARISON_METADATA = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Tag",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "label", "@required": true } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Base", abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "createdAt", "@autoSet": "onCreate" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Author",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@required": true } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Article", extends: "Base",
          children: [
            { "field.string": { name: "title", "@required": true } },
            { "field.string": { name: "slug" } },
            { "field.long": { name: "authorId" } },
            {
              "relationship.association": {
                name: "author",
                "@cardinality": "one", "@objectRef": "Author", "@fkField": "authorId",
              },
            },
            { "identity.primary": { "@fields": "id" } },
            { "identity.secondary": { name: "bySlug", "@fields": ["slug"], "@unique": true } },
          ],
        },
      },
    ],
  },
});

/** Loads COMPARISON_METADATA. Returns the raw MetaData root (for the codegen-ts baseline). */
export async function loadModelRoot(): Promise<MetaData> {
  const { root, errors } = await new MetaDataLoader().load([new InMemorySource(COMPARISON_METADATA)]);
  if (errors.length) throw new Error("fixture load errors: " + errors.map((e) => e.message).join("; "));
  return root;
}

/** Loads COMPARISON_METADATA. Returns the MetaRoot typed view (for the POC). */
export async function loadMetaRoot(): Promise<MetaRoot> {
  return (await loadModelRoot()) as unknown as MetaRoot;
}

/** The non-abstract entities of the comparison fixture, as raw MetaDatas (codegen-ts baseline). */
export async function comparisonEntitiesAsModels(): Promise<MetaData[]> {
  return (await loadModelRoot())
    .children()
    .filter((c) => c.type === "object" && c.isAbstract !== true);
}

/** The non-abstract entities of the comparison fixture, as typed MetaObjects (POC). */
export async function comparisonEntitiesAsObjects(): Promise<MetaObject[]> {
  return ((await loadModelRoot()) as unknown as MetaRoot).objects().filter((o) => o.isAbstract !== true);
}
