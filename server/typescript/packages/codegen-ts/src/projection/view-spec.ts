import type { AggregateFunction } from "@metaobjectsdev/metadata";

/** One node in the JOIN tree. `alias` is an auto-generated unique short alias. */
export interface JoinNode {
  /** Relationship name on the parent object (e.g., "weeks"). */
  readonly relationship: string;
  /** Entity name this join lands on (e.g., "Week"). */
  readonly targetEntity: string;
  /** Auto-assigned SQL alias for this join (e.g., "w", "w0"). */
  readonly alias: string;
  /** Cardinality of the relationship being traversed. */
  readonly cardinality: "one" | "many";
  /** FK physical column (strategy + @column resolved); lives on whichever side `referenceHolder` indicates. */
  readonly fkColumn: string;
  /** PK physical column (strategy + @column resolved) on the side that does NOT hold the FK. */
  readonly pkColumn: string;
  /** Which side of this hop physically holds the FK: the parent (source) or the child (target). */
  readonly referenceHolder: "source" | "target";
  /** Child joins. */
  readonly children: readonly JoinNode[];
}

/** Tree of JOINs rooted at the projection's base entity. */
export interface JoinTree {
  /** Base entity name (e.g., "Program"). */
  readonly baseEntity: string;
  /** SQL alias for the base entity (typically "p", "p0"). */
  readonly baseAlias: string;
  /** Joined entities (could be empty for a flat projection). */
  readonly joins: readonly JoinNode[];
}

/**
 * A resolved filter clause scoping an aggregate to a subset of related rows. Column
 * refs are already resolved to `alias.column` (naming-strategy applied), so the
 * emitter is a pure renderer. Mirrors the canonical attr.filter shape.
 */
export type ViewFilterClause =
  | { readonly kind: "cmp"; readonly ref: string; readonly op: string; readonly value: unknown }
  | { readonly kind: "and"; readonly clauses: readonly ViewFilterClause[] }
  | { readonly kind: "or"; readonly clauses: readonly ViewFilterClause[] };

/** A scalar literal in a resolved computed expression (mirrors attr.expression's ExprLiteral). */
export type ViewExprLiteral = string | number | boolean | null;

/**
 * A resolved node of an `origin.computed` expression (#195). Field refs are already
 * lowered to a physical `alias.column` (base alias + naming strategy applied), so the
 * emitter is a pure tree-walk. Mirrors the closed `attr.expression` node grammar.
 */
export type ViewExprNode =
  | { readonly kind: "col"; readonly ref: string }                                       // resolved base column `alias.column`
  | { readonly kind: "lit"; readonly value: ViewExprLiteral }                            // scalar literal
  | { readonly kind: "cmp"; readonly op: string; readonly left: ViewExprNode; readonly right: ViewExprNode } // eq/ne/gt/gte/lt/lte
  | { readonly kind: "nullTest"; readonly negated: boolean; readonly arg: ViewExprNode } // isNull / isNotNull
  | { readonly kind: "not"; readonly arg: ViewExprNode }
  | { readonly kind: "logic"; readonly op: "and" | "or"; readonly args: readonly ViewExprNode[] }
  | { readonly kind: "coalesce"; readonly args: readonly ViewExprNode[] };

/** A resolved ordering key: a physical column (naming-strategy applied) + direction. */
export interface ViewOrderKey {
  readonly column: string;
  readonly dir: "asc" | "desc";
}

