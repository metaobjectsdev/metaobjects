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
import { PACKAGE_SEPARATOR, PACKAGE_PARENT } from "./shared/structural.js";

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
 * Resolve a single super reference string against a tree.
 *
 * Called by the parser IMMEDIATELY when a node with a `super` key is created,
 * against the loader's accumulating root (intoRoot). Java semantics: if the
 * ref cannot be resolved, the parser throws ParseError.
 *
 * @param ref - The raw super reference (e.g., "Fruit", "::pkg::Name", "..::common::id")
 * @param contextPackage - The package of the model whose super is being resolved
 * @param root - The root MetaData of the accumulating tree to search within
 * @returns The resolved MetaData, or undefined if the reference cannot be resolved
 */
export function resolveSuperRef(
  ref: string,
  contextPackage: string,
  root: MetaData,
): MetaData | undefined {
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
    const target = resolveSuperRef(node.superRef, effectivePkg, root);
    if (target !== undefined) {
      try {
        node.setSuperResolved(target);
      } catch {
        // Frozen — ignore; the loader should resolve before freeze.
      }
    } else {
      failures.push({ nodeFqn: node.fqn(), ref: node.superRef, source: node.source });
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
