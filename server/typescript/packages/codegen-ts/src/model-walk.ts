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
import { isMetaObject, resolveObjectRef } from "@metaobjectsdev/metadata";
import { effectivePackage } from "./docs-paths.js";

/** The object that declares `field` — its parent node, when that is an object. */
function owningObject(field: MetaField): MetaObject | undefined {
  const parent = field.parent;
  return parent !== undefined && isMetaObject(parent) ? parent : undefined;
}

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
  const ref = field.objectRef;
  if (ref === undefined || ref.length === 0) return undefined;
  const owner = owningObject(field);
  const referrerPkg = (owner !== undefined ? effectivePackage(owner) : undefined) ?? "";
  const node = resolveObjectRef(field.root(), ref, referrerPkg).node;
  return node !== undefined && isMetaObject(node) ? node : undefined;
}
