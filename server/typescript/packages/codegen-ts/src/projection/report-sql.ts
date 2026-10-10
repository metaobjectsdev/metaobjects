// FR-044 — the SQL fragments of a report: identifier quoting, literals, filter clauses,
// relative dates, and the resolution of a reporting `@filter` or named segment over an entity's
// fields. The report VIEW lowering (report-ddl-emit.ts, extract-report-spec.ts) renders views
// from them, and the Cube exporter renders its members' SQL from them, so there is exactly one
// filter-to-SQL translator and one rule for quoting a column or writing a literal.
//
// `ref` and `cond` take an optional `SqlRenderer`. Omitted, identifiers and literals are written
// as the view lowering writes them (VIEW_SQL). The Cube exporter passes one that also escapes
// Cube's `{...}` reference syntax and Jinja (cube/cube-sql.ts); the clause structure, the
// operators and the relative-date SQL are the same for both.
import {
  FIELD_ATTR_LOCAL_TIME,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_TIMESTAMP,
  FILTER_COMPOSE_AND,
  FILTER_COMPOSE_OR,
  FILTER_OP_IN,
  FILTER_RELATIVE_NOW,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  TYPE_SEGMENT,
  type MetaField,
  type MetaMeasure,
  type MetaObject,
  type MetaSegment,
} from "@metaobjectsdev/metadata";
import { intValueMapOf } from "../enum-meta.js";
import {
  desugarClause,
  encodeIntEnumFilterValue,
  sourceColumnNameFor,
  type ExtractContext,
} from "./extract-view-spec.js";
import { isRelativeNow } from "./report-spec.js";
import { relativeNowSql, type ReportDialect, type ReportTemporal } from "./time-sql.js";
import type { ViewFilterClause } from "./view-spec.js";

