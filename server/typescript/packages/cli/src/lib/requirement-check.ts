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
//                            `planned` requirement names nodes that do not exist
//                            YET — declaring it there would make every recorded
//                            intention fail to load.
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
  REQUIREMENT_DISPOSITION_DEFERRED,
  REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
  // One shared resolver (FR-038): codegen's requirement-test fan-out needs the same
  // ADR-0042 package-local binding, so these moved to @metaobjectsdev/metadata rather
  // than being reimplemented there.
  resolveClaimTarget,
  resolveMember,
  didYouMeanHint,
  type MetaData,
  type MetaRequirement,
  type RequirementStatus,
} from "@metaobjectsdev/metadata";

export type Severity = "error" | "warn";

export interface Diagnostic {
  severity: Severity;
  code: string;
  /** The subject's ADDRESS, when the diagnostic has one — the dotted child-name
   *  path. Two branches of a ledger may reuse a NAME, so a bare name does not
   *  locate the node, and a diagnostic you cannot locate is one you cannot act on.
   *  Absent on a diagnostic whose subject is not a requirement (object coverage
   *  names the entity in its message instead). */
  path?: string;
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
export const WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE = "WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE";
export const WARN_REQUIREMENT_DEFERRED_UNTRACKED = "WARN_REQUIREMENT_DEFERRED_UNTRACKED";
export const WARN_REQUIREMENT_NOTHING_IMPLEMENTS = "WARN_REQUIREMENT_NOTHING_IMPLEMENTS";

/** Counts behind the summary line `meta verify` prints on every run, clean or
 *  not. A clean run that says nothing cannot distinguish "checked, all good"
 *  from "checked nothing" — and a ledger that skipped an entire grain reads
 *  identically to a complete one. */
export interface RequirementSummary {
  total: number;
  functional: number;
  architectural: number;
  byStatus: Record<string, number>;
  /** partial or planned with NO disposition recorded — the unreviewed gaps. */
  undecided: number;
  /** deferred entries naming no ticket, so nobody will be reminded. */
  deferredUntracked: number;
  entitiesTotal: number;
  entitiesClaimed: number;
}

/** Severity of the object-coverage gate. Promotion to `"error"` is a one-line
 *  flip here, which activates an already-written test rather than requiring new
 *  authoring under release pressure.
 *
 *  It stays `"warn"`, and the reason is measured rather than cautious:
 *
 *  - On a real 120-file estate carrying a SINGLE requirement, this gate reports
 *    93 unclaimed entities — every entity in the repository. At `"error"` a
 *    project adopting requirements incrementally fails its first `verify` after
 *    authoring one entry, which teaches people to delete the entry.
 *  - The gate is satisfiable without being informative: `claimedObjects` below
 *    counts a claim from any requirement at any level and any status, so
 *    appending an FQN to an existing list clears it. Green proves an entity is
 *    NAMED, never that it is understood.
 *  - The experiment meant to settle whether forcing it yields real entries or
 *    padding stopped at its ceiling probe: at `"warn"` agents already authored
 *    proper L3/L4/L5 entries for what they added, so the arms could not differ.
 *    That is not evidence promotion is useless — it is evidence that instrument
 *    cannot see it.
 *
 *  spec/design-docs/2026-08-11-prereg-duplication-and-levels.md, "Round E result". */
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

/** Resolution keys of every root-level object whose `extends` chain reaches
 *  `ancestor`. Walks the RESOLVED super pointer rather than the raw string, so a
 *  cross-package or dotted reference resolves the same way the loader resolved
 *  it — reading `superRef` here would be a second, divergent resolver. */
function subtypesOf(root: MetaData, ancestor: MetaData): string[] {
  const out: string[] = [];
  for (const cand of root.children()) {
    if (cand.type !== TYPE_OBJECT || cand === ancestor) continue;
    const seen = new Set<MetaData>();
    let cur = cand.superData;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      if (cur === ancestor) { out.push(cand.resolutionKey()); break; }
      cur = cur.superData;
    }
  }
  return out;
}

