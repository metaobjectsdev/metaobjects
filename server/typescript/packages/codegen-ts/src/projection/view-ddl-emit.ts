import type {
  JoinNode, ViewSpec, ViewFilterClause, ViewExprNode, ViewOrderKey, SelectColumn,
} from "./view-spec.js";

// Quote an identifier only when it isn't a plain lowercase snake identifier —
// exactly postgres's own rule. This keeps snake_case output unquoted (the common
// case + every existing fixture) while quoting mixed-case / kebab identifiers
// (the `literal`/`kebab-case` strategies) so postgres preserves their case
// instead of folding `programId` → `programid`. Both postgres and sqlite quote
// with double-quotes, so one helper serves every dialect.
function quoteIfNeeded(ident: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(ident)) return ident;
  return `"${ident.replace(/"/g, '""')}"`;
}

/** Quote the column part of an `alias.column` reference, leaving the alias bare. */
function quoteRef(ref: string): string {
  const dot = ref.indexOf(".");
  if (dot < 0) return quoteIfNeeded(ref);
  return ref.slice(0, dot) + "." + quoteIfNeeded(ref.slice(dot + 1));
}

export interface EmitOptions {
  readonly dialect: "postgres" | "sqlite";
  /** Resolved table name for the JoinTree's base entity. */
  readonly baseTableName: string;
  /** Map from entity name → table name for every entity referenced in joins. */
  readonly joinTables: Readonly<Record<string, string>>;
  /**
   * When true, return only the view BODY (`SELECT … FROM …`, no `CREATE VIEW … AS`
   * wrapper, no trailing `;`). This is what migrate-ts's expected-schema/diff layer
   * consumes (it re-wraps the body); the full statement is for direct application.
   */
  readonly bodyOnly?: boolean;
}

/** SQL literal for a filter value, dialect-aware for booleans. */
function sqlLiteral(value: unknown, dialect: EmitOptions["dialect"]): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") {
    return dialect === "sqlite" ? (value ? "1" : "0") : (value ? "TRUE" : "FALSE");
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

const FILTER_OP_SQL: Readonly<Record<string, string>> = {
  eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE",
};

/** Render a resolved {@link ViewFilterClause} to a SQL boolean expression. */
function renderFilterCond(clause: ViewFilterClause, dialect: EmitOptions["dialect"]): string {
  if (clause.kind === "and" || clause.kind === "or") {
    const joined = clause.clauses.map((c) => renderFilterCond(c, dialect)).join(clause.kind === "and" ? " AND " : " OR ");
    return `(${joined})`;
  }
  // The left-hand side is a bare `alias.column` for a `cmp`, or a parenthesized
  // inlined computed expression for #207's `exprCmp` (a projection @filter ref to
  // an origin.computed field). The op handling below is identical for both.
  const lhs = clause.kind === "exprCmp" ? `(${renderExpr(clause.expr, dialect)})` : quoteRef(clause.ref);
  if (clause.op === "isNull") return clause.value === false ? `${lhs} IS NOT NULL` : `${lhs} IS NULL`;
  if (clause.op === "in") {
    const vals = (Array.isArray(clause.value) ? clause.value : [clause.value]).map((v) => sqlLiteral(v, dialect));
    return `${lhs} IN (${vals.join(", ")})`;
  }
  const op = FILTER_OP_SQL[clause.op];
  if (!op) throw new Error(`view-ddl-emit: unsupported filter operator "${clause.op}".`);
  return `${lhs} ${op} ${sqlLiteral(clause.value, dialect)}`;
}

/** Alias of the json_each table that a SQLite collect column sorts its elements over.
 *  Scoped to its own scalar subquery, so it cannot collide with a JOIN-tree alias; named
 *  distinctly anyway so it is obvious in emitted DDL where it came from. */
const JSON_EACH_ALIAS = "mo_je";

/**
 * Render resolved ordering keys, applying the #195 nulls-last pin (`NULLS LAST` in
 * both directions — PG + SQLite ≥ 3.30). `alias` qualifies each key's column.
 */
function renderOrderKeys(keys: readonly ViewOrderKey[], alias: string): string {
  return keys
    .map((k) => `${alias}.${quoteIfNeeded(k.column)} ${k.dir.toUpperCase()} NULLS LAST`)
    .join(", ");
}

