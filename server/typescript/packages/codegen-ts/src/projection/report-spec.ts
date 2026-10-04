// FR-044 Plan 2 (contract Table F) — the dialect-neutral shape of a report's view.
// `extractReportSpec` produces it; the report DDL emitter renders it per dialect. Column
// references are already resolved to unquoted `alias.column`, as in `ViewSpec`.

import type { MeasureAgg, TimeGrain } from "@metaobjectsdev/metadata";
import type { JoinTree, ViewFilterClause } from "./view-spec.js";
import type { ReportTemporal } from "./time-sql.js";

/** A relative-date operand, carried as the `value` of a ViewFilterClause `cmp`. */
export interface RelativeNow {
  readonly kind: "relativeNow";
  /** The signed ISO-8601 duration as authored, e.g. "-P90D". */
  readonly duration: string;
  readonly temporal: ReportTemporal;
}

export function isRelativeNow(v: unknown): v is RelativeNow {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "relativeNow";
}

/** One aggregate (Table C). `refs` are unquoted `alias.column`. */
export interface ReportAggregate {
  readonly agg: MeasureAgg;
  readonly distinct: boolean;
  readonly refs: readonly string[];
  /** The measure's condition: its `@segment` filter AND its `@filter`. */
  readonly filter?: ViewFilterClause;
  /** The Table C cast: integral sum → "bigint", floating sum → "double". */
  readonly cast?: "bigint" | "double";
}

export type ReportColumn =
  | { readonly kind: "dimension"; readonly fieldName: string; readonly dbColAlias: string; readonly ref: string }
  | {
      readonly kind: "timeDimension";
      readonly fieldName: string;
      readonly dbColAlias: string;
      readonly ref: string;
      readonly grain: TimeGrain;
      readonly temporal: ReportTemporal;
    }
  | {
      readonly kind: "aggregate";
      readonly fieldName: string;
      readonly dbColAlias: string;
      readonly aggregate: ReportAggregate;
    }
  | {
      readonly kind: "ratio";
      readonly fieldName: string;
      readonly dbColAlias: string;
      readonly numerator: ReportAggregate;
      readonly denominator: ReportAggregate;
    };

export interface ReportViewSpec {
  readonly viewName: string;
  readonly joinTree: JoinTree;
  /** One column per `@dimensions` item then one per `@measures` item, in listed order. */
  readonly columns: readonly ReportColumn[];
  /** The report's `@segment` filter, then its `@filter`, ANDed. Absent when neither is declared. */
  readonly where?: ViewFilterClause;
}
