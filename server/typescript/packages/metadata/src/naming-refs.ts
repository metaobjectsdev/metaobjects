// References: the one resolver every reference form goes through (ADR-0059).
//
// Sources do not interpret references: YAML, canonical JSON and any future source
// build the tree with every reference string exactly as authored. This module
// gives each form its meaning, once, against the built tree:
//
//   `::Rest`      root-absolute — the node whose resolution key is exactly `Rest`
//                 (`::Apple` is the root-level Apple; `::a::b::C` is `a::b::C`).
//   `..::Rest`    parent-relative — drop one segment of the referrer's package per
//                 `..::`, then the exact key `<remaining>::Rest`. More `..::` than
//                 the package has segments is ERR_BAD_ATTR_VALUE.
//   `pkg::Name`   exact.
//   `Name`        the referrer's own package (`<referrerPkg>::Name`), else the
//                 root-level `Name` (ADR-0042 §2). Never another package.
//
// No form falls back to another: `::Apple` never binds a local `acme::Apple`.
// A FR-024 dotted child tail (`Owner.child.grand`) starts at the first `.` after the
// last `::`; only the owner part is resolved by form, and the tail is kept as written.
//
// `spellRef` is the inverse: the one canonical spelling of a resolved target that
// resolves to the same node with or without a referrer. The `resolveReferences`
// loader pass rewrites every reference to it, so consumers read canonical values.

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
import { OBJECT_REPORT_ATTR_FROM, OBJECT_REPORT_ATTR_SPINE } from "./core/object/object-constants.js";
import { TEMPLATE_ATTR_PAYLOAD_REF, TEMPLATE_ATTR_RESPONSE_REF } from "./template/template-constants.js";

const PARENT_PREFIX = PACKAGE_PARENT + PACKAGE_SEPARATOR; // "..::"

/**
 * The inline (`@`-prefixed) attribute names whose VALUE is a metadata object
 * reference (ADR-0059 R4). The structural `extends` key is handled separately (it is
 * not `@`-prefixed). `@objectRef`/`@references`/`@through` are pure object refs;
 * `@from`/`@of`/`@via`/`@spine` carry an entity HEAD with a dotted
 * relationship/field tail; `@parameterRef`/`@payloadRef`/`@responseRef` name
 * value-objects. The same set is used in every port. `@sourceRefField` (a FK FIELD
 * name) and `@implementedBy` (which may name a template as well as an object) are
 * NOT in the set.
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
  OBJECT_REPORT_ATTR_FROM, // = ORIGIN_PASSTHROUGH_ATTR_FROM ("from")
  OBJECT_REPORT_ATTR_SPINE,
]);

/** True when `raw` is a relative reference form (`::Rest` or `..::Rest`). */
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
export function splitChildTail(raw: string): { owner: string; tail: string } {
  const lastSep = raw.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const dotInSeg = raw.indexOf(CHILD_REF_SEPARATOR, segStart);
  if (dotInSeg === -1) return { owner: raw, tail: "" };
  return { owner: raw.slice(0, dotInSeg), tail: raw.slice(dotInSeg) };
}

/**
 * Expand an authored reference's OWNER part (no child tail) against a package
 * context: `::Rest` → `Rest`, `..::Rest` → the reduced package `::Rest`,
 * `pkg::Name` unchanged, bare `Name` → `<P>::Name`. Throws on parent-relative
 * over-drop. The resolver uses it for the two relative forms only; a bare name is
 * resolved own-package-then-root (see `ownerCandidateKeys`).
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
 * Expand an authored reference against a package context, preserving any FR-024
 * dotted child suffix. Throws on parent-relative over-drop — the caller emits an
 * error.
 */
export function expandRef(raw: string, packageContext: string): string {
  const { owner, tail } = splitChildTail(raw);
  return expandOwner(owner, packageContext) + tail;
}

/** A parent-relative reference with more `..::` than its referrer's package has segments. */
export class RefOverDropError extends Error {
  readonly code = "ERR_BAD_ATTR_VALUE" as const;
}

/**
 * The resolution keys an OWNER reference (no child tail) may bind, in the order to
 * try them (ADR-0059 R2). Every form but bare is one exact key; bare is the
 * referrer's own package, then root-level. Throws RefOverDropError on over-drop.
 */
export function ownerCandidateKeys(owner: string, referrerPkg: string): readonly string[] {
  if (owner.startsWith(PACKAGE_SEPARATOR)) return [owner.slice(PACKAGE_SEPARATOR.length)];
  if (owner.startsWith(PARENT_PREFIX)) {
    try {
      return [expandOwner(owner, referrerPkg)];
    } catch (err) {
      throw new RefOverDropError((err as Error).message);
    }
  }
  if (owner.includes(PACKAGE_SEPARATOR)) return [owner];
  return referrerPkg !== "" ? [`${referrerPkg}${PACKAGE_SEPARATOR}${owner}`, owner] : [owner];
}

