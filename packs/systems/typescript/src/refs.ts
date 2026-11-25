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
  referrerPackageFor,
  resolveRef,
  topLevelNodeOf,
  type MetaData,
  type ValidationContext,
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
 * Given the attribute the reference sits in, a qualified or top-level name resolves in
 * the package of the node that wrote it (ADR-0059 R3), so an inherited reference means
 * what it meant where it was written.
 */
export function resolveSystemRef(
  from: MetaData,
  ref: string,
  attr?: string,
  kinds?: readonly string[],
): MetaData | undefined {
  const top = topLevelNodeOf(from);
  const root = top.parent;
  if (root === undefined) return undefined;
  const pkg = attr === undefined ? effectivePackageOf(top) : referrerPackageFor(from, attr);
  if (!ref.includes(CHILD_REF_SEPARATOR) && !ref.includes(PACKAGE_SEPARATOR)) {
    // ADR-0039: resolving, so a system that `extends` another sees its inherited children.
    // An app and a resource may share a name; given the kinds wanted, prefer one of them.
    const named = enclosingSystem(from)?.children().filter((c) => c.name === ref) ?? [];
    const sibling = (kinds === undefined ? undefined : named.find((c) => isKind(c, kinds))) ?? named[0];
    if (sibling !== undefined) return sibling;
  }
  return resolveRef(root, ref, pkg).node;
}

/** Whether `node` is one of `kinds` (each a type, or a `type.subType`). */
function isKind(node: MetaData, kinds: readonly string[]): boolean {
  return kinds.some((k) => k === node.type || k === `${node.type}.${node.subType}`);
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
  ctx: ValidationContext,
): void {
  for (const ref of refList(node, attr)) {
    const target = resolveSystemRef(node, ref, attr, kinds);
    const label = `${node.type}.${node.subType} "${node.name}" @${attr} "${ref}"`;
    const want = kinds.join(" or ");
    if (target === undefined) {
      // A bare name finds a node of the referrer's own system or a top-level node; one
      // inside another system, or seen from outside any system, needs its system's name.
      const bare = !ref.includes(CHILD_REF_SEPARATOR) && !ref.includes(PACKAGE_SEPARATOR);
      const hint = bare ? ` A node inside a system is named System.${ref}.` : "";
      ctx.error(code, node, `${label} does not resolve to a ${want}.${hint}`);
    } else if (!isKind(target, kinds)) {
      ctx.error(code, node, `${label} resolves to ${target.type}.${target.subType}, not a ${want}.`);
    }
  }
}
