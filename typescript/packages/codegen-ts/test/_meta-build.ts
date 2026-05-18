// Shared test helper for building metadata graphs imperatively.
//
// The metadata refactor removed the constructible `MetaData` class; nodes are
// now concrete classes (MetaObject, MetaField, ...). This helper dispatches a
// (TypeId, name) pair to the right concrete class so existing imperative test
// builders keep working with a one-token change (`new MetaData(` → `meta(`).

import {
  MetaData,
  TypeId,
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_ATTR,
  TYPE_VALIDATOR,
  TYPE_VIEW,
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_LAYOUT,
  TYPE_SOURCE,
  TYPE_ORIGIN,
  MetaRoot,
  MetaObject,
  MetaField,
  MetaAttr,
  MetaValidator,
  MetaView,
  MetaIdentity,
  MetaRelationship,
  MetaLayout,
  MetaSource,
  MetaOrigin,
} from "@metaobjects/metadata";

type NodeCtor = new (typeId: TypeId, name: string) => MetaData;

const CTORS: Record<string, NodeCtor> = {
  [TYPE_METADATA]: MetaRoot,
  [TYPE_OBJECT]: MetaObject,
  [TYPE_FIELD]: MetaField,
  [TYPE_ATTR]: MetaAttr,
  [TYPE_VALIDATOR]: MetaValidator,
  [TYPE_VIEW]: MetaView,
  [TYPE_IDENTITY]: MetaIdentity,
  [TYPE_RELATIONSHIP]: MetaRelationship,
  [TYPE_LAYOUT]: MetaLayout,
  [TYPE_SOURCE]: MetaSource,
  [TYPE_ORIGIN]: MetaOrigin,
};

/**
 * Build a concrete metadata node from a TypeId + name. Drop-in replacement for
 * the removed `new MetaData(typeId, name)` constructor.
 */
export function meta(typeId: TypeId, name = ""): MetaData {
  const Ctor = CTORS[typeId.type];
  if (Ctor === undefined) {
    throw new Error(`meta(): no concrete class for type "${typeId.type}"`);
  }
  return new Ctor(typeId, name);
}

// ---------------------------------------------------------------------------
// Typed convenience helpers — structurally justified casts.
// meta(TypeId(TYPE_METADATA, ...)) ALWAYS returns MetaRoot because CTORS maps
// TYPE_METADATA → MetaRoot; likewise for MetaObject and MetaField.
// ---------------------------------------------------------------------------

/** Build a MetaRoot node (type=metadata). */
export function metaRoot(subType = "root", name = ""): MetaRoot {
  return meta(new TypeId(TYPE_METADATA, subType), name) as MetaRoot;
}

/** Build a MetaObject node (type=object) with the given subType and name. */
export function metaObject(subType: string, name: string): MetaObject {
  return meta(new TypeId(TYPE_OBJECT, subType), name) as MetaObject;
}

/** Build a MetaField node (type=field) with the given subType and name. */
export function metaField(subType: string, name: string): MetaField {
  return meta(new TypeId(TYPE_FIELD, subType), name) as MetaField;
}
