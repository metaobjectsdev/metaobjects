// Shared metadata input for the old-vs-new codegen comparison tests.
// Four entities exercise: a plain entity, extends-inheritance, @autoSet,
// a secondary-unique identity, and a one-side FK relationship.

import { Loader, metaOf } from "@metaobjects/metadata";
import type { MetaModel, MetaRoot, MetaObject } from "@metaobjects/metadata";

export const COMPARISON_METADATA = JSON.stringify({
  metadata: {
    package: "acme",
    children: [
      {
        object: {
          name: "Tag", subType: "entity",
          children: [
            { field: { name: "id", subType: "long" } },
            { field: { name: "label", subType: "string", "@required": true } },
            { identity: { subType: "primary", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        object: {
          name: "Base", subType: "entity", isAbstract: true,
          children: [
            { field: { name: "id", subType: "long" } },
            { field: { name: "createdAt", subType: "string", "@autoSet": "onCreate" } },
            { identity: { subType: "primary", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        object: {
          name: "Author", subType: "entity",
          children: [
            { field: { name: "id", subType: "long" } },
            { field: { name: "name", subType: "string", "@required": true } },
            { identity: { subType: "primary", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        object: {
          name: "Article", subType: "entity", extends: "Base",
          children: [
            { field: { name: "title", subType: "string", "@required": true } },
            { field: { name: "slug", subType: "string" } },
            { field: { name: "authorId", subType: "long" } },
            {
              relationship: {
                name: "author", subType: "association",
                "@cardinality": "one", "@objectRef": "Author", "@fkField": "authorId",
              },
            },
            { identity: { subType: "primary", "@fields": "id" } },
            { identity: { subType: "secondary", name: "bySlug", "@fields": ["slug"], "@unique": true } },
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
  return metaOf(loadModelRoot()) as MetaRoot;
}

/** The non-abstract entities of the comparison fixture, as raw MetaModels (codegen-ts baseline). */
export function comparisonEntitiesAsModels(): MetaModel[] {
  return loadModelRoot()
    .children()
    .filter((c) => c.type === "object" && c.isAbstract !== true);
}

/** The non-abstract entities of the comparison fixture, as typed MetaObjects (POC). */
export function comparisonEntitiesAsObjects(): MetaObject[] {
  return loadMetaRoot().objects().filter((o) => o.isAbstract !== true);
}
