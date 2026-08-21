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
  ORIGIN_COMPUTED_ATTR_EXPR,
  ORIGIN_FIRST_ATTR_OF,
  ORIGIN_FIRST_ATTR_VIA,
  ORIGIN_ATTR_ORDER_BY,
  type OriginAggValue,
} from "./origin-constants.js";
import type { ExprNode } from "../../core/attr/meta-attr-expression.js";

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
  /** The reducing function (count | sum | avg | min | max | any | all | collect). */
  get agg(): OriginAggValue | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG);
    return typeof v === "string" ? (v as OriginAggValue) : undefined;
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
 * Computed origin (#195) — a row-level value computed from the base entity's own
 * fields via a structured expression tree (`@expr`). No related rows, no `@via`.
 * The expression's inferred type must equal the carrying field's declared subType
 * (ERR_COMPUTED_TYPE_MISMATCH).
 */
export class MetaComputedOrigin extends MetaOrigin {
  /** The structured expression tree computing this field's value. */
  get expr(): ExprNode | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_COMPUTED_ATTR_EXPR);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as ExprNode) : undefined;
  }
}

/**
 * First origin (#195) — the single related row selected by `@orderBy` along
 * `@via`, projecting its `@of` column (argmax-then-project). Empty related set
 * (after `@filter`) → null, so the carrying field must not be `@required`.
 *
 * Carries `@of` (required, type-preserving), `@via` (optional; single-hop-unique
 * inference), `@orderBy` (required), and an optional `@filter`.
 */
export class MetaFirstOrigin extends MetaOrigin {
  /** The dotted Entity.field reference projected from the selected row (e.g. "ChildA.label"). */
  get of(): string | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_FIRST_ATTR_OF);
    return typeof v === "string" ? v : undefined;
  }

  /** The dotted relationship path to the related rows (e.g. "Parent.childAs"). */
  get via(): string | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_FIRST_ATTR_VIA);
    return typeof v === "string" ? v : undefined;
  }

  /** The ordering keys ('field[:asc|desc]') selecting the single row. */
  get orderBy(): string[] | undefined {
    // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
    const v = this.ownAttr(ORIGIN_ATTR_ORDER_BY);
    return Array.isArray(v) ? (v as string[]) : undefined;
  }
}
