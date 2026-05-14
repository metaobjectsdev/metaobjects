import { toSnakeCase } from "../naming.js";
import type { JoinNode, ViewSpec } from "./view-spec.js";

export interface EmitOptions {
  readonly dialect: "postgres" | "sqlite";
  /** Resolved table name for the JoinTree's base entity. */
  readonly baseTableName: string;
  /** Map from entity name → table name for every entity referenced in joins. */
  readonly joinTables: Readonly<Record<string, string>>;
}

function renderColumn(c: import("./view-spec.js").SelectColumn): string {
  if (c.kind === "passthrough") {
    return `${c.sourceAlias}.${c.sourceColumn} AS ${c.dbColAlias}`;
  }
  // aggregate — use DISTINCT for count() over joined PKs to avoid join inflation.
  if (c.agg === "count") {
    return `COUNT(DISTINCT ${c.sourceAlias}.${c.sourceColumn}) AS ${c.dbColAlias}`;
  }
  return `${c.agg.toUpperCase()}(${c.sourceAlias}.${c.sourceColumn}) AS ${c.dbColAlias}`;
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
  // JoinNode stores raw camelCase field names from metadata (e.g. "programId").
  // Emit always applies snake_case — view DDL is SQL-side and always snake_case.
  const fkCol = toSnakeCase(node.fkField);
  const parentCol = toSnakeCase(node.parentJoinField);
  const childAlias = node.alias;
  let sql = `  LEFT OUTER JOIN ${table} ${childAlias} ON ${childAlias}.${fkCol} = ${parentAlias}.${parentCol}`;
  for (const childJoin of node.children) {
    sql += "\n" + renderJoin(childJoin, childAlias, options);
  }
  return sql;
}

export function emitViewDdl(spec: ViewSpec, options: EmitOptions): string {
  const cols = spec.selectSpec.columns
    .map((c) => "    " + renderColumn(c))
    .join(",\n");
  const fromClause = `  FROM ${options.baseTableName} ${spec.joinTree.baseAlias}`;
  const joinsClause = spec.joinTree.joins
    .map((j) => renderJoin(j, spec.joinTree.baseAlias, options))
    .join("\n");
  const groupByClause =
    spec.groupBy.length > 0 ? `\n  GROUP BY ${spec.groupBy.join(", ")}` : "";

  return `CREATE VIEW ${spec.viewName} AS
  SELECT
${cols}
${fromClause}${joinsClause ? "\n" + joinsClause : ""}${groupByClause};`;
}
