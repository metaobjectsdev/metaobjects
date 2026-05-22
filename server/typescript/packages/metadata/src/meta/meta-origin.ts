// MetaOrigin — concrete node class for type=origin nodes.
// Field-level provenance (Project E).
// passthrough / aggregate origin subtypes declare how field values are derived.
//
// MetaPassthroughOrigin and MetaAggregateOrigin are co-located subtype classes
// (mirrors the meta-identity.ts pattern).
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import {
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  type AggregateFunction,
} from "../persistence/origin/origin-constants.js";

export class MetaOrigin extends MetaData {}

/**
 * Passthrough origin — the field's value is sourced directly from a
 * cross-entity field reference (e.g. a projection that forwards Program.title).
 *
 * Carries `@from` (required): the dotted Entity.field reference identifying
 * the source value.
 */
export class MetaPassthroughOrigin extends MetaOrigin {
  /** The dotted-path cross-entity field reference this origin passes through (e.g. "Program.title"). */
  get from(): string | undefined {
    const v = this.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
    return typeof v === "string" ? v : undefined;
  }

  /** Optional dotted relationship path used to reach the source entity (e.g. "Program.weeks"). */
  get via(): string | undefined {
    const v = this.ownAttr(ORIGIN_PASSTHROUGH_ATTR_VIA);
    return typeof v === "string" ? v : undefined;
  }
}

/**
 * Aggregate origin — the field's value is computed by aggregating values
 * over a relationship path (count / sum / avg / min / max).
 *
 * Carries `@agg`, `@of`, and `@via` (all required).
 */
export class MetaAggregateOrigin extends MetaOrigin {
  /** The aggregate function (count | sum | avg | min | max). */
  get agg(): AggregateFunction | undefined {
    const v = this.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG);
    return typeof v === "string" ? (v as AggregateFunction) : undefined;
  }

  /** The dotted-path target of the aggregate (e.g. "Week.id"). */
  get of(): string | undefined {
    const v = this.ownAttr(ORIGIN_AGGREGATE_ATTR_OF);
    return typeof v === "string" ? v : undefined;
  }

  /** The dotted relationship path the aggregate walks (e.g. "Program.weeks"). */
  get via(): string | undefined {
    const v = this.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
    return typeof v === "string" ? v : undefined;
  }
}
