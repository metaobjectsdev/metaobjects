// FR-044 Plan 2 (contract Tables C, F) — renders a ReportViewSpec to view SQL for
// Postgres, SQLite and MySQL. Kept apart from view-ddl-emit.ts on purpose: the projection
// emitter quotes conditionally (`quoteIfNeeded`) and is Postgres/SQLite only; a report
// quotes every identifier unconditionally, so a measure named `order` is valid DDL.
import { tphScopeSql } from "./view-ddl-emit.js";
import type { JoinNode } from "./view-spec.js";
import type { ReportAggregate, ReportColumn, ReportDerivedTerm, ReportViewSpec } from "./report-spec.js";
import { AGG_ALL, AGG_ANY, DERIVED_FN_ADD, DERIVED_FN_DIVIDE, DERIVED_FN_SUBTRACT } from "@metaobjectsdev/metadata";
import { cond, mysqlTupleCount, q, ref } from "./report-sql.js";
import { truncateToGrain, type ReportDialect } from "./time-sql.js";

export interface ReportEmitOptions {
  readonly dialect: ReportDialect;
  readonly baseTableName: string;
  /** Map from entity name → table name for every entity referenced in joins. */
  readonly joinTables: Readonly<Record<string, string>>;
  /** Entity name to declared `@schema`. Postgres qualifies a relation with it when declared; otherwise the name stays bare. */
  readonly tableSchemas?: Readonly<Record<string, string | undefined>>;
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
  // A boolean measure's @default is 0 (false) or 1 (true): a boolean literal on Postgres only.
  if (dv.boolean === true) return `COALESCE(${sql}, ${d === "postgres" ? (dv.value === 1 ? "TRUE" : "FALSE") : String(dv.value)})`;
  // SQLite: a REAL column keeps one storage class in every row, so its default is a REAL literal.
  return `COALESCE(${sql}, ${d === "sqlite" && dv.real ? `${dv.value}.0` : String(dv.value)})`;
}

/** The SQL function of an `@agg`. A boolean any / all is `bool_or` / `bool_and` where the dialect has
 *  them (Postgres), else MAX / MIN: a boolean is 0 / 1 there, so the maximum is the OR. */
function aggFunction(agg: ReportAggregate["agg"], d: ReportDialect): string {
  if (agg === AGG_ANY) return d === "postgres" ? "bool_or" : "MAX";
  if (agg === AGG_ALL) return d === "postgres" ? "bool_and" : "MIN";
  return agg.toUpperCase();
}

/** One aggregate (Table C): the bare aggregate, the condition by dialect, the cast, then the
 *  Table D default around all of it. `factRef` is set under `@spine`: a column of @from that is
 *  null only on the padding row a spine row with no facts gets. */
