// FR-044 Plan 4, Tables C and D — one dimension's type and SQL, one measure, one segment, on
// the cube of the entity they are read over. `@of`, `@segment`, `@filter` and ratio operands
// resolve through the same functions the report view lowering calls (report-resolve.ts), and
// conditions render through its own `cond`, with the Cube renderer (cube-sql.ts). Which members a cube has, and
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
  FIELD_SUBTYPE_INET,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_UUID,
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
import { ratioOperand, resolveAggregate } from "../projection/report-resolve.js";
import { cond, mysqlTupleCount, resolveReportFilter, type SqlRenderer } from "../projection/report-sql.js";
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
// uri and inet are strings on the wire, and Cube has no URI or network-address dimension type, so
// each is a string dimension over its column.
const STRING_SUBTYPES: ReadonlySet<string> = new Set([
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_UUID, FIELD_SUBTYPE_TIME, FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_INET,
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
      `field.${field.subType}: it maps string, enum, uuid, time, uri, inet, int, long, double, float, decimal, ` +
      `currency, boolean, date and timestamp. Group by a field of one of those subtypes, or remove the dimension.`,
  );
}

/** `<m>Raw`: the member that holds a defaulted measure.aggregate's aggregate (Table G, added members). */
export function rawMeasureName(measure: string): string {
  return `${measure}Raw`;
}

/**
 * One measure as Cube members. `raw` is present for a measure.aggregate with `@default`: it is
 * the Table D aggregate, `public: false`, under `<m>Raw`, and `measure` reads it through
 * `COALESCE` (the zero-rows / measure-defaults plan, Table D: `COALESCE(E, n)`).
 */
export interface MeasureMembers {
  readonly raw?: CubeMeasureSpec;
  readonly measure: CubeMeasureSpec;
}

/** `COALESCE(<sql>, n)`: `n` is the measure's integer `@default`. */
function withDefault(sql: string, n: number): string {
  return `COALESCE(${sql}, ${String(n)})`;
}

/** Table D, and the zero-rows / measure-defaults plan's Table D: one measure over `entity`'s own rows. */
export function measureMembers(entity: MetaObject, m: MetaMeasure, where: string, mc: MemberContext): MeasureMembers {
  // ADR-0039: defaultValue() resolves, so a measure inherited through extends keeps its default.
  const n = m.defaultValue();
  if (m.isRatio()) {
    // Member references: each operand is its full Cube expression, condition included, and an
    // operand with its own @default is its COALESCE member, so that default reaches the ratio
    // (the plan's decision 4). The ratio's own @default wraps the whole quotient.
    const num = memberRef(ratioOperand(entity, m, m.numerator(), where).name);
    const den = memberRef(ratioOperand(entity, m, m.denominator(), where).name);
    const quotient = mc.dialect === "postgres" ? `CAST(${num} AS NUMERIC) / NULLIF(${den}, 0)` : `${num} / NULLIF(${den}, 0)`;
    return { measure: { name: m.name, sql: n === undefined ? quotient : withDefault(quotient, n), type: "number", ...docOf(m) } };
  }
  const aggregate = aggregateSpec(entity, m, where, mc);
  if (n === undefined) return { measure: { name: m.name, ...aggregate, ...docOf(m) } };
  const raw = rawMeasureName(m.name);
  return {
    raw: { name: raw, ...aggregate, public: false },
    measure: { name: m.name, sql: withDefault(memberRef(raw), n), type: "number", ...docOf(m) },
  };
}

/** Table D: a measure.aggregate's Cube aggregate (type, sql and filters), without its name or docs. */
function aggregateSpec(
  entity: MetaObject,
  m: MetaMeasure,
  where: string,
  mc: MemberContext,
): Pick<CubeMeasureSpec, "sql" | "type" | "filters"> {
  const d = mc.dialect;
  const renderer = cubeSqlRenderer(where);
  // The view's own resolution: @of read from the cube's entity, then its condition.
  const { agg, distinct, fields, condition } = resolveAggregate(m, entity, mc.root, CUBE_SELF, mc.extract, where);
  const cols = fields.map((f) => cubeColumn(sourceColumnNameFor(f, mc.extract), d, renderer));
  if (cols.length === 0) throw new Error(`${where}: has no @of.`);
  const c = condition === undefined ? undefined : cond(condition, d, renderer);
  if (cols.length > 1) {
    if (agg !== AGG_COUNT || !distinct) throw new Error(`${where}: a column tuple needs @agg: count with @distinct.`);
    if (d === "mysql") {
      // The view's own MySQL form (report-ddl-emit.ts): the multi-argument COUNT(DISTINCT a, b),
      // which skips a tuple with a NULL component and compares each component by its column's
      // collation. A count_distinct over JSON_ARRAY(a, b) compares JSON strings byte for byte, so
      // under MySQL's default utf8mb4_0900_ai_ci it counts 'abc' and 'ABC' twice where the view
      // counts them once (executed on mysql:8.4: 6 against the view's 4). Cube takes the
      // aggregate as written in a `number` measure.
      return { sql: mysqlTupleCount(cols, c), type: "number" };
    }
    // A tuple with any NULL component is not counted, as in the view.
    const filter = [...cols.map((x) => `${x} IS NOT NULL`), ...(c === undefined ? [] : [c])].join(" AND ");
    return { sql: `ROW(${cols.join(", ")})`, type: "count_distinct", filters: [{ sql: filter }] };
  }
  const type: CubeMeasureType = agg === AGG_COUNT ? (distinct ? "count_distinct" : "count") : agg;
  return { sql: cols[0]!, type, ...(c === undefined ? {} : { filters: [{ sql: c }] }) };
}

/** A `segment.filter`: its filter over `entity`'s fields. */
export function segmentSpec(entity: MetaObject, s: MetaSegment, where: string, mc: MemberContext): CubeSegmentSpec {
  const clause = resolveReportFilter(s.filter(), entity, CUBE_SELF, mc.extract, where);
  if (clause === undefined) throw new Error(`${where}: declares no @filter.`);
  return { name: s.name, sql: cond(clause, mc.dialect, cubeSqlRenderer(where)), ...docOf(s) };
}
