// FR-044 Plan 4, Tables C and D — one dimension's type and SQL, one measure, one segment, on
// the cube of the entity they are read over. `@of`, `@segment` and `@filter` resolve exactly as
// the report view lowering resolves them (extract-report-spec.ts), and conditions render
// through its own `cond`, with the Cube renderer (cube-sql.ts). Which members a cube has, and
// in what order, is build-cube-model.ts's concern.

import {
  AGG_COUNT,
  CHILD_REF_SEPARATOR,
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_TITLE,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_UUID,
  TYPE_MEASURE,
  reportingMemberOwner,
  resolveReportingFieldRef,
  type MetaData,
  type MetaDimension,
  type MetaField,
  type MetaMeasure,
  type MetaObject,
  type MetaRoot,
  type MetaSegment,
} from "@metaobjectsdev/metadata";
import { intValueMapOf } from "../enum-meta.js";
import { sourceColumnNameFor, type ExtractContext } from "../projection/extract-view-spec.js";
import { andOf, cond, declared, resolveReportFilter, segmentClause, type SqlRenderer } from "../projection/report-sql.js";
import { CubeModelError, ERR_CUBE_UNMAPPABLE_DIMENSION } from "./cube-errors.js";
import type {
  CubeDialect,
  CubeDimensionSpec,
  CubeDimensionType,
  CubeMeasureSpec,
  CubeMeasureType,
  CubeSegmentSpec,
} from "./cube-model-spec.js";
import { CUBE_SELF, cubeColumn, cubeSqlRenderer, memberRef } from "./cube-sql.js";

/** What every member mapping reads: the model, the dialect, the column naming strategy. */
export interface MemberContext {
  readonly root: MetaRoot;
  readonly dialect: CubeDialect;
  readonly extract: ExtractContext;
}

const NUMBER_SUBTYPES: ReadonlySet<string> = new Set([
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_CURRENCY,
]);
const STRING_SUBTYPES: ReadonlySet<string> = new Set([
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_UUID, FIELD_SUBTYPE_TIME,
]);

/** `<owner resolution key>.<name>`: a member's address, as `@of` and `@via` spell it. */
export function memberKey(node: MetaData): string {
  const owner = node.parent;
  return owner === undefined ? node.resolutionKey() : `${owner.resolutionKey()}${CHILD_REF_SEPARATOR}${node.name}`;
}

/** The common attributes `title` and `description`, when declared. `notes` is internal-only. */
export function docOf(node: MetaData): { title?: string; description?: string } {
  // ADR-0039: resolving attr(), as every doc-gen tier reads them.
  const title = node.attr(DOC_ATTR_TITLE);
  const description = node.attr(DOC_ATTR_DESCRIPTION);
  return {
    ...(typeof title === "string" && title !== "" ? { title } : {}),
    ...(typeof description === "string" && description !== "" ? { description } : {}),
  };
}

/** A `dimension.time`'s `@grains` as `meta.grains` (Table B); Cube does not enforce them. */
export function grainsOf(dim: MetaDimension): Pick<CubeDimensionSpec, "meta"> {
  const grains = dim.isTime() ? dim.grains() : [];
  return grains.length === 0 ? {} : { meta: { grains } };
}

/** Table C: a field as a dimension's type and SQL on the cube that owns its column. */
export function dimensionColumn(
  field: MetaField,
  where: string,
  renderer: SqlRenderer,
  mc: MemberContext,
): { sql: string; type: CubeDimensionType } {
  const read = `field '${memberKey(field)}'`;
  const unmappable = (detail: string): CubeModelError =>
    new CubeModelError(
      ERR_CUBE_UNMAPPABLE_DIMENSION,
      `${where} reads ${read} (${detail}), which no Cube dimension can hold: Cube has no array or JSON ` +
        `dimension type. Group by a scalar field instead, or remove the dimension.`,
    );
  // ADR-0039: resolving isArray and @objectRef, so an inherited one is seen.
  if (field.resolvedIsArray()) throw unmappable(`field.${field.subType}, isArray`);
  const objectRef = field.objectRef;
  if (objectRef !== undefined) throw unmappable(`field.${field.subType} @objectRef '${objectRef}'`);
  if (field.subType === FIELD_SUBTYPE_OBJECT || field.subType === FIELD_SUBTYPE_MAP) {
    throw unmappable(`field.${field.subType}`);
  }
  const d = mc.dialect;
  const col = cubeColumn(sourceColumnNameFor(field, mc.extract), d, renderer);
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const intMap = intValueMapOf(field);
    if (intMap !== undefined) {
      // An int-backed enum stores the integer; the wire carries the member symbol, as every
      // port's read does.
      const arms = Object.entries(intMap).map(([symbol, n]) => `WHEN ${String(n)} THEN ${renderer.literal(symbol, d)}`);
      return { sql: `CASE ${col} ${arms.join(" ")} END`, type: "string" };
    }
  }
  if (STRING_SUBTYPES.has(field.subType)) return { sql: col, type: "string" };
  if (NUMBER_SUBTYPES.has(field.subType)) return { sql: col, type: "number" };
  if (field.subType === FIELD_SUBTYPE_BOOLEAN) return { sql: col, type: "boolean" };
  if (field.subType === FIELD_SUBTYPE_TIMESTAMP) return { sql: col, type: "time" };
  if (field.subType === FIELD_SUBTYPE_DATE) {
    // Cube's time dimension is a TIMESTAMP. MySQL's CAST has no TIMESTAMP target; DATETIME is its type.
    return { sql: `CAST(${col} AS ${d === "mysql" ? "DATETIME" : "TIMESTAMP"})`, type: "time" };
  }
  throw new CubeModelError(
    ERR_CUBE_UNMAPPABLE_DIMENSION,
    `${where} reads ${read} (field.${field.subType}), and the exporter maps no Cube dimension type for ` +
      `field.${field.subType}: it maps string, enum, uuid, time, int, long, double, float, decimal, currency, ` +
      `boolean, date and timestamp. Group by a field of one of those subtypes, or remove the dimension.`,
  );
}

