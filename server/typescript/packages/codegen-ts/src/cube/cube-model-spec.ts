// FR-044 Plan 4 — the Cube data model the cube-model generator writes, as plain data
// (Table H's shape). `buildCubeModel` produces it from the reporting vocabulary; the YAML
// renderers write one file per cube and one per view (a served `@spine` report) from it. Field names follow Cube's own keys in camelCase
// (`sqlTable` is `sql_table`, `primaryKey` is `primary_key`, `preAggregations` is
// `pre_aggregations`). Every SQL fragment (`sql`, `sqlTable`, a filter's or a join's `sql`)
// arrives escaped for Cube's template reader (backslashes doubled, `{...}` escaped) and for
// Jinja (Table G), so a renderer only YAML-quotes it. Free text (`title`, `description`) arrives
// raw, as the model declares it: the YAML renderer escapes it for Cube, which reads free text as
// a template too, and for Jinja.

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

interface CubeRollupBase {
  readonly name: string;
  readonly type: "rollup";
  /** Member names on this cube, in the report's listed order; the renderer writes `CUBE.<name>`. */
  readonly measures: readonly string[];
  readonly dimensions: readonly string[];
  readonly segments: readonly string[];
}

/** A rollup with one time dimension: the documented `time_dimension` + `granularity` form. */
export interface CubeRollupOneTime extends CubeRollupBase {
  /** A member name on this cube. */
  readonly timeDimension: string;
  readonly granularity: TimeGrain;
  readonly timeDimensions?: never;
}

/** A rollup with two or more time dimensions: the `time_dimensions` list (executed on Cube 1.7.43). */
export interface CubeRollupTimeList extends CubeRollupBase {
  readonly timeDimensions: readonly CubeRollupTimeDimension[];
  readonly timeDimension?: never;
  readonly granularity?: never;
}

/** A rollup with no time dimension. */
export interface CubeRollupNoTime extends CubeRollupBase {
  readonly timeDimension?: never;
  readonly granularity?: never;
  readonly timeDimensions?: never;
}

/** A `rollup` pre-aggregation (Table F): one of the three time forms, never two at once. */
export type CubeRollupSpec = CubeRollupOneTime | CubeRollupTimeList | CubeRollupNoTime;

/** What a cube is over: a table, or a SELECT. Exactly one, so a cube cannot carry both or neither. */
export interface CubeTableSource {
  /** `"table"`, or `"schema"."table"` when `@schema` is declared. */
  readonly sqlTable: string;
  readonly sql?: never;
}

export interface CubeSqlSource {
  /** The cube's SELECT, for a TPH subtype (its discriminator predicate). */
  readonly sql: string;
  readonly sqlTable?: never;
}

export type CubeSource = CubeTableSource | CubeSqlSource;

/** Everything on a cube but its source. */
export interface CubeSpecBase {
  readonly name: string;
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

export type CubeSpec = CubeSpecBase & CubeSource;

/**
 * One member a Cube view includes: a member of the cube its `joinPath` ends on, under `alias`
 * when the view names it differently (a report field reads a member named after another field:
 * `programKey` is `Program.id`). `title`, `description` and `meta` override the member's own, so
 * the view's member carries the report field's documentation (executed on Cube 1.7.43).
 */
export interface CubeViewIncludeSpec {
  readonly name: string;
  readonly alias?: string;
  readonly title?: string;
  readonly description?: string;
  readonly meta?: CubeDimensionMeta;
}

/**
 * Cube's own syntax for a view's join path: cube names, each a join of the one before, joined by
 * this (`Program.ProgramRosterFacts`).
 */
export const JOIN_PATH_SEPARATOR = ".";

/** One `cubes` entry of a Cube view: a dotted join path from the view's root cube, and the members it includes there. */
export interface CubeViewCubeSpec {
  /** e.g. `Program`, then `Program.ProgramRosterFacts`. Every step is a join of the cube before it. */
  readonly joinPath: string;
  readonly includes: readonly CubeViewIncludeSpec[];
}

/**
 * A Cube view: a served report with `@spine` (the zero-rows / measure-defaults build). Its first
 * `cubes` entry is the spine cube, so every spine row is a row of the view, and its last is the
 * report's facts cube, reached through one_to_many joins.
 */
export interface CubeViewSpec {
  /** The report's name. Views and cubes share Cube's one namespace. */
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly cubes: readonly CubeViewCubeSpec[];
}

export interface CubeModel {
  readonly cubes: readonly CubeSpec[];
  /** One view per served report that declares `@spine`, in model order. */
  readonly views: readonly CubeViewSpec[];
}
