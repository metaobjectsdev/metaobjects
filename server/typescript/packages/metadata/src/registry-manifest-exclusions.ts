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

import { RESERVED_KEY_IS_ARRAY, RESERVED_KEY_EXTENDS } from "./shared/structural.js";
import { DOC_ATTR_DESCRIPTION } from "./core/documentation/doc-constants.js";
import { SUBTYPE_BASE, TYPE_METADATA, TYPE_VIEW } from "./shared/base-types.js";
import { VIEW_SUBTYPE_CURRENCY } from "./presentation/view/view-constants.js";

/** The `isAbstract` structural keyword as Java's per-type attr name (the contract's bare `abstract`). */
const ATTR_NAME_IS_ABSTRACT = "isAbstract";

/**
 * The Java-OO structural-shape keyword names (`implements`, `isInterface`) as
 * Java's per-type attr names. Like `extends`/`isArray`/`isAbstract` these are
 * bare structural/OO-shape keywords (the OO modeling spine), NOT per-type
 * attributes in the cross-port logical vocabulary. TS/C#/Python never register
 * them as per-type attrs, so filtering them here is a no-op for those ports;
 * the filter is what drops Java's per-type registrations from its emitter. See
 * SP-G analysis C-2/C-3 (Unit 6b).
 */
const ATTR_NAME_IMPLEMENTS = "implements";
const ATTR_NAME_IS_INTERFACE = "isInterface";

/**
 * The two per-port type-BINDING facet attr names: `object` (ADR-0001 class-FQN
 * type binding for OO ports — the Java runtime resolves an object's native class
 * from this attr) and `objectAdapter` (ADR-0005 hybrid value-access seam). These
 * are the same category as the already-excluded native type bindings —
 * legitimate per-port binding mechanisms, not cross-port logical vocabulary. Java
 * registers them as per-type attrs on `object.*` and the filter drops them from
 * its emitter; no-op for TS/C#/Python (which never register them). See SP-G Unit
 * 6b-finish.
 */
const ATTR_NAME_OBJECT = "object";
const ATTR_NAME_OBJECT_ADAPTER = "objectAdapter";

/**
 * Per-type attr names excluded from the manifest's `attrs` list — structural /
 * OO-shape keywords (`isArray`, `isAbstract`, `extends`, `implements`,
 * `isInterface`), the per-port type-binding facets (`object`, `objectAdapter`),
 * and the `description` commonAttr (emitted in the `commonAttrs` block, never
 * per-type). See C-2/C-3 + Unit 6b-finish.
 */
export const EXCLUDED_PER_TYPE_ATTR_NAMES: ReadonlySet<string> = new Set<string>([
  RESERVED_KEY_IS_ARRAY,
  ATTR_NAME_IS_ABSTRACT,
  RESERVED_KEY_EXTENDS,
  ATTR_NAME_IMPLEMENTS,
  ATTR_NAME_IS_INTERFACE,
  ATTR_NAME_OBJECT,
  ATTR_NAME_OBJECT_ADAPTER,
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