/** Lower a resolved computed expression tree (#195 origin.computed) to a SQL scalar expression. */
function renderExpr(node: ViewExprNode, dialect: EmitOptions["dialect"]): string {
  switch (node.kind) {
    case "col":
      return quoteRef(node.ref);
    case "lit":
      return sqlLiteral(node.value, dialect);
    case "cmp": {
      const op = FILTER_OP_SQL[node.op];
      if (!op) throw new Error(`view-ddl-emit: unsupported computed comparison operator "${node.op}".`);
      return `${renderExpr(node.left, dialect)} ${op} ${renderExpr(node.right, dialect)}`;
    }
    case "nullTest":
      return `${renderExpr(node.arg, dialect)} IS ${node.negated ? "NOT " : ""}NULL`;
    case "not":
      return `NOT (${renderExpr(node.arg, dialect)})`;
    case "logic": {
      const joiner = node.op === "and" ? " AND " : " OR ";
      return `(${node.args.map((a) => renderExpr(a, dialect)).join(joiner)})`;
    }
    case "coalesce":
      return `COALESCE(${node.args.map((a) => renderExpr(a, dialect)).join(", ")})`;
  }
}

/**
 * Lower an `origin.first` column (#195) to a correlated scalar subquery. The subquery
 * keys on the OUTER base alias (`baseAlias`), so it composes with the view's GROUP BY
 * (the base PK is always a grouped passthrough column). The child PK ascending is
 * ALWAYS appended as the final tie-breaker so equal-order rows stay byte-deterministic.
 */
function renderFirst(
  c: Extract<SelectColumn, { kind: "first" }>,
  options: EmitOptions,
  baseAlias: string,
): string {
  const childTable = options.joinTables[c.childEntity];
  if (!childTable) {
    throw new Error(`view-ddl-emit: no table name registered for origin.first child entity "${c.childEntity}".`);
  }
  const of = `${c.childAlias}.${quoteIfNeeded(c.sourceColumn)}`;
  const fk = quoteIfNeeded(c.fkColumn);
  const pk = quoteIfNeeded(c.pkColumn);
  // Mirror renderJoin's ON clause, with the child in the subquery and the base outside.
  //   referenceHolder "source" → FK on base:  child.pk = base.fk   (belongs-to)
  //   referenceHolder "target" → FK on child: child.fk = base.pk   (has-many)
  const correlation = c.referenceHolder === "source"
    ? `${c.childAlias}.${pk} = ${baseAlias}.${fk}`
    : `${c.childAlias}.${fk} = ${baseAlias}.${pk}`;
  const filterClause = c.filter ? ` AND ${renderFilterCond(c.filter, options.dialect)}` : "";
  // The @orderBy keys carry the nulls-last pin; the appended PK tie-breaker never does
  // (a primary key is non-null, so NULLS LAST would be noise). Its ASC direction makes
  // equal-order rows byte-deterministic.
  const tieBreak = `${c.childAlias}.${quoteIfNeeded(c.childPkColumn)} ASC`;
  const orderKeys = c.orderBy.length > 0
    ? `${renderOrderKeys(c.orderBy, c.childAlias)}, ${tieBreak}`
    : tieBreak;
  return (
    `(SELECT ${of} FROM ${quoteIfNeeded(childTable)} ${c.childAlias}` +
    ` WHERE ${correlation}${filterClause} ORDER BY ${orderKeys} LIMIT 1) AS ${quoteIfNeeded(c.dbColAlias)}`
  );
}

type CollectColumn = Extract<SelectColumn, { kind: "collectAgg" | "collectObjectAgg" }>;

/** Alias of the grouped inner query in a two-level SQLite view. */
const GROUPED_ALIAS = "mo_g";
/** Alias of the sorted element subquery in a SQLite collect column. */
const SORTED_ALIAS = "mo_s";

/**
 * How a SQLite collect column orders its elements. Each element is stored as a JSON array
 * `[key1, …, keyN, payload]`, or as the bare value when `bare` is set (a `@distinct`
 * collect orders by the value itself).
 */
interface SqliteCollectLayout {
  readonly keys: readonly { readonly expr: string; readonly order: string }[];
  readonly payload: string;
  readonly bare: boolean;
  /** Wrap each element in json() when re-aggregating — true for a JSON object payload. */
  readonly json: boolean;
}

