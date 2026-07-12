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
  type MetaRoot,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  stripPackage,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";
import { isFieldRequired, neutralTypeStr } from "./docs-data-builder.js";
import type { AnnotatePayloadField } from "./template-source-annotate.js";

// ADR-0041/0042: FQN-exact object resolution — a "::"-qualified @objectRef binds the exact
// package (never a bare-tail fallback), so a same-named object.value in another package
// can't be wrongly bound (which would attach the wrong owner/type/link to a doc node); a
// bare ref binds the referrer's package FIRST, else a root-level object.
// Mirrors render-helper.ts's findObject + the CLI payload-field-tree resolver.
function findObject(root: MetaRoot, ref: string, referrerPkg = ""): MetaObject | undefined {
  return resolveObjectRef(root, ref, referrerPkg).node as MetaObject | undefined;
}

/**
 * Walk the payload VO `voName` into an enriched `AnnotatePayloadField[]`. Each
 * node carries `owner` (the short name of the VO that DECLARES the field — the
 * link target), `type` (the neutral logical type), and `required`. Object-ref
 * fields recurse into their referenced VO with `owner` switched to that nested
 * VO; a `seen` set guards a (pathological) reference cycle (returns `[]` rather
 * than recursing forever).
 *
 * Returns `[]` when the VO can't be resolved — the annotator then leaves the
 * referencing variables unresolved (flagged "not on payload"), never throws.
 */
export function buildEnrichedPayloadTree(
  root: MetaRoot,
  voName: string,
  referrerPkg = "",
  seen: ReadonlySet<string> = new Set(),
): AnnotatePayloadField[] {
  if (seen.has(voName)) return [];
  const vo: MetaObject | undefined = findObject(root, voName, referrerPkg);
  if (vo === undefined) return [];
  const owner = stripPackage(vo.name);
  // ADR-0042: a nested @objectRef resolves in the FIELD's own declaring package
  // (fallback below), which differs from this VO's when the field is inherited via
  // extends from an abstract VO in another package (the bare ref was authored there).
  const voPkg = vo.package ?? vo.fileDefaultPackage ?? "";
  const nextSeen = new Set(seen).add(voName);
  const out: AnnotatePayloadField[] = [];
  for (const f of vo.fields()) {
    const node: AnnotatePayloadField = {
      name: f.name,
      owner,
      type: neutralTypeStr(f),
      required: isFieldRequired(f),
    };
    if (f.subType === FIELD_SUBTYPE_OBJECT) {
      const ref = f.attr(FIELD_ATTR_OBJECT_REF);
      if (typeof ref === "string" && ref.length > 0) {
        // Owner switches to the nested VO for its fields (the recursion below
        // re-derives `owner` from the resolved VO's own name). Pass the FULL ref
        // (not stripPackage), resolved package-locally against the FIELD's declaring
        // package (ADR-0042 — the bare ref was authored there, not on the concrete VO).
        const fieldPkg = f.parent?.package ?? f.parent?.fileDefaultPackage ?? voPkg;
        node.fields = buildEnrichedPayloadTree(root, ref, fieldPkg, nextSeen);
      }
    }
    out.push(node);
  }
  return out;
}
