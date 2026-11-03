// check-expression.ts — render an attr.expression tree (a cross-field validator's @condition)
// as SQL for a CHECK constraint, and negate one so `NOT (condition) OR (rule)` reads the way it
// would be written by hand: `"a" <> "b" OR …`, not `NOT ("a" = "b") OR …`.
//
// The negation is exact in SQL's three-valued logic: a flipped comparison is NULL exactly when
// the original is, isNull/isNotNull swap, and/or follow De Morgan. A field resolves to its
// physical column through the caller's lookup; a field the lookup does not know refuses the
// render (the loader refuses that model first, ERR_BAD_ATTR_VALUE).

import {
  EXPR_FN_COALESCE,
  EXPR_OP_IS_NOT_NULL,
  EXPR_OP_NOT,
  FILTER_COMPOSE_AND,
  FILTER_COMPOSE_OR,
  FILTER_OP_EQ,
  FILTER_OP_GT,
  FILTER_OP_GTE,
  FILTER_OP_IS_NULL,
  FILTER_OP_LT,
  FILTER_OP_LTE,
  FILTER_OP_NE,
  type ExprNode,
} from "@metaobjectsdev/metadata";
import type { Dialect } from "./types.js";

const SQL_OP: Readonly<Record<string, string>> = {
  [FILTER_OP_EQ]: "=", [FILTER_OP_NE]: "<>", [FILTER_OP_GT]: ">",
  [FILTER_OP_GTE]: ">=", [FILTER_OP_LT]: "<", [FILTER_OP_LTE]: "<=",
};

const NEGATED_OP: Readonly<Record<string, string>> = {
  [FILTER_OP_EQ]: FILTER_OP_NE, [FILTER_OP_NE]: FILTER_OP_EQ,
  [FILTER_OP_GT]: FILTER_OP_LTE, [FILTER_OP_LTE]: FILTER_OP_GT,
  [FILTER_OP_LT]: FILTER_OP_GTE, [FILTER_OP_GTE]: FILTER_OP_LT,
  [FILTER_OP_IS_NULL]: EXPR_OP_IS_NOT_NULL, [EXPR_OP_IS_NOT_NULL]: FILTER_OP_IS_NULL,
};

type Node = Record<string, unknown>;

/** The logical negation of `node`, pushed down to its comparisons. */
export function negateExpression(node: ExprNode): ExprNode {
  const n = node as Node;
  const op = n["op"];
  if (op === EXPR_OP_NOT) return n["arg"] as ExprNode;
  if (op === FILTER_COMPOSE_AND || op === FILTER_COMPOSE_OR) {
    return {
      op: op === FILTER_COMPOSE_AND ? FILTER_COMPOSE_OR : FILTER_COMPOSE_AND,
      args: (n["args"] as ExprNode[]).map(negateExpression),
    } as ExprNode;
  }
  if (typeof op === "string" && NEGATED_OP[op] !== undefined) {
    return { ...n, op: NEGATED_OP[op] } as ExprNode;
  }
  return { op: EXPR_OP_NOT, arg: node } as ExprNode;
}

/**
 * `node` as SQL. `column(field)` is the quoted physical column for a field name, or undefined
 * when the entity has no such field.
 */
export function renderExpressionSql(
  node: ExprNode, column: (field: string) => string | undefined, dialect: Dialect | undefined,
): string {
  const n = node as Node;
  if (typeof n["field"] === "string") {
    const col = column(n["field"]);
    if (col === undefined) throw new Error(`@condition names "${n["field"]}", which is not a field of the entity`);
    return col;
  }
  if ("value" in n) return renderLiteral(n["value"], dialect);
  const op = n["op"];
  const sub = (x: unknown): string => renderExpressionSql(x as ExprNode, column, dialect);
  if (typeof op === "string" && SQL_OP[op] !== undefined) return `${sub(n["left"])} ${SQL_OP[op]} ${sub(n["right"])}`;
  if (op === FILTER_OP_IS_NULL) return `${sub(n["arg"])} IS NULL`;
  if (op === EXPR_OP_IS_NOT_NULL) return `${sub(n["arg"])} IS NOT NULL`;
  if (op === EXPR_OP_NOT) return `NOT (${sub(n["arg"])})`;
  if (op === FILTER_COMPOSE_AND || op === FILTER_COMPOSE_OR) {
    return (n["args"] as unknown[]).map((a) => `(${sub(a)})`).join(op === FILTER_COMPOSE_AND ? " AND " : " OR ");
  }
  if (n["fn"] === EXPR_FN_COALESCE) return `COALESCE(${(n["args"] as unknown[]).map(sub).join(", ")})`;
  throw new Error(`@condition: an expression node migrate cannot render: ${JSON.stringify(node)}`);
}

function renderLiteral(v: unknown, dialect: Dialect | undefined): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return dialect === "sqlite" || dialect === "d1" ? (v ? "1" : "0") : (v ? "TRUE" : "FALSE");
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
