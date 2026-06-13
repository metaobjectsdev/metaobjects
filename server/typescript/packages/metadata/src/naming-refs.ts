// FR-032 (ADR-0032) — canonical reference expansion.
//
// `expandRef(raw, packageContext)` is the SINGLE ref-expansion primitive. It
// lowers an authored metadata reference to its fully-qualified canonical form
// per ADR-0032 §2.1 — deterministically, with NO root fallback:
//
//   bare `Name` (no `::`, no leading `.`)  → `<P>::Name` (current package only;
//                                            stays bare when P is empty/root).
//   qualified `pkg::Name` (contains `::`,  → unchanged (absolute from root).
//     NOT leading `::`)
//   `::Rest` (leading `::`)                → strip the leading `::`; the
//                                            remainder is absolute from root
//                                            (so `::a::b::C` ≡ `a::b::C`,
//                                            `::Apple` = root-level Apple).
//   `..::Rest` (one or more leading `..::`) → drop one package segment from P
//                                            per `..::`, then resolve Rest
//                                            (itself bare/qualified) against the
//                                            reduced package. Over-drop (more
//                                            `..::` than P has segments) throws.
//
// The trailing FR-024 DOTTED CHILD suffix (`.child` / `.child.grandchild`) is
// PRESERVED verbatim: only the OWNER part (everything before the first `.` in
// the final `::`-segment) is expanded; the `.child...` tail is reattached.
//
// The desugar runs this on every ref-bearing attr so canonical JSON is FQN-only
// (ADR-0032 §2.2/§2.3); the resolution layer then does pure FQN matching. The
// `package` attribute is NEVER expanded — it is the node's identity.

import type { MetaData } from "./shared/meta-data.js";
import { PACKAGE_SEPARATOR, PACKAGE_PARENT, CHILD_REF_SEPARATOR } from "./shared/structural.js";
import { RELATIONSHIP_ATTR_OBJECT_REF } from "./core/relationship/relationship-constants.js";
import { FIELD_ATTR_OBJECT_REF } from "./core/field/field-constants.js";
import { IDENTITY_REFERENCE_ATTR_REFERENCES } from "./core/identity/identity-constants.js";
import {
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_COLLECTION_ATTR_VIA,
} from "./persistence/origin/origin-constants.js";
import { SOURCE_ATTR_PARAMETER_REF } from "./persistence/source/source-constants.js";
import { TEMPLATE_ATTR_PAYLOAD_REF, TEMPLATE_ATTR_RESPONSE_REF } from "./template/template-constants.js";

const PARENT_PREFIX = PACKAGE_PARENT + PACKAGE_SEPARATOR; // "..::"

/**
 * The inline (`@`-prefixed) attribute names whose VALUE is a metadata reference
 * subject to FR-032 expansion/guarding (ADR-0032 §3). The structural `extends`
 * key is handled separately (it is not `@`-prefixed). `@objectRef`/`@references`
 * are pure object refs; `@from`/`@of`/`@via` carry an entity HEAD (possibly with
 * a dotted relationship/field tail — expandRef preserves the tail);
 * `@parameterRef`/`@payloadRef`/`@responseRef` reference value-objects. These are
 * expanded by the YAML desugar and rejected (when still relative) by the
 * canonical-JSON guard. `@sourceRefField` (a FK FIELD name, not an object ref)
 * and `@through` are intentionally NOT in this set (out of scope for FR-032 T-slice).
 */
export const REF_BEARING_ATTR_NAMES: ReadonlySet<string> = new Set<string>([
  RELATIONSHIP_ATTR_OBJECT_REF, // = FIELD_ATTR_OBJECT_REF (same spelling "objectRef")
  FIELD_ATTR_OBJECT_REF,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA, // = ORIGIN_AGGREGATE_ATTR_VIA = ORIGIN_COLLECTION_ATTR_VIA ("via")
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_COLLECTION_ATTR_VIA,
  SOURCE_ATTR_PARAMETER_REF,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_RESPONSE_REF,
]);

/**
 * True when `raw` is a relative reference form (`::Rest` or `..::Rest`) that the
 * YAML desugar must expand before canonical JSON. Canonical JSON must be FQN; a
 * relative ref surviving into it is `ERR_RELATIVE_REF_IN_CANONICAL`.
 */
