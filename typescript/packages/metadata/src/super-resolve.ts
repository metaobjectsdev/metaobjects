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

import type { MetaModel } from "./model.js";
import { PACKAGE_SEPARATOR, PACKAGE_PARENT } from "./constants.js";

// ---------------------------------------------------------------------------
// Tree search helper
// ---------------------------------------------------------------------------

/**
 * Recursively searches the tree for a node whose fqn() matches.
 * Returns the first match, or undefined.
 */
function findInTree(root: MetaModel, fqn: string): MetaModel | undefined {
  if (root.fqn() === fqn) return root;
  for (const child of root.children()) {
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
 * @param root - The root MetaModel of the accumulating tree to search within
 * @returns The resolved MetaModel, or undefined if the reference cannot be resolved
 */
export function resolveSuperRef(
  ref: string,
  contextPackage: string,
  root: MetaModel,
): MetaModel | undefined {
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
}

/**
 * Walk the tree and resolve every node's superRef against the full root.
 * Used by Loader.loadJsonStrings as a second pass after all input files
 * have been parsed with deferSuperResolution: true. Unresolved refs are
 * collected and returned — caller decides whether to throw or warn.
 *
 * Tracks an inherited context package while walking so children whose own
 * `package` is unset (e.g., fields inside an object) still resolve against
 * the parent's package — matching the parser's eager-resolution semantics.
 *
 * Idempotent: nodes that already have superResolved set are skipped.
 */
export function resolveDeferredSupers(root: MetaModel): DeferredSuperFailure[] {
  const failures: DeferredSuperFailure[] = [];
  walk(root, "", (node, ctxPkg) => {
    if (node.superRef === undefined) return;
    if (node.superResolved !== undefined) return;
    const effectivePkg = node.package ?? ctxPkg;
    const target = resolveSuperRef(node.superRef, effectivePkg, root);
    if (target !== undefined) {
      try {
        node.setSuperResolved(target);
      } catch {
        // Frozen — ignore; the loader should resolve before freeze.
      }
    } else {
      failures.push({ nodeFqn: node.fqn(), ref: node.superRef });
    }
  });
  return failures;
}

function walk(
  node: MetaModel,
  ctxPkg: string,
  visit: (n: MetaModel, ctx: string) => void,
): void {
  visit(node, ctxPkg);
  const nextCtx = node.package ?? ctxPkg;
  for (const child of node.children()) {
    walk(child, nextCtx, visit);
  }
}