function sqliteCollectLayout(c: CollectColumn): SqliteCollectLayout {
  const col = (name: string): string => `${c.sourceAlias}.${quoteIfNeeded(name)}`;
  const orderKeys = c.orderBy.map((k) => ({ expr: col(k.column), order: `${k.dir.toUpperCase()} NULLS LAST` }));
  if (c.kind === "collectObjectAgg") {
    const pairs = c.members.map((m) => `'${m.memberName}', ${col(m.sourceColumn)}`).join(", ");
    // Default element order is the related entity's PK; an explicit @orderBy leads with the
    // PK appended as a tie-break, so equal-order rows stay byte-deterministic.
    return {
      keys: [...orderKeys, { expr: col(c.joinedPkColumn), order: "ASC" }],
      payload: `json_object(${pairs})`,
      bare: false,
      json: true,
    };
  }
  const src = col(c.sourceColumn);
  // @distinct always orders by the value; otherwise an explicit @orderBy, else value ascending.
  if (c.distinct) return { keys: [], payload: src, bare: true, json: false };
  return {
    keys: orderKeys.length > 0 ? orderKeys : [{ expr: src, order: "ASC" }],
    payload: src,
    bare: false,
    json: false,
  };
}

/**
 * SQLite collect, inner half: the grouped query aggregates the related rows UNSORTED, each
 * element carrying its sort keys. Ordering happens in the outer query
 * ({@link sqliteCollectOuter}).
 *
 * Why two levels. The ordered aggregate `json_group_array(x ORDER BY …)` needs SQLite 3.44,
 * and a database holding such a view will not open on anything older (Ubuntu 22.04 ships
 * 3.37). Before 3.44 the only way to order an aggregate's input is to aggregate over a
 * sorted subquery — and a subquery cannot read an aggregate of the query around it
 * ("misuse of aggregate function"), so the sort has to sit one query further out, reading
 * the grouped result as a plain column. Measured on SQLite 3.35.5, 3.37.2, 3.44 and 3.53.
 *
 * This also keeps whole-object elements as JSON objects: without an in-aggregate ORDER BY
 * `json_group_array(json_array(…, json_object(…)))` nests correctly, where on 3.44
 * `json_group_array(json_object(…) ORDER BY …)` returned an array of quoted strings.
 */
function sqliteCollectInner(c: CollectColumn): string {
  const layout = sqliteCollectLayout(c);
  const guard = `${c.sourceAlias}.${quoteIfNeeded(c.joinedPkColumn)} IS NOT NULL`;
  const element = layout.bare
    ? `DISTINCT ${layout.payload}`
    : `json_array(${[...layout.keys.map((k) => k.expr), layout.payload].join(", ")})`;
  return `COALESCE(json_group_array(${element}) FILTER (WHERE ${guard}), json_array())`;
}

/** SQLite collect, outer half: sort the grouped column's elements and re-aggregate them. */
function sqliteCollectOuter(c: CollectColumn): string {
  const layout = sqliteCollectLayout(c);
  const grouped = `${GROUPED_ALIAS}.${quoteIfNeeded(c.dbColAlias)}`;
  const at = (i: number): string => `json_extract(${JSON_EACH_ALIAS}.value, '$[${i}]')`;
  const value = layout.bare ? `${JSON_EACH_ALIAS}.value` : at(layout.keys.length);
  const orderBy = layout.bare
    ? `${JSON_EACH_ALIAS}.value ASC`
    : layout.keys.map((k, i) => `${at(i)} ${k.order}`).join(", ");
  const element = layout.json ? `json(${SORTED_ALIAS}.v)` : `${SORTED_ALIAS}.v`;
  return (
    `(SELECT json_group_array(${element}) FROM (SELECT ${value} AS v FROM json_each(${grouped}) ${JSON_EACH_ALIAS}` +
    ` ORDER BY ${orderBy}) ${SORTED_ALIAS}) AS ${quoteIfNeeded(c.dbColAlias)}`
  );
}

const isCollect = (c: SelectColumn): c is CollectColumn =>
  c.kind === "collectAgg" || c.kind === "collectObjectAgg";

