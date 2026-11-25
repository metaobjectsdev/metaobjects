// Resolving a reference to a node inside a system.
//
// Apps and resources are children of a system.internal, so they are not top-level nodes
// and the loader's reference descriptors (which bind top-level nodes only) cannot reach
// them. They are addressed the house way instead (ADR-0059): `System.child` binds the
// system among the top-level nodes and walks to its child, and `pkg::System.child`
// does so from another package. A bare name is a convenience for the common case, a
// node in the referrer's own system, then a top-level node of that name (an outside
// system declared at the document root).

import {
  CHILD_REF_SEPARATOR,
  PACKAGE_SEPARATOR,
  effectivePackageOf,
  resolveRef,
  topLevelNodeOf,
  type MetaData,
} from "@metaobjectsdev/metadata";
import { TYPE_SYSTEM } from "./constants.js";

/** The nearest enclosing system of `node`, or undefined when it sits in none. */
function enclosingSystem(node: MetaData): MetaData | undefined {
  for (let p = node.parent; p !== undefined; p = p.parent) if (p.type === TYPE_SYSTEM) return p;
  return undefined;
}

/**
 * The node `ref` names, seen from `from`, or undefined when it names nothing. The
 * caller checks the kind: a reference to the wrong kind of node is the caller's error.
 */
export function resolveSystemRef(from: MetaData, ref: string): MetaData | undefined {
  const top = topLevelNodeOf(from);
  const root = top.parent;
  if (root === undefined) return undefined;
  const pkg = effectivePackageOf(top);
  if (!ref.includes(CHILD_REF_SEPARATOR) && !ref.includes(PACKAGE_SEPARATOR)) {
    // ADR-0039: resolving, so a system that `extends` another sees its inherited children.
    const sibling = enclosingSystem(from)?.children().find((c) => c.name === ref);
    if (sibling !== undefined) return sibling;
  }
  return resolveRef(root, ref, pkg).node;
}

/** The string entries of a string or string-array attribute (absent: none). */
export function refList(node: MetaData, attr: string): string[] {
  const raw = node.attr(attr);
  if (typeof raw === "string") return raw === "" ? [] : [raw];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Check every reference in `attr` resolves to a node of one of `kinds` (a type, or a
 * `type.subType`), reporting each one that does not under `code`.
 */
export function checkRefs(
  node: MetaData,
  attr: string,
  kinds: readonly string[],
  code: string,
  error: (code: string, node: MetaData, message: string) => void,
): void {
  for (const ref of refList(node, attr)) {
    const target = resolveSystemRef(node, ref);
    const label = `${node.type}.${node.subType} "${node.name}" @${attr} "${ref}"`;
    const want = kinds.join(" or ");
    if (target === undefined) {
      error(code, node, `${label} does not resolve to a ${want}.`);
    } else if (!kinds.some((k) => k === target.type || k === `${target.type}.${target.subType}`)) {
      error(code, node, `${label} resolves to ${target.type}.${target.subType}, not a ${want}.`);
    }
  }
}
