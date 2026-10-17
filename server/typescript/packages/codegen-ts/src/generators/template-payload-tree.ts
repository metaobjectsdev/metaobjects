// Enriched payload-field tree for the template-source annotator
// (linked-template-source-docs, Task 4).
//
// The render-helper drift gate walks the payload VO into a bare `PayloadField[]`
// (name + nested fields) — enough to VERIFY that a `{{field}}` exists. The doc
// page needs MORE per node: which VO OWNS the field (so the link points at the
// right entity page), the field's NEUTRAL type, and whether it's required — the
// exact same facts the entity Constraints table shows.
//
// This walk produces that `AnnotatePayloadField[]`. It is the same recursion the
// render-helper's `derivePayloadFieldTree` does (object-ref fields recurse into
// their referenced VO; a `seen` set guards a reference cycle) — but it carries
// owner/type/required and SWITCHES owner to the nested VO when it descends, so a
// `{{address.city}}` resolves to `Address.city` and links to `./Address.md`.
//
// Reuse, not reimplementation:
//   • isFieldRequired / neutralTypeStr — the SAME helpers the entity Constraints
//     table uses, so the documented type/required can never drift from the
//     entity page.

import {
  type MetaObject,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  isMetaObject,
  refTarget,
  stripPackage,
} from "@metaobjectsdev/metadata";
import { isFieldRequired, neutralTypeStr } from "./docs-data-builder.js";
import type { AnnotatePayloadField } from "./template-source-annotate.js";

/**
 * Walk the payload VO `vo` into an enriched `AnnotatePayloadField[]`. Each
 * node carries `owner` (the short name of the VO that DECLARES the field),
 * `ownerKey` (its resolution key — the link target), `type` (the neutral logical type), and `required`. Object-ref
 * fields recurse into the VO the loader bound for their `@objectRef` (ADR-0059 R7),
 * with `owner` switched to that nested VO; a `seen` set guards a (pathological)
 * reference cycle (returns `[]` rather than recursing forever).
 *
 * Returns `[]` when the VO is undefined (the ref did not resolve) — the annotator
 * then leaves the referencing variables unresolved (flagged "not on payload"),
 * never throws.
 */
export function buildEnrichedPayloadTree(
  vo: MetaObject | undefined,
  seen: ReadonlySet<MetaObject> = new Set(),
): AnnotatePayloadField[] {
  if (vo === undefined || seen.has(vo)) return [];
  const owner = stripPackage(vo.name);
  const ownerKey = vo.resolutionKey();
  const nextSeen = new Set(seen).add(vo);
  const out: AnnotatePayloadField[] = [];
  for (const f of vo.fields()) {
    const node: AnnotatePayloadField = {
      name: f.name,
      owner,
      ownerKey,
      type: neutralTypeStr(f),
      required: isFieldRequired(f),
      ...(f.resolvedIsArray() ? { isArray: true } : {}),
    };
    if (f.subType === FIELD_SUBTYPE_OBJECT) {
      const target = refTarget(f, FIELD_ATTR_OBJECT_REF);
      if (target !== undefined && isMetaObject(target)) {
        node.fields = buildEnrichedPayloadTree(target, nextSeen);
      }
    }
    out.push(node);
  }
  return out;
}
