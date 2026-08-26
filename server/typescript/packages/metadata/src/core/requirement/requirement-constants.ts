// Requirement concern constants — type name, subtypes, and attr keys.
//
// `requirement.*` is REGISTERED metamodel vocabulary (ruling amendment 3): the
// capability ledger is a metadata model, so it is declared in `metaobjects/`
// beside the entities it describes and validated by the loader like everything
// else — not hand-parsed from a side file.

export const REQUIREMENT = "requirement";

// ---------------------------------------------------------------------------
// Subtypes — the axis is the CHECK POLARITY, which is a genuine behaviour
// difference and therefore a subtype under ADR-0037 §2:
//   functional    -> EXISTENCE:    fails when nothing implements it
//   architectural -> UNIVERSALITY: fails when something violates it
// ---------------------------------------------------------------------------

export const REQUIREMENT_SUBTYPE_FUNCTIONAL = "functional";
export const REQUIREMENT_SUBTYPE_ARCHITECTURAL = "architectural";

export const REQUIREMENT_SUBTYPES = [
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
] as const;
export type RequirementSubType = (typeof REQUIREMENT_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Attrs
// ---------------------------------------------------------------------------

/** 1 solution · 2 segment · 3 service · 4 object · 5 member — levels of
 *  ABSTRACTION AND OWNERSHIP in the problem domain, never of code structure. */
export const REQUIREMENT_ATTR_LEVEL = "level";
export const REQUIREMENT_ATTR_STATUS = "status";
export const REQUIREMENT_ATTR_DISPOSITION = "disposition";
export const REQUIREMENT_ATTR_TRACKED_BY = "trackedBy";
export const REQUIREMENT_ATTR_STATEMENT = "statement";
export const REQUIREMENT_ATTR_COUNTEREXAMPLE = "counterexample";
export const REQUIREMENT_ATTR_IMPLEMENTED_BY = "implementedBy";

/** FR-039 — the requirement that REPLACED a retired one. A resolving reference,
 *  so a supersession chain stays walkable: A -> B, and when B is retired too it
 *  carries its own. Legal ONLY on `retired`; the original 2026-08-10 ruling
 *  asked for a resolving `supersededBy` (point 4) and 0.24.0 deregistered the
 *  unresolved string version without ever building it. */
export const REQUIREMENT_ATTR_SUPERSEDED_BY = "supersededBy";

// ---------------------------------------------------------------------------
// Status — a closed enum, enforced by the registry via `allowedValues`. This is
// the one payload with controlled evidence behind it: model-only agents flagged
// a deliberately-retired capability 0 times out of 24, so a typo that silently
// disabled it would disable the whole mechanism.
// ---------------------------------------------------------------------------

export const REQUIREMENT_STATUS_PLANNED = "planned";
export const REQUIREMENT_STATUS_LIVE = "live";
export const REQUIREMENT_STATUS_PARTIAL = "partial";
/** FR-039 — built, then deliberately removed; it must NOT be rebuilt.
 *
 *  PRESCRIPTIVE, which is what makes it admissible under FR-038's rule that a
 *  requirement never journals what happened: the entry states a prohibition in
 *  force, falsifiable by exactly one observable — the capability reappearing.
 *  The retired `abandoned` described the past; this describes the standing rule.
 *
 *  This is the status the ledger's only surviving controlled result is about:
 *  model-only agents flagged a deliberately-retired capability 0 times out of
 *  24, ledger arms 19 of 40. */
export const REQUIREMENT_STATUS_RETIRED = "retired";

export const REQUIREMENT_STATUSES = [
  REQUIREMENT_STATUS_PLANNED,
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PARTIAL,
  REQUIREMENT_STATUS_RETIRED,
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Statuses whose implementing nodes are supposed to still exist. A dangling
 *  `@implementedBy` on one of these means the model moved and the requirement is
 *  stale. `planned` is exempt — there the nodes do not exist YET — and `retired`
 *  cannot appear here at all, because it may not carry `@implementedBy`. */
export const REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES: readonly RequirementStatus[] = [
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PARTIAL,
];

/** Statuses with outstanding work, so a `@disposition` is meaningful on them.
 *  On any other status the decision IS the status, and recording a second one
 *  can only agree with it or contradict it. */
export const REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK: readonly RequirementStatus[] = [
  REQUIREMENT_STATUS_PLANNED,
  REQUIREMENT_STATUS_PARTIAL,
];

/** Statuses on which `@implementedBy` is REFUSED AT LOAD (FR-039).
 *
 *  This is the structural half of FR-039 and the reason it is a list rather
 *  than an inline test. FR-038 removed `abandoned` because `verify` was SILENT
 *  on dangling refs for it, hiding 29 unresolvable references across 14 entries
 *  in one estate. That silence was a deliberate EXEMPTION — dangling was
 *  specified as correct there. Forbidding the attribute outright makes the bug
 *  class UNREACHABLE instead: a retired capability has no implementation by
 *  definition, so the references cannot dangle because they cannot exist. */
export const REQUIREMENT_STATUSES_FORBIDDING_IMPLEMENTORS: readonly RequirementStatus[] = [
  REQUIREMENT_STATUS_RETIRED,
];

// ---------------------------------------------------------------------------
// Disposition — what was DECIDED about the outstanding work. Orthogonal to
// status, which says whether the work is done. Absent means UNDECIDED, and that
// is the state a review exists to find; collapsing it into the status enum
// would make "there is a gap" and "we chose to live with it" the same fact.
// ---------------------------------------------------------------------------

export const REQUIREMENT_DISPOSITION_ACCEPTED = "accepted";
export const REQUIREMENT_DISPOSITION_DEFERRED = "deferred";

export const REQUIREMENT_DISPOSITIONS = [
  REQUIREMENT_DISPOSITION_ACCEPTED,
  REQUIREMENT_DISPOSITION_DEFERRED,
] as const;
export type RequirementDisposition = (typeof REQUIREMENT_DISPOSITIONS)[number];

// ---------------------------------------------------------------------------
// Levels — organisational above the link floor, model-referencing at or below.
// ---------------------------------------------------------------------------

export const REQUIREMENT_LEVEL_SOLUTION = 1;
export const REQUIREMENT_LEVEL_SEGMENT = 2;
export const REQUIREMENT_LEVEL_SERVICE = 3;
export const REQUIREMENT_LEVEL_OBJECT = 4;
export const REQUIREMENT_LEVEL_MEMBER = 5;

/** The lowest level that may reference the model. L1-L3 are organisational and
 *  carrying `@implementedBy` there is an error. */
export const REQUIREMENT_LINK_FLOOR_LEVEL = REQUIREMENT_LEVEL_OBJECT;
export const REQUIREMENT_MIN_LEVEL = REQUIREMENT_LEVEL_SOLUTION;
export const REQUIREMENT_MAX_LEVEL = REQUIREMENT_LEVEL_MEMBER;
