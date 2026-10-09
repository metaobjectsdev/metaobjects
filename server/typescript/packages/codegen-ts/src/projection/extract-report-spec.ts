// FR-044 Plan 2 — lower an `object.report` plus its shape to a dialect-neutral
// ReportViewSpec (contract Table F). Dimension joins reuse the projection walk
// (`walkViaPath` / `pathsToJoins`), so hop resolution, ambiguity errors and the #209
// join type are one implementation. The renderer (report-ddl-emit) turns the spec to SQL.

import {
  AGG_SUM,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  measureDerivedSubType,
  reportShape,
  reportSpine,
  reportSpineHops,
  type MetaField,
  type MetaMeasure,
  type MetaObject,
  type MetaRoot,
  type ReportField,
} from "@metaobjectsdev/metadata";
import { columnNameFromField } from "../naming.js";
import { hasWritableRdbSource } from "../source-detect.js";
import { isTphSubtype, tphDiscriminatorBase, tphDiscriminatorPin } from "../templates/zod-validators.js";
import {
  packageOf,
  pathsToJoins,
  projectionViewName,
  shortAliasFor,
  sourceColumnNameFor,
  walkViaPath,
  type ExtractContext,
  type Path,
} from "./extract-view-spec.js";
import {
  dimensionOfField,
  ratioOperand,
  resolveAggregate,
  resolveDimensionViaPath,
  viaHopError,
} from "./report-resolve.js";
import type { ReportAggregate, ReportColumn, ReportViewSpec } from "./report-spec.js";
import { andOf, resolveReportFilter, segmentClause, temporalOf } from "./report-sql.js";
import type { JoinNode } from "./view-spec.js";

// `temporalOf` lives with the other report SQL helpers; this module keeps exporting it.
export { temporalOf };