function aggregate(a: ReportAggregate, d: ReportDialect, factRef?: string): string {
  const refs = a.refs.map((r) => ref(r, d));
  const c = a.filter === undefined ? undefined : cond(a.filter, d);
  const fn = aggFunction(a.agg, d);
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
      case "mysql":
        // MySQL's multi-argument COUNT(DISTINCT …) already skips a tuple with a NULL component.
        sql = mysqlTupleCount(refs, c);
        break;
    }
  } else if (refs.length === 0) {
    // @agg any / all with no @of (rule M0): the condition IS the quantified predicate, "some row
    // (every row) passes". A comparison is a boolean on Postgres and 0 / 1 / NULL elsewhere, so
    // MAX / MIN of it is the OR / AND. A row whose predicate is NULL does not pass, as WHERE would
    // drop it, so the predicate is COALESCEd to false and only an empty group reads NULL.
    if (c === undefined) throw new Error(`report-ddl-emit: @agg '${a.agg}' has neither @of nor a condition.`);
    const passes = `COALESCE(${c}, ${d === "postgres" ? "FALSE" : "0"})`;
    // Under @spine the padding row's condition can still be true (`col IS NULL`), so only fact
    // rows are aggregated, and a spine row with no facts reads null as every other measure does.
    if (factRef === undefined) sql = `${fn}(${passes})`;
    else if (d === "postgres") sql = `${fn}(${passes}) FILTER (WHERE ${ref(factRef, d)} IS NOT NULL)`;
    else sql = `${fn}(CASE WHEN ${ref(factRef, d)} IS NOT NULL THEN ${passes} END)`;
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

/** A ratio (Table C/D): each operand its full aggregate, the quotient real, its own default around it. */
function ratio(
  numerator: ReportAggregate,
  denominator: ReportAggregate,
  defaultValue: number | undefined,
  d: ReportDialect,
  factRef: string | undefined,
): string {
  // Each operand is its FULL Table C expression (condition and cast included), and its own
  // Table D default; the ratio's default wraps the whole quotient, which is always real.
  const num = aggregate(numerator, d, factRef);
  const den = aggregate(denominator, d, factRef);
  const quotient = `${realOf(num, d)} / NULLIF(${den}, 0)`;
  const dv = defaultValue === undefined ? undefined : { value: defaultValue, real: true };
  return withDefault(quotient, dv, d);
}

/** `CAST(x AS <real>)` where the dialect would otherwise divide integers as integers. */
function realOf(sql: string, d: ReportDialect): string {
  const top = d === "postgres" ? "NUMERIC" : d === "sqlite" ? "REAL" : undefined;
  return top === undefined ? sql : `CAST(${sql} AS ${top})`;
}

/** FR-044 R13: a derived measure's expression. An operation or ratio under another operator is
 *  parenthesised; `divide` divides as a ratio does (real, a zero divisor reads null), and a
 *  nonzero literal divisor needs no NULLIF. */
function derived(t: ReportDerivedTerm, d: ReportDialect, factRef: string | undefined, top = true): string {
  switch (t.kind) {
    case "aggregate":
      return aggregate(t.aggregate, d, factRef);
    case "ratio": {
      const sql = ratio(t.numerator, t.denominator, t.defaultValue, d, factRef);
      return top || t.defaultValue !== undefined ? sql : `(${sql})`;
    }
    case "ref":
      return ref(t.ref, d);
    case "value":
      return t.value < 0 ? `(${String(t.value)})` : String(t.value);
    case "op": {
      let sql: string;
      if (t.fn === DERIVED_FN_DIVIDE) {
        // Inside CAST(...) the dividend needs no parentheses of its own; MySQL has no cast.
        const dividend = d === "mysql" ? derived(t.left, d, factRef, false) : realOf(derived(t.left, d, factRef), d);
        const divisor =
          t.right.kind === "value" && t.right.value !== 0
            ? derived(t.right, d, factRef, false)
            : `NULLIF(${derived(t.right, d, factRef)}, 0)`;
        sql = `${dividend} / ${divisor}`;
      } else {
        const sign = t.fn === DERIVED_FN_ADD ? "+" : t.fn === DERIVED_FN_SUBTRACT ? "-" : "*";
        sql = `${derived(t.left, d, factRef, false)} ${sign} ${derived(t.right, d, factRef, false)}`;
      }
      return top ? sql : `(${sql})`;
    }
  }
}

interface RenderedColumn {
  readonly expr: string;
  readonly alias: string;
  /** Present for a dimension: its expression is the GROUP BY term. */
  readonly grouped: boolean;
}

function column(c: ReportColumn, d: ReportDialect, factRef: string | undefined): RenderedColumn {
  const alias = q(c.dbColAlias, d);
  switch (c.kind) {
    case "dimension":
      return { expr: ref(c.ref, d), alias, grouped: true };
    case "timeDimension":
      return { expr: truncateToGrain(ref(c.ref, d), c.grain, c.temporal, d), alias, grouped: true };
    case "aggregate":
      return { expr: aggregate(c.aggregate, d, factRef), alias, grouped: false };
    case "ratio":
      return { expr: ratio(c.numerator, c.denominator, c.defaultValue, d, factRef), alias, grouped: false };
    case "derived": {
      // Typed decimal (Table B) whatever its operands: the whole expression is real.
      const top = c.term.kind === "op" && c.term.fn === DERIVED_FN_DIVIDE;
      const sql = derived(c.term, d, factRef);
      return { expr: top ? sql : realOf(sql, d), alias, grouped: false };
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

/** A relation the view reads: schema-qualified on Postgres only when the entity declares a `@schema`. */
function relation(entity: string, table: string, options: ReportEmitOptions): string {
  const d = options.dialect;
  const schema = d === "postgres" ? options.tableSchemas?.[entity] : undefined;
  return schema === undefined ? q(table, d) : `${q(schema, d)}.${q(table, d)}`;
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
  // Every generated join is LEFT OUTER.
  const kw = "LEFT OUTER JOIN";
  // A join onto a TPH level keeps only its rows of the shared table.
  const scope = node.tphScope !== undefined
    ? ` AND ${node.alias}.${q(node.tphScope.column, d)}${tphScopeSql(node.tphScope.values, (v) => typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`)}`
    : "";
  let sql = `  ${kw} ${relation(node.targetEntity, table, options)} ${node.alias} ON ${onPredicate(node, parentAlias, d)}${scope}`;
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
  let sql = `  FROM ${relation(spine.targetEntity, tableOf(spine.targetEntity, options), options)} ${spine.alias}`;
  for (let i = chain.length - 1; i >= 0; i--) {
    const parentAlias = i === 0 ? spec.joinTree.baseAlias : chain[i - 1]!.alias;
    const parentEntity = i === 0 ? spec.joinTree.baseEntity : chain[i - 1]!.targetEntity;
    const parentTable = relation(parentEntity, i === 0 ? options.baseTableName : tableOf(parentEntity, options), options);
    const scope = i === 0 && spec.where !== undefined ? ` AND ${cond(spec.where, d)}` : "";
    sql += `\n  LEFT OUTER JOIN ${parentTable} ${parentAlias} ON ${onPredicate(chain[i]!, parentAlias, d)}${scope}`;
  }
  for (const child of spine.children) sql += "\n" + renderJoin(child, spine.alias, options);
  return sql;
}

export function emitReportViewDdl(spec: ReportViewSpec, options: ReportEmitOptions): string {
  const d = options.dialect;
  // Under @spine, @from's side of the first hop's ON equality: non-null on every fact row the
  // join keeps, null on the padding row of a spine row with no facts.
  const first = spec.spineDepth === undefined ? undefined : spec.joinTree.joins[0];
  const factRef =
    first === undefined
      ? undefined
      : `${spec.joinTree.baseAlias}.${first.referenceHolder === "source" ? first.fkColumn : first.pkColumn}`;
  // Rendered once: a dimension's SELECT expression is its GROUP BY term, so they cannot differ.
  const cols = spec.columns.map((c) => column(c, d, factRef));
  const select = cols.map((c) => `    ${c.expr} AS ${c.alias}`).join(",\n");
  const groupBy = cols.filter((c) => c.grouped).map((c) => c.expr);

  let from: string;
  if (spec.spineDepth === undefined) {
    const base = spec.joinTree.baseAlias;
    const joins = spec.joinTree.joins.map((j) => renderJoin(j, base, options)).join("\n");
    from =
      `  FROM ${relation(spec.joinTree.baseEntity, options.baseTableName, options)} ${base}` +
      (joins === "" ? "" : `\n${joins}`) +
      (spec.where === undefined ? "" : `\n  WHERE ${cond(spec.where, d)}`);
  } else {
    from = spineFrom(spec, spec.spineDepth, options);
  }
  const body = `  SELECT\n${select}\n${from}` + (groupBy.length === 0 ? "" : `\n  GROUP BY ${groupBy.join(", ")}`);

  if (options.bodyOnly) return body;
  return `CREATE VIEW ${q(spec.viewName, d)} AS\n${body};`;
}
