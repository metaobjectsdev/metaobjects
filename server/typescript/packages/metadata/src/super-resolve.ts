// super reference resolution — package navigation helpers
//
// Reference syntax (Java metaobjects-core conventions):
//   Bare name       "Fruit"            → resolve in contextPackage, then root fallback
//   Absolute        "::fishstore::Fish" → strip leading ::, walk from root
//   Relative parent "..::common::id"   → up one package level, then resolve "common::id"
//   Multi-level     "..::..::shared::User" → up two levels, then resolve "shared::User"
//   Same-package    "common::id"       → try contextPackage prepend first, then root-rooted
//
// Super resolution is now IMMEDIATE during parse (Java behavior).
// This module provides only the lookup helper; the parser calls it inline.
// The old resolveSupers() multi-pass walker has been deleted.

import type { MetaData } from "./shared/meta-data.js";
import { PACKAGE_SEPARATOR, PACKAGE_PARENT, CHILD_REF_SEPARATOR } from "./shared/structural.js";

// ---------------------------------------------------------------------------
// Tree search helper
// ---------------------------------------------------------------------------

/**
 * Recursively searches the tree for a node whose qualified name matches `fqn`.
 *
 * A node is matched by its own `fqn()` (covers the explicit-package and
 * no-package-at-all cases) OR by its EFFECTIVE qualified key
 * `<fileDefaultPackage>::<name>` (`MetaData.resolutionKey()`) — the
 * file-default package captured at PARSE time. This mirrors Java, where
 * `BaseMetaDataParser` folds the file-default package into the registered name
 * at parse time (so an object `BaseEntity` declared under `package: acme` is
 * registered as `acme::BaseEntity` and a fully-qualified `extends:
 * acme::BaseEntity` resolves) — even though TS keeps object `fqn()` bare for
 * the FR5d referrer-envelope cross-port contract.
 *
 * Because the resolution key is captured at parse time (not derived from the
 * post-merge tree), this is independent of load order AND of whether the base
 * node's file-default package differs from the referrer's — the cross-PACKAGE
 * cross-file case. No package is threaded down the walk anymore.
 */