/**
 * Does root-level object `node` satisfy object reference `ref` (no child tail),
 * declared by a node whose effective package is `referrerPkg`? True when the node's
 * resolution key is the FIRST candidate key that any object could bind — so it
 * agrees with `resolveObjectRef`. Never matches on a short name.
 */
export function refMatchesObject(node: MetaData, ref: string, referrerPkg: string): boolean {
  const resolved = resolveObjectRef(node.parent ?? node, ref, referrerPkg).node;
  if (resolved !== undefined) return resolved === node;
  return false;
}

/** The root's direct children of `type` (ADR-0039: root has no super). */
function topLevelOfType(root: MetaData, type: string | undefined): readonly MetaData[] {
  const all = root.children();
  return type === undefined ? all : all.filter((c) => c.type === type);
}

/** Bind an owner reference among `candidates` by exact resolution key (R2). */
function bindOwner(
  candidates: readonly MetaData[],
  owner: string,
  referrerPkg: string,
): { node?: MetaData | undefined; error?: string | undefined } {
  let keys: readonly string[];
  try {
    keys = ownerCandidateKeys(owner, referrerPkg);
  } catch (err) {
    return { error: (err as Error).message };
  }
  for (const key of keys) {
    const node = candidates.find((c) => c.resolutionKey() === key);
    if (node !== undefined) return { node };
  }
  return {};
}

/**
 * Resolve a metadata OBJECT reference (no child tail) under ADR-0059 R2.
 * `referrerPkg` is the referrer's package (R3). Returns `{ node }` on resolution,
 * `{ error }` for a parent-relative over-drop, or `{}` when nothing matches. The
 * single object resolver every object-ref site shares.
 */
export function resolveObjectRef(
  root: MetaData,
  ref: string,
  referrerPkg: string,
): { node?: MetaData | undefined; error?: string | undefined } {
  return bindOwner(topLevelOfType(root, TYPE_OBJECT), ref, referrerPkg);
}

/**
 * Resolve a reference that may carry a dotted child tail (ADR-0059 R2): bind the
 * owner among the root's top-level nodes (of `ownerType` when given), then walk the
 * tail by child name. Intermediate segments must be unique among the current node's
 * effective children; the last segment is scoped to `lastType` when given. Returns
 * the owner as well as the target, so a caller can spell the owner and keep the tail.
 */
export function resolveRef(
  root: MetaData,
  ref: string,
  referrerPkg: string,
  opts?: { ownerType?: string; lastType?: string },
): { node?: MetaData | undefined; owner?: MetaData | undefined; error?: string | undefined } {
  const { owner, tail } = splitChildTail(ref);
  const bound = bindOwner(topLevelOfType(root, opts?.ownerType), owner, referrerPkg);
  if (bound.node === undefined) return bound;
  if (tail === "") return { node: bound.node, owner: bound.node };
  const path = tail.slice(CHILD_REF_SEPARATOR.length).split(CHILD_REF_SEPARATOR);
  if (path.some((p) => p === "")) return {};
  let current: MetaData = bound.node;
  for (let i = 0; i < path.length - 1; i++) {
    const matches = current.children().filter((c) => c.name === path[i]);
    if (matches.length !== 1) return { owner: bound.node };
    current = matches[0]!;
  }
  const last = path[path.length - 1]!;
  const target = current
    .children()
    .find((c) => c.name === last && (opts?.lastType === undefined || c.type === opts.lastType));
  return { node: target, owner: bound.node };
}

/**
 * ADR-0059 R7 — resolve a CANONICAL reference with no referrer: strip one leading
 * `::`, match a top-level node's resolution key exactly, then walk any dotted tail.
 * For consumers that hold a resolved model and no referrer context. Never matches
 * on a short name.
 */
export function lookupCanonical(
  root: MetaData,
  value: string,
  opts?: { ownerType?: string; lastType?: string },
): MetaData | undefined {
  const { owner, tail } = splitChildTail(value);
  const exact = owner.startsWith(PACKAGE_SEPARATOR) ? owner : `${PACKAGE_SEPARATOR}${owner}`;
  return resolveRef(root, exact + tail, "", opts).node;
}

/**
 * ADR-0059 R6 — the canonical spelling of a resolved owner, as written from a
 * referrer in package `referrerPkg`: `pkg::Name` for a packaged target, `::Name` for
 * a root-level target from a packaged referrer, `Name` from a root-level referrer.
 * Every spelling resolves to the same node with or without a referrer.
 */
