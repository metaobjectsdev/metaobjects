// resolveClaim — resolve an `@implementedBy` reference to the node it names.
//
// Moved here from the CLI's requirement-check so `codegen-ts` can share ONE
// resolver (FR-038): the requirement-test generator has to know each claimed
// node's TYPE to fan out per concern, and a second implementation would fork the
// ADR-0042 package-local binding contract the loader already owns.

import { TYPE_OBJECT, TYPE_REQUIREMENT } from "../../shared/base-types.js";
import { PACKAGE_SEPARATOR } from "../../shared/structural.js";
import { resolveObjectRef } from "../../naming-refs.js";
import type { MetaData } from "../../shared/meta-data.js";

/**
 * Resolve the owner segment of an `@implementedBy` reference to the node it names.
 *
 * OBJECTS FIRST, through the loader's own resolver, so package-local binding stays the
 * ADR-0042 contract and never a parallel name scan (#228).
 *
 * Then ROOT-LEVEL NON-OBJECT nodes — `template.prompt` and its siblings today. The
 * attribute is documented as naming "the model nodes realising this requirement", and a
 * declared prompt is one: it is the durable artifact a capability like "the game master
 * is told what the party can see" actually lives in. Resolving only objects meant the
 * prompt estate — the thing whose retirement is hardest to see in a model, since a
 * removed prompt leaves no table behind — was the one part of a model that could not
 * carry a status. So L4 means "a declared top-level model node", not "an object".
 *
 * Requirements themselves are excluded: hierarchy is nesting, and a requirement claiming
 * a requirement would be a second, contradictory parent mechanism.
 */
export function resolveClaimTarget(
  root: MetaData,
  owner: string,
  referrerPkg: string,
): MetaData | undefined {
  const { node } = resolveObjectRef(root, owner, referrerPkg);
  if (node !== undefined) return node;

  const candidates = root
    .children()
    .filter((c) => c.type !== TYPE_OBJECT && c.type !== TYPE_REQUIREMENT);

  // A fully-qualified reference binds exactly, like every other FQN in the model.
  if (owner.includes(PACKAGE_SEPARATOR)) {
    return candidates.find((c) => c.resolutionKey() === owner);
  }
  // A bare reference prefers the referrer's own package, then a root-level node of that
  // bare name. An ambiguous bare name binds NOTHING — same fail-closed rule objects use,
  // because silently picking one of two same-named nodes is how a claim ends up pointing
  // at the wrong thing without anyone noticing.
  const local =
    referrerPkg === ""
      ? []
      : candidates.filter(
          (c) => c.resolutionKey() === `${referrerPkg}${PACKAGE_SEPARATOR}${owner}`,
        );
  if (local.length === 1) return local[0];
  // Root-level (unpackaged) only, matching resolveObjectRef's own bare fallback. A bare
  // ref must not reach into an arbitrary package just because the name is unique there.
  const bare = candidates.filter(
    (c) => c.name === owner && c.resolutionKey() === owner,
  );
  return bare.length === 1 ? bare[0] : undefined;
}

/** Walk dotted member segments by CHILD NAME from an object node.
 *
 *  Exported alongside `resolveClaimTarget` because the CLI's coverage pass needs the
 *  OWNER node's `resolutionKey()` while only using member resolution as a yes/no
 *  validity test. Composing them into `resolveClaim` there would key coverage on the
 *  member instead of the object — a silent behaviour change. */
export function resolveMember(obj: MetaData, path: string[]): MetaData | undefined {
  let cur: MetaData | undefined = obj;
  for (const seg of path) {
    if (cur === undefined) return undefined;
    cur = cur.children().find((c) => c.name === seg);
  }
  return cur;
}

/**
 * Resolve a full `@implementedBy` reference — owner segment plus any dotted member
 * segments — to the node it names, or undefined when it does not resolve.
 *
 * Resolution walks to the FULL depth of the reference, so `Council.slug.display`
 * yields the view node rather than stopping at the field. FR-038's fan-out keys on
 * the resolved node's type, and a resolver that stopped short would silently collapse
 * two concerns into one.
 */
export function resolveClaim(
  root: MetaData,
  ref: string,
  referrerPkg: string,
): MetaData | undefined {
  const segs = ref.split(".");
  const owner = resolveClaimTarget(root, segs[0] ?? "", referrerPkg);
  if (owner === undefined || segs.length === 1) return owner;
  return resolveMember(owner, segs.slice(1));
}
