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
