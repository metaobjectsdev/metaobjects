// Relation resolver — pre-pass that builds the inverse-side map for relations() emission.
// For each entity, we need to know:
//   - Which outgoing belongs-to relationships it declares (one-side, reference on this entity)
//   - Which incoming relationships point to it (many-side, reference on the other entity)
//
// Reads identity.reference declarations to determine the physical reference side.

import type { MetaRoot } from "@metaobjects/metadata";
import {
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  CARDINALITY_ONE,
} from "@metaobjects/metadata";
import { variableNameFromEntity, stripPackage } from "./naming.js";
import { isProjection } from "./projection/projection-detector.js";

export interface RelationEntry {
  /** Name of the relationship (e.g., "author") */
  name: string;
  /** Cardinality: 'one' | 'many' */
  cardinality: "one" | "many";
  /** The other entity's name (e.g., "User") */
  targetEntity: string;
  /** For cardinality 'one': the field on THIS entity that holds the FK (e.g., "authorId") */
  fkField?: string;
  /** For cardinality 'one': the target entity's PK field (e.g., "id") */
  targetPkField?: string;
}

/** Map from entity name → list of relations for that entity's relations() block */
export type RelationMap = Map<string, RelationEntry[]>;

/**
 * Walk all entities, collect relationship children, and also register inverse
 * many() sides on the target entity.
 */
export function buildRelationMap(root: MetaRoot): RelationMap {
  const result: RelationMap = new Map();

  const ensure = (name: string): RelationEntry[] => {
    if (!result.has(name)) result.set(name, []);
    return result.get(name)!;
  };

  for (const obj of root.objects()) {
    // Projections (source.dbView) are view-backed; they never emit a relations()
    // block, and their inherited belongs-to relationships would otherwise register
    // a spurious inverse-many on the target entity.
    if (isProjection(obj)) continue;

    for (const child of obj.relationships()) {
      const cardinality = child.ownAttr(RELATIONSHIP_ATTR_CARDINALITY) as string | undefined;
      if (cardinality !== CARDINALITY_ONE) continue;

      const targetEntityRaw = child.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
      if (!targetEntityRaw) continue;
      const targetEntity = stripPackage(targetEntityRaw);

      // Find an identity.reference on `obj` whose @references targets this relationship's target.
      // Compare against package-stripped names since both relationship @objectRef and
      // identity.reference @references may carry package-qualified entity names.
      const refs = obj.referenceIdentities();
      const matching = refs.find((r) => stripPackage(r.targetEntity ?? "") === targetEntity);
      if (!matching) continue;

      const fkFields = matching.fields;
      if (fkFields.length === 0) continue;
      const fkField = fkFields[0]!;

      ensure(obj.name).push({
        name: child.name,
        cardinality: "one",
        targetEntity,
        fkField,
        targetPkField: "id",
      });
      ensure(targetEntity).push({
        name: variableNameFromEntity(obj.name),
        cardinality: "many",
        targetEntity: obj.name,
      });
    }
  }

  return result;
}
