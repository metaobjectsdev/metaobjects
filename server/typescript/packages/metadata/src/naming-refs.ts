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
import { TYPE_OBJECT } from "./shared/base-types.js";
import { RELATIONSHIP_ATTR_OBJECT_REF, RELATIONSHIP_ATTR_THROUGH } from "./core/relationship/relationship-constants.js";
import { FIELD_ATTR_OBJECT_REF } from "./core/field/field-constants.js";
import { IDENTITY_REFERENCE_ATTR_REFERENCES } from "./core/identity/identity-constants.js";
import {
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
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
 * canonical-JSON guard. `@through` (the M:N junction ref) is in the set per
 * ADR-0042 §4 — it desugars to FQN and resolves package-local like every other
 * object ref. `@sourceRefField` (a FK FIELD name, not an object ref) is NOT in
 * the set.
 */
export const REF_BEARING_ATTR_NAMES: ReadonlySet<string> = new Set<string>([
  RELATIONSHIP_ATTR_OBJECT_REF, // = FIELD_ATTR_OBJECT_REF (same spelling "objectRef")
  FIELD_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_THROUGH, // ADR-0042: the M:N junction ref joins the desugar+resolution set.
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA, // = ORIGIN_AGGREGATE_ATTR_VIA ("via")
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
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
 * ADR-0042 — does root-level object `node` satisfy object reference `ref`,
 * declared by a node whose effective package is `referrerPkg`? A single
 * package-local matcher:
 *   - **FQN** `ref` (contains `::`) → EXACT match on `resolutionKey()`. No
 *     bare-tail fallback, so an FQN pointing at one package never binds a
 *     same-named object in another.
 *   - **bare** `ref` (no `::`) → the referrer's OWN package
 *     (`<referrerPkg>::<ref>`), else a **root-level** (empty-package) object
 *     whose resolution key IS `ref`. No cross-package bare resolution, no
 *     globally-unique scan.
 *
 * Objects keep a BARE `fqn()` per the FR5d cross-port contract, so the canonical
 * FQN accessor is `resolutionKey()` (`<package | fileDefaultPackage>::<name>`) —
 * this mirrors `super-resolve`'s `findInTree`. This is the single matcher the
 * non-super resolvers (origin `@from`/`@of`/`@via` heads, template
 * `@payloadRef`/`@responseRef`, source `@parameterRef`, relationship `@through`)
 * share, so resolution behaves identically everywhere a ref resolves.
 *
 * `referrerPkg` defaults to `""` — the fail-closed FQN-exact-plus-root-level
 * behavior. The LOADER always passes the real referrer package (bare refs there
 * must resolve package-locally); downstream CODEGEN resolvers, which run on
 * already-validated metadata whose refs are FQN, may omit it. An empty
 * `referrerPkg` never binds a bare ref across a package boundary (fail-closed),
 * so omission can only fail to resolve — never mis-resolve.
 */
export function refMatchesObject(node: MetaData, ref: string, referrerPkg = ""): boolean {
  const key = node.resolutionKey();
  if (ref.includes(PACKAGE_SEPARATOR)) return key === ref;
  if (referrerPkg !== "" && key === `${referrerPkg}${PACKAGE_SEPARATOR}${ref}`) return true;
  return key === ref; // root-level (empty-package) object whose key is the bare name
}

/**
 * Resolve a metadata OBJECT reference under the ADR-0042 package-local contract
 * (see `refMatchesObject` for the matcher). `referrerPkg` is the effective
 * package of the node carrying the ref. Returns `{ node }` on resolution, or
 * `{}` (node undefined) when nothing matches — there is NO ambiguous outcome
 * (bare = package-local, so ambiguity is unreachable). The SINGLE resolver every
 * object-ref site shares so the contract is uniform.
 */
export function resolveObjectRef(
  root: MetaData,
  ref: string,
  referrerPkg: string,
): { node?: MetaData | undefined } {
  const objects = root.children().filter((c) => c.type === TYPE_OBJECT);
  if (ref.includes(PACKAGE_SEPARATOR)) {
    return { node: objects.find((c) => c.resolutionKey() === ref) };
  }
  // Bare: PREFER the referrer's own package, THEN a root-level (empty-package)
  // object — mirroring the loader symbol table's `byKey.get(localKey) ?? get(ref)`
  // so both resolvers agree when a root-level object shares the bare name.
  const localKey = referrerPkg !== "" ? `${referrerPkg}${PACKAGE_SEPARATOR}${ref}` : ref;
  const own = objects.find((c) => c.resolutionKey() === localKey);
  if (own !== undefined) return { node: own };
  return { node: localKey !== ref ? objects.find((c) => c.resolutionKey() === ref) : undefined };
}

/**
 * ADR-0042 §5 — a did-you-mean suffix for an UNRESOLVED object reference: the
 * FQNs of same-short-name objects that DO exist (typically in other packages),
 * so the author can qualify a bare ref they meant to point across a package
 * boundary. Returns "" when no same-short-name object exists (nothing to
 * suggest). Appended to the per-attr unresolved-ref error message.
 */
export function didYouMeanHint(root: MetaData, ref: string): string {
  const { owner } = splitChildTail(ref);
  const sep = owner.lastIndexOf(PACKAGE_SEPARATOR);
  const shortName = sep === -1 ? owner : owner.slice(sep + PACKAGE_SEPARATOR.length);
  const candidates = root
    .children()
    .filter((c) => c.type === TYPE_OBJECT && c.name === shortName)
    .map((c) => c.resolutionKey());
  if (candidates.length === 0) return "";
  return ` An object named "${shortName}" exists in: ${candidates.join(", ")}. Qualify it with its package (FQN).`;
}