function findInTree(root: MetaData, fqn: string): MetaData | undefined {
  if (root.fqn() === fqn) return root;
  if (root.package === undefined && root.name !== "" && root.resolutionKey() === fqn) {
    return root;
  }
  for (const child of root.ownChildren()) {
    const found = findInTree(child, fqn);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Reference parsing & resolution
// ---------------------------------------------------------------------------

/**
 * FR-024 (ADR-0029): the type-scope of the node whose `extends` is being
 * resolved. A dotted `Entity.child` ref selects among the owner's children of
 * the SAME type as the referrer — a field ref resolves fields, an identity
 * ref resolves identities. Required for the dotted branch; ignored for
 * dot-free refs (legacy behavior unchanged).
 */
export interface ReferrerScope {
  readonly type: string;
}

/**
 * FR-024: true when a ref's final `::`-segment contains a `.` — i.e. the ref
 * targets a child nested inside an object (`Customer.id`,
 * `acme::sales::Customer.id`). Names cannot contain `.`, so this is
 * unambiguous. Call sites use this to apply the dotted-only
 * type/subtype-mismatch check (ERR_EXTENDS_TARGET_MISMATCH) without altering
 * shipped top-level extends behavior.
 */
export function isChildTargetingRef(ref: string): boolean {
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const lastSegment = lastSep === -1 ? ref : ref.slice(lastSep + PACKAGE_SEPARATOR.length);
  return lastSegment.includes(CHILD_REF_SEPARATOR);
}

/**
 * FR-024: split a child-targeting ref into the owner-object ref and the child
 * name. Returns undefined for the reserved multi-dot form (`X.y.z`) and for
 * degenerate empty parts (`.id`, `Customer.`).
 */
function parseChildTargetingRef(
  ref: string,
): { ownerRef: string; path: readonly string[] } | undefined {
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const lastSegment = ref.slice(segStart);
  const parts = lastSegment.split(CHILD_REF_SEPARATOR);
  if (parts.length < 2 || parts.some((p) => p === "")) return undefined;
  return {
    ownerRef: ref.slice(0, segStart) + parts[0],
    path: parts.slice(1),
  };
}

/**
 * Resolve a single super reference string against a tree.
 *
 * Called by the parser IMMEDIATELY when a node with a `super` key is created,
 * against the loader's accumulating root (intoRoot). Java semantics: if the
 * ref cannot be resolved, the parser throws ParseError.
 *
 * FR-024 (ADR-0029): a ref whose final segment is dotted (`Customer.id`)
 * targets a child nested inside an object. The owner part resolves with the
 * existing strategies (absolute / relative / bare / same-package); the child
 * is then selected among the owner's EFFECTIVE children (so inherited
 * children resolve) by name AND the referrer's type (type-scoped). A dotted
 * ref that does not resolve returns undefined WITHOUT falling through to the
 * bare lookup; a dotted ref with no `referrerScope` is unresolvable.
 *
 * @param ref - The raw super reference (e.g., "Fruit", "::pkg::Name", "..::common::id", "Customer.id")
 * @param contextPackage - The package of the model whose super is being resolved
 * @param root - The root MetaData of the accumulating tree to search within
 * @param referrerScope - FR-024: the extending node's type — required to resolve dotted refs
 * @returns The resolved MetaData, or undefined if the reference cannot be resolved
 */
export function resolveSuperRef(
  ref: string,
  contextPackage: string,
  root: MetaData,
  referrerScope?: ReferrerScope,
): MetaData | undefined {
  // -------------------------------------------------------------------------
  // 0. FR-024 dotted child-targeting ref: `<rootRef>.<child>...<child>`
  //
  // Addressing model (ADR-0029): the package qualifies the ROOT-level node
  // only; each subsequent segment traverses CHILD NAMES, to any depth
  // (object → field → view: `Customer.priceCents.display`). INTERMEDIATE
  // segments select by unique name among the current node's effective
  // children (a cross-type name collision, e.g. a field AND an identity both
  // named "id", is ambiguous → unresolved); the FINAL segment is type-scoped
  // to the referrer (a field ref resolves fields, a view ref views), which is
  // also what disambiguates the common 2-segment `Customer.id` case.
  // -------------------------------------------------------------------------
  if (isChildTargetingRef(ref)) {
    if (referrerScope === undefined) return undefined;
    const parsed = parseChildTargetingRef(ref);
    if (parsed === undefined) return undefined; // degenerate (empty segment)
    let current = resolveSuperRef(parsed.ownerRef, contextPackage, root);
    if (current === undefined) return undefined;
    for (let i = 0; i < parsed.path.length - 1; i++) {
      const seg = parsed.path[i]!;
      const matches = current.children().filter((c) => c.name === seg);
      if (matches.length !== 1) return undefined; // missing or ambiguous intermediate
      current = matches[0]!;
    }
    const last = parsed.path[parsed.path.length - 1]!;
    return current
      .children()
      .find((c) => c.name === last && c.type === referrerScope.type);
  }
  // -------------------------------------------------------------------------
  // 1. Absolute reference: leading "::"
  // -------------------------------------------------------------------------
  if (ref.startsWith(PACKAGE_SEPARATOR)) {
    const absolutePath = ref.slice(PACKAGE_SEPARATOR.length);
    return findInTree(root, absolutePath);
  }

  // -------------------------------------------------------------------------
  // 2. Relative reference: one or more leading "..::"
  // -------------------------------------------------------------------------
  if (ref.startsWith(PACKAGE_PARENT + PACKAGE_SEPARATOR)) {
    const parts = ref.split(PACKAGE_SEPARATOR);
    let levels = 0;
    while (levels < parts.length && parts[levels] === PACKAGE_PARENT) {
      levels++;
    }

    const pkgParts = contextPackage !== "" ? contextPackage.split(PACKAGE_SEPARATOR) : [];
    const remainder = parts.slice(levels);
    if (pkgParts.length < levels || remainder.length === 0) {
      return undefined;
    }

    const allParts = [...pkgParts.slice(0, pkgParts.length - levels), ...remainder];
    return findInTree(root, allParts.join(PACKAGE_SEPARATOR));
  }

  // -------------------------------------------------------------------------
  // 3. Bare name OR same-package shorthand (contains "::" but no leading
  //    "::" or "..::"): try contextPackage prepend first, then root-rooted.
  // -------------------------------------------------------------------------
  if (contextPackage !== "") {
    const found = findInTree(root, `${contextPackage}${PACKAGE_SEPARATOR}${ref}`);
    if (found !== undefined) return found;
  }
  return findInTree(root, ref);
}

// ---------------------------------------------------------------------------
// Deferred resolution — second pass after all files parsed
// ---------------------------------------------------------------------------

export interface DeferredSuperFailure {
  /** FQN of the node whose super ref could not be resolved. */
  nodeFqn: string;
  /** The raw super ref string that didn't resolve. */
  ref: string;
  /** ADR-0009 provenance envelope of the referencing node (FR5a). */
  source: import("./source.js").ErrorSource;
  /**
   * FR-024: why resolution failed.
   * - "unresolved" — no target found (loader emits ERR_UNRESOLVED_SUPER).
   * - "target-mismatch" — a dotted child-targeting ref resolved, but the
   *   target's type/subtype differs from the extending node's (loader emits
   *   ERR_EXTENDS_TARGET_MISMATCH). Applies ONLY to dotted refs — top-level
   *   extends behavior is unchanged.
   */
  kind: "unresolved" | "target-mismatch";
  /** target-mismatch only: the resolved target's identity, for the message. */
  target?: { type: string; subType: string };
  /** target-mismatch only: the extending node's type/subtype, for the message. */
  referrer?: { type: string; subType: string };
}

/**
 * Walk the tree and resolve every node's superRef against the full root.
 * Used by Loader.loadJsonStrings as a second pass after all input files
 * have been parsed with deferSuperResolution: true. Unresolved refs are
 * collected and returned — caller decides whether to throw or warn.
 *
 * The referrer's context package (for bare/same-package shorthand refs) comes
 * from the node's own `package`, else the file-default package captured at
 * PARSE time (`fileDefaultPackage`). Both are order- and merge-independent, so
 * resolution does not depend on the post-merge tree shape.
 *
 * Idempotent: nodes that already have superResolved set are skipped.
 */
export function resolveDeferredSupers(root: MetaData): DeferredSuperFailure[] {
  const failures: DeferredSuperFailure[] = [];
  walk(root, (node) => {
    if (node.superRef === undefined) return;
    if (node.superResolved !== undefined) return;
    const effectivePkg = node.package ?? node.fileDefaultPackage ?? "";
    // FR-024: thread the referrer's type so dotted `Entity.child` refs resolve
    // type-scoped (a field ref selects fields; an identity ref identities).
    const target = resolveSuperRef(node.superRef, effectivePkg, root, { type: node.type });
    if (target !== undefined) {
      // FR-024: a dotted ref must target a node of the SAME type and subtype
      // as the extending node. Dotted-only — top-level extends is unchanged.
      if (
        isChildTargetingRef(node.superRef) &&
        (target.type !== node.type || target.subType !== node.subType)
      ) {
        failures.push({
          nodeFqn: node.fqn(),
          ref: node.superRef,
          source: node.source,
          kind: "target-mismatch",
          target: { type: target.type, subType: target.subType },
          referrer: { type: node.type, subType: node.subType },
        });
        return;
      }
      try {
        node.setSuperResolved(target);
      } catch {
        // Frozen — ignore; the loader should resolve before freeze.
      }
    } else {
      failures.push({
        nodeFqn: node.fqn(),
        ref: node.superRef,
        source: node.source,
        kind: "unresolved",
      });
    }
  });
  return failures;
}

function walk(node: MetaData, visit: (n: MetaData) => void): void {
  visit(node);
  for (const child of node.ownChildren()) {
    walk(child, visit);
  }
}