/** True when this requirement, or anything nested beneath it, names an
 *  implementing node. Subtree-scoped deliberately: an L1 solution that delegates
 *  everything to its children implements nothing directly, and flagging that
 *  would fire on the correct shape of every tree. */
function subtreeClaimsAnything(req: MetaRequirement): boolean {
  if (req.implementedBy().length > 0) return true;
  for (const child of req.children()) {
    if (child.type !== TYPE_REQUIREMENT) continue;
    if (subtreeClaimsAnything(child as MetaRequirement)) return true;
  }
  return false;
}

/** A requirement paired with its ADDRESS — the dotted child-name path from the
 *  root, which is how every other node in the model is addressed, and which the
 *  requirement-test generator also turns into the stub's filename. */
export interface AddressedRequirement {
  readonly node: MetaRequirement;
  readonly path: string;
}

/**
 * Every `requirement.*` node in the tree, at any nesting depth, each with its
 * dotted path. Hierarchy IS nesting — an L1 solution contains its L2 segments —
 * so this is a walk, not a scan of a flat list keyed by a `parent` string.
 *
 * ONE derivation of the address for the gate AND the authoring lint, deliberately.
 * They are two sections of a single `meta verify` run, and when they walked
 * separately they addressed the same node two different ways — the gate by bare
 * `name`, which is ambiguous the moment two branches of a ledger reuse one, and the
 * lint by path. A reader cannot reconcile two addressings of one tree.
 *
 * The traversal descends through EVERY node rather than only through requirements:
 * a requirement somewhere the child rules did not anticipate is still gated, which
 * is the fail-closed direction for a gate.
 */
export function collectAddressedRequirements(root: MetaData): AddressedRequirement[] {
  const out: AddressedRequirement[] = [];
  const walk = (n: MetaData, prefix: string): void => {
    for (const c of n.children()) {
      // Only a requirement contributes a path segment. An intervening non-requirement
      // node is traversed THROUGH, so the address stays the requirement hierarchy.
      const isReq = c.type === TYPE_REQUIREMENT;
      const path = isReq ? (prefix === "" ? c.name : `${prefix}.${c.name}`) : prefix;
      if (isReq) out.push({ node: c as MetaRequirement, path });
      walk(c, path);
    }
  };
  walk(root, "");
  return out;
}


/**
 * Resolve a `@supersededBy` reference to a requirement in the same ledger (FR-039).
 *
 * A requirement is addressed the way every other node is: a package qualifies the
 * ROOT-level node only, and each dotted segment after it walks CHILD names — so
 * `acme::caps::Billing.InvoiceRecord` names the `InvoiceRecord` child of the
 * root-level `Billing`. A bare reference binds package-locally first and then at
 * root level, which is the ADR-0042 contract every other reference already follows.
 *
 * Deliberately resolves against the LEDGER, not the model: a capability is replaced
 * by another capability. Pointing this at an entity would be `@implementedBy` wearing
 * a different name, and `@implementedBy` is exactly what a retired entry may not have.
 */
export function resolveRequirementRef(
  addressed: readonly AddressedRequirement[],
  ref: string,
  referrerPkg: string,
): MetaRequirement | undefined {
  const keyed = new Map<string, MetaRequirement>();
  for (const { node, path } of addressed) {
    const pkg = node.package ?? node.fileDefaultPackage ?? "";
    if (pkg !== "") keyed.set(`${pkg}::${path}`, node);
    // Bare path is registered too, so a single-package ledger can reference
    // without repeating its own package on every line.
    if (!keyed.has(path)) keyed.set(path, node);
  }
  // An FQN binds exactly; a bare ref prefers the referrer's own package.
  const exact = keyed.get(ref);
  if (exact !== undefined) return exact;
  if (referrerPkg !== "") {
    const local = keyed.get(`${referrerPkg}::${ref}`);
    if (local !== undefined) return local;
  }
  return undefined;
}

/** The nodes alone, for callers with no use for the address. */
export function collectRequirements(root: MetaData): MetaRequirement[] {
  return collectAddressedRequirements(root).map((r) => r.node);
}

