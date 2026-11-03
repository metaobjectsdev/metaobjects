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
 * How a literal compared with a field is stored in that field's column, when that is not the
 * literal itself: an int-backed enum (`@intValueMap`) stores a member as its integer, and a
 * duration is an interval or a microsecond integer. Answers the
 * SQL for the stored value, or undefined to render the literal as written.
 */
export type StoredLiteral = (field: string, value: unknown) => string | undefined;

/** A node SQL can use as a comparison operand without parentheses. */
function isAtom(x: unknown): boolean {
  const n = x as Node;
  return typeof n["field"] === "string" || "value" in n || n["fn"] !== undefined;
}

/**
 * `node` as SQL. `column(field)` is the quoted physical column for a field name, or undefined
 * when the entity has no such field. A compound operand of a comparison or a null test is
 * parenthesised: `IS` binds looser than `=`, and `AND` / `OR` looser than both.
 */
export function renderExpressionSql(
  node: ExprNode, column: (field: string) => string | undefined, dialect: Dialect | undefined,
  stored?: StoredLiteral,
): string {
  const n = node as Node;
  if (typeof n["field"] === "string") {
    const col = column(n["field"]);
    if (col === undefined) throw new Error(`@condition names "${n["field"]}", which is not a field of the entity`);
    return col;
  }
  if ("value" in n) return renderLiteral(n["value"], dialect);
  const op = n["op"];
  const sub = (x: unknown): string => renderExpressionSql(x as ExprNode, column, dialect, stored);
  const operand = (x: unknown, other: unknown): string => {
    const field = storedFieldOf(other);
    if (stored !== undefined && "value" in (x as Node) && field !== undefined) {
      const sql = stored(field, (x as Node)["value"]);
      if (sql !== undefined) return sql;
    }
    return isAtom(x) ? sub(x) : `(${sub(x)})`;
  };
  if (typeof op === "string" && SQL_OP[op] !== undefined) {
    return `${operand(n["left"], n["right"])} ${SQL_OP[op]} ${operand(n["right"], n["left"])}`;
  }
  if (op === FILTER_OP_IS_NULL) return `${operand(n["arg"], undefined)} IS NULL`;
  if (op === EXPR_OP_IS_NOT_NULL) return `${operand(n["arg"], undefined)} IS NOT NULL`;
  if (op === EXPR_OP_NOT) return `NOT (${sub(n["arg"])})`;
  if (op === FILTER_COMPOSE_AND || op === FILTER_COMPOSE_OR) {
    return (n["args"] as unknown[]).map((a) => `(${sub(a)})`).join(op === FILTER_COMPOSE_AND ? " AND " : " OR ");
  }
  if (n["fn"] === EXPR_FN_COALESCE) return `COALESCE(${(n["args"] as unknown[]).map(sub).join(", ")})`;
  throw new Error(`@condition: an expression node migrate cannot render: ${JSON.stringify(node)}`);
}

/**
 * The field whose column form a literal compared with `node` takes: the field itself, or for a
 * `coalesce` the first field among its arguments (a coalesce of fields has their column type).
 */
function storedFieldOf(node: unknown): string | undefined {
  const n = (node ?? {}) as Node;
  if (typeof n["field"] === "string") return n["field"];
  if (n["fn"] === EXPR_FN_COALESCE && Array.isArray(n["args"])) {
    for (const a of n["args"] as unknown[]) {
      const f = storedFieldOf(a);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

function renderLiteral(v: unknown, dialect: Dialect | undefined): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return dialect === "sqlite" || dialect === "d1" ? (v ? "1" : "0") : (v ? "TRUE" : "FALSE");
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
