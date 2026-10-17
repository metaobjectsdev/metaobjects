// Derive a plain payload field tree from a loaded `object.value` view-object,
// for `meta verify` (FR-004 Plan #3, T6). This is the metadata-side bridge to
// the zero-core-dependency render engine: render's `verify` takes a PLAIN
// PayloadField[] (no metadata import), and this function produces it by walking
// the view-object exactly as payload-codegen.ts does — scalars become leaves,
// `field.object` with an `@objectRef` becomes a nested tree.

import {
  type MetaData,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  isMetaField,
  refTarget,
} from "@metaobjectsdev/metadata";
import type { PayloadField } from "@metaobjectsdev/render";

/**
 * Walk an `object.value` view-object into a render `PayloadField[]`. Object-ref
 * fields recurse into the view-object the loader bound for their `@objectRef`
 * (ADR-0059 R7); a `seen` set guards against a (pathological) reference cycle.
 * Returns `[]` when `vo` is undefined (the ref did not resolve).
 */
export function derivePayloadFieldTree(
  vo: MetaData | undefined,
  seen: ReadonlySet<MetaData> = new Set(),
): PayloadField[] {
  if (vo === undefined || seen.has(vo)) return [];
  const nextSeen = new Set(seen).add(vo);
  const fields: PayloadField[] = [];
  for (const f of vo.children().filter(isMetaField)) {
    // ADR-0039: effective array-ness — `isArray` may be inherited via extends. Carried only
    // when true, so verify can tell a list of objects from a single object and a list of
    // scalars from a scalar.
    const arrayness = f.resolvedIsArray() ? { isArray: true } : {};
    if (f.subType === FIELD_SUBTYPE_OBJECT && typeof f.attr(FIELD_ATTR_OBJECT_REF) === "string") {
      // ADR-0039: effective attr — @objectRef may be inherited via extends.
      fields.push({ name: f.name, fields: derivePayloadFieldTree(refTarget(f, FIELD_ATTR_OBJECT_REF), nextSeen), ...arrayness });
      continue;
    }
    fields.push({ name: f.name, ...arrayness });
  }
  return fields;
}