function renderColumn(c: SelectColumn, options: EmitOptions, baseAlias: string): string {
  const dialect = options.dialect;
  const alias = quoteIfNeeded(c.dbColAlias);

  if (c.kind === "passthrough") {
    return `${c.sourceAlias}.${quoteIfNeeded(c.sourceColumn)} AS ${alias}`;
  }

  if (c.kind === "aggregate") {
    const src = `${c.sourceAlias}.${quoteIfNeeded(c.sourceColumn)}`;
    // aggregate — use DISTINCT for count() over joined PKs to avoid join inflation.
    // A scoping @filter renders as postgres `FILTER (WHERE …)`; sqlite (no aggregate
    // FILTER pre-3.30) uses the portable `CASE WHEN … END` argument form.
    const cond = c.filter ? renderFilterCond(c.filter, dialect) : undefined;
    if (c.agg === "count") {
      if (cond && dialect === "sqlite") return `COUNT(DISTINCT CASE WHEN ${cond} THEN ${src} END) AS ${alias}`;
      if (cond) return `COUNT(DISTINCT ${src}) FILTER (WHERE ${cond}) AS ${alias}`;
      return `COUNT(DISTINCT ${src}) AS ${alias}`;
    }
    const fn = c.agg.toUpperCase();
    if (cond && dialect === "sqlite") return `${fn}(CASE WHEN ${cond} THEN ${src} END) AS ${alias}`;
    if (cond) return `${fn}(${src}) FILTER (WHERE ${cond}) AS ${alias}`;
    return `${fn}(${src}) AS ${alias}`;
  }

  if (c.kind === "predicateAgg") {
    // #195 any/all. The phantom-row guard (joined.pk IS NOT NULL) EXCLUDES null-extended
    // LEFT-JOIN non-matches, so the empty-related-set pins hold: any=false / all=true.
    const pred = renderFilterCond(c.pred, dialect);
    const guard = `${c.sourceAlias}.${quoteIfNeeded(c.joinedPkColumn)} IS NOT NULL`;
    if (dialect === "sqlite") {
      // No boolean aggregates: MAX≡bool_or, MIN≡bool_and over 1/0. The outer CASE yields
      // NULL (not 0) for phantom rows so MIN/MAX ignore them — the COALESCE default then
      // supplies the empty-set pin (0 for any, 1 for all).
      const fn = c.quant === "any" ? "MAX" : "MIN";
      const empty = c.quant === "any" ? "0" : "1";
      return `COALESCE(${fn}(CASE WHEN ${guard} THEN (CASE WHEN ${pred} THEN 1 ELSE 0 END) END), ${empty}) AS ${alias}`;
    }
    const fn = c.quant === "any" ? "bool_or" : "bool_and";
    const empty = c.quant === "any" ? "FALSE" : "TRUE";
    return `COALESCE(${fn}(${pred}) FILTER (WHERE ${guard}), ${empty}) AS ${alias}`;
  }

  if (c.kind === "collectAgg") {
    const src = `${c.sourceAlias}.${quoteIfNeeded(c.sourceColumn)}`;
    const guard = `${c.sourceAlias}.${quoteIfNeeded(c.joinedPkColumn)} IS NOT NULL`;
    const distinctKw = c.distinct ? "DISTINCT " : "";
    // Element order: @distinct always orders by the value (PG's array_agg(DISTINCT x
    // ORDER BY x) co-occurrence rule); otherwise an explicit @orderBy, else the
    // value-ascending default (both for conformance byte-stability).
    const orderClause = !c.distinct && c.orderBy.length > 0
      ? `ORDER BY ${renderOrderKeys(c.orderBy, c.sourceAlias)}`
      : `ORDER BY ${src} ASC`;
    if (dialect === "sqlite") {
      // Unsorted here; the outer query of the two-level SQLite view sorts it (see
      // sqliteCollectInner / sqliteCollectOuter).
      return `${sqliteCollectInner(c)} AS ${alias}`;
    }
    return `COALESCE(array_agg(${distinctKw}${src} ${orderClause}) FILTER (WHERE ${guard}), '{}') AS ${alias}`;
  }

  if (c.kind === "collectObjectAgg") {
    if (dialect === "sqlite") {
      // SQLite: unsorted here; the outer query of the two-level view sorts it.
      return `${sqliteCollectInner(c)} AS ${alias}`;
    }
    // #335 whole-object rollup. jsonb, not json: PG's `json` has neither an equality
    // nor an ordering operator, so `json_agg(json_build_object(…) ORDER BY …)` does not
    // run — verified against a real PG 15.
    const guard = `${c.sourceAlias}.${quoteIfNeeded(c.joinedPkColumn)} IS NOT NULL`;
    const pk = `${c.sourceAlias}.${quoteIfNeeded(c.joinedPkColumn)}`;
    // Element order: the related entity's PK ascending by default — "value ascending"
    // is meaningless for an object (and does not parse on PG json). An explicit
    // @orderBy leads, with the PK appended as a tie-break so equal-order rows stay
    // byte-deterministic. The SCALAR arm above deliberately keeps its no-tie-break
    // behaviour: adding one there would alter emitted SQL for every existing project.
    const orderClause = c.orderBy.length > 0
      ? `ORDER BY ${renderOrderKeys(c.orderBy, c.sourceAlias)}, ${pk} ASC`
      : `ORDER BY ${pk} ASC`;
    // The JSON key is the VO MEMBER name; the value reads the TERMINAL entity's
    // physical column. Those two differ whenever a field carries @column.
    const pairs = c.members
      .map((m) => `'${m.memberName}', ${c.sourceAlias}.${quoteIfNeeded(m.sourceColumn)}`)
      .join(", ");
    // PG's jsonb_build_object already yields real jsonb, so jsonb_agg nests it correctly
    // with no wrapper — verified against a real engine, not assumed by symmetry.
    return `COALESCE(jsonb_agg(jsonb_build_object(${pairs}) ${orderClause}) FILTER (WHERE ${guard}), '[]'::jsonb) AS ${alias}`;
  }

  if (c.kind === "computed") {
    return `${renderExpr(c.expr, dialect)} AS ${alias}`;
  }

  // first — a correlated scalar subquery keyed on the base alias.
  return renderFirst(c, options, baseAlias);
}

