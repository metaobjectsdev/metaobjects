// MetaDimension — concrete node class for type=dimension nodes (FR-044).
//
// Extends MetaData directly. Accessors are RESOLVING (ADR-0039): a dimension
// declared on an abstract base entity is read through the same accessors as one
// declared on the concrete entity.

import { MetaData } from "../../shared/meta-data.js";
import {
  DIMENSION_SUBTYPE_TIME,
  REPORTING_ATTR_GRAINS,
  REPORTING_ATTR_OF,
  REPORTING_ATTR_VIA,
  TIME_GRAINS,
  type TimeGrain,
} from "./reporting-constants.js";

export class MetaDimension extends MetaData {
  /** True for `dimension.time` (grain truncation); false for `dimension.attribute`. */
  isTime(): boolean {
    return this.subType === DIMENSION_SUBTYPE_TIME;
  }

  /** Dotted `Entity.field` reference naming the grouped column. */
  of(): string | undefined {
    const v = this.attr(REPORTING_ATTR_OF);
    return typeof v === "string" ? v : undefined;
  }

  /** Optional dotted to-one relationship path from the owning entity to the `@of` entity. */
  via(): string | undefined {
    const v = this.attr(REPORTING_ATTR_VIA);
    return typeof v === "string" ? v : undefined;
  }

  /** The grains a `dimension.time` supports (empty for `dimension.attribute`). */
  grains(): TimeGrain[] {
    const v = this.attr(REPORTING_ATTR_GRAINS);
    const items = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    return items.filter((g): g is TimeGrain => (TIME_GRAINS as readonly unknown[]).includes(g));
  }
}
