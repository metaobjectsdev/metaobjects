import type { JoinNode, ViewSpec, ViewFilterClause } from "./view-spec.js";

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
  const ref = quoteRef(clause.ref);
  if (clause.op === "isNull") return clause.value === false ? `${ref} IS NOT NULL` : `${ref} IS NULL`;
  if (clause.op === "in") {
    const vals = (Array.isArray(clause.value) ? clause.value : [clause.value]).map((v) => sqlLiteral(v, dialect));
    return `${ref} IN (${vals.join(", ")})`;
  }
  const op = FILTER_OP_SQL[clause.op];
  if (!op) throw new Error(`view-ddl-emit: unsupported aggregate filter operator "${clause.op}".`);
  return `${ref} ${op} ${sqlLiteral(clause.value, dialect)}`;
}

function renderColumn(c: import("./view-spec.js").SelectColumn, dialect: EmitOptions["dialect"]): string {
  const src = `${c.sourceAlias}.${quoteIfNeeded(c.sourceColumn)}`;
  const alias = quoteIfNeeded(c.dbColAlias);
  if (c.kind === "passthrough") {
    return `${src} AS ${alias}`;
  }
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
  let sql = `  LEFT OUTER JOIN ${quoteIfNeeded(table)} ${childAlias} ON ${onClause}`;
  for (const childJoin of node.children) {
    sql += "\n" + renderJoin(childJoin, childAlias, options);
  }
  return sql;
}

export function emitViewDdl(spec: ViewSpec, options: EmitOptions): string {
  const cols = spec.selectSpec.columns
    .map((c) => "    " + renderColumn(c, options.dialect))
    .join(",\n");
  const fromClause = `  FROM ${quoteIfNeeded(options.baseTableName)} ${spec.joinTree.baseAlias}`;
  const joinsClause = spec.joinTree.joins
    .map((j) => renderJoin(j, spec.joinTree.baseAlias, options))
    .join("\n");
  const groupByClause =
    spec.groupBy.length > 0
      ? `\n  GROUP BY ${spec.groupBy.map(quoteRef).join(", ")}`
      : "";

  const body = `  SELECT
${cols}
${fromClause}${joinsClause ? "\n" + joinsClause : ""}${groupByClause}`;

  if (options.bodyOnly) return body;
  return `CREATE VIEW ${quoteIfNeeded(spec.viewName)} AS
${body};`;
}