/**
 * What one `meta verify` run computes once and both requirement passes read.
 *
 * The gate and the summary each need the same two things, and each used to derive
 * both for itself — so a run walked the model twice and resolved every
 * `@implementedBy` claim twice, the second of which is the expensive half
 * (resolution is O(claims x root objects)). Threading the result rather than the
 * function is what the "SHARED by the gate and the summary" note on
 * `claimedObjectKeys` was always asking for.
 */
export interface RequirementScan {
  readonly addressed: readonly AddressedRequirement[];
  readonly claimedObjects: ReadonlySet<string>;
}

export function scanRequirements(root: MetaData): RequirementScan {
  const addressed = collectAddressedRequirements(root);
  return { addressed, claimedObjects: claimedObjectKeys(root, addressed.map((r) => r.node)) };
}

/**
 * Resolution keys of every object claimed by a requirement.
 *
 * SHARED by the gate and the summary deliberately. The two used to compute this
 * separately and drifted: the summary missed the extends-chain propagation the
 * gate applies to an ARCHITECTURAL claim, so a project using the documented
 * BaseEntity pattern got a summary reporting entities as unclaimed while the
 * gate beneath it named none. A summary that contradicts its own diagnostics
 * reads as a measurement and cannot be reconciled with the run that produced it.
 */
function claimedObjectKeys(root: MetaData, reqs: MetaRequirement[]): Set<string> {
  const claimed = new Set<string>();
  for (const req of reqs) {
    // A PLANNED requirement never contributes to coverage. Otherwise the
    // cheapest way to clear an unclaimed-entity warning would be to declare an
    // intention — the gate would measure ambition rather than work.
    if (req.isPlanned()) continue;
    // referrerPkg is the requirement's own effective package, so a bare ref
    // binds package-locally under the ADR-0042 contract — the loader's own
    // resolver, never a parallel name scan (#228).
    const referrerPkg = req.package ?? req.fileDefaultPackage ?? "";
    for (const ref of req.implementedBy()) {
      const { owner, path } = splitMemberRef(ref);
      const node = resolveClaimTarget(root, owner, referrerPkg);
      if (node === undefined) continue;
      if (path.length > 0 && resolveMember(node, path) === undefined) continue;
      claimed.add(node.resolutionKey());
      // ARCHITECTURAL claims propagate DOWN the extends chain; functional ones
      // do not. A policy ("every row is addressable") claimed on an abstract
      // BaseEntity genuinely holds for everything extending it — that is what
      // universality means, and without this the documented BaseEntity pattern
      // is worse than not using it. A functional claim is the opposite: it says
      // this entity exists for a REASON, and inheriting a reason from a shared
      // base would mean adding an entity no longer forces anyone to say what it
      // is for. Same mechanism, opposite polarity — as everywhere else in the
      // subtype split.
      if (req.subType === REQUIREMENT_SUBTYPE_ARCHITECTURAL) {
        for (const sub of subtypesOf(root, node)) claimed.add(sub);
      }
    }
  }
  return claimed;
}

/**
 * The entities object coverage measures — and the same set for the gate and the
 * summary, for the reason given on `claimedObjectKeys`.
 *
 * An ABSTRACT entity is shape, not data: there is no table and no rows, so
 * demanding a capability claim for it is the same category error as demanding
 * one for an object.value. It is exempt for the same reason.
 */
function coverableEntities(root: MetaData): MetaData[] {
  return root.children().filter(
    (n) => n.type === TYPE_OBJECT && n.subType === OBJECT_SUBTYPE_ENTITY && !n.isAbstract,
  );
}

/**
 * Check the requirement tree against the loaded model.
 *
 * What a clean run proves: referential integrity — links sit at or below the
 * link floor, nesting agrees with levels, and references resolve. What it CANNOT
 * prove: that a status is *true*, or that a node actually implements the
 * requirement claiming it. No test can. That truth is the adopter's job.
 */
