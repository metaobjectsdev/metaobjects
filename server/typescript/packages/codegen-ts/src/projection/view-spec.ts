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
  /** FK field name (lives on whichever side `referenceHolder` indicates). */
  readonly fkField: string;
  /** PK field name on the side that does NOT hold the FK. */
  readonly pkField: string;
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
