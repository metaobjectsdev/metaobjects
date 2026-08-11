// `meta verify` — the requirement (capability) gate.
//
// Requirements are METADATA: `requirement.functional` / `requirement.architectural`
// are registered metamodel types, declared in `metaobjects/` beside the entities
// they describe. So this file parses NOTHING. It reads `requirement.*` nodes off
// the already-loaded model and checks the things the loader cannot.
//
// Division of labour, and the reason for it:
//
//   LOADER (unconditional)   the `@status` enum via `allowedValues`, required
//                            attrs, child rules, levels being integers.
//   VERIFY  (conditional)    `@implementedBy` resolution, whose SEVERITY DEPENDS
//                            ON `@status`. A loader `references` descriptor
//                            always errors on an unresolved target, and an
//                            `abandoned` requirement exists precisely to name
//                            nodes that are gone — declaring it there would make
//                            the entries carrying the mechanism's only controlled
//                            evidence fail to load.
//
// Two kinds, opposite checks: `functional` fails when NOTHING implements it;
// `architectural` fails when something VIOLATES it (v1: an empty claim set on a
// live policy — claim-set arithmetic, deliberately not a predicate DSL).

import {
  TYPE_OBJECT,
  TYPE_REQUIREMENT,
  OBJECT_SUBTYPE_ENTITY,
  PACKAGE_SEPARATOR,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
  REQUIREMENT_LINK_FLOOR_LEVEL,
  REQUIREMENT_MIN_LEVEL,
  REQUIREMENT_MAX_LEVEL,
  REQUIREMENT_LEVEL_MEMBER,
  REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
  resolveObjectRef,
  didYouMeanHint,
  type MetaData,
  type MetaRequirement,
  type RequirementStatus,
} from "@metaobjectsdev/metadata";

export type Severity = "error" | "warn";

export interface Diagnostic {
  severity: Severity;
  code: string;
  /** The requirement node's name, when the diagnostic belongs to one. */
  name?: string;
  message: string;
}

export const ERR_REQUIREMENT_LINK_ABOVE_FLOOR = "ERR_REQUIREMENT_LINK_ABOVE_FLOOR";
export const ERR_REQUIREMENT_DANGLING_REF = "ERR_REQUIREMENT_DANGLING_REF";
export const ERR_REQUIREMENT_BAD_LEVEL = "ERR_REQUIREMENT_BAD_LEVEL";
export const ERR_REQUIREMENT_LEVEL_NESTING = "ERR_REQUIREMENT_LEVEL_NESTING";
export const ERR_REQUIREMENT_L4_NOT_OBJECT = "ERR_REQUIREMENT_L4_NOT_OBJECT";
export const ERR_REQUIREMENT_L5_NOT_MEMBER = "ERR_REQUIREMENT_L5_NOT_MEMBER";
export const ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS = "ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS";
export const WARN_REQUIREMENT_OBJECT_UNCLAIMED = "WARN_REQUIREMENT_OBJECT_UNCLAIMED";

/** Severity of the object-coverage gate. Ships as a warning until it runs clean
 *  on a real repository; promotion to `"error"` is a one-line flip here, which
 *  activates an already-written test rather than requiring new authoring under
 *  release pressure. */
export const OBJECT_COVERAGE_SEVERITY: Severity = "warn";

/**
 * Split a member reference into its owning object ref and the dotted member path.
 * `::` qualifies the ROOT-level node only, so the object ref ends at the FIRST
 * `.` after the last `::`.
 * `acme::sales::Order.total.display` -> `["acme::sales::Order", ["total","display"]]`
 */
export function splitMemberRef(ref: string): { owner: string; path: string[] } {
  const pkgEnd = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const from = pkgEnd === -1 ? 0 : pkgEnd + PACKAGE_SEPARATOR.length;
  const dot = ref.indexOf(".", from);
  if (dot === -1) return { owner: ref, path: [] };
  return { owner: ref.slice(0, dot), path: ref.slice(dot + 1).split(".") };
}

/** Walk dotted member segments by CHILD NAME from an object node. */
function resolveMember(obj: MetaData, path: string[]): MetaData | undefined {
  let cur: MetaData | undefined = obj;
  for (const seg of path) {
    if (cur === undefined) return undefined;
    cur = cur.children().find((c) => c.name === seg);
  }
  return cur;
}

/** Every `requirement.*` node in the tree, at any nesting depth. Hierarchy IS
 *  nesting — an L1 solution contains its L2 segments — so this is a walk, not a
 *  scan of a flat list keyed by a `parent` string. */
