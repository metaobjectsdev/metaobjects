// MetaRequirement — concrete node class for type=requirement nodes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.
// Accessors are RESOLVING (ADR-0039) so a requirement that `extends` an
// abstract parent inherits its properties.

import { MetaData } from "../../shared/meta-data.js";
import {
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
  REQUIREMENT_ATTR_LEVEL,
  REQUIREMENT_ATTR_STATUS,
  REQUIREMENT_ATTR_DISPOSITION,
  REQUIREMENT_ATTR_TRACKED_BY,
  REQUIREMENT_ATTR_IMPLEMENTED_BY,
  REQUIREMENT_LINK_FLOOR_LEVEL,
  REQUIREMENT_STATUS_PLANNED,
  REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
  REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK,
  type RequirementDisposition,
  type RequirementStatus,
  REQUIREMENT_STATUS_RETIRED,
  REQUIREMENT_ATTR_SUPERSEDED_BY,
} from "./requirement-constants.js";

export class MetaRequirement extends MetaData {
  /** What the product does for a user — checked by EXISTENCE. */
  isFunctional(): boolean {
    return this.subType === REQUIREMENT_SUBTYPE_FUNCTIONAL;
  }

  /** How the system is built — checked by UNIVERSALITY (the opposite polarity). */
  isArchitectural(): boolean {
    return this.subType === REQUIREMENT_SUBTYPE_ARCHITECTURAL;
  }

  /** 1 solution · 2 segment · 3 service · 4 object · 5 member. Required on a
   *  functional requirement. OPTIONAL on an architectural one, where absent
   *  means the original flat, object-independent form and present means it
   *  sits in a levelled tree (a quality taxonomy over non-functional claims). */
  level(): number | undefined {
    const v = this.attr(REQUIREMENT_ATTR_LEVEL);
    return typeof v === "number" ? v : undefined;
  }

  status(): RequirementStatus | undefined {
    const v = this.attr(REQUIREMENT_ATTR_STATUS);
    return typeof v === "string" ? (v as RequirementStatus) : undefined;
  }

  /** What was DECIDED about the outstanding work. Undefined means UNDECIDED —
   *  a real state, and the one worth finding in a review. */
  disposition(): RequirementDisposition | undefined {
    const v = this.attr(REQUIREMENT_ATTR_DISPOSITION);
    return typeof v === "string" ? (v as RequirementDisposition) : undefined;
  }

  /** Issue/ticket references. Free-form; never resolved (verify has no network). */
  trackedBy(): string[] {
    const v = this.attr(REQUIREMENT_ATTR_TRACKED_BY);
    return Array.isArray(v) ? (v as string[]) : [];
  }

  /** Intended but not built. Its nodes may legitimately not exist yet, and it
   *  must NOT count toward object coverage — planning a capability cannot be
   *  allowed to silence the warning that nothing implements it. */
  isPlanned(): boolean {
    return this.status() === REQUIREMENT_STATUS_PLANNED;
  }

  /** True when there is outstanding work, so a `@disposition` says something. */
  hasOutstandingWork(): boolean {
    const s = this.status();
    return s !== undefined && REQUIREMENT_STATUSES_WITH_OUTSTANDING_WORK.includes(s);
  }

  /** Built, then deliberately removed. Carries no `@implementedBy` (the loader
   *  refuses it), never counts toward object coverage, and is exempt from the
   *  architectural universality check — a withdrawn policy governs nothing. */
  isRetired(): boolean {
    return this.status() === REQUIREMENT_STATUS_RETIRED;
  }

  /** The requirement that REPLACED this one (FR-039). Legal on `retired` only;
   *  `verify` resolves it, so a supersession chain stays walkable. */
  supersededBy(): string | undefined {
    const v = this.attr(REQUIREMENT_ATTR_SUPERSEDED_BY);
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  }

  implementedBy(): string[] {
    const v = this.attr(REQUIREMENT_ATTR_IMPLEMENTED_BY);
    return Array.isArray(v) ? (v as string[]) : [];
  }

  /** True when this requirement is permitted to reference the model at all.
   *
   *  An UNLEVELLED architectural requirement always may — its claim set is the
   *  whole point, and that is the original flat form. Once a level is present,
   *  the node has opted into a tree and the link floor applies to it exactly as
   *  it does to a functional one, so an "ISO 25010 Security" grouping node
   *  cannot quietly start naming entities. Levelling is the opt-in; enforcing
   *  the floor unconditionally would have broken every existing flat policy. */
  mayReferenceModel(): boolean {
    const lvl = this.level();
    if (lvl === undefined) return this.isArchitectural();
    return lvl >= REQUIREMENT_LINK_FLOOR_LEVEL;
  }

  /** True when a dangling `@implementedBy` is an ERROR rather than expected.
   *  `planned` is exempt (the nodes do not exist YET) and `retired` cannot reach
   *  this at all, because the loader refuses `@implementedBy` there. */
  requiresLiveNodes(): boolean {
    const s = this.status();
    return s !== undefined && REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES.includes(s);
  }
}
