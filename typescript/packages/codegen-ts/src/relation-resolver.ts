// Relation resolver — pre-pass that builds the inverse-side map for relations() emission.
// For each entity, we need to know:
//   - Which outgoing relationships it declares (one-side, FK on this entity)
//   - Which incoming relationships point to it (many-side, FK on other entity)

import type { MetaModel } from "@metaobjects/metadata";
import {
  TYPE_OBJECT,
  TYPE_RELATIONSHIP,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_FK_FIELD,
  CARDINALITY_ONE,
} from "@metaobjects/metadata";
import { variableNameFromEntity, stripPackage } from "./naming.js";

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
export function buildRelationMap(root: MetaModel): RelationMap {
  const result: RelationMap = new Map();

  const ensure = (name: string): RelationEntry[] => {
    if (!result.has(name)) result.set(name, []);
    return result.get(name)!;
  };

  for (const obj of root.children()) {
    if (obj.type !== TYPE_OBJECT) continue;
    // Use effectiveChildren() so inherited relationships (from extends:/super:) are included.
    for (const child of obj.effectiveChildren()) {
      if (child.type !== TYPE_RELATIONSHIP) continue;
      const cardinality = child.attr(RELATIONSHIP_ATTR_CARDINALITY) as string | undefined;
      if (cardinality !== CARDINALITY_ONE) continue;
      const targetEntityRaw = child.attr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
      if (!targetEntityRaw) continue;
      const targetEntity = stripPackage(targetEntityRaw);
      const fkField = child.attr(RELATIONSHIP_ATTR_FK_FIELD) as string | undefined;
      // Match buildFkMapForEntity: skip relationships missing the FK field.
      if (fkField === undefined) continue;

      ensure(obj.name).push({
        name: child.name,
        cardinality: "one",
        targetEntity,
        fkField,
        targetPkField: "id", // resolved properly via pkMap during emit
      });
      // Inverse many() side on the target entity.
      ensure(targetEntity).push({
        name: variableNameFromEntity(obj.name),
        cardinality: "many",
        targetEntity: obj.name,
      });
    }
  }

  return result;
}
