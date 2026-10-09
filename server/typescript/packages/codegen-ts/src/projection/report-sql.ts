// FR-044 — the SQL fragments of a report, in one place. The report VIEW lowering
// (report-ddl-emit.ts) renders them into `CREATE VIEW` text, and any other consumer of a
// report's filters, segments and relative dates (the Cube exporter) reuses them from here, so
// there is exactly one filter-to-SQL translator and one rule for quoting a column or writing a
// literal. Moved verbatim out of report-ddl-emit.ts and extract-report-spec.ts: not a byte of
// any view changes.
import {
  FIELD_ATTR_LOCAL_TIME,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_TIMESTAMP,
  FILTER_COMPOSE_AND,
  FILTER_COMPOSE_OR,
  FILTER_OP_IN,
  FILTER_RELATIVE_NOW,
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
export function ref(r: string, d: ReportDialect): string {
  const dot = r.indexOf(".");
  return dot < 0 ? q(r, d) : `${r.slice(0, dot)}.${q(r.slice(dot + 1), d)}`;
}

export function literal(v: unknown, d: ReportDialect): string {
  if (isRelativeNow(v)) return relativeNowSql(v.duration, v.temporal, d);
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return d === "sqlite" ? (v ? "1" : "0") : v ? "TRUE" : "FALSE";
  const s = String(v).replace(/'/g, "''");
  return `'${d === "mysql" ? s.replace(/\\/g, "\\\\") : s}'`;
}

export const FILTER_OP_SQL: Readonly<Record<string, string>> = {
  eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE",
};

/** A resolved filter clause as a SQL boolean expression; `and` / `or` groups are parenthesised. */
export function cond(clause: ViewFilterClause, d: ReportDialect): string {
  switch (clause.kind) {
    case "and":
    case "or":
      return `(${clause.clauses.map((c) => cond(c, d)).join(clause.kind === "and" ? " AND " : " OR ")})`;
    case "exprCmp":
      throw new Error("report-ddl-emit: a report filter never lowers to an exprCmp clause.");
    case "cmp": {
      const lhs = ref(clause.ref, d);
      if (clause.op === "isNull") return clause.value === false ? `${lhs} IS NOT NULL` : `${lhs} IS NULL`;
      if (clause.op === "in") {
        const vals = (Array.isArray(clause.value) ? clause.value : [clause.value]).map((v) => literal(v, d));
        return `${lhs} IN (${vals.join(", ")})`;
      }
      const op = FILTER_OP_SQL[clause.op];
      if (op === undefined) throw new Error(`report-ddl-emit: unsupported filter operator "${clause.op}".`);
      return `${lhs} ${op} ${literal(clause.value, d)}`;
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
    const ref = `${alias}.${sourceColumnNameFor(field, ctx)}`;
    for (const [op, raw] of Object.entries(desugarClause(val))) {
      // `IN ()` is a syntax error on Postgres and MySQL, so it would fail when the migration is
      // applied, far from the report. The loader accepts the empty list; refuse it here by name.
      if (op === FILTER_OP_IN && Array.isArray(raw) && raw.length === 0) {
        throw new Error(
          `${where}: the 'in' list on "${key}" is empty, which no row can match and no database accepts ` +
            `as SQL (IN ()). List at least one value, or remove the clause.`,
        );
      }
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