export function collectRequirements(root: MetaData): MetaRequirement[] {
  const out: MetaRequirement[] = [];
  const walk = (n: MetaData): void => {
    for (const c of n.children()) {
      if (c.type === TYPE_REQUIREMENT) out.push(c as MetaRequirement);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/**
 * Check the requirement tree against the loaded model.
 *
 * What a clean run proves: referential integrity — links sit at or below the
 * link floor, nesting agrees with levels, and references resolve. What it CANNOT
 * prove: that a status is *true*, or that a node actually implements the
 * requirement claiming it. No test can. That truth is the adopter's job.
 */
export function checkRequirements(root: MetaData): Diagnostic[] {
  const out: Diagnostic[] = [];
  const reqs = collectRequirements(root);
  if (reqs.length === 0) return out; // opt-in by declaration — no requirements, nothing to say

  const claimedObjects = new Set<string>();

  for (const req of reqs) {
    const architectural = req.subType === REQUIREMENT_SUBTYPE_ARCHITECTURAL;
    const level = req.level();
    const refs = req.implementedBy();

    if (!architectural) {
      if (level === undefined || !Number.isInteger(level)
          || level < REQUIREMENT_MIN_LEVEL || level > REQUIREMENT_MAX_LEVEL) {
        out.push({
          severity: "error", code: ERR_REQUIREMENT_BAD_LEVEL, name: req.name,
          message: `level must be an integer ${REQUIREMENT_MIN_LEVEL}-${REQUIREMENT_MAX_LEVEL} (got ${String(level)}). ` +
            `L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member.`,
        });
      }
      // Nesting IS the hierarchy, so a child must sit strictly below its parent.
      const parent = req.parent;
      if (parent !== undefined && parent.type === TYPE_REQUIREMENT) {
        const pl = (parent as MetaRequirement).level();
        if (pl !== undefined && level !== undefined && level <= pl) {
          out.push({
            severity: "error", code: ERR_REQUIREMENT_LEVEL_NESTING, name: req.name,
            message: `nested under "${parent.name}" (level ${pl}) but declares level ${level}. ` +
              `Nesting is the hierarchy — a child sits strictly below its parent.`,
          });
        }
      }
    }

    // -- the link boundary ----------------------------------------------------
    if (refs.length > 0 && !req.mayReferenceModel()) {
      out.push({
        severity: "error", code: ERR_REQUIREMENT_LINK_ABOVE_FLOOR, name: req.name,
        message: `'implementedBy' is legal at L${REQUIREMENT_LINK_FLOOR_LEVEL} (object) and ` +
          `L${REQUIREMENT_MAX_LEVEL} (member) only. L1-L3 are organisational and never reference ` +
          `the model — move the links to a nested L${REQUIREMENT_LINK_FLOOR_LEVEL} child.`,
      });
      continue;
    }

    for (const ref of refs) {
      const { owner, path } = splitMemberRef(ref);
      // referrerPkg is the requirement's own effective package, so a bare ref
      // binds package-locally under the ADR-0042 contract — the loader's own
      // resolver, never a parallel name scan (#228).
      const referrerPkg = req.package ?? req.fileDefaultPackage ?? "";
      const { node } = resolveObjectRef(root, owner, referrerPkg);
      const isObjectRef = path.length === 0;

      if (node !== undefined && (isObjectRef || resolveMember(node, path) !== undefined)) {
        claimedObjects.add(node.resolutionKey());
      }

      if (!architectural && level === REQUIREMENT_LINK_FLOOR_LEVEL && !isObjectRef) {
        out.push({
          severity: "error", code: ERR_REQUIREMENT_L4_NOT_OBJECT, name: req.name,
          message: `L${REQUIREMENT_LINK_FLOOR_LEVEL} references an object; '${ref}' names a member. ` +
            `Move it to a nested L${REQUIREMENT_LEVEL_MEMBER} child, or reference the object itself.`,
        });
        continue;
      }
      if (!architectural && level === REQUIREMENT_LEVEL_MEMBER && isObjectRef) {
        out.push({
          severity: "error", code: ERR_REQUIREMENT_L5_NOT_MEMBER, name: req.name,
          message: `L${REQUIREMENT_LEVEL_MEMBER} references a member (field, view or identity); ` +
            `'${ref}' names an object. Move it to its L${REQUIREMENT_LINK_FLOOR_LEVEL} parent.`,
        });
        continue;
      }

      const resolved = node !== undefined && (isObjectRef || resolveMember(node, path) !== undefined);
      if (!resolved) {
        // Severity is CONDITIONAL ON STATUS, and the asymmetry inverts as a pair.
        // On abandoned/superseded the nodes are SUPPOSED to be gone — that is the
        // entry doing its job, and the reason this check cannot live in the loader.
        if (req.requiresLiveNodes()) {
          out.push({
            severity: "error", code: ERR_REQUIREMENT_DANGLING_REF, name: req.name,
            message: `'${ref}' does not resolve in the loaded model (status '${String(req.status())}' — ` +
              `the model moved and the requirement is stale).` + didYouMeanHint(root, owner),
          });
        }
      }
    }

    // -- architectural universality, v1: claim-set arithmetic -----------------
    // A live policy claimed by nothing is the audited-base case: declared and
    // applied to nothing. Deliberately NOT a violation-predicate DSL — that
    // would be the registration this design already argued its way to, arriving
    // a second time through the back door.
    const status = req.status();
    const live = status !== undefined
      && REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES.includes(status as RequirementStatus);
    if (architectural && live && refs.length === 0) {
      out.push({
        severity: "error", code: ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS, name: req.name,
        message: `architectural requirement is '${String(status)}' but nothing implements it. ` +
          `Its check is universality — a claim set of zero means the policy is declared and unapplied.`,
      });
    }
  }

  // -- object coverage: adding an entity forces a requirement -----------------
  // Binary per entity, never a ratio: a "% claimed" number measures what the
  // schema can express, is biased against the hardest rules, and invites
  // optimising the number.
  for (const ent of root.children()) {
    if (ent.type !== TYPE_OBJECT || ent.subType !== OBJECT_SUBTYPE_ENTITY) continue;
    const key = ent.resolutionKey();
    if (!claimedObjects.has(key)) {
      out.push({
        severity: OBJECT_COVERAGE_SEVERITY, code: WARN_REQUIREMENT_OBJECT_UNCLAIMED,
        message: `no requirement claims '${key}'. Add it to an L${REQUIREMENT_LINK_FLOOR_LEVEL} requirement's 'implementedBy'.`,
      });
    }
  }

  return out;
}
