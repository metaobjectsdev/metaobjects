// FR-044 Plan 2 — lower an `object.report` plus its shape to a dialect-neutral
// ReportViewSpec (contract Table F). Dimension joins reuse the projection walk
// (`walkViaPath` / `pathsToJoins`), so hop resolution, ambiguity errors and the #209
// join type are one implementation. The renderer (report-ddl-emit) turns the spec to SQL.

import {
  AGG_SUM,
  FIELD_ATTR_LOCAL_TIME,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_TIMESTAMP,
  FILTER_COMPOSE_AND,
  FILTER_COMPOSE_OR,
  FILTER_RELATIVE_NOW,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  TYPE_MEASURE,
  TYPE_SEGMENT,
  reportShape,
  resolveReportingFieldRef,
  type MetaField,
  type MetaMeasure,
  type MetaObject,
  type MetaRoot,
  type MetaSegment,
  type ReportField,
} from "@metaobjectsdev/metadata";
import { intValueMapOf } from "../enum-meta.js";
import { columnNameFromField } from "../naming.js";
import { hasWritableRdbSource } from "../source-detect.js";
import {
  desugarClause,
  encodeIntEnumFilterValue,
  packageOf,
  pathsToJoins,
  projectionViewName,
  shortAliasFor,
  sourceColumnNameFor,
  walkViaPath,
  type ExtractContext,
  type Path,
} from "./extract-view-spec.js";
import type { ReportAggregate, ReportColumn, ReportViewSpec } from "./report-spec.js";
import type { ReportTemporal } from "./time-sql.js";
import type { JoinNode, ViewFilterClause } from "./view-spec.js";

/** Table D's column kind for a `field.date` / `field.timestamp`. */
export function temporalOf(field: MetaField): ReportTemporal {
  if (field.subType === FIELD_SUBTYPE_DATE) return "date";
  return field.attr(FIELD_ATTR_LOCAL_TIME) === true ? "naive" : "instant";
}

