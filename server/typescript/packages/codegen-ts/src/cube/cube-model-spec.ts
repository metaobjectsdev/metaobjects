// FR-044 Plan 4 — the Cube data model the cube-model generator writes, as plain data
// (Table H's shape). `buildCubeModel` produces it from the reporting vocabulary; the YAML
// renderer writes one file per cube from it. Field names follow Cube's own keys in camelCase
// (`sqlTable` is `sql_table`, `primaryKey` is `primary_key`, `preAggregations` is
// `pre_aggregations`). Every `sql` value is the SQL text as Cube reads it, already escaped for
// Cube's `{...}` reference syntax and Jinja (Table G): a renderer only YAML-quotes it.

import type { TimeGrain } from "@metaobjectsdev/metadata";

/** Cube's data sources this exporter writes SQL for (open question 3). */
export type CubeDialect = "postgres" | "mysql";

export type CubeDimensionType = "string" | "number" | "boolean" | "time";

export type CubeMeasureType = "count" | "count_distinct" | "sum" | "avg" | "min" | "max" | "number";

export type CubeJoinRelationship = "many_to_one" | "one_to_one" | "one_to_many";

export interface CubeJoinSpec {
  /** The joined cube's name: the target entity's cube, or an alias cube (Table E). */
  readonly name: string;
  readonly relationship: CubeJoinRelationship;
  /** The ON predicate, e.g. `{CUBE}."programId" = {Program}."id"`. */
  readonly sql: string;
}

export interface CubeDimensionMeta {
  /** A `dimension.time`'s `@grains`, in declared order. Carried, not enforced (Table J). */
  readonly grains: readonly TimeGrain[];
}

export interface CubeDimensionSpec {
  readonly name: string;
  readonly sql: string;
  readonly type: CubeDimensionType;
  /** Set on each primary-key dimension. Cube makes a primary key non-public by default. */
  readonly primaryKey?: boolean;
  /** `false` for a member the exporter adds for a `@via` to read; absent means Cube's default. */
  readonly public?: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly meta?: CubeDimensionMeta;
}

export interface CubeFilterSpec {
  readonly sql: string;
}

export interface CubeMeasureSpec {
  readonly name: string;
  readonly sql: string;
  readonly type: CubeMeasureType;
  /** At most one entry: the measure's condition (Table D). */
  readonly filters?: readonly CubeFilterSpec[];
  readonly public?: boolean;
  readonly title?: string;
  readonly description?: string;
}

export interface CubeSegmentSpec {
  readonly name: string;
  readonly sql: string;
  readonly public?: boolean;
  readonly title?: string;
  readonly description?: string;
}

/** One `{ dimension, granularity }` entry of a rollup's `time_dimensions` list (Table F). */
export interface CubeRollupTimeDimension {
  /** A member name on this cube; the renderer writes it `CUBE.<name>`. */
  readonly dimension: string;
  readonly granularity: TimeGrain;
}

/**
 * A `rollup` pre-aggregation (Table F). Member lists hold member names on this cube, in the
 * report's listed order; the renderer writes each `CUBE.<name>`. A rollup with one time
 * dimension uses `timeDimension` + `granularity` (the documented form); one with two or more
 * uses `timeDimensions`; never both.
 */
export interface CubeRollupSpec {
  readonly name: string;
  readonly type: "rollup";
  readonly measures: readonly string[];
  readonly dimensions: readonly string[];
  readonly segments: readonly string[];
  readonly timeDimension?: string;
  readonly granularity?: TimeGrain;
  readonly timeDimensions?: readonly CubeRollupTimeDimension[];
}

export interface CubeSpec {
  readonly name: string;
  /** `"table"`, or `"schema"."table"` when `@schema` is declared. Absent with `sql` or `extends`. */
  readonly sqlTable?: string;
  /** The cube's SELECT, for a TPH subtype (its discriminator predicate). Absent with `sqlTable`. */
  readonly sql?: string;
  /** The cube an alias cube extends (Table E). */
  readonly extends?: string;
  /** `false` for a join-target or alias cube; absent means Cube's default (public). */
  readonly public?: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly joins: readonly CubeJoinSpec[];
  /** Primary key first, then declared dimensions, then the members added for a `@via`. */
  readonly dimensions: readonly CubeDimensionSpec[];
  readonly measures: readonly CubeMeasureSpec[];
  readonly segments: readonly CubeSegmentSpec[];
  readonly preAggregations: readonly CubeRollupSpec[];
}

/** One cube a Cube view includes (Task 10). */
export interface CubeViewIncludeAlias {
  readonly name: string;
  readonly alias: string;
}

export interface CubeViewCubeSpec {
  /** Dotted cube path from the view's root cube, e.g. `Program.Week`. */
  readonly joinPath: string;
  readonly includes: readonly (string | CubeViewIncludeAlias)[];
  readonly prefix?: boolean;
}

export interface CubeViewSpec {
  readonly name: string;
  readonly public?: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly cubes: readonly CubeViewCubeSpec[];
}

export interface CubeModel {
  readonly cubes: readonly CubeSpec[];
  readonly views: readonly CubeViewSpec[];
}
