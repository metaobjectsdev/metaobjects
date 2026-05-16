// Shared metadata input for the old-vs-new codegen comparison tests.
// Four entities exercise: a plain entity, extends-inheritance, @autoSet,
// a secondary-unique identity, and a one-side FK relationship.

import { Loader } from "@metaobjects/metadata";
import type { MetaModel, MetaRoot, MetaObject } from "@metaobjects/metadata";

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

/** Loads COMPARISON_METADATA. Returns the raw MetaModel root (for the codegen-ts baseline). */
export function loadModelRoot(): MetaModel {
  const { root, errors } = new Loader().loadJson(COMPARISON_METADATA);
  if (errors.length) throw new Error("fixture load errors: " + errors.map((e) => e.message).join("; "));
  return root;
}

/** Loads COMPARISON_METADATA. Returns the MetaRoot typed view (for the POC). */
export function loadMetaRoot(): MetaRoot {
  return loadModelRoot() as unknown as MetaRoot;
}

/** The non-abstract entities of the comparison fixture, as raw MetaModels (codegen-ts baseline). */
export function comparisonEntitiesAsModels(): MetaModel[] {
  return loadModelRoot()
    .children()
    .filter((c) => c.type === "object" && c.isAbstract !== true);
}

/** The non-abstract entities of the comparison fixture, as typed MetaObjects (POC). */
export function comparisonEntitiesAsObjects(): MetaObject[] {
  return (loadModelRoot() as unknown as MetaRoot).objects().filter((o) => o.isAbstract !== true);
}
