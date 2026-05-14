// PK resolver — pre-pass over the loaded metadata to build a name → PK info map.
// codegen uses this when emitting FK columns (per design §13 #2).

import { MetaModel } from "@metaobjects/metadata";
import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  IDENTITY_SUBTYPE_PRIMARY,
  FIELD_SUBTYPE_LONG,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
} from "@metaobjects/metadata";

export interface PkInfo {
  /** Field name within the entity (e.g., "id"). */
  fieldName: string;
  /** Field subType (e.g., "long", "string", "int"). */
  fieldSubType: string;
  /** Generation strategy: 'increment' | 'uuid' | 'assigned' (or undefined). */
  generation?: string;
}

/**
 * Walk the loaded metadata root, find each object's primary identity,
 * resolve the referenced field's subType, and build a name → PkInfo map.
 *
 * Used by FK column emission: when Post.authorId references User, codegen
 * looks up User's PK info to choose the matching FK column type.
 */
export function buildPkMap(root: MetaModel): Map<string, PkInfo> {
  const result = new Map<string, PkInfo>();
  for (const obj of root.children()) {
    if (obj.type !== TYPE_OBJECT) continue;
    // Use effectiveChildren() to include inherited identities/fields (from extends:/super:).
    const effective = obj.effectiveChildren();
    const primary = effective.find(
      (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_PRIMARY,
    );
    if (!primary) continue;
    const fields = primary.attr(IDENTITY_ATTR_FIELDS);
    if (!Array.isArray(fields) && typeof fields !== "string") continue;
    const fieldsList = Array.isArray(fields) ? fields : [fields];
    if (fieldsList.length === 0) continue;
    const pkFieldName = String(fieldsList[0]);
    const pkField = effective.find(
      (c) => c.type === TYPE_FIELD && c.name === pkFieldName,
    );
    const fieldSubType = pkField?.subType ?? FIELD_SUBTYPE_LONG; // sane default
    const generation = primary.attr(IDENTITY_ATTR_GENERATION);
    const info: PkInfo = { fieldName: pkFieldName, fieldSubType };
    if (typeof generation === "string") info.generation = generation;
    result.set(obj.name, info);
  }
  return result;
}