export function checkRequirements(root: MetaData, scan: RequirementScan = scanRequirements(root)): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { addressed, claimedObjects } = scan;
  if (addressed.length === 0) return out; // opt-in by declaration — no requirements, nothing to say

  for (const { node: req, path: reqPath } of addressed) {
    const architectural = req.subType === REQUIREMENT_SUBTYPE_ARCHITECTURAL;
    const level = req.level();
    const refs = req.implementedBy();

    // -- the level rules -------------------------------------------------------
    // A functional requirement MUST be levelled. An architectural one MAY be,
    // and levelling is the OPT-IN: unlevelled it is the original flat,
    // object-independent policy and these rules must not touch it. Once a level
    // is present the node has joined a tree, and `@level`'s own registered
    // description promises that "the same rules as functional apply: nesting
    // must agree with the level". Enforcing that here is what makes the promise
    // true — a levelled architectural node used to be exempt from BOTH checks,
    // so an ISO-25010 tree could re-ascend or declare a level 7 in silence.
    const levelled = level !== undefined;
    if (!architectural || levelled) {
      if (!levelled || !Number.isInteger(level)
          || level < REQUIREMENT_MIN_LEVEL || level > REQUIREMENT_MAX_LEVEL) {
        out.push({
          severity: "error", code: ERR_REQUIREMENT_BAD_LEVEL, path: reqPath,
          message: `level must be an integer ${REQUIREMENT_MIN_LEVEL}-${REQUIREMENT_MAX_LEVEL} (got ${String(level)}). ` +
            `L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member.` +
            (architectural ? ` On an architectural requirement the level is optional — omit it for a flat policy.` : ``),
        });
      }
      // Nesting IS the hierarchy, so a child must sit strictly below its parent.
      const parent = req.parent;
      if (parent !== undefined && parent.type === TYPE_REQUIREMENT) {
        const pl = (parent as MetaRequirement).level();
        if (pl !== undefined && level !== undefined && level <= pl) {
          out.push({
            severity: "error", code: ERR_REQUIREMENT_LEVEL_NESTING, path: reqPath,
            message: `nested under "${parent.name}" (level ${pl}) but declares level ${level}. ` +
              `Nesting is the hierarchy — a child sits strictly below its parent.`,
          });
        }
      }
    }

    // -- the link boundary ----------------------------------------------------
    if (refs.length > 0 && !req.mayReferenceModel()) {
      out.push({
        severity: "error", code: ERR_REQUIREMENT_LINK_ABOVE_FLOOR, path: reqPath,
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
      const node = resolveClaimTarget(root, owner, referrerPkg);
      const isObjectRef = path.length === 0;

      // GRAIN, and it stays functional-only DELIBERATELY. On a functional
      // requirement L4 and L5 MEAN "an object" and "a member" — that is what the
      // allocation step allocates. On a levelled architectural one the upper
      // tiers are a quality taxonomy and L4/L5 retain only their link-floor
      // meaning, so a policy whose claim set legitimately mixes grains ("every
      // money FIELD declares its currency", claimed alongside the entities that
      // hold them) must not be forced to split by grain to say so. Extending
      // this to architectural would be a new rule, not the missing half of an
      // existing one — unlike the level checks above, which `@level` already
      // promised.
      if (!architectural && level === REQUIREMENT_LINK_FLOOR_LEVEL && !isObjectRef) {
        out.push({
          severity: "error", code: ERR_REQUIREMENT_L4_NOT_OBJECT, path: reqPath,
          message: `L${REQUIREMENT_LINK_FLOOR_LEVEL} references an object; '${ref}' names a member. ` +
            `Move it to a nested L${REQUIREMENT_LEVEL_MEMBER} child, or reference the object itself.`,
        });
        continue;
      }
      if (!architectural && level === REQUIREMENT_LEVEL_MEMBER && isObjectRef) {
        out.push({
          severity: "error", code: ERR_REQUIREMENT_L5_NOT_MEMBER, path: reqPath,
          message: `L${REQUIREMENT_LEVEL_MEMBER} references a member (field, view or identity); ` +
            `'${ref}' names an object. Move it to its L${REQUIREMENT_LINK_FLOOR_LEVEL} parent.`,
        });
        continue;
      }

      const resolved = node !== undefined && (isObjectRef || resolveMember(node, path) !== undefined);
      if (!resolved) {
        // Severity is CONDITIONAL ON STATUS, and the asymmetry inverts as a pair.
        // On `planned` the nodes do not exist YET — that is the entry doing its
        // job, and the reason this check cannot live in the loader.
        if (req.requiresLiveNodes()) {
          out.push({
            severity: "error", code: ERR_REQUIREMENT_DANGLING_REF, path: reqPath,
            message: `'${ref}' does not resolve in the loaded model (status '${String(req.status())}' — ` +
              `the model moved and the requirement is stale).` + didYouMeanHint(root, owner),
          });
        }
      }
    }

    // -- @supersededBy resolution (FR-039) ------------------------------------
    // The 2026-08-10 ruling asked for exactly this at point 4 — "a supersededBy
    // that RESOLVES (FQN-checked, so verify can fail on a dangling one), turning
    // 'deleted in S6' from an inert comment into a build gate" — and 0.24.0
    // deregistered the unresolved string version without ever building it.
    //
    // Resolution is what makes a supersession CHAIN survive. A prose note points
    // one hop and rots when that hop is itself retired; a resolved reference does
    // not, because the target is a real node carrying its own @supersededBy.
    //
    // The target is a REQUIREMENT, not a model node: a capability is replaced by
    // another capability. It resolves package-locally under ADR-0042 through the
    // requirement's own effective package, exactly as @implementedBy does.
    const superseded = req.supersededBy();
    if (superseded !== undefined) {
      const referrerPkg = req.package ?? req.fileDefaultPackage ?? "";
      if (resolveRequirementRef(addressed, superseded, referrerPkg) === undefined) {
        out.push({
          severity: "error", code: ERR_REQUIREMENT_DANGLING_REF, path: reqPath,
          message: `@supersededBy '${superseded}' does not name a requirement in the loaded ` +
            `ledger. It must name the requirement that REPLACED this one — if nothing did, ` +
            `drop the attribute and let \`notes\` carry why the capability went.`,
        });
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
    // Two exemptions, both structural rather than lenient.
    //
    // `planned` — a policy that is not built yet is SUPPOSED to be applied to
    // nothing, so the check would fire on precisely the entries it should stay
    // quiet about.
    //
    // An ORGANISATIONAL node in a levelled architectural tree — an "ISO 25010
    // Security" at L1 delegates to its children and names nothing, exactly as
    // an L1 functional node does. mayReferenceModel() is the right predicate
    // because it already encodes "is this tier allowed to name the model at
    // all": true for a flat policy (the original form), false for L1-L3 of a
    // levelled one, true again at the link floor.
    if (architectural && live && refs.length === 0 && req.mayReferenceModel()) {
      out.push({
        severity: "error", code: ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS, path: reqPath,
        message: `architectural requirement is '${String(status)}' but nothing implements it. ` +
          `Its check is universality — a claim set of zero means the policy is declared and unapplied.`,
      });
    }

    // -- disposition: the decision, not the state -----------------------------
    const disposition = req.disposition();
    if (disposition !== undefined && !req.hasOutstandingWork()) {
      out.push({
        severity: "warn", code: WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE, path: reqPath,
        message: `carries @disposition '${disposition}' but its status is '${String(status)}', which has no ` +
          `outstanding work to decide about. A disposition is meaningful on 'planned' and 'partial' only — ` +
          `on any other status the decision IS the status.`,
      });
    }
    // -- functional existence, SUBTREE-scoped ---------------------------------
    // A functional requirement's check is EXISTENCE: it fails when nothing
    // implements it. But an organisational tier legitimately implements nothing
    // ITSELF — it delegates to children, and that is the whole shape of the
    // tree. So the question is not "does this node claim anything" but "does
    // anything in this subtree claim anything". A live L1 whose entire subtree
    // is empty is a capability declared and built by nobody.
    if (!architectural && live && !subtreeClaimsAnything(req)) {
      out.push({
        severity: "warn", code: WARN_REQUIREMENT_NOTHING_IMPLEMENTS, path: reqPath,
        message: `is '${String(status)}' but neither it nor anything nested under it names an ` +
          `implementing node. A functional requirement's check is existence — a subtree that claims ` +
          `nothing is a capability nobody built.`,
      });
    }

    if (disposition === REQUIREMENT_DISPOSITION_DEFERRED && req.trackedBy().length === 0) {
      out.push({
        severity: "warn", code: WARN_REQUIREMENT_DEFERRED_UNTRACKED, path: reqPath,
        message: `is deferred but names no @trackedBy issue. Deferring without a ticket is how a known gap ` +
          `becomes an unknown one — nothing will raise it again.`,
      });
    }
  }

  // -- object coverage: adding an entity forces a requirement -----------------
  // Binary per entity, never a ratio: a "% claimed" number measures what the
  // schema can express, is biased against the hardest rules, and invites
  // optimising the number.
  //
  // SCOPE, stated because it is a decision and not an oversight:
  //
  //   ENTITIES ONLY. `object.value` and `object.projection` are exempt. A value is a
  //   shape (a DTO, a payload, a message) and a projection is DERIVED from an entity
  //   that is itself claimable — requiring both to carry their own capability claim
  //   would multiply entries without adding information.
  //
  //   OBJECT GRAIN ONLY. Fields, views, validators and identities are never required
  //   to be claimed. Member-grain coverage is the "thousands of meaningless links"
  //   failure `spec/capability-ledger.md` argues against: plumbing members are covered
  //   by ARCHITECTURAL requirements with high fan-out (one uuid-PK rule claims every
  //   entity), not by a per-member entry. L5 exists so a claim about a specific member
  //   CAN be made when it carries real meaning — never so that every member must.
  //
  // So a green run means "every entity is claimed by something", not "every node is
  // described". The stronger reading would be false.
  for (const ent of coverableEntities(root)) {
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

/**
 * Count what the ledger contains, for the line `meta verify` prints on EVERY
 * run — including a clean one.
 *
 * This exists because silence is ambiguous. A run that prints nothing cannot be
 * told apart from a run that checked nothing, and an entry that skipped a whole
 * grain of the model looks exactly like one that covered it. The counts below
 * are deliberately the ones an author would otherwise have to write a script to
 * get: how many gaps are recorded, and how many of those nobody has ruled on.
 */
export function summariseRequirements(
  root: MetaData,
  scan: RequirementScan = scanRequirements(root),
): RequirementSummary | undefined {
  const reqs = scan.addressed.map((r) => r.node);
  if (reqs.length === 0) return undefined; // opt-in by declaration

  const summary: RequirementSummary = {
    total: reqs.length,
    functional: 0,
    architectural: 0,
    byStatus: {},
    undecided: 0,
    deferredUntracked: 0,
    entitiesTotal: 0,
    entitiesClaimed: 0,
  };

  for (const req of reqs) {
    if (req.subType === REQUIREMENT_SUBTYPE_ARCHITECTURAL) summary.architectural++;
    else summary.functional++;

    const status = req.status();
    if (status !== undefined) summary.byStatus[status] = (summary.byStatus[status] ?? 0) + 1;

    if (req.hasOutstandingWork() && req.disposition() === undefined) summary.undecided++;
    if (req.disposition() === REQUIREMENT_DISPOSITION_DEFERRED && req.trackedBy().length === 0) {
      summary.deferredUntracked++;
    }
  }

  // Both sides of the ratio come from the SAME scan the gate read, so the printed
  // summary cannot disagree with the diagnostics printed beneath it — previously
  // the same helper, now literally the same result.
  const claimed = scan.claimedObjects;
  for (const ent of coverableEntities(root)) {
    summary.entitiesTotal++;
    if (claimed.has(ent.resolutionKey())) summary.entitiesClaimed++;
  }

  return summary;
}
