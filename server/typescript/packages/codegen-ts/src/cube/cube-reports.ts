// FR-044 Plan 4, Table F — what a served `object.report` contributes to its `@from` cube: a
// `rollup` pre-aggregation named after the report, over the dimensions, measures and segments it
// lists, and, for its `@filter`, a scope segment `<report>Scope`. Which reports are served, and
// which cube receives them, is build-cube-model.ts's concern.
//
// The report's parts resolve as the view lowering resolves them (`reportShape`, `reportScope`,
// `resolveAggregate`), so the rows a rollup groups are the rows the view
// groups. A relative date is found on those LOWERED clauses (a `RelativeNow` operand), never by
// reading the authored JSON.

import {
  TIME_GRAINS,
  type MetaMeasure,
  type ReportShape,
  type TimeGrain,
} from "@metaobjectsdev/metadata";
import { ratioOperand, resolveAggregate } from "../projection/report-resolve.js";
import { isRelativeNow } from "../projection/report-spec.js";
import { cond, reportScope } from "../projection/report-sql.js";
import type { ViewFilterClause } from "../projection/view-spec.js";
import type { MemberContext } from "./cube-members.js";
import type { CubeRollupSpec, CubeRollupTimeDimension, CubeSegmentSpec } from "./cube-model-spec.js";
import { CUBE_SELF, cubeSqlRenderer } from "./cube-sql.js";

export interface ReportContribution {
  /** The `<report>Scope` segment, when the report declares a `@filter`. */
  readonly scope?: CubeSegmentSpec;
  /**
   * The rollup. Absent when the report's `@filter`, its `@segment`, or the condition of any
   * measure it lists holds a relative date: a rollup is built at refresh time, so it would
   * answer with the "now" of its build, where the view answers with the query's.
   */
  readonly rollup?: CubeRollupSpec;
}

/** How many grouping columns a rollup has: its attribute dimensions plus its time dimensions. */
export function rollupDimensionCount(rollup: CubeRollupSpec): number {
  const times = rollup.timeDimensions !== undefined ? rollup.timeDimensions.length : rollup.timeDimension !== undefined ? 1 : 0;
  return rollup.dimensions.length + times;
}

/** A rollup's time grains in listed order: the `time_dimensions` entries, or its one granularity. */
function rollupGrains(rollup: CubeRollupSpec): readonly TimeGrain[] {
  if (rollup.timeDimensions !== undefined) return rollup.timeDimensions.map((t) => t.granularity);
  return rollup.granularity !== undefined ? [rollup.granularity] : [];
}

/**
 * Coarser grain first, compared position by position in listed order. TIME_GRAINS runs from the
 * finest (hour) to the coarsest (year), so a higher index sorts earlier. Where only one of the
 * two has a time dimension at a position, the one without sorts first.
 */
function compareGrains(a: readonly TimeGrain[], b: readonly TimeGrain[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ga = a[i];
    const gb = b[i];
    if (ga === gb) continue;
    if (ga === undefined) return -1;
    if (gb === undefined) return 1;
    return TIME_GRAINS.indexOf(gb) - TIME_GRAINS.indexOf(ga);
  }
  return 0;
}

/**
 * A cube's rollups as they are written: coarsest first. Cube answers a query from the FIRST
 * rollup in definition order that can serve it, and a finer rollup can serve a coarser query
 * whose measures are additive. Executed on 1.7.43: in report order, FitnessTotals' query (no
 * dimensions) was answered from ProgramMinutes' rollup (grouped by two). Rows are correct either
 * way. The order exists so that each report's query reaches a rollup that matches it exactly
 * before any strictly finer one. The keys, in turn:
 *
 *   1. {@link rollupDimensionCount} ascending: fewer grouping columns first;
 *   2. the coarser time grain first, the time dimensions compared in listed order (a month
 *      rollup can serve nothing a day rollup's query asks, but a day rollup can serve a month
 *      query);
 *   3. fewer measures first (a rollup holding a superset of measures can serve the other's query);
 *   4. report declaration order (the sort is stable).
 */
