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
  REQUIREMENT_ATTR_IMPLEMENTED_BY,
  REQUIREMENT_ATTR_VERIFIED_BY,
  REQUIREMENT_LINK_FLOOR_LEVEL,
  REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
  type RequirementStatus,
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

  /** 1 solution · 2 segment · 3 service · 4 object · 5 member. Architectural
   *  requirements carry none — they are object-independent by definition. */
  level(): number | undefined {
    const v = this.attr(REQUIREMENT_ATTR_LEVEL);
    return typeof v === "number" ? v : undefined;
  }

  status(): RequirementStatus | undefined {
    const v = this.attr(REQUIREMENT_ATTR_STATUS);
    return typeof v === "string" ? (v as RequirementStatus) : undefined;
  }

  implementedBy(): string[] {
    const v = this.attr(REQUIREMENT_ATTR_IMPLEMENTED_BY);
    return Array.isArray(v) ? (v as string[]) : [];
  }

  verifiedBy(): string[] {
    const v = this.attr(REQUIREMENT_ATTR_VERIFIED_BY);
    return Array.isArray(v) ? (v as string[]) : [];
  }

  /** True when this requirement is permitted to reference the model at all.
   *  Architectural requirements always may (their claim set is the point);
   *  functional ones only at or below the link floor, so the organisational
   *  tiers stay organisational. */
  mayReferenceModel(): boolean {
    if (this.isArchitectural()) return true;
    const lvl = this.level();
    return lvl !== undefined && lvl >= REQUIREMENT_LINK_FLOOR_LEVEL;
  }

  /** True when a dangling `@implementedBy` is an ERROR rather than expected.
   *  An abandoned or superseded requirement's nodes are supposed to be gone. */
  requiresLiveNodes(): boolean {
    const s = this.status();
    return s !== undefined && REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES.includes(s);
  }
}
