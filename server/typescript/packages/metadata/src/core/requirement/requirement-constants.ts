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

/** 1 solution · 2 segment (app/library) · 3 service · 4 object · 5 member. */
export const REQUIREMENT_ATTR_LEVEL = "level";
export const REQUIREMENT_ATTR_STATUS = "status";
export const REQUIREMENT_ATTR_STATEMENT = "statement";
export const REQUIREMENT_ATTR_VIOLATION = "violation";
export const REQUIREMENT_ATTR_IMPLEMENTED_BY = "implementedBy";
export const REQUIREMENT_ATTR_VERIFIED_BY = "verifiedBy";
export const REQUIREMENT_ATTR_SUPERSEDED_BY = "supersededBy";

// ---------------------------------------------------------------------------
// Status — a closed enum, enforced by the registry via `allowedValues`. This is
// the one payload with controlled evidence behind it: model-only agents flagged
// a deliberately-retired capability 0 times out of 24, so a typo that silently
// disabled it would disable the whole mechanism.
// ---------------------------------------------------------------------------

export const REQUIREMENT_STATUS_LIVE = "live";
export const REQUIREMENT_STATUS_PARTIAL = "partial";
export const REQUIREMENT_STATUS_ABANDONED = "abandoned";
export const REQUIREMENT_STATUS_SUPERSEDED = "superseded";

export const REQUIREMENT_STATUSES = [
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PARTIAL,
  REQUIREMENT_STATUS_ABANDONED,
  REQUIREMENT_STATUS_SUPERSEDED,
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Statuses whose implementing nodes are supposed to still exist. A dangling
 *  `@implementedBy` on one of these means the model moved and the requirement is
 *  stale; on the other two the nodes are supposed to be GONE, which is the whole
 *  point of the entry. The asymmetry inverts as a pair. */
export const REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES: readonly RequirementStatus[] = [
  REQUIREMENT_STATUS_LIVE,
  REQUIREMENT_STATUS_PARTIAL,
];

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
