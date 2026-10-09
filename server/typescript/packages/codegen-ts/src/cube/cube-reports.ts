// FR-044 Plan 4, Table F — what a served `object.report` contributes to its `@from` cube: a
// `rollup` pre-aggregation named after the report, over the dimensions, measures and segments it
// lists, and, for its `@filter`, a scope segment `<report>Scope`. Which reports are served, and
// which cube receives them, is build-cube-model.ts's concern.
//
// The report's parts resolve as the view lowering resolves them (`reportShape`, `segmentClause`,
// `resolveReportFilter`, `resolveAggregate`), so the rows a rollup groups are the rows the view
// groups. A relative date is found on those LOWERED clauses (a `RelativeNow` operand), never by
// reading the authored JSON.

import {
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  type MetaMeasure,
  type ReportShape,
} from "@metaobjectsdev/metadata";
import { ratioOperand, resolveAggregate } from "../projection/report-resolve.js";
import { isRelativeNow } from "../projection/report-spec.js";
import { cond, resolveReportFilter, segmentClause } from "../projection/report-sql.js";
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

  const segmentAttr = report.attr(OBJECT_REPORT_ATTR_SEGMENT);
  const segmentName = typeof segmentAttr === "string" ? segmentAttr : undefined;
  const segment = segmentClause(segmentName, from, CUBE_SELF, ctx, where);
  const filterWhere = `${where} @filter`;
  const filter = resolveReportFilter(report.attr(OBJECT_REPORT_ATTR_FILTER), from, CUBE_SELF, ctx, filterWhere);
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
