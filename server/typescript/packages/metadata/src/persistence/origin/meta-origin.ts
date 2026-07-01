// MetaOrigin — concrete node class for type=origin nodes.
// Field-level provenance (Project E).
// passthrough / aggregate origin subtypes declare how field values are derived.
//
// MetaPassthroughOrigin and MetaAggregateOrigin are co-located subtype classes
// (mirrors the meta-identity.ts pattern).
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "../../shared/meta-data.js";
import {
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_COLLECTION_ATTR_VIA,
  type AggregateFunction,
} from "./origin-constants.js";

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
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
    return typeof v === "string" ? v : undefined;
  }

  /** Optional dotted relationship path used to reach the source entity (e.g. "Program.weeks"). */
  get via(): string | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
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
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG);
    return typeof v === "string" ? (v as AggregateFunction) : undefined;
  }

  /** The dotted-path target of the aggregate (e.g. "Week.id"). */
  get of(): string | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_AGGREGATE_ATTR_OF);
    return typeof v === "string" ? v : undefined;
  }

  /** The dotted relationship path the aggregate walks (e.g. "Program.weeks"). */
  get via(): string | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA);
    return typeof v === "string" ? v : undefined;
  }
}

/**
 * Collection origin — the (array) field's value is a relationship-derived
 * array of nested view-objects (FR-004 R4). Carries `@via` (required): the
 * dotted relationship path the collection walks (e.g. "Author.posts"), or a
 * wildcard-prefixed selector for a package-spanning collection (e.g. "*.User").
 */
export class MetaCollectionOrigin extends MetaOrigin {
  /** The dotted relationship path (or wildcard selector) this collection is sourced from. */
  get via(): string | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_COLLECTION_ATTR_VIA);
    return typeof v === "string" ? v : undefined;
  }
}