function renderJoin(
  node: JoinNode,
  parentAlias: string,
  options: EmitOptions,
): string {
  const table = options.joinTables[node.targetEntity];
  if (!table) {
    throw new Error(
      `view-ddl-emit: no table name registered for joined entity "${node.targetEntity}".`,
    );
  }
  // JoinNode carries physical column names already resolved by extractViewSpec
  // (naming strategy + @column applied); quote them if the strategy produced a
  // case-sensitive identifier.
  const fkCol = quoteIfNeeded(node.fkColumn);
  const pkCol = quoteIfNeeded(node.pkColumn);
  const childAlias = node.alias;
  // referenceHolder = "source" → FK on parent (source): child.pk = parent.fk  (belongs-to)
  // referenceHolder = "target" → FK on child  (target): child.fk = parent.pk  (has-many)
  const onClause = node.referenceHolder === "source"
    ? `${childAlias}.${pkCol} = ${parentAlias}.${fkCol}`
    : `${childAlias}.${fkCol} = ${parentAlias}.${pkCol}`;
  // #209 — join type derived from FK optionality (extract-view-spec): a required
  // belongs-to FK → INNER (matches the hand-written INNER-join view); else LEFT OUTER.
  const joinKw = node.joinType === "inner" ? "INNER JOIN" : "LEFT OUTER JOIN";
  let sql = `  ${joinKw} ${quoteIfNeeded(table)} ${childAlias} ON ${onClause}`;
  for (const childJoin of node.children) {
    sql += "\n" + renderJoin(childJoin, childAlias, options);
  }
  return sql;
}

export function emitViewDdl(spec: ViewSpec, options: EmitOptions): string {
  const cols = spec.selectSpec.columns
    .map((c) => "    " + renderColumn(c, options, spec.joinTree.baseAlias))
    .join(",\n");
  const fromClause = `  FROM ${quoteIfNeeded(options.baseTableName)} ${spec.joinTree.baseAlias}`;
  const joinsClause = spec.joinTree.joins
    .map((j) => renderJoin(j, spec.joinTree.baseAlias, options))
    .join("\n");
  // #207 — a projection-level row @filter is an outer WHERE that scopes which base
  // rows the view returns. It renders AFTER the joins and BEFORE any GROUP BY (it
  // filters rows, not aggregate groups — a post-aggregate HAVING is a separate concern).
  const whereClause =
    spec.where !== undefined
      ? `\n  WHERE ${renderFilterCond(spec.where, options.dialect)}`
      : "";
  const groupByClause =
    spec.groupBy.length > 0
      ? `\n  GROUP BY ${spec.groupBy.map(quoteRef).join(", ")}`
      : "";

  const grouped = `  SELECT
${cols}
${fromClause}${joinsClause ? "\n" + joinsClause : ""}${whereClause}${groupByClause}`;

  // SQLite orders collect elements in an outer query over the grouped one — see
  // sqliteCollectInner for why. Every other column passes straight through.
  const collects = options.dialect === "sqlite" && spec.selectSpec.columns.some(isCollect);
  const body = !collects ? grouped : `  SELECT
${spec.selectSpec.columns
  .map((c) => "    " + (isCollect(c)
    ? sqliteCollectOuter(c)
    : `${GROUPED_ALIAS}.${quoteIfNeeded(c.dbColAlias)} AS ${quoteIfNeeded(c.dbColAlias)}`))
  .join(",\n")}
  FROM (
${grouped}
  ) ${GROUPED_ALIAS}`;

  if (options.bodyOnly) return body;
  return `CREATE VIEW ${quoteIfNeeded(spec.viewName)} AS
${body};`;
}