export function spellRef(target: MetaData, referrerPkg: string, tail = ""): string {
  const key = target.resolutionKey();
  const rootLevel = !key.includes(PACKAGE_SEPARATOR);
  return (rootLevel && referrerPkg !== "" ? `${PACKAGE_SEPARATOR}${key}` : key) + tail;
}

/** Effective package of a node: its own `package`, else its file's (ADR-0059 R10). */
export function effectivePackageOf(node: MetaData): string {
  return node.package ?? node.fileDefaultPackage ?? "";
}

/** The top-level node (a direct child of the root) that physically contains `node`. */
export function topLevelNodeOf(node: MetaData): MetaData {
  let current = node;
  while (current.parent !== undefined && current.parent.parent !== undefined) current = current.parent;
  return current;
}

/**
 * ADR-0059 R3 default — the package a reference attribute resolves in: the effective
 * package of the top-level node that PHYSICALLY declares the attribute. For an
 * attribute `node` inherits through `extends`, that is the ancestor that wrote it,
 * so an inherited reference means what it meant where it was written.
 */
export function referrerPackageFor(node: MetaData, attrName: string): string {
  let declarer: MetaData | undefined = node;
  const seen = new Set<MetaData>();
  // ADR-0039: own — locating the layer that physically declares the attr.
  while (declarer !== undefined && !declarer.ownHasAttr(attrName) && !seen.has(declarer)) {
    seen.add(declarer);
    declarer = declarer.superResolved;
  }
  return effectivePackageOf(topLevelNodeOf(declarer ?? node));
}

/**
 * ADR-0042 §5 — a did-you-mean suffix for an UNRESOLVED object reference: the
 * FQNs of same-short-name objects that DO exist (typically in other packages),
 * so the author can qualify a bare ref they meant to point across a package
 * boundary. Returns "" when no same-short-name object exists (nothing to
 * suggest). Appended to the per-attr unresolved-ref error message.
 */
export function didYouMeanHint(root: MetaData, ref: string): string {
  const found = sameNamedObjects(root, ref);
  if (found === undefined) return "";
  return ` An object named "${found.shortName}" exists in: ${found.candidates.join(", ")}. Qualify it with its package (FQN).`;
}

/**
 * The did-you-mean suffix for an UNRESOLVED `extends` ref: the same candidate list
 * as {@link didYouMeanHint}, plus the exact spelling to write. A bare `extends`
 * resolves in the referrer's own package (ADR-0042/0059), so a base declared in
 * another package must be named by its FQN. Returns "" when nothing is named alike.
 */
export function didYouMeanSuperHint(root: MetaData, ref: string): string {
  const found = sameNamedObjects(root, ref);
  if (found === undefined) return "";
  return ` An object named "${found.shortName}" exists in: ${found.candidates.join(", ")}. Qualify it with its package (FQN): write extends: "${found.candidates[0]}".`;
}

function sameNamedObjects(
  root: MetaData,
  ref: string,
): { shortName: string; candidates: string[] } | undefined {
  const { owner } = splitChildTail(ref);
  const sep = owner.lastIndexOf(PACKAGE_SEPARATOR);
  const shortName = sep === -1 ? owner : owner.slice(sep + PACKAGE_SEPARATOR.length);
  const candidates = root
    .children()
    .filter((c) => c.type === TYPE_OBJECT && c.name === shortName)
    .map((c) => c.resolutionKey());
  return candidates.length === 0 ? undefined : { shortName, candidates };
}

/**
 * ADR-0059 R7 — the object a reference attribute on `node` names: the owner the loader
 * bound once (`MetaAttr.resolvedTarget`), read RESOLVING so an inherited attribute
 * works (ADR-0039). For a dotted ref (`Week.id`, `Program.weeks`) it is the owner
 * object, not the tail. A tree built without the loader has no recorded target, so the
 * value is resolved here from the package of the node that declared it. Undefined when
 * the attribute is absent, is a list, or names nothing. Consumers use this instead of
 * comparing a reference value to a short name.
 */
export function refTarget(node: MetaData, attrName: string): MetaData | undefined {
  const seen = new Set<MetaData>();
  for (let n: MetaData | undefined = node; n !== undefined && !seen.has(n); n = n.superResolved) {
    seen.add(n);
    // ADR-0039: own — locating the layer that declares the attr, walking the super chain.
    const attr = n.ownMetaAttr(attrName);
    if (attr === undefined) continue;
    const recorded = attr.resolvedTarget;
    if (recorded !== undefined) return Array.isArray(recorded) ? undefined : (recorded as MetaData);
    const value = attr.value;
    if (typeof value !== "string" || value === "") return undefined;
    const { owner } = splitChildTail(value);
    return resolveObjectRef(node.root(), owner, effectivePackageOf(topLevelNodeOf(n))).node;
  }
  return undefined;
}
