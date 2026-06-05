// SP-G Registry Conformance — manifest emitter CLASSIFICATION (the in/out boundary).
//
// WHY THIS FILE IS A CLASSIFICATION, NOT A NAME-MATCH LIST (Wave 3b).
// ---------------------------------------------------------------------------
// The manifest's in/out boundary used to be decided by a bare exclusion
// name-list: an attr was OUT iff its name happened to be hand-added to the set,
// IN otherwise — a silent default-include. That is a tautology: it cannot tell a
// genuinely-logical attr from a port-private one; it just records the names
// someone remembered to list. The next physical/binding attr nobody adds to the
// list silently enters the cross-port logical contract.
//
// The principled axis. Every metamodel facet the emitter encounters is one of:
//
//   • LOGICAL  — part of the cross-port vocabulary contract. MUST be identical
//                in all five ports (this is what the gate measures). INCLUDED.
//                Note "logical" is NOT "non-physical": the physical-DB attrs
//                `column`/`dbColumnType`/`db.indexed`/`precision`/`scale`/
//                `maxLength`/`unique` ARE logical here — they are the agreed
//                cross-port persistence vocabulary (every port emits the same
//                DDL contract from them). The axis is cross-port-CONTRACT vs
//                port-PRIVATE-mechanism, not abstract-vs-physical.
//
//   • PORT_PRIVATE — a per-port mechanism, NOT cross-port vocabulary:
//        - NATIVE_BINDING   factories / native type classes / the ADR-0001
//                           `object` class-FQN binding + ADR-0005 `objectAdapter`
//                           value-access seam (OO-port runtime mechanisms).
//        - STRUCTURAL_KEYWORD bare body keywords (`isArray`/`isAbstract`/
//                           `extends`/`implements`/`isInterface`) — the
//                           structural/OO-shape spine, peers of name/children,
//                           never per-type attributes.
//        - COMMON_ATTR_DUP  `description` re-registered per-type (it lives in the
//                           `commonAttrs` block, never as a per-type attr).
//        - INHERITANCE_ANCHOR the `metadata.base` per-port abstract anchor (the
//                           deferred `inheritsFrom` facet; other ports register
//                           only the concrete `metadata.root`).
//        - PRESENTATION_ONLY the 11 generic `view.*` controls (checkbox/date/…)
//                           — a TS-web presentation facet (TS web client + TS
//                           form codegen consume them; zero backend/codegen/
//                           render consumers in any port), like the TS-only `D1`
//                           dialect. Stay REGISTERED in TS; deregistered in
//                           C#/Python; EXCLUDED from the manifest everywhere.
//
// The boundary is now an EXPLICIT classification (not a silent default): the
// port-private set is enumerated WITH a reason category, and a TRIPWIRE
// (`assertExclusionsAreLive`) asserts every enumerated exclusion is genuinely
// present in the registry — so a stale/typo'd exclusion (an excluded name no
// provider registers) fails the emit instead of silently doing nothing.
//
// Inclusion-by-default is SOUND here precisely because of ADR-0023: the library
// seals its composed metamodel registry after the agreed-provider bootstrap, so
// every registered (type, subType, attr) is, by construction, deliberately-agreed
// metamodel vocabulary — there is no "accidental" registration to silently let
// in. The classification's job is therefore to carve the small, declared set of
// agreed-but-port-private facets OUT of that agreed vocabulary, with a reason and
// a liveness tripwire. See fixtures/registry-conformance/README.md.

import { RESERVED_KEY_IS_ARRAY, RESERVED_KEY_EXTENDS } from "./shared/structural.js";
import { DOC_ATTR_DESCRIPTION } from "./core/documentation/doc-constants.js";
import { SUBTYPE_BASE, TYPE_METADATA, TYPE_VIEW } from "./shared/base-types.js";
import { VIEW_SUBTYPE_CURRENCY } from "./presentation/view/view-constants.js";
import { TEMPLATE_ATTR_RESPONSE_REF } from "./template/template-constants.js";

