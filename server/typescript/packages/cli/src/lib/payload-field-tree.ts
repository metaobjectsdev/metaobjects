// Derive a plain payload field tree from a loaded `object.value` view-object,
// for `meta verify` (FR-004 Plan #3, T6). This is the metadata-side bridge to
// the zero-core-dependency render engine: render's `verify` takes a PLAIN
// PayloadField[] (no metadata import), and this function produces it by walking
// the view-object exactly as payload-codegen.ts does — scalars become leaves,
// `field.object` with an `@objectRef` becomes a nested tree.

import {
  type MetaData,
  TYPE_FIELD,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import type { PayloadField } from "@metaobjectsdev/render";

function findObject(root: MetaData, name: string, referrerPkg: string): MetaData | undefined {
  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  // ADR-0042: package-local — an FQN @objectRef binds the exact package; a bare ref
  // binds the referrer's package FIRST (else root-level), never a same-named object.value
  // in another package. The SAME resolver render-helper.ts's findObject uses (must not drift).
  return resolveObjectRef(root, name, referrerPkg).node;
}

/**
 * Walk an `object.value` view-object into a render `PayloadField[]`. Object-ref
 * fields recurse into their referenced view-object; a `seen` set guards against
 * a (pathological) reference cycle. `referrerPkg` (ADR-0042) is the package of
 * the node that declares `voName` (the template for the root call; the parent VO
 * for a nested recursion), so a bare ref resolves package-locally.
 */
export function derivePayloadFieldTree(
  root: MetaData,
  voName: string,
  referrerPkg = "",
  seen: ReadonlySet<string> = new Set(),
): PayloadField[] {
  if (seen.has(voName)) return [];
  const vo = findObject(root, voName, referrerPkg);
  if (!vo) return [];
  // A nested @objectRef resolves in the FIELD's own declaring package (fallback
  // below), which differs from this VO's when the field is inherited via extends
  // from an abstract VO in another package (the bare ref was authored there).
  const voPkg = vo.package ?? vo.fileDefaultPackage ?? "";
  const nextSeen = new Set(seen).add(voName);
  const fields: PayloadField[] = [];
  for (const f of vo.children().filter((c) => c.type === TYPE_FIELD)) {
    if (f.subType === FIELD_SUBTYPE_OBJECT) {
      // ADR-0039: effective attr — @objectRef may be inherited via extends.
      const ref = f.attr(FIELD_ATTR_OBJECT_REF);
      if (typeof ref === "string") {
        const fieldPkg = f.parent?.package ?? f.parent?.fileDefaultPackage ?? voPkg;
        fields.push({ name: f.name, fields: derivePayloadFieldTree(root, ref, fieldPkg, nextSeen) });
        continue;
      }
    }
    fields.push({ name: f.name });
  }
  return fields;
}
