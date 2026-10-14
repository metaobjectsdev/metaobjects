// PK resolver — pre-pass over the loaded metadata to build a name → PK info map.
// codegen uses this when emitting FK columns (per design §13 #2).

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_LONG,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  OBJECT_SUBTYPE_PROJECTION,
  computedIdentityFields,
} from "@metaobjectsdev/metadata";
import type { RenderContext } from "./render-context.js";

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
export function buildPkMap(root: MetaRoot): Map<string, PkInfo> {
  const result = new Map<string, PkInfo>();
  for (const obj of root.objects()) {
    // primaryIdentity() resolves the primary identity across the super-chain.
    const primary = obj.primaryIdentity();
    if (!primary) continue;
    // attr() (effective) not ownAttr() — @fields/@generation can be inherited when the
    // identity node-level `extends` a base identity without restating them (#56).
    const fields = primary.attr(IDENTITY_ATTR_FIELDS);
    if (!Array.isArray(fields) && typeof fields !== "string") continue;
    const fieldsList = Array.isArray(fields) ? fields : [fields];
    if (fieldsList.length === 0) continue;
    const pkFieldName = String(fieldsList[0]);
    // findField() resolves the field across the super-chain (handles extends:).
    const pkField = obj.findField(pkFieldName);
    const fieldSubType = pkField?.subType ?? FIELD_SUBTYPE_LONG; // sane default
    const generation = primary.attr(IDENTITY_ATTR_GENERATION);
    const info: PkInfo = { fieldName: pkFieldName, fieldSubType };
    if (typeof generation === "string") info.generation = generation;
    result.set(obj.name, info);
  }
  return result;
}

/** Map a field subType to the generated TS scalar type for keys/values. */
export function subTypeToTsType(subType: string): "number" | "boolean" | "string" {
  return subType === "long" || subType === "int" || subType === "short" || subType === "byte"
    ? "number"
    : subType === "boolean"
      ? "boolean"
      : "string";
}

/** The by-id field of an object that declares no primary identity: `id`, by convention.
 *  `hasItemRoute` (api-surface.ts) asks whether this field exists before a read-only
 *  surface addresses a row by it. An instance field name, not a metamodel string. */
export const DEFAULT_ID_FIELD = "id";

/** Get the PK field name and its TS type for a given entity. */
export function getPkInfo(entity: MetaObject, ctx: RenderContext): { fieldName: string; tsType: string } {
  // Use primaryIdentity() to find the primary identity (may be inherited from extends:/super:).
  const pkFieldName = getPkFields(entity)[0] ?? DEFAULT_ID_FIELD;
  const pkInfo = ctx.pkMap.get(entity.name);
  const subType = pkInfo?.fieldSubType ?? "long";
  return { fieldName: pkFieldName, tsType: subTypeToTsType(subType) };
}

/** All primary-key field names, in order. `getPkInfo` exposes only the first (the
 *  query layer's single-PK finder/update signatures key on it); #214's write-through
 *  create re-read keys on ALL of them so a composite PK re-reads the exact written row
 *  (via the insert's returning() values), not any row sharing the first key component. */
export function getPkFields(entity: MetaObject): string[] {
  const identity = entity.primaryIdentity();
  // A projection's identity passes the base entity's key through, and an `@fields` it omits
  // is DERIVED: the local fields that extend the base key's fields, which the loader
  // computes and never writes back. Reading the effective `@fields` instead yields the BASE
  // field names, so a key renamed in the projection (`regNo` extending `Invoice.id`) named
  // a field the projection does not have. An explicit `@fields` equals the computed key
  // (the loader rejects one that disagrees), so the explicit form is unchanged.
  if (identity !== undefined && entity.subType === OBJECT_SUBTYPE_PROJECTION) {
    const computed = computedIdentityFields(identity);
    if (computed !== undefined) return computed;
  }
  const rawFields = identity?.attr(IDENTITY_ATTR_FIELDS);
  if (Array.isArray(rawFields)) return rawFields.filter((f): f is string => typeof f === "string");
  return typeof rawFields === "string" ? [rawFields] : [];
}
