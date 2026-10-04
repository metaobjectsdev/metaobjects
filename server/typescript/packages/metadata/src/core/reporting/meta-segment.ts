// MetaSegment — concrete node class for type=segment nodes (FR-044).
//
// Extends MetaData directly. Accessors are RESOLVING (ADR-0039).

import { MetaData } from "../../shared/meta-data.js";
import { REPORTING_ATTR_FILTER } from "./reporting-constants.js";

export class MetaSegment extends MetaData {
  /** The named row scope: a canonical attr.filter over the declaring entity's fields. */
  filter(): Record<string, unknown> | undefined {
    const v = this.attr(REPORTING_ATTR_FILTER);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  }
}
