// attr-class-map — dependency-free registry mapping each attr subtype to its
// concrete MetaAttr (sub)class.
//
// Why a registry (and not a static Map literal of class references): MetaData
// (the base of every node, including MetaAttr) must resolve an attr subclass in
// setAttr. If MetaData imported a module that imported the MetaAttr subclasses,
// that closes a module-eval cycle (meta-data → <map> → meta-attr → meta-data)
// and the `class MetaAttr extends MetaData` clause runs before MetaData is
// initialized (TDZ). To break it, this module imports NOTHING from the meta
// tree: each subclass registers ITSELF here (one self-registration line per
// subclass — the Open-Closed seam), and meta-data.ts reads back through this
// dependency-free leaf.

import type { TypeId } from "./registry.js";
import type { MetaData } from "./meta/meta-data.js";
import type { MetaAttr } from "./meta/meta-attr.js";

/** A general node constructor — kept assignable from AttrConstructor. */
export type NodeConstructor = new (typeId: TypeId, name: string) => MetaData;

/** A MetaAttr (sub)class constructor — narrower than NodeConstructor so callers
 *  can read `.dataType` off a probe instance and store the result in a
 *  Map<string, MetaAttr>. Assignable to NodeConstructor since MetaAttr extends
 *  MetaData. MetaAttr is imported type-only here so this module stays free of
 *  any meta-tree value import (type imports are erased — no eval cycle). */
export type AttrConstructor = new (typeId: TypeId, name: string) => MetaAttr;

/** Subtype → concrete attr subclass. Populated by each subclass at module load
 *  via registerAttrClass. The base MetaAttr is the fallback for unmapped
 *  (scalar/string) subtypes — see attrClassFor. */
export const ATTR_CLASS_MAP = new Map<string, AttrConstructor>();

/** Fallback constructor for unmapped subtypes (the base MetaAttr). Registered
 *  by meta-attr.ts at load so attrClassFor never returns undefined. */
let fallbackAttrClass: AttrConstructor | undefined;

/** Register a subtype → subclass mapping. Called by each attr subclass module
 *  at load time (`registerAttrClass(ATTR_SUBTYPE_X, XAttr)`). */
export function registerAttrClass(subType: string, ctor: AttrConstructor): void {
  ATTR_CLASS_MAP.set(subType, ctor);
}

/** Register the base MetaAttr as the fallback for unmapped subtypes. Called once
 *  by meta-attr.ts at load. */
export function registerFallbackAttrClass(ctor: AttrConstructor): void {
  fallbackAttrClass = ctor;
}

/** The concrete MetaAttr subclass for an attr subtype (default base MetaAttr).
 *  Used by MetaData.setAttr to materialize an undeclared attr as the right
 *  class, and by core-types to register the subtype's TypeDefinition. */
export function attrClassFor(subType: string): AttrConstructor {
  const ctor = ATTR_CLASS_MAP.get(subType) ?? fallbackAttrClass;
  if (ctor === undefined) {
    throw new Error(
      `No attr class registered for subType '${subType}' and no fallback set ` +
        `(meta-attr.ts must register the base MetaAttr as fallback at load).`,
    );
  }
  return ctor;
}
