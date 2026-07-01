// Derive a plain payload field tree from a loaded `object.value` view-object,
// for `meta verify` (FR-004 Plan #3, T6). This is the metadata-side bridge to
// the zero-core-dependency render engine: render's `verify` takes a PLAIN
// PayloadField[] (no metadata import), and this function produces it by walking
// the view-object exactly as payload-codegen.ts does — scalars become leaves,
// `field.object` with an `@objectRef` becomes a nested tree.

import {
  type MetaData,
  TYPE_OBJECT,
  TYPE_FIELD,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
} from "@metaobjectsdev/metadata";
import type { PayloadField } from "@metaobjectsdev/render";

function findObject(root: MetaData, name: string): MetaData | undefined {
  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  return root.children().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

/**
 * Walk an `object.value` view-object into a render `PayloadField[]`. Object-ref
 * fields recurse into their referenced view-object; a `seen` set guards against
 * a (pathological) reference cycle.
 */
export function derivePayloadFieldTree(
  root: MetaData,
  voName: string,
  seen: ReadonlySet<string> = new Set(),
): PayloadField[] {
  if (seen.has(voName)) return [];
  const vo = findObject(root, voName);
  if (!vo) return [];
  const nextSeen = new Set(seen).add(voName);
  const fields: PayloadField[] = [];
  for (const f of vo.children().filter((c) => c.type === TYPE_FIELD)) {
    if (f.subType === FIELD_SUBTYPE_OBJECT) {
      // ADR-0039: effective attr — @objectRef may be inherited via extends.
      const ref = f.attr(FIELD_ATTR_OBJECT_REF);
      if (typeof ref === "string") {
        fields.push({ name: f.name, fields: derivePayloadFieldTree(root, ref, nextSeen) });
        continue;
      }
    }
    fields.push({ name: f.name });
  }
  return fields;
}