export function isRelativeRef(raw: string): boolean {
  return raw.startsWith(PACKAGE_SEPARATOR) || raw.startsWith(PARENT_PREFIX);
}

/**
 * Split a ref into its owner part (the object reference) and any FR-024 dotted
 * child tail. The `.` that marks a child can only appear in the FINAL
 * `::`-segment (package separators never follow a child dot), so the owner ends
 * at the first `.` AFTER the last `::`. Returns `{ owner, tail }` where `tail`
 * includes the leading `.` (or is "" when there is no child suffix).
 */
function splitChildTail(raw: string): { owner: string; tail: string } {
  const lastSep = raw.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const dotInSeg = raw.indexOf(CHILD_REF_SEPARATOR, segStart);
  if (dotInSeg === -1) return { owner: raw, tail: "" };
  return { owner: raw.slice(0, dotInSeg), tail: raw.slice(dotInSeg) };
}

/**
 * Expand an authored reference's OWNER part (no child tail) to its FQN per
 * ADR-0032 §2.1. Throws on parent-relative over-drop.
 */
function expandOwner(owner: string, packageContext: string): string {
  // root-absolute: leading "::" → strip; the remainder is absolute from root.
  if (owner.startsWith(PACKAGE_SEPARATOR)) {
    return owner.slice(PACKAGE_SEPARATOR.length);
  }

  // parent-relative: one or more leading "..::".
  if (owner.startsWith(PARENT_PREFIX)) {
    let rest = owner;
    let levels = 0;
    while (rest.startsWith(PARENT_PREFIX)) {
      levels++;
      rest = rest.slice(PARENT_PREFIX.length);
    }
    const pkgParts = packageContext !== "" ? packageContext.split(PACKAGE_SEPARATOR) : [];
    if (levels > pkgParts.length) {
      throw new Error(
        `Relative reference '${owner}' over-drops: ${levels} parent level(s) ` +
          `but the package context '${packageContext}' has only ${pkgParts.length} segment(s)`,
      );
    }
    const reducedPkg = pkgParts.slice(0, pkgParts.length - levels).join(PACKAGE_SEPARATOR);
    // `rest` is itself bare/qualified — resolve it against the reduced package.
    // (A qualified remainder still resolves bare-in-the-reduced-package per the
    // §2.1 example `..::veg::Carrot` → `acme::veg::Carrot`.)
    return reducedPkg !== "" ? `${reducedPkg}${PACKAGE_SEPARATOR}${rest}` : rest;
  }

  // qualified: contains "::" (not leading) → absolute, unchanged.
  if (owner.includes(PACKAGE_SEPARATOR)) {
    return owner;
  }

  // bare name → current package (only). Stays bare when context is empty/root.
  return packageContext !== "" ? `${packageContext}${PACKAGE_SEPARATOR}${owner}` : owner;
}

/**
 * Expand an authored reference to its fully-qualified canonical form per
 * ADR-0032 §2.1, preserving any FR-024 dotted child suffix. The package context
 * `P` is the declaring node's effective package (its own `package` or the
 * file-default). Throws on parent-relative over-drop — the caller emits an error.
 */
export function expandRef(raw: string, packageContext: string): string {
  const { owner, tail } = splitChildTail(raw);
  return expandOwner(owner, packageContext) + tail;
}

/**
 * FR-032 — does a root-level object `node` satisfy an (already-expanded)
 * object reference `ref`? After the YAML desugar + corpus sweep every ref is
 * fully qualified, so resolution is a pure FQN match. Objects keep a BARE
 * `fqn()` per the FR5d cross-port contract, so the canonical FQN accessor is
 * `resolutionKey()` (`<package | fileDefaultPackage>::<name>`) — this mirrors
 * `super-resolve`'s `findInTree`. The bare `name`/`fqn()` arms cover legacy
 * same-tree refs and root-level (empty-package) objects.
 *
 * This is the single matcher the non-super resolvers (origin `@from`/`@of`/
 * `@via` heads, template `@payloadRef`/`@responseRef`, source `@parameterRef`)
 * share, so FQN matching behaves identically everywhere a ref resolves.
 */
export function refMatchesObject(node: MetaData, ref: string): boolean {
  return node.resolutionKey() === ref || node.fqn() === ref || node.name === ref;
}