/** An identifier, quoted unconditionally. */
export function q(ident: string, d: ReportDialect): string {
  return d === "mysql" ? "`" + ident.replace(/`/g, "``") + "`" : `"${ident.replace(/"/g, '""')}"`;
}

/** `alias.column` → `alias."column"`. The alias is generated, never quoted. */
export function ref(r: string, d: ReportDialect, renderer: SqlRenderer = VIEW_SQL): string {
  const dot = r.indexOf(".");
  return dot < 0 ? renderer.identifier(r, d) : `${r.slice(0, dot)}.${renderer.identifier(r.slice(dot + 1), d)}`;
}

export function literal(v: unknown, d: ReportDialect): string {
  if (isRelativeNow(v)) return relativeNowSql(v.duration, v.temporal, d);
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return d === "sqlite" ? (v ? "1" : "0") : v ? "TRUE" : "FALSE";
  const s = String(v).replace(/'/g, "''");
  return `'${d === "mysql" ? s.replace(/\\/g, "\\\\") : s}'`;
}

/**
 * How a fragment writes its identifiers and literals. Everything else in a clause (operators,
 * grouping, `IS NULL`, the relative-date SQL inside `literal`) is the same for every renderer.
 */
export interface SqlRenderer {
  /** One identifier, quoted. */
  readonly identifier: (ident: string, d: ReportDialect) => string;
  /** One filter operand as SQL. */
  readonly literal: (v: unknown, d: ReportDialect) => string;
}

/** The report view lowering's renderer: `q` and `literal`, unchanged. */
export const VIEW_SQL: SqlRenderer = { identifier: q, literal };

export const FILTER_OP_SQL: Readonly<Record<string, string>> = {
  eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE",
};

/** A resolved filter clause as a SQL boolean expression; `and` / `or` groups are parenthesised. */
export function cond(clause: ViewFilterClause, d: ReportDialect, renderer: SqlRenderer = VIEW_SQL): string {
  switch (clause.kind) {
    case "and":
    case "or":
      return `(${clause.clauses.map((c) => cond(c, d, renderer)).join(clause.kind === "and" ? " AND " : " OR ")})`;
    case "exprCmp":
      throw new Error("report-sql: a report filter never lowers to an exprCmp clause.");
    case "cmp": {
      const lhs = ref(clause.ref, d, renderer);
      if (clause.op === "isNull") return clause.value === false ? `${lhs} IS NOT NULL` : `${lhs} IS NULL`;
      if (clause.op === "in") {
        const vals = (Array.isArray(clause.value) ? clause.value : [clause.value]).map((v) => renderer.literal(v, d));
        return `${lhs} IN (${vals.join(", ")})`;
      }
      const op = FILTER_OP_SQL[clause.op];
      if (op === undefined) throw new Error(`report-sql: unsupported filter operator "${clause.op}".`);
      return `${lhs} ${op} ${renderer.literal(clause.value, d)}`;
    }
  }
}

/** Table D's column kind for a `field.date` / `field.timestamp`. */
export function temporalOf(field: MetaField): ReportTemporal {
  if (field.subType === FIELD_SUBTYPE_DATE) return "date";
  return field.attr(FIELD_ATTR_LOCAL_TIME) === true ? "naive" : "instant";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRelativeValue(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && FILTER_RELATIVE_NOW in v;
}

/** AND of the present clauses, a lone clause as itself, none as undefined. */
export function andOf(clauses: readonly (ViewFilterClause | undefined)[]): ViewFilterClause | undefined {
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
export function resolveReportFilter(
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
    const columnRef = `${alias}.${sourceColumnNameFor(field, ctx)}`;
    for (const [op, raw] of Object.entries(desugarClause(val))) {
      // `IN ()` is a syntax error on Postgres and MySQL, so it would fail when the migration is
      // applied, far from the report. The loader accepts the empty list; refuse it here by name.
      if (op === FILTER_OP_IN && Array.isArray(raw) && raw.length === 0) {
        throw new Error(
          `${where}: the 'in' list on "${key}" is empty, which no row can match and no database accepts ` +
            `as SQL (IN ()). List at least one value, or remove the clause.`,
        );
      }
      clauses.push({ kind: "cmp", ref: columnRef, op, value: lowerFilterValue(raw, op, field, key, where) });
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
export function declared(from: MetaObject, type: string, name: string): MetaSegment | MetaMeasure | undefined {
  // ADR-0039: resolving children(), so a member declared on an abstract base is found. The
  // type string identifies the node (no `instanceof` across packages); the cast is type-only.
  return from.children().find((c) => c.type === type && c.name === name) as MetaSegment | MetaMeasure | undefined;
}

/** The filter of a named segment on `from`, resolved over `from`'s fields. */
export function segmentClause(
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

/**
 * MySQL's distinct count of a column tuple, as the report view writes it: the multi-argument
 * `COUNT(DISTINCT a, b, ...)`, which skips a tuple with a NULL component and compares each
 * component by its column's collation. A condition goes on the first component
 * (`CASE WHEN <condition> THEN a END`), which a tuple with a NULL component never counts. `refs`
 * and `condition` are rendered SQL; the Cube exporter writes the same expression as a `number`
 * measure.
 */
export function mysqlTupleCount(refs: readonly string[], condition: string | undefined): string {
  const [first, ...rest] = refs;
  if (first === undefined) throw new Error("report-sql: a tuple count needs at least one column.");
  const head = condition === undefined ? first : `CASE WHEN ${condition} THEN ${first} END`;
  return `COUNT(DISTINCT ${[head, ...rest].join(", ")})`;
}

/** A report's row scope over `from`'s fields on `alias`. */
export interface ReportScope {
  /** The `@segment` the report names, when it names one. */
  readonly segmentName?: string;
  /** That segment's filter. */
  readonly segment?: ViewFilterClause;
  /** The report's own `@filter`. */
  readonly filter?: ViewFilterClause;
  /** The segment's filter, then the `@filter`, ANDed. Absent when the report declares neither. */
  readonly where?: ViewFilterClause;
}

/**
 * A report's `@segment` and `@filter`, resolved over `from`'s fields on `alias`: the scope the
 * report view writes as its WHERE (or, under `@spine`, on the join that introduces `@from`), and
 * the Cube exporter writes as segments or inside a facts cube. `where` names the report for an
 * error; the `@filter`'s errors are named `<where> @filter`.
 */
export function reportScope(
  report: MetaObject,
  from: MetaObject,
  alias: string,
  ctx: ExtractContext,
  where: string,
): ReportScope {
  const named = report.attr(OBJECT_REPORT_ATTR_SEGMENT);
  const segmentName = typeof named === "string" ? named : undefined;
  const segment = segmentClause(segmentName, from, alias, ctx, where);
  const filter = resolveReportFilter(report.attr(OBJECT_REPORT_ATTR_FILTER), from, alias, ctx, `${where} @filter`);
  const scope = andOf([segment, filter]);
  return {
    ...(segmentName !== undefined ? { segmentName } : {}),
    ...(segment !== undefined ? { segment } : {}),
    ...(filter !== undefined ? { filter } : {}),
    ...(scope !== undefined ? { where: scope } : {}),
  };
}
