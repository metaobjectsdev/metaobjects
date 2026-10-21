// Model-walking helpers for a generator written from scratch (ADR-0034 Amendment 4).
//
// A generator reads the loaded, READ-ONLY model and emits text. Most of what it needs is on
// the metadata nodes themselves, through their RESOLVING accessors (ADR-0039):
//
//   object.fields()            every field, own AND inherited through `extends`
//   field.attr(name)           an attribute's effective value (own wins, else inherited)
//   field.isRequired / .maxLength / .precision / .scale / .objectRef / .column
//   field.resolvedIsArray()    array-ness, inherited too — NOT the raw `isArray` flag
//   object.primaryIdentity()?.fields   the primary-key field names
//
// This module holds the few answers that are NOT a single accessor — where getting it right
// means knowing a rule the engine already owns. Each is exported from the package root.

import type { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import { FIELD_ATTR_OBJECT_REF, isMetaObject, refTarget } from "@metaobjectsdev/metadata";

/**
 * The object a `field.object`'s `@objectRef` points at, resolved the way the loader resolves
 * it (ADR-0041/0042): a fully-qualified ref exactly, a bare ref in the DECLARING object's own
 * package first. Undefined when the field carries no `@objectRef` or it names nothing.
 *
 * Use this rather than matching `o.name === field.objectRef`: two packages may declare the
 * same short name, and a bare-name match picks whichever the walk meets first.
 *
 * `@objectRef` is read RESOLVING, so a field that inherits its ref through `extends` works,
 * and the referrer package is the package of the object that DECLARED the field — which for
 * an inherited field is the base, where the bare ref was written.
 */
export function objectRefTarget(field: MetaField): MetaObject | undefined {
  const node = refTarget(field, FIELD_ATTR_OBJECT_REF);
  return node !== undefined && isMetaObject(node) ? node : undefined;
}