const INTEGRAL_SUM: ReadonlySet<string> = new Set([FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY]);
const FLOATING_SUM: ReadonlySet<string> = new Set([FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT]);
/** Table D: a measure whose derived subtype is one of these reads a REAL `@default` on SQLite. */
const REAL_SUBTYPES: ReadonlySet<string> = new Set([FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT]);

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
  const { agg, distinct, fields, condition } = resolveAggregate(measure, from, root, baseAlias, ctx, where);
  const cast = castFor(agg, fields[0]);
  // Table D: `@default` is read through the measure itself, so a ratio operand that the report
  // does not list still carries its own.
  const value = measure.defaultValue();
  const defaultValue =
    value === undefined ? undefined : { value, real: REAL_SUBTYPES.has(measureDerivedSubType(measure, from, root)) };
  return {
    agg,
    distinct,
    refs: fields.map((f) => `${baseAlias}.${sourceColumnNameFor(f, ctx)}`),
    ...(condition !== undefined ? { filter: condition } : {}),
    ...(cast !== undefined ? { cast } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
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

/** The object a join step lands on, by the resolution key the walk recorded. */
function stepTarget(step: Path[number], root: MetaRoot): MetaObject | undefined {
  return root.objects().find((o) => o.resolutionKey() === step.targetEntity);
}

/**
 * Table D: a report's `@spine`, walked from `@from` as a dimension's `@via` is, and required
 * whole. Every entity on the chain contributes rows through its own table, so one with no table
 * (abstract, or no writable source.rdb) or a TPH subtype (it shares its base's table with every
 * other subtype) is refused, naming the report, the spine and the entity.
 */
function spinePathOf(
  report: MetaObject,
  hops: readonly string[],
  from: MetaObject,
  root: MetaRoot,
  ctx: ExtractContext,
): Path {
  const spine = reportSpine(report) ?? "";
  const where = `report '${report.name}':`;
  const path = walkViaPath([from.name, ...hops].join("."), root, packageOf(from), ctx);
  if (path.length !== hops.length) {
    const last = path[path.length - 1];
    const at = last === undefined ? from : stepTarget(last, root);
    throw viaHopError(where, "@spine", spine, hops[path.length]!, at ?? from, root);
  }
  for (const step of path) {
    const entity = stepTarget(step, root);
    if (entity === undefined) {
      // The walk resolved this hop, so it should be in the root. Skipping it would skip the no-table
      // and TPH refusals below for that entity, so fail closed instead.
      throw new Error(
        `${where} @spine '${spine}' reaches '${step.targetEntity}', which is not an entity in the model, so ` +
          `its table cannot be checked. Fix the @spine path or declare the entity.`,
      );
    }
    const head = `${where} @spine '${spine}' reaches '${entity.name}'`;
    if (entity.isAbstract || !hasWritableRdbSource(entity)) {
      throw new Error(
        `${head}, which has no table (it is abstract or declares no writable source.rdb), so its rows cannot ` +
          `be the report's rows. Give '${entity.name}' a source, or end @spine at an entity that has one.`,
      );
    }
    if (isTphSubtype(entity)) {
      throw new Error(
        `${head}, a TPH subtype: it shares the table of '${tphDiscriminatorBase(entity)?.name ?? ""}' with every ` +
          `other subtype, so the report would have a row for each row of all of them. End @spine at an entity ` +
          `with a table of its own.`,
      );
    }
  }
  return path;
}

/** Table D: under `@spine` every join is LEFT OUTER (the #209 INNER rule is not applied), so no
 *  join can drop a spine row. */
function allLeft(nodes: readonly JoinNode[]): JoinNode[] {
  return nodes.map((n) => ({ ...n, joinType: "left", children: allLeft(n.children) }));
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
  // A TPH subtype has no table of its own: its rows sit in the discriminator base's table beside
  // every other subtype's. A derived view has no discriminator predicate, so it would aggregate
  // all of them and report wrong numbers with nothing failing. Refuse, and say how to scope it.
  if (isTphSubtype(from)) {
    const base = tphDiscriminatorBase(from);
    const pin = tphDiscriminatorPin(from);
    throw new Error(
      `report '${report.name}': @from '${from.name}' is a TPH subtype: it shares the table of ` +
        `'${base?.name ?? ""}' with every other subtype, so a view derived from it would aggregate all of ` +
        `their rows. Declare the report @from '${base?.name ?? ""}' with an @filter on the discriminator ` +
        `field '${pin?.fieldName ?? ""}' (for example { ${JSON.stringify(pin?.fieldName ?? "")}: ` +
        `${JSON.stringify(pin?.value ?? "")} }).`,
    );
  }
  const used = new Set<string>();
  const baseAlias = shortAliasFor(from.name, used);

  // Table D: the @spine's own path. Walked before any dimension, so a broken spine is reported
  // as the spine's error rather than as the first dimension that crosses it.
  const spineHops = reportSpineHops(report, from, root);
  const spinePath = spineHops === undefined ? undefined : spinePathOf(report, spineHops, from, root, ctx);
  // Rule R9, which the loader enforces: under @spine every listed dimension is reached through it.
  // A tree built past the loader is refused here rather than given a join the view cannot place.
  const notThroughSpine = (where: string, why: string): Error =>
    new Error(`${where} is not reached through @spine '${reportSpine(report) ?? ""}': ${why}.`);

  // One path per LISTED dimension that has @via (Table F); an unlisted dimension adds no join.
  const pathOf = new Map<ReportField, Path>();
  for (const f of shape.fields) {
    const dim = f.dimension;
    const via = dim?.via();
    const where = `report '${report.name}': dimension '${f.name}'`;
    if (dim !== undefined && via === undefined && spineHops !== undefined) {
      throw notThroughSpine(where, `it has no @via, so it reads @from '${from.name}', which a spine row with no facts lacks`);
    }
    if (dim === undefined || via === undefined) continue;
    const throughSpine = (hops: readonly string[]): void => {
      if (spineHops !== undefined && !spineHops.every((h, i) => hops[i] === h)) {
        throw notThroughSpine(
          where,
          `its @via '${via}' does not begin with the spine's hops, so the view has no join to place it on`,
        );
      }
    };
    pathOf.set(f, resolveDimensionViaPath(dim, from, root, ctx, where, throughSpine));
  }
  // Under @spine its path goes in FIRST, so it is the first (and, by R9, the only) child at every
  // level of the trie down to the spine entity. Every dimension path begins with it, so inserting
  // it first creates no node and assigns no alias that the first dimension path would not have:
  // the aliases are exactly those of the same report without @spine, and no measure reference
  // moves. The emitter still checks the chain is single (spineFrom) rather than trust the order.
  const dimensionPaths = [...pathOf.values()];
  const tree = pathsToJoins(spinePath === undefined ? dimensionPaths : [spinePath, ...dimensionPaths], used);
  const joins = spinePath === undefined ? tree : allLeft(tree);

  const columns = shape.fields.map((f): ReportColumn => {
    const dbColAlias = columnNameFromField(f.name, ctx.columnNamingStrategy);
    if (f.role === "dimension") {
      const dim = f.dimension;
      // A time dimension below the hour grain carries no typeSource; resolve by reportShape's rule.
      const of = f.typeSource ?? (dim === undefined ? undefined : dimensionOfField(dim, from, root));
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
      const operand = (name: string | undefined): ReportAggregate =>
        aggregateOf(ratioOperand(from, measure, name, `report '${report.name}'`), report, from, baseAlias, root, ctx);
      const defaultValue = measure.defaultValue();
      return {
        kind: "ratio",
        fieldName: f.name,
        dbColAlias,
        numerator: operand(measure.numerator()),
        denominator: operand(measure.denominator()),
        ...(defaultValue !== undefined ? { defaultValue } : {}),
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
    ...(spinePath !== undefined ? { spineDepth: spinePath.length } : {}),
  };
}