const INTEGRAL_SUM: ReadonlySet<string> = new Set([FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY]);
const FLOATING_SUM: ReadonlySet<string> = new Set([FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRelativeValue(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && FILTER_RELATIVE_NOW in v;
}

/** AND of the present clauses, a lone clause as itself, none as undefined. */
function andOf(clauses: readonly (ViewFilterClause | undefined)[]): ViewFilterClause | undefined {
  const present = clauses.filter((c): c is ViewFilterClause => c !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0]! : { kind: "and", clauses: present };
}

/**
 * A reporting filter (`{ field: value | { op: value }, and?, or? }`) over the `@from`
 * entity's own fields on the base alias. Differs from `resolveAggregateFilter` in that every
 * operator on a field survives (a range keeps both ends) and a relative-date operand
 * (`{ now: "-P90D" }`, legal only on reporting hosts, rule F1) lowers to a `RelativeNow`.
 * Projection and `origin.aggregate` filters keep refusing relative dates.
 */
function resolveReportFilter(
  filter: unknown,
  entity: MetaObject,
  alias: string,
  ctx: ExtractContext,
  where: string,
): ViewFilterClause | undefined {
  if (!isPlainObject(filter)) return undefined;
  const clauses: ViewFilterClause[] = [];
  for (const [key, val] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_AND || key === FILTER_COMPOSE_OR) {
      const subs = (Array.isArray(val) ? val : [])
        .map((s) => resolveReportFilter(s, entity, alias, ctx, where))
        .filter((c): c is ViewFilterClause => c !== undefined);
      if (subs.length > 0) clauses.push({ kind: key === FILTER_COMPOSE_AND ? "and" : "or", clauses: subs });
      continue;
    }
    // ADR-0039: resolving fields(), so a field inherited through extends is found.
    const field = entity.fields().find((f) => f.name === key);
    if (field === undefined) {
      throw new Error(`${where}: filter field "${key}" is not a field of '${entity.name}'.`);
    }
    const ref = `${alias}.${sourceColumnNameFor(field, ctx)}`;
    for (const [op, raw] of Object.entries(desugarClause(val))) {
      clauses.push({ kind: "cmp", ref, op, value: lowerFilterValue(raw, op, field, key, where) });
    }
  }
  return andOf(clauses);
}

function lowerFilterValue(raw: unknown, op: string, field: MetaField, key: string, where: string): unknown {
  const relative = (v: Record<string, unknown>) => {
    if (field.subType !== FIELD_SUBTYPE_DATE && field.subType !== FIELD_SUBTYPE_TIMESTAMP) {
      throw new Error(`${where}: a relative-date value on "${key}" needs a field.date or field.timestamp.`);
    }
    return {
      kind: "relativeNow" as const,
      duration: String(v[FILTER_RELATIVE_NOW]),
      temporal: temporalOf(field),
    };
  };
  if (isRelativeValue(raw)) return relative(raw);
  if (Array.isArray(raw) && raw.some(isRelativeValue)) {
    return raw.map((v) => (isRelativeValue(v) ? relative(v) : v));
  }
  return encodeIntEnumFilterValue(
    raw,
    op,
    field.subType === FIELD_SUBTYPE_ENUM ? intValueMapOf(field) : undefined,
    key,
    where,
  );
}

/** A named member (segment or measure) declared on the `@from` entity. */
function declared(from: MetaObject, type: string, name: string): MetaSegment | MetaMeasure | undefined {
  // ADR-0039: resolving children(), so a member declared on an abstract base is found. The
  // type string identifies the node (no `instanceof` across packages); the cast is type-only.
  return from.children().find((c) => c.type === type && c.name === name) as MetaSegment | MetaMeasure | undefined;
}

/** The filter of a named segment on `from`, resolved over `from`'s fields. */
function segmentClause(
  segmentName: string | undefined,
  from: MetaObject,
  alias: string,
  ctx: ExtractContext,
  where: string,
): ViewFilterClause | undefined {
  if (segmentName === undefined) return undefined;
  const segment = declared(from, TYPE_SEGMENT, segmentName) as MetaSegment | undefined;
  if (segment === undefined) throw new Error(`${where}: segment '${segmentName}' is not declared on '${from.name}'.`);
  return resolveReportFilter(segment.filter(), from, alias, ctx, `${where} segment '${segmentName}'`);
}

function castFor(agg: string, of: MetaField | undefined): ReportAggregate["cast"] {
  if (agg !== AGG_SUM || of === undefined) return undefined;
  if (INTEGRAL_SUM.has(of.subType)) return "bigint";
  if (FLOATING_SUM.has(of.subType)) return "double";
  return undefined;
}

/** One aggregate (Table C) for a `measure.aggregate` on `from`. */
function aggregateOf(
  measure: MetaMeasure,
  report: MetaObject,
  from: MetaObject,
  baseAlias: string,
  root: MetaRoot,
  ctx: ExtractContext,
): ReportAggregate {
  const where = `report '${report.name}' measure '${measure.name}'`;
  const agg = measure.agg();
  if (agg === undefined) throw new Error(`${where}: has no @agg.`);
  const fields = measure.ofColumns().map((ref) => {
    const f = resolveReportingFieldRef(ref, from, root);
    if (f === undefined) throw new Error(`${where}: @of '${ref}' does not resolve.`);
    return f;
  });
  const filter = andOf([
    segmentClause(measure.segmentName(), from, baseAlias, ctx, where),
    resolveReportFilter(measure.filter(), from, baseAlias, ctx, `${where} @filter`),
  ]);
  const cast = castFor(agg, fields[0]);
  return {
    agg,
    distinct: measure.distinct(),
    refs: fields.map((f) => `${baseAlias}.${sourceColumnNameFor(f, ctx)}`),
    ...(filter !== undefined ? { filter } : {}),
    ...(cast !== undefined ? { cast } : {}),
  };
}

/** The join alias a dimension's path ends on: walk the deduplicated tree by relationship name. */
function aliasAtEndOf(path: Path, joins: readonly JoinNode[]): string {
  let level = joins;
  let alias = "";
  for (const step of path) {
    const node = level.find((j) => j.relationship === step.relationship);
    if (node === undefined) throw new Error(`report join tree lost the hop '${step.relationship}'.`);
    alias = node.alias;
    level = node.children;
  }
  return alias;
}

export function extractReportSpec(report: MetaObject, root: MetaRoot, ctx: ExtractContext): ReportViewSpec {
  const shape = reportShape(report, root);
  const from = shape.from;
  // A view over a table that does not exist: refuse, naming both, rather than emit SQL that fails at apply.
  if (from.isAbstract || !hasWritableRdbSource(from)) {
    throw new Error(
      `report '${report.name}': @from '${from.name}' has no table (it is abstract or declares no writable ` +
        `source.rdb), so no view can be derived. Give '${from.name}' a source, or remove the report's source.`,
    );
  }
  const used = new Set<string>();
  const baseAlias = shortAliasFor(from.name, used);
  const pkg = packageOf(from);

  // One path per LISTED dimension that has @via (Table F); an unlisted dimension adds no join.
  const pathOf = new Map<ReportField, Path>();
  for (const f of shape.fields) {
    const via = f.dimension?.via();
    if (via === undefined) continue;
    const path = walkViaPath(via, root, pkg, ctx);
    // walkViaPath stops at the first hop it cannot resolve; a partial path would pin the
    // dimension to the wrong alias, so the whole chain must be walked.
    const hops = via.split(".").length - 1;
    if (path.length !== hops || hops === 0) {
      throw new Error(`report '${report.name}': dimension '${f.name}' @via '${via}' does not resolve to a join path.`);
    }
    pathOf.set(f, path);
  }
  const joins = pathsToJoins([...pathOf.values()], used);

  const columns = shape.fields.map((f): ReportColumn => {
    const dbColAlias = columnNameFromField(f.name, ctx.columnNamingStrategy);
    if (f.role === "dimension") {
      const of = f.typeSource ?? resolveReportingFieldRef(f.dimension?.of() ?? "", from, root);
      if (of === undefined) throw new Error(`report '${report.name}': dimension '${f.name}' @of does not resolve.`);
      const path = pathOf.get(f);
      const alias = path === undefined ? baseAlias : aliasAtEndOf(path, joins);
      const ref = `${alias}.${sourceColumnNameFor(of, ctx)}`;
      if (f.grain !== undefined) {
        return { kind: "timeDimension", fieldName: f.name, dbColAlias, ref, grain: f.grain, temporal: temporalOf(of) };
      }
      return { kind: "dimension", fieldName: f.name, dbColAlias, ref };
    }
    const measure = f.measure!;
    if (measure.isRatio()) {
      const operand = (name: string | undefined): ReportAggregate => {
        const m = name === undefined ? undefined : (declared(from, TYPE_MEASURE, name) as MetaMeasure | undefined);
        if (m === undefined || m.isRatio()) {
          throw new Error(
            `report '${report.name}': ratio '${measure.name}' operand '${name ?? ""}' is not a measure.aggregate on '${from.name}'.`,
          );
        }
        return aggregateOf(m, report, from, baseAlias, root, ctx);
      };
      return {
        kind: "ratio",
        fieldName: f.name,
        dbColAlias,
        numerator: operand(measure.numerator()),
        denominator: operand(measure.denominator()),
      };
    }
    return { kind: "aggregate", fieldName: f.name, dbColAlias, aggregate: aggregateOf(measure, report, from, baseAlias, root, ctx) };
  });

  const reportWhere = `report '${report.name}'`;
  const segment = report.attr(OBJECT_REPORT_ATTR_SEGMENT);
  const where = andOf([
    segmentClause(typeof segment === "string" ? segment : undefined, from, baseAlias, ctx, reportWhere),
    resolveReportFilter(report.attr(OBJECT_REPORT_ATTR_FILTER), from, baseAlias, ctx, `${reportWhere} @filter`),
  ]);
  return {
    viewName: projectionViewName(report, ctx.columnNamingStrategy),
    joinTree: { baseEntity: from.resolutionKey(), baseAlias, joins },
    columns,
    ...(where !== undefined ? { where } : {}),
  };
}
