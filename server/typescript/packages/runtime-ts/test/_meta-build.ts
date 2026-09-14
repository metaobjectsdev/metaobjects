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
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
  MetaRoot,
  MetaObject,
  MetaField,
  MetaAttr,
  MetaValidator,
  MetaView,
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
  MetaReferenceIdentity,
  MetaRelationship,
  MetaLayout,
  MetaSource,
  MetaOrigin,
} from "@metaobjectsdev/metadata";

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

// identity.reference nodes must be actual MetaReferenceIdentity instances —
// the loader's IDENTITY_CLASS_MAP (core-types.ts) dispatches on subtype the
// same way, since resolveRelationshipReference() (#368) reads its
// subtype-only getters (targetEntity, referencesRaw). A plain MetaIdentity
// built for subtype "reference" answers `undefined` to those, so identity
// subtypes get their own dispatch here too rather than falling through to
// the generic TYPE_IDENTITY entry above.
const IDENTITY_CTORS: Record<string, NodeCtor> = {
  [IDENTITY_SUBTYPE_PRIMARY]: MetaPrimaryIdentity,
  [IDENTITY_SUBTYPE_SECONDARY]: MetaSecondaryIdentity,
  [IDENTITY_SUBTYPE_REFERENCE]: MetaReferenceIdentity,
};

/**
 * Build a concrete metadata node from a TypeId + name. Drop-in replacement for
 * the removed `new MetaData(typeId, name)` constructor.
 */
export function meta(typeId: TypeId, name = ""): MetaData {
  if (typeId.type === TYPE_IDENTITY) {
    const IdentityCtor = IDENTITY_CTORS[typeId.subType] ?? MetaIdentity;
    return new IdentityCtor(typeId, name);
  }
  const Ctor = CTORS[typeId.type];
  if (Ctor === undefined) {
    throw new Error(`meta(): no concrete class for type "${typeId.type}"`);
  }
  return new Ctor(typeId, name);
}