/** Table D: one measure over `entity`'s own rows. */
export function measureSpec(entity: MetaObject, m: MetaMeasure, where: string, mc: MemberContext): CubeMeasureSpec {
  const d = mc.dialect;
  const renderer = cubeSqlRenderer(where);
  if (m.isRatio()) {
    const operand = (name: string | undefined): string => {
      const o = name === undefined ? undefined : (declared(entity, TYPE_MEASURE, name) as MetaMeasure | undefined);
      if (o === undefined || o.isRatio()) {
        throw new Error(`${where}: ratio operand '${name ?? ""}' is not a measure.aggregate on '${entity.name}'.`);
      }
      return memberRef(o.name);
    };
    // Member references: each operand is its full Cube expression, condition included.
    const num = operand(m.numerator());
    const den = operand(m.denominator());
    const sql = d === "postgres" ? `CAST(${num} AS NUMERIC) / NULLIF(${den}, 0)` : `${num} / NULLIF(${den}, 0)`;
    return { name: m.name, sql, type: "number", ...docOf(m) };
  }
  const agg = m.agg();
  if (agg === undefined) throw new Error(`${where}: has no @agg.`);
  // The same rule as the view: the entity half resolves in the DECLARING entity's package,
  // and the column is read from the cube's entity (a measure aggregates its own rows).
  const declaring = reportingMemberOwner(m, entity);
  const cols = m.ofColumns().map((r) => {
    const f = resolveReportingFieldRef(r, declaring, mc.root, entity);
    if (f === undefined) throw new Error(`${where}: @of '${r}' does not resolve.`);
    return cubeColumn(sourceColumnNameFor(f, mc.extract), d, renderer);
  });
  if (cols.length === 0) throw new Error(`${where}: has no @of.`);
  // Its @segment filter, then its @filter, ANDed by the lowering's own andOf.
  const condition = andOf([
    segmentClause(m.segmentName(), entity, CUBE_SELF, mc.extract, where),
    resolveReportFilter(m.filter(), entity, CUBE_SELF, mc.extract, `${where} @filter`),
  ]);
  const c = condition === undefined ? undefined : cond(condition, d, renderer);
  if (cols.length > 1) {
    if (agg !== AGG_COUNT || !m.distinct()) throw new Error(`${where}: a column tuple needs @agg: count with @distinct.`);
    // A tuple with any NULL component is not counted, as in the view.
    const tuple = d === "postgres" ? `ROW(${cols.join(", ")})` : `JSON_ARRAY(${cols.join(", ")})`;
    const filter = [...cols.map((x) => `${x} IS NOT NULL`), ...(c === undefined ? [] : [c])].join(" AND ");
    return { name: m.name, sql: tuple, type: "count_distinct", filters: [{ sql: filter }], ...docOf(m) };
  }
  const type: CubeMeasureType = agg === AGG_COUNT ? (m.distinct() ? "count_distinct" : "count") : agg;
  return { name: m.name, sql: cols[0]!, type, ...(c === undefined ? {} : { filters: [{ sql: c }] }), ...docOf(m) };
}

/** A `segment.filter`: its filter over `entity`'s fields. */
export function segmentSpec(entity: MetaObject, s: MetaSegment, where: string, mc: MemberContext): CubeSegmentSpec {
  const clause = resolveReportFilter(s.filter(), entity, CUBE_SELF, mc.extract, where);
  if (clause === undefined) throw new Error(`${where}: declares no @filter.`);
  return { name: s.name, sql: cond(clause, mc.dialect, cubeSqlRenderer(where)), ...docOf(s) };
}
