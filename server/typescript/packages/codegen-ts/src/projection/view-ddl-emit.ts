import type { JoinNode, ViewSpec } from "./view-spec.js";

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

function renderColumn(c: import("./view-spec.js").SelectColumn): string {
  const src = `${c.sourceAlias}.${quoteIfNeeded(c.sourceColumn)}`;
  const alias = quoteIfNeeded(c.dbColAlias);
  if (c.kind === "passthrough") {
    return `${src} AS ${alias}`;
  }
  // aggregate — use DISTINCT for count() over joined PKs to avoid join inflation.
  if (c.agg === "count") {
    return `COUNT(DISTINCT ${src}) AS ${alias}`;
  }
  return `${c.agg.toUpperCase()}(${src}) AS ${alias}`;
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
    .map((c) => "    " + renderColumn(c))
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