/** The reason an attr/row is classified PORT_PRIVATE (carved out of the agreed vocabulary). */
export enum ExclusionReason {
  /** Native type-binding / factory mechanism (incl. ADR-0001 `object`, ADR-0005 `objectAdapter`). */
  NativeBinding = "native-binding",
  /** Bare structural / OO-shape keyword (`isArray`/`isAbstract`/`extends`/`implements`/`isInterface`). */
  StructuralKeyword = "structural-keyword",
  /** A `commonAttr` (`description`) re-registered per-type — belongs in the commonAttrs block. */
  CommonAttrDup = "common-attr-dup",
  /** The `metadata.base` per-port inheritance anchor (deferred `inheritsFrom` facet). */
  InheritanceAnchor = "inheritance-anchor",
  /** TS-web-presentation-only facet (the generic `view.*` controls). */
  PresentationOnly = "presentation-only",
  /**
   * A TS-pilot feature attr deliberately NOT yet part of the cross-port
   * contract. Registered + validated + exercised in TS only (the other four
   * ports have not ported the foundation behind it), so it is carved out of the
   * cross-port manifest until the feature is promoted to all five ports. The
   * liveness tripwire still requires it to be genuinely registered in TS — this
   * is an explicit, reasoned carve-out, not a silent default. Today the sole
   * member is `template.prompt`'s `@responseRef` (the AI prompt-derived-trace
   * vertical, sibling of the cross-port `@payloadRef`).
   */
  TsPilotVocab = "ts-pilot-vocab",
}

/** `isAbstract` as Java's per-type attr name (the contract's bare `abstract` structural keyword). */
const ATTR_NAME_IS_ABSTRACT = "isAbstract";
/** Java-OO structural-shape keywords as per-type attr names (the OO modeling spine). */
const ATTR_NAME_IMPLEMENTS = "implements";
const ATTR_NAME_IS_INTERFACE = "isInterface";
/** ADR-0001 class-FQN type binding + ADR-0005 hybrid value-access seam (per-port runtime mechanisms). */
const ATTR_NAME_OBJECT = "object";
const ATTR_NAME_OBJECT_ADAPTER = "objectAdapter";

/**
 * The per-type attr names carved OUT of the agreed vocabulary, each mapped to
 * its PORT_PRIVATE reason category. This is the classification — an attr name
 * here is OUT *because of its declared category*, not merely because it is
 * listed. A per-type attr NOT in this map is LOGICAL (INCLUDED) by the
 * ADR-0023 sealed-vocabulary contract.
 */
export const EXCLUDED_PER_TYPE_ATTRS: ReadonlyMap<string, ExclusionReason> = new Map([
  [RESERVED_KEY_IS_ARRAY, ExclusionReason.StructuralKeyword],
  [ATTR_NAME_IS_ABSTRACT, ExclusionReason.StructuralKeyword],
  [RESERVED_KEY_EXTENDS, ExclusionReason.StructuralKeyword],
  [ATTR_NAME_IMPLEMENTS, ExclusionReason.StructuralKeyword],
  [ATTR_NAME_IS_INTERFACE, ExclusionReason.StructuralKeyword],
  [ATTR_NAME_OBJECT, ExclusionReason.NativeBinding],
  [ATTR_NAME_OBJECT_ADAPTER, ExclusionReason.NativeBinding],
  [DOC_ATTR_DESCRIPTION, ExclusionReason.CommonAttrDup],
  [TEMPLATE_ATTR_RESPONSE_REF, ExclusionReason.TsPilotVocab],
]);

/**
 * `(type, subType)` rows carved OUT of the agreed vocabulary, with reason.
 * `metadata.base` is the per-port inheritance anchor (INHERITANCE_ANCHOR); the
 * 11 generic `view.*` controls are TS-web-presentation-only (PRESENTATION_ONLY).
 * Returns the reason, or `undefined` for an INCLUDED (logical) row.
 */
export function classifyTypeSubType(
  type: string,
  subType: string,
): ExclusionReason | undefined {
  if (type === TYPE_METADATA && subType === SUBTYPE_BASE) {
    return ExclusionReason.InheritanceAnchor; // C-5 — Java's internal inheritance anchor
  }
  if (type === TYPE_VIEW && subType !== SUBTYPE_BASE && subType !== VIEW_SUBTYPE_CURRENCY) {
    return ExclusionReason.PresentationOnly; // B-2 — TS-web-presentation generic view controls
  }
  return undefined;
}

/** True if a `(type, subType)` row is carved out of the manifest (any reason). */
export function isExcludedTypeSubType(type: string, subType: string): boolean {
  return classifyTypeSubType(type, subType) !== undefined;
}
