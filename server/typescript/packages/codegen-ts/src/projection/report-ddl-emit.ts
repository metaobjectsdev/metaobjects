// FR-044 Plan 2 (contract Tables C, F) — renders a ReportViewSpec to view SQL for
// Postgres, SQLite and MySQL. Kept apart from view-ddl-emit.ts on purpose: the projection
// emitter quotes conditionally (`quoteIfNeeded`) and is Postgres/SQLite only; a report
// quotes every identifier unconditionally, so a measure named `order` is valid DDL.
import type { JoinNode } from "./view-spec.js";
import type { ReportAggregate, ReportColumn, ReportViewSpec } from "./report-spec.js";
import { cond, q, ref } from "./report-sql.js";
import { truncateToGrain, type ReportDialect } from "./time-sql.js";

export interface ReportEmitOptions {
  readonly dialect: ReportDialect;
  readonly baseTableName: string;
  /** Map from entity name → table name for every entity referenced in joins. */
  readonly joinTables: Readonly<Record<string, string>>;
  /** Body only (no CREATE VIEW wrapper, no trailing `;`), as migrate-ts consumes it. */
  readonly bodyOnly?: boolean;
}

function castType(cast: "bigint" | "double", d: ReportDialect): string | undefined {
  switch (d) {
    case "postgres":
      return cast === "bigint" ? "BIGINT" : "DOUBLE PRECISION";
    case "mysql":
      return cast === "bigint" ? "SIGNED" : undefined; // MySQL SUM(double) is already DOUBLE
    case "sqlite":
      return undefined; // SQLite has one integer and one real affinity; SUM already fits
  }
}

/** Table D: `COALESCE(E, n)` for a measure with a `@default`; `E` unchanged without one. */
function withDefault(sql: string, dv: ReportAggregate["defaultValue"], d: ReportDialect): string {
  if (dv === undefined) return sql;
  // SQLite: a REAL column keeps one storage class in every row, so its default is a REAL literal.
  return `COALESCE(${sql}, ${d === "sqlite" && dv.real ? `${dv.value}.0` : String(dv.value)})`;
}

/** One aggregate (Table C): the bare aggregate, the condition by dialect, the cast, then the
 *  Table D default around all of it. */
function aggregate(a: ReportAggregate, d: ReportDialect): string {
  const refs = a.refs.map((r) => ref(r, d));
  const c = a.filter === undefined ? undefined : cond(a.filter, d);
  const fn = a.agg.toUpperCase();
  let sql: string;
  if (refs.length > 1) {
    // A distinct tuple count: a tuple with any NULL component is not counted, on every dialect.
    const notNull = refs.map((r) => `${r} IS NOT NULL`);
    const both = [...notNull, ...(c === undefined ? [] : [c])].join(" AND ");
    switch (d) {
      case "postgres":
        sql = `COUNT(DISTINCT (${refs.join(", ")})) FILTER (WHERE ${both})`;
        break;
      case "sqlite":
        sql = `COUNT(DISTINCT CASE WHEN ${both} THEN json_array(${refs.join(", ")}) END)`;
        break;
      case "mysql": {
        // MySQL's multi-argument COUNT(DISTINCT …) already skips a tuple with a NULL component.
        const [first, ...rest] = refs;
        const head = c === undefined ? first! : `CASE WHEN ${c} THEN ${first} END`;
        sql = `COUNT(DISTINCT ${[head, ...rest].join(", ")})`;
        break;
      }
    }
  } else {
    const x = refs[0]!;
    const distinct = a.distinct ? "DISTINCT " : "";
    if (c === undefined) sql = `${fn}(${distinct}${x})`;
    else if (d === "postgres") sql = `${fn}(${distinct}${x}) FILTER (WHERE ${c})`;
    else sql = `${fn}(${distinct}CASE WHEN ${c} THEN ${x} END)`;
  }
  const type = a.cast === undefined ? undefined : castType(a.cast, d);
  return withDefault(type === undefined ? sql : `CAST(${sql} AS ${type})`, a.defaultValue, d);
}

interface RenderedColumn {
  readonly expr: string;
  readonly alias: string;
  /** Present for a dimension: its expression is the GROUP BY term. */
  readonly grouped: boolean;
}

function column(c: ReportColumn, d: ReportDialect): RenderedColumn {
  const alias = q(c.dbColAlias, d);
  switch (c.kind) {
    case "dimension":
      return { expr: ref(c.ref, d), alias, grouped: true };
    case "timeDimension":
      return { expr: truncateToGrain(ref(c.ref, d), c.grain, c.temporal, d), alias, grouped: true };
    case "aggregate":
      return { expr: aggregate(c.aggregate, d), alias, grouped: false };
    case "ratio": {
      // Each operand is its FULL Table C expression (condition and cast included), and its own
      // Table D default; the ratio's default wraps the whole quotient, which is always real.
      const num = aggregate(c.numerator, d);
      const den = aggregate(c.denominator, d);
      const top = d === "postgres" ? "NUMERIC" : d === "sqlite" ? "REAL" : undefined;
      const quotient = `${top === undefined ? num : `CAST(${num} AS ${top})`} / NULLIF(${den}, 0)`;
      const dv = c.defaultValue === undefined ? undefined : { value: c.defaultValue, real: true };
      return { expr: withDefault(quotient, dv, d), alias, grouped: false };
    }
  }
}

