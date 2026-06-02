// SP-G Registry Conformance — manifest emitter exclusions.
//
// A small, explicit, documented exclusion set applied UNIFORMLY by all four
// registry-manifest emitters (TS / C# / Python / Java) so the canonical settles
// to its cross-port logical shape. Each exclusion is a principled decision (see
// the SP-G divergence analysis, buckets C-2/C-3/C-5 and B-2), NOT a fudge to
// hide a real divergence:
//
//  - Structural-keyword / commonAttr per-type attrs (C-2/C-3): `isArray` and
//    `isAbstract` are bare STRUCTURAL KEYWORDS (peers of name/extends/children),
//    and `description` is a `commonAttr` — none is a per-type attribute. Java
//    additionally registers all three as ordinary per-type attrs (inherited
//    everywhere); the others do not. Filtering them by name from the per-type
//    `attrs` list makes every port's emitter agree (no-op for TS/C#/Python,
//    which never registered them as per-type attrs).
//
//  - The `metadata.base` inheritance anchor (C-5): Java registers an internal
//    abstract anchor (`metadata.base`) that all types inherit from; the other
//    ports register only the concrete tree root (`metadata.root`). It is the
//    not-universally-tracked `inheritsFrom` anchor the manifest already defers,
//    so the `(type, subType)` row is skipped.
//
//  - The 11 generic `view.*` controls (B-2): `checkbox`/`date`/`dropdown`/
//    `hidden`/`hotlink`/`month`/`number`/`password`/`radio`/`text`/`textarea`/
//    `web` are a TS-web-PRESENTATION facet (the TS web client + TS form codegen
//    consume them; zero backend/codegen/render consumers in any port). Like the
//    TS-only `D1` dialect, they are excluded from the cross-port logical
//    contract. They stay REGISTERED in TS (the loader must accept an authored
//    `view.dropdown`); C#/Python deregister them (dead vocab there). Only
//    `view.base` + `view.currency` (the cross-port currency `@locale` wire
//    contract) remain in the manifest.

import { RESERVED_KEY_IS_ARRAY } from "./shared/structural.js";
import { DOC_ATTR_DESCRIPTION } from "./core/documentation/doc-constants.js";
import { SUBTYPE_BASE, TYPE_METADATA, TYPE_VIEW } from "./shared/base-types.js";
import { VIEW_SUBTYPE_CURRENCY } from "./presentation/view/view-constants.js";

/** The `isAbstract` structural keyword as Java's per-type attr name (the contract's bare `abstract`). */
const ATTR_NAME_IS_ABSTRACT = "isAbstract";

/**
 * Per-type attr names excluded from the manifest's `attrs` list — structural
 * keywords (`isArray`, `isAbstract`) and the `description` commonAttr (which is
 * emitted in the `commonAttrs` block, never per-type). See C-2/C-3.
 */
export const EXCLUDED_PER_TYPE_ATTR_NAMES: ReadonlySet<string> = new Set<string>([
  RESERVED_KEY_IS_ARRAY,
  ATTR_NAME_IS_ABSTRACT,
  DOC_ATTR_DESCRIPTION,
]);

/**
 * `(type, subType)` rows excluded from the manifest. `metadata.base` is Java's
 * internal inheritance anchor (the deferred `inheritsFrom` anchor — C-5). The
 * 11 generic `view.*` controls are a TS-web-presentation facet (B-2): every
 * `view.*` subtype EXCEPT `base` and `currency` is excluded.
 */
export function isExcludedTypeSubType(type: string, subType: string): boolean {
  if (type === TYPE_METADATA && subType === SUBTYPE_BASE) {
    return true; // C-5 — Java's internal inheritance anchor
  }
  if (type === TYPE_VIEW && subType !== SUBTYPE_BASE && subType !== VIEW_SUBTYPE_CURRENCY) {
    return true; // B-2 — TS-web-presentation-only generic view controls
  }
  return false;
}
