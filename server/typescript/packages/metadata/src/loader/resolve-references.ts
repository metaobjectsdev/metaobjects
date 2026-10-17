// ADR-0059 R5 — resolve every reference once, after validation and before freeze.
//
// Sources do not interpret references (R1): YAML and canonical JSON hand the loader
// each reference string exactly as written. The validation passes resolve those
// authored strings through the shared resolver and report failures with their own
// codes. This pass then walks the physical tree once and, for every reference that
// resolves, records the target and rewrites the value to its canonical spelling (R6),
// keeping the authored string beside it. After the pass every consumer reads values
// that mean the same thing whatever package they are read from, and the serializer
// writes them as they are.
//
// A reference that does not resolve is left exactly as written: validation has
// already reported it.

import type { MetaData, AttrValue } from "../shared/meta-data.js";
import { MetaAttr } from "../core/attr/meta-attr.js";
import { TYPE_DIMENSION } from "../shared/base-types.js";
import { REPORTING_ATTR_OF, REPORTING_ATTR_VIA } from "../core/reporting/reporting-constants.js";
import {
  OBJECT_REPORT_ATTR_FROM,
  OBJECT_REPORT_ATTR_SPINE,
  OBJECT_SUBTYPE_REPORT,
} from "../core/object/object-constants.js";
import { TYPE_OBJECT } from "../shared/base-types.js";
import {
  REF_BEARING_ATTR_NAMES,
  effectivePackageOf,
  resolveObjectRef,
  spellRef,
  splitChildTail,
  topLevelNodeOf,
} from "../naming-refs.js";
import { resolveSuperRef } from "../super-resolve.js";
import { dimensionViaTerminal } from "./reporting-validation.js";

/** One resolved reference: its owner object and the canonical spelling. */
interface Resolved {
  readonly target: MetaData;
  readonly canonical: string;
}

/** Resolve one reference string's owner in `refPkg`, and spell it canonically. Root-level
 *  targets are spelled `::Name` unless both the resolution package and the declaring
 *  package are root-level, so a consumer reading from either package binds the same node. */
function resolveOne(root: MetaData, value: string, refPkg: string, declPkg: string): Resolved | undefined {
  const { owner, tail } = splitChildTail(value);
  const target = resolveObjectRef(root, owner, refPkg).node;
  if (target === undefined) return undefined;
  return { target, canonical: spellRef(target, refPkg !== "" ? refPkg : declPkg, tail) };
}

/** R3 — the package an own reference attribute of `node` resolves in. */
function referrerPackage(root: MetaData, node: MetaData, attr: string, declPkg: string): string {
  // `@of` on a dimension that walks `@via`: the package of the entity the walk reaches.
  if (node.type === TYPE_DIMENSION && attr === REPORTING_ATTR_OF) {
    // ADR-0039: resolving — the @via that governs this @of may be inherited.
    const via = node.attr(REPORTING_ATTR_VIA);
    const declaring = node.parent;
    if (typeof via === "string" && via !== "" && declaring !== undefined) {
      const terminal = dimensionViaTerminal(root, declaring, via);
      return terminal !== undefined ? effectivePackageOf(terminal) : declPkg;
    }
  }
  // `@spine` on a report: the package of the `@from` entity.
  if (node.type === TYPE_OBJECT && node.subType === OBJECT_SUBTYPE_REPORT && attr === OBJECT_REPORT_ATTR_SPINE) {
    // ADR-0039: resolving — @from may be inherited.
    const from = node.attr(OBJECT_REPORT_ATTR_FROM);
    if (typeof from === "string" && from !== "") {
      const fromNode = resolveObjectRef(root, from, declPkg).node;
      if (fromNode !== undefined) return effectivePackageOf(fromNode);
    }
  }
  return declPkg;
}

function resolveAttr(root: MetaData, node: MetaData, attr: MetaAttr, declPkg: string): void {
  const value = attr.value;
  const refPkg = referrerPackage(root, node, attr.name, declPkg);
  if (typeof value === "string") {
    if (value === "") return;
    const r = resolveOne(root, value, refPkg, declPkg);
    if (r === undefined) return;
    attr.resolvedTarget = r.target;
    if (r.canonical !== value) {
      attr.authoredValue ??= value;
      node.setAttr(attr.name, r.canonical);
    }
    return;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    const items = value as readonly string[];
    const resolved = items.map((v) => (v === "" ? undefined : resolveOne(root, v, refPkg, declPkg)));
    if (resolved.every((r) => r === undefined)) return;
    attr.resolvedTarget = resolved.map((r) => r?.target);
    const canonical: AttrValue = items.map((v, i) => resolved[i]?.canonical ?? v);
    if (canonical.some((v, i) => v !== items[i])) {
      attr.authoredValue ??= [...items];
      node.setAttr(attr.name, canonical);
    }
  }
}

/** Canonical `extends`: the owner spelled from the declaring node's package, tail kept. */
function resolveExtends(root: MetaData, node: MetaData): void {
  const ref = node.superRef;
  if (ref === undefined || node.superResolved === undefined) return;
  const pkg = effectivePackageOf(node);
  const { owner, tail } = splitChildTail(ref);
  let ownerNode: MetaData | undefined;
  try {
    ownerNode = resolveSuperRef(owner, pkg, root);
  } catch {
    return; // an over-drop never resolved, so superResolved would be unset
  }
  if (ownerNode === undefined) return;
  const canonical = spellRef(ownerNode, pkg, tail);
  if (canonical === ref) return;
  node.authoredSuperRef ??= ref;
  node.setSuper(canonical);
}

/**
 * Resolve every own reference attribute (ADR-0059 R4) and every `extends` in the
 * tree, record the targets, and rewrite resolved values to their canonical spelling.
 * Must run after the last validation pass and before `freeze()`.
 */
export function resolveReferences(root: MetaData): void {
  const visit = (node: MetaData): void => {
    if (node !== root) {
      resolveExtends(root, node);
      // R3 default: the effective package of the top-level node that physically
      // declares the attribute. Own attributes are declared here, by definition.
      const declPkg = effectivePackageOf(topLevelNodeOf(node));
      // ADR-0039: own — this pass rewrites the declared-here layer; an inherited
      // attribute is resolved once, on the node that declares it.
      for (const attr of node.ownMetaAttrs()) {
        if (REF_BEARING_ATTR_NAMES.has(attr.name)) resolveAttr(root, node, attr, declPkg);
      }
    }
    // ADR-0039: own — structural walk over the physical declaration tree.
    for (const child of node.ownChildren()) visit(child);
  };
  visit(root);
}