/** One column of the SELECT list. */
export type SelectColumn =
  | {
      readonly kind: "passthrough";
      readonly fieldName: string;        // projection field name
      readonly dbColAlias: string;       // SQL output column name
      readonly sourceAlias: string;      // join alias of the source
      readonly sourceColumn: string;     // source table's column name (already strategy-applied)
    }
  | {
      readonly kind: "aggregate";
      readonly fieldName: string;
      readonly dbColAlias: string;
      readonly agg: AggregateFunction;
      readonly sourceAlias: string;
      readonly sourceColumn: string;
      /** Optional scoping filter (origin.aggregate @filter) → SQL aggregate FILTER (WHERE …). */
      readonly filter?: ViewFilterClause;
    }
  | {
      // #195 — origin.aggregate @agg:any|all — a predicate quantifier over the related
      // row-set. Lowered to COALESCE(bool_or/bool_and(pred) FILTER (WHERE joined.pk IS
      // NOT NULL), FALSE/TRUE) on PG; MAX/MIN(CASE …) on SQLite. Empty set → false (any)
      // / true (all). Inflation-immune; never null.
      readonly kind: "predicateAgg";
      readonly fieldName: string;
      readonly dbColAlias: string;
      readonly quant: "any" | "all";
      readonly sourceAlias: string;      // alias of the related (aggregated) entity
      readonly joinedPkColumn: string;   // related entity's PK column — the LEFT-JOIN phantom guard
      readonly pred: ViewFilterClause;   // the quantified predicate (origin.aggregate @filter — required)
    }
  | {
      // #195 — origin.aggregate @agg:collect — array rollup of @of across the related set.
      // Lowered to COALESCE(array_agg(<of> [DISTINCT] ORDER BY …) FILTER (WHERE joined.pk
      // IS NOT NULL), '{}') on PG; json_group_array on SQLite. Empty set → []. Default
      // element order = value ascending (byte-stability); @distinct dedupes.
      readonly kind: "collectAgg";
      readonly fieldName: string;
      readonly dbColAlias: string;
      readonly sourceAlias: string;
      readonly sourceColumn: string;     // the @of column (collected value)
      readonly joinedPkColumn: string;   // related entity's PK column — the LEFT-JOIN phantom guard
      readonly distinct: boolean;
      /** Element ordering over the @of entity's columns; empty ⇒ value-ascending default. */
      readonly orderBy: readonly ViewOrderKey[];
    }
  | {
      // #195 — origin.computed — a row-level value from the base entity's own fields via
      // a structured @expr tree (no related rows). Lowered by a tree-walk to a SQL scalar
      // expression over the base alias's columns.
      readonly kind: "computed";
      readonly fieldName: string;
      readonly dbColAlias: string;
      readonly expr: ViewExprNode;
    }
  | {
      // #195 — origin.first — argmax-then-project: the single related row selected by
      // @orderBy along @via, projecting @of. Lowered to a CORRELATED scalar subquery
      // keyed on the base alias (coexists with the outer GROUP BY). Empty set → null.
      readonly kind: "first";
      readonly fieldName: string;
      readonly dbColAlias: string;
      readonly childEntity: string;      // entity name of the related rows (for table lookup)
      readonly childAlias: string;       // FRESH subquery alias (never a JOIN-tree alias)
      readonly sourceColumn: string;     // the @of column projected from the selected row
      /** Correlation direction (mirrors JoinNode.referenceHolder). */
      readonly referenceHolder: "source" | "target";
      readonly fkColumn: string;         // FK column (resolved) for the base↔child correlation
      readonly pkColumn: string;         // PK column (resolved) for the base↔child correlation
      readonly childPkColumn: string;    // child's own PK column — the determinism tie-breaker
      readonly orderBy: readonly ViewOrderKey[]; // row-selection ordering over the child entity
      /** Optional scoping filter over the child entity (refs use `childAlias`). */
      readonly filter?: ViewFilterClause;
    };

export interface SelectSpec {
  readonly columns: readonly SelectColumn[];
}

/** Top-level view specification consumed by view-ddl-emit + Drizzle declaration. */
export interface ViewSpec {
  readonly viewName: string;        // already strategy-applied (e.g., "v_program_summary")
  readonly joinTree: JoinTree;
  readonly selectSpec: SelectSpec;
  /** non-aggregate column SQL fragments to put in GROUP BY (empty if no aggregates). */
  readonly groupBy: readonly string[];
}
