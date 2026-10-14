// The TPH (table-per-hierarchy) model walk: which level of a hierarchy owns the
// discriminator, which value a subtype pins, and which object's table stores a row.
//
// ENGINE (ADR-0034 Amendment 8). These answer questions about the model and return no
// emitted text, so an owned generator keeps importing them from the package. They lived in
// `templates/zod-validators.ts`, which made ejecting `hooks`, `grid` or `form` copy the whole
// Zod emitter for one lookup; that module still re-exports them for callers of its subpath.

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { OBJECT_ATTR_DISCRIMINATOR, OBJECT_ATTR_DISCRIMINATOR_VALUE } from "@metaobjectsdev/metadata";

/**
 * FR-017 Tier 1 — when this object is a TPH subtype (@discriminatorValue set
 * and an ancestor carries @discriminator), return the discriminator-field-name
 * → pinned-literal-value pair. Subtypes emit `<field>: z.literal("<value>")`
 * instead of the inherited field's normal type expression. Returns undefined
 * when the object is not a TPH subtype.
 */
export function tphDiscriminatorPin(obj: MetaObject): { fieldName: string; value: string } | undefined {
  // ADR-0039: own — a subtype declares its OWN @discriminatorValue (must not inherit
  // one); the base level is found by the super-resolution walk in `tphDiscriminatorLevel`.
  const value = obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE);
  if (typeof value !== "string" || value === "") return undefined;
  const level = tphDiscriminatorLevel(obj);
  if (level === undefined) return undefined;
  return { fieldName: level.fieldName, value };
}

/**
 * The discriminator BASE an object extends — the nearest ancestor declaring
 * `@discriminator` — or undefined when there is none.
 *
 * The base is NOT the topmost ancestor: a multi-level hierarchy can extend further up
 * past the level that owns the discriminator, and a route path composed against the
 * wrong level names an endpoint nothing mounts. One walk, read by `tphDiscriminatorPin`
 * and by `restPath` (api-surface.ts), so the pin and the address agree on which object
 * is the base.
 */
export function tphDiscriminatorBase(obj: MetaObject): MetaObject | undefined {
  return tphDiscriminatorLevel(obj)?.base;
}

/**
 * The object whose TABLE stores `obj`'s rows: the discriminator base for anything beneath
 * a TPH base — a concrete subtype or an abstract level in between — otherwise `obj`.
 *
 * Neither a subtype's module nor an abstract level's emits a table const, so anything
 * that binds to "the other side" of a reference or relationship — an FK's `.references()`,
 * a `relations()` entry, an M:N traversal's target table — must bind here and never to the
 * target's own name. Binding to the subtype imported `carriers` from a `Carrier.ts` that
 * does not export it.
 */
export function tphStorageObject(obj: MetaObject): MetaObject {
  if (declaresTphDiscriminator(obj)) return obj;
  return tphDiscriminatorBase(obj) ?? obj;
}

/** {@link tphStorageObject} by entity name, for the name-keyed relation map. A name the
 *  root does not resolve is returned unchanged. */
export function tphStorageName(entityName: string, root: MetaRoot): string {
  const obj = root.findObject(entityName);
  return obj === undefined ? entityName : tphStorageObject(obj).name;
}

/**
 * True when this object itself DECLARES `@discriminator` — the level of a TPH hierarchy
 * that owns the discriminator, whether or not any concrete subtype extends it yet.
 *
 * ADR-0039: own — `@discriminator` identifies a hierarchy LEVEL, so it is read own: a
 * subtype inheriting the attr through `extends` must not be mistaken for a base. This is
 * the one predicate the form generator's filter (`hasGeneratedForm`) and the `agent/ui.md`
 * page both ask, so "is this a discriminator base?" has one spelling.
 */
export function declaresTphDiscriminator(obj: MetaObject): boolean {
  return typeof obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR) === "string";
}

/**
 * The ONE super-resolution walk behind `tphDiscriminatorBase` and `tphDiscriminatorPin`:
 * the nearest ancestor declaring a non-empty `@discriminator`, with the field name it
 * declares. Returning both from one walk is what keeps the pin's field name and the
 * base's identity from ever being read at two different levels.
 */
function tphDiscriminatorLevel(obj: MetaObject): { base: MetaObject; fieldName: string } | undefined {
  let cursor = obj.superResolved;
  while (cursor !== undefined) {
    // ADR-0039: own — super-resolution walk; read each level's OWN @discriminator.
    const fieldName = cursor.ownAttr(OBJECT_ATTR_DISCRIMINATOR);
    if (typeof fieldName === "string" && fieldName !== "") {
      return { base: cursor as MetaObject, fieldName };
    }
    cursor = cursor.superResolved;
  }
  return undefined;
}

/** True when this object is a TPH subtype — it declares @discriminatorValue
 *  and an ancestor carries @discriminator. */
export function isTphSubtype(obj: MetaObject): boolean {
  return tphDiscriminatorPin(obj) !== undefined;
}