export function coarsestFirst(rollups: readonly CubeRollupSpec[]): CubeRollupSpec[] {
  return [...rollups].sort(
    (a, b) =>
      rollupDimensionCount(a) - rollupDimensionCount(b) ||
      compareGrains(rollupGrains(a), rollupGrains(b)) ||
      a.measures.length - b.measures.length,
  );
}

/** `RecentPrograms` → `recentProgramsScope`: the segment a report's `@filter` becomes (Table G). */
export function scopeSegmentName(reportName: string): string {
  return `${reportName.charAt(0).toLowerCase()}${reportName.slice(1)}Scope`;
}

/** True when a lowered clause compares against a relative date anywhere inside it. */
export function hasRelativeDate(clause: ViewFilterClause | undefined): boolean {
  if (clause === undefined) return false;
  switch (clause.kind) {
    case "and":
    case "or":
      return clause.clauses.some(hasRelativeDate);
    case "cmp":
    case "exprCmp":
      return isRelativeNow(clause.value) || (Array.isArray(clause.value) && clause.value.some(isRelativeNow));
  }
}

/**
 * What a served report adds to `cube`, the cube of its `@from` entity. `shape` is the report's
 * `reportShape`. Member names in the rollup are the cube's: a dimension or measure is the
 * declared member the report item names (`Week.weeks` is `weeks`, `createdAt:month` is
 * `createdAt` at `month`), and a `@via` dimension is a member of this cube like any other.
 */
export function reportContribution(shape: ReportShape, cube: string, mc: MemberContext): ReportContribution {
  const { report, from } = shape;
  const where = `cube '${cube}': report '${report.resolutionKey()}'`;
  const ctx = mc.extract;

  // The report view's own scope: its @segment's filter and its @filter, resolved as the view does.
  const { segmentName, segment, filter } = reportScope(report, from, CUBE_SELF, ctx, where);
  const filterWhere = `${where} @filter`;
  const scope: CubeSegmentSpec | undefined =
    filter === undefined
      ? undefined
      : { name: scopeSegmentName(report.name), sql: cond(filter, mc.dialect, cubeSqlRenderer(filterWhere)) };

  const dimensions: string[] = [];
  const times: CubeRollupTimeDimension[] = [];
  const measures: string[] = [];
  const conditions: (ViewFilterClause | undefined)[] = [segment, filter];
  for (const f of shape.fields) {
    // reportShape sets `dimension` on a dimension field and `measure` on a measure field.
    if (f.role === "dimension") {
      const dim = f.dimension;
      if (dim === undefined) throw new Error(`${where}: report field '${f.name}' names no dimension.`);
      if (f.grain === undefined) dimensions.push(dim.name);
      else times.push({ dimension: dim.name, granularity: f.grain });
      continue;
    }
    const m = f.measure;
    if (m === undefined) throw new Error(`${where}: report field '${f.name}' names no measure.`);
    measures.push(m.name);
    // A ratio's condition is its operands' conditions: each is the full aggregate it divides.
    const aggregates: MetaMeasure[] = m.isRatio()
      ? [ratioOperand(from, m, m.numerator(), where), ratioOperand(from, m, m.denominator(), where)]
      : [m];
    for (const a of aggregates) {
      conditions.push(resolveAggregate(a, from, mc.root, CUBE_SELF, ctx, `${where} measure '${a.name}'`).condition);
    }
  }
  if (conditions.some(hasRelativeDate)) return scope === undefined ? {} : { scope };

  const segments = [...(segmentName === undefined ? [] : [segmentName]), ...(scope === undefined ? [] : [scope.name])];
  const base = { name: report.name, type: "rollup" as const, measures, dimensions, segments };
  // One time dimension takes Cube's documented form; two or more, the list form (Table F).
  const rollup: CubeRollupSpec =
    times.length === 0
      ? base
      : times.length === 1
        ? { ...base, timeDimension: times[0]!.dimension, granularity: times[0]!.granularity }
        : { ...base, timeDimensions: times };
  return { ...(scope === undefined ? {} : { scope }), rollup };
}
