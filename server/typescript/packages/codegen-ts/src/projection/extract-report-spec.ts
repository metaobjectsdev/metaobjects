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
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  IDENTITY_SUBTYPE_REFERENCE,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  RELATIONSHIP_ATTR_OBJECT_REF,
  TYPE_IDENTITY,
  TYPE_MEASURE,
  TYPE_RELATIONSHIP,
  measureDerivedSubType,
  reportShape,
  reportSpine,
  reportSpineHops,
  reportingMemberOwner,
  reportingViaHops,
  resolveObjectRef,
  resolveReportingFieldRef,
  type MetaData,
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
import type { ReportAggregate, ReportColumn, ReportViewSpec } from "./report-spec.js";
import { andOf, declared, resolveReportFilter, segmentClause, temporalOf } from "./report-sql.js";
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
  const agg = measure.agg();
  if (agg === undefined) throw new Error(`${where}: has no @agg.`);
  // The same rule as reportShape: the entity half resolves in the DECLARING entity's package,
  // and the column is read from `from` (a measure aggregates `from`'s own rows).
  const declaring = reportingMemberOwner(measure, from);
  const fields = measure.ofColumns().map((ref) => {
    const f = resolveReportingFieldRef(ref, declaring, root, from);
    if (f === undefined) throw new Error(`${where}: @of '${ref}' does not resolve.`);
    return f;
  });
  const filter = andOf([
    segmentClause(measure.segmentName(), from, baseAlias, ctx, where),
    resolveReportFilter(measure.filter(), from, baseAlias, ctx, `${where} @filter`),
  ]);
  const cast = castFor(agg, fields[0]);
  // Table D: `@default` is read through the measure itself, so a ratio operand that the report
  // does not list still carries its own.
  const value = measure.defaultValue();
  const defaultValue =
    value === undefined ? undefined : { value, real: REAL_SUBTYPES.has(measureDerivedSubType(measure, from, root)) };
  return {
    agg,
    distinct: measure.distinct(),
    refs: fields.map((f) => `${baseAlias}.${sourceColumnNameFor(f, ctx)}`),
    ...(filter !== undefined ? { filter } : {}),
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

/**
 * Why a dimension's `@via` (or a report's `@spine`, `attr`) walk stopped at `hop`: the error
 * names the hop, the entity it was looked up on, and what the model is missing. The loader
 * (rules D2 and R8) accepts a to-one `relationship.*` with no `identity.reference` behind it,
 * so the missing-foreign-key case is reachable from a model that loads clean.
 */
function viaHopError(where: string, attr: string, via: string, hop: string, at: MetaData, root: MetaRoot): Error {
  const head = `${where} ${attr} '${via}' cannot be joined at hop '${hop}' on '${at.resolutionKey()}'`;
  // ADR-0039: resolving children(), so an inherited relationship or reference is found.
  const node = at
    .children()
    .find(
      (c) =>
        c.name === hop &&
        (c.type === TYPE_RELATIONSHIP || (c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_REFERENCE)),
    );
  if (node === undefined) {
    return new Error(`${head}: it names no relationship or identity.reference of that entity.`);
  }
  const targetRef = node.attr(
    node.type === TYPE_IDENTITY ? IDENTITY_REFERENCE_ATTR_REFERENCES : RELATIONSHIP_ATTR_OBJECT_REF,
  );
  const target = typeof targetRef === "string" ? resolveObjectRef(root, targetRef, packageOf(at)).node : undefined;
  if (target === undefined) {
    return new Error(`${head}: its target '${String(targetRef ?? "")}' does not resolve to an object.`);
  }
  return new Error(
    `${head}: the model declares no foreign key for it. A view joins a hop through an identity.reference; ` +
      `declare one on '${at.name}' whose @references is '${target.name}' (with the foreign-key field in @fields).`,
  );
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
    // The loader's rule D2: the owner half resolves in the DECLARING entity's package and must be
    // `from` or an entity it extends; the walk then starts AT `from`.
    const hops = reportingViaHops(via, reportingMemberOwner(dim, from), from, root);
    if (hops === undefined) {
      throw new Error(
        `${where} @via '${via}' must be Owner.hop[.hop...], starting at @from '${from.name}' or an entity it extends.`,
      );
    }
    if (spineHops !== undefined && !spineHops.every((h, i) => hops[i] === h)) {
      throw notThroughSpine(
        where,
        `its @via '${via}' does not begin with the spine's hops, so the view has no join to place it on`,
      );
    }
    // The head is `from`'s SHORT name, resolved in `from`'s own package: a bare name binds the
    // referrer's package first, so it is `from` itself even when another package has an entity
    // of that name. Never its resolution key: walkViaPath splits on every `.`, and a package
    // name may contain one (`com.acme::F`).
    const path = walkViaPath([from.name, ...hops].join("."), root, packageOf(from), ctx);
    // walkViaPath stops at the first hop it cannot resolve; a partial path would pin the
    // dimension to the wrong alias, so the whole chain must be walked.
    if (path.length !== hops.length) {
      const last = path[path.length - 1];
      const at = last === undefined ? from : root.objects().find((o) => o.resolutionKey() === last.targetEntity);
      throw viaHopError(where, "@via", via, hops[path.length]!, at ?? from, root);
    }
    pathOf.set(f, path);
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
      const of =
        f.typeSource ??
        (dim === undefined
          ? undefined
          : resolveReportingFieldRef(
              dim.of() ?? "",
              reportingMemberOwner(dim, from),
              root,
              dim.via() === undefined ? from : undefined,
            ));
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