/** The table of a joined entity, refused by name when none is registered. */
function tableOf(entity: string, options: ReportEmitOptions): string {
  const table = options.joinTables[entity];
  if (!table) {
    throw new Error(`report-ddl-emit: no table name registered for joined entity "${entity}".`);
  }
  return table;
}

/** The `ON` predicate of the hop `node` from `parentAlias`. An equality, so the same text
 *  serves the hop walked backwards (Table D's spine chain). */
function onPredicate(node: JoinNode, parentAlias: string, d: ReportDialect): string {
  const fk = q(node.fkColumn, d);
  const pk = q(node.pkColumn, d);
  // referenceHolder "source": FK on the parent (belongs-to); "target": FK on the child (has-many).
  return node.referenceHolder === "source"
    ? `${node.alias}.${pk} = ${parentAlias}.${fk}`
    : `${node.alias}.${fk} = ${parentAlias}.${pk}`;
}

function renderJoin(node: JoinNode, parentAlias: string, options: ReportEmitOptions): string {
  const table = tableOf(node.targetEntity, options);
  const d = options.dialect;
  const kw = node.joinType === "inner" ? "INNER JOIN" : "LEFT OUTER JOIN";
  let sql = `  ${kw} ${q(table, d)} ${node.alias} ON ${onPredicate(node, parentAlias, d)}`;
  for (const child of node.children) sql += "\n" + renderJoin(child, node.alias, options);
  return sql;
}

/**
 * Table D, a report with `@spine`: FROM the spine entity S, then the spine's hops walked from S
 * back to @from, one LEFT OUTER JOIN each with the ON its forward join renders; the last one
 * introduces @from's table under the base alias. The report scope is ANDed onto that join's ON:
 * it filters facts, never spine rows, so there is no WHERE. Onward joins hang off S's alias.
 */
function spineFrom(spec: ReportViewSpec, depth: number, options: ReportEmitOptions): string {
  const d = options.dialect;
  // The chain: the single root, then its single child, down to S. Rule R9 routes every dimension
  // through the spine, so nothing branches off above S; a tree that does would hold a join this
  // FROM has no place for, so it is refused rather than half-rendered.
  const chain: JoinNode[] = [];
  let level = spec.joinTree.joins;
  while (chain.length < depth && level.length === 1) {
    chain.push(level[0]!);
    level = level[0]!.children;
  }
  if (depth < 1 || chain.length !== depth) {
    throw new Error(
      `report-ddl-emit: view '${spec.viewName}' declares a @spine of ${depth} hop(s), but its join tree is not ` +
        `one chain of that many hops from @from, so the spine cannot be placed.`,
    );
  }
  const spine = chain[chain.length - 1]!;
  let sql = `  FROM ${q(tableOf(spine.targetEntity, options), d)} ${spine.alias}`;
  for (let i = chain.length - 1; i >= 0; i--) {
    const parentAlias = i === 0 ? spec.joinTree.baseAlias : chain[i - 1]!.alias;
    const parentTable = i === 0 ? options.baseTableName : tableOf(chain[i - 1]!.targetEntity, options);
    const scope = i === 0 && spec.where !== undefined ? ` AND ${cond(spec.where, d)}` : "";
    sql += `\n  LEFT OUTER JOIN ${q(parentTable, d)} ${parentAlias} ON ${onPredicate(chain[i]!, parentAlias, d)}${scope}`;
  }
  for (const child of spine.children) sql += "\n" + renderJoin(child, spine.alias, options);
  return sql;
}

export function emitReportViewDdl(spec: ReportViewSpec, options: ReportEmitOptions): string {
  const d = options.dialect;
  // Rendered once: a dimension's SELECT expression is its GROUP BY term, so they cannot differ.
  const cols = spec.columns.map((c) => column(c, d));
  const select = cols.map((c) => `    ${c.expr} AS ${c.alias}`).join(",\n");
  const groupBy = cols.filter((c) => c.grouped).map((c) => c.expr);

  let from: string;
  if (spec.spineDepth === undefined) {
    const base = spec.joinTree.baseAlias;
    const joins = spec.joinTree.joins.map((j) => renderJoin(j, base, options)).join("\n");
    from =
      `  FROM ${q(options.baseTableName, d)} ${base}` +
      (joins === "" ? "" : `\n${joins}`) +
      (spec.where === undefined ? "" : `\n  WHERE ${cond(spec.where, d)}`);
  } else {
    from = spineFrom(spec, spec.spineDepth, options);
  }
  const body = `  SELECT\n${select}\n${from}` + (groupBy.length === 0 ? "" : `\n  GROUP BY ${groupBy.join(", ")}`);

  if (options.bodyOnly) return body;
  return `CREATE VIEW ${q(spec.viewName, d)} AS\n${body};`;
}
