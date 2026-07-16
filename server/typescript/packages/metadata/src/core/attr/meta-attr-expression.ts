// attr.expression — the closed structured-expression node grammar backing
// origin.computed (#195). A row-level value computed from a base entity's own
// fields. Deliberately NOT a raw-SQL string: a declarative, backend-agnostic
// tree that any lowering (SQL view DDL, an in-process evaluator, a document
// store) can walk.
//
// It shares the FILTER op vocabulary and per-subtype legality bands
// (query-constants.ts) so the two languages stay ONE vocabulary, and a canonical
// filter object embeds into it (`filterToExpr`) — so each port implements one
// expression engine and the filter renderers become thin adapters. The filter's
// leaves are `field → {op: literal}` and cannot hold a value tree (field-vs-field,
// coalesce), which is why the expression tree is its own grammar rather than a
// reused filter object.
//
// This module exposes the STANDALONE grammar (validate / infer / embed) AND the
// `attr.expression` MetaAttr registration. The registration is only live once the
// subtype is in ATTR_SUBTYPES + the canonical spec (a COORDINATED cross-port step,
// since the registry manifest is a single shared byte-matched file) — #195.

import {
  FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
  FILTER_OP_IS_NULL, FILTER_COMPOSE_AND, FILTER_COMPOSE_OR,
  opsForSubType, type FilterOp,
} from "../query/query-constants.js";
import {
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_BOOLEAN,
} from "../field/field-constants.js";
import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "../../shared/meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../../data-type.js";
import { ATTR_SUBTYPE_EXPRESSION } from "./attr-constants.js";
import { registerAttrClass } from "../../attr-class-map.js";

// --- Expression-only op/fn names (the comparison + and/or/isNull names are the
// --- shared filter vocabulary above; these three are new). ---
export const EXPR_OP_IS_NOT_NULL = "isNotNull";
export const EXPR_OP_NOT = "not";
export const EXPR_FN_COALESCE = "coalesce";

const COMPARISON_OPS: ReadonlySet<string> = new Set([
  FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
]);
const NULL_OPS: ReadonlySet<string> = new Set([FILTER_OP_IS_NULL, EXPR_OP_IS_NOT_NULL]);
const VARIADIC_LOGIC_OPS: ReadonlySet<string> = new Set([FILTER_COMPOSE_AND, FILTER_COMPOSE_OR]);

export type ExprLiteral = string | number | boolean | null;
export type ExprNode =
  | { field: string }
  | { value: ExprLiteral }
  | { op: string; left: ExprNode; right: ExprNode }   // comparison
  | { op: string; arg: ExprNode }                     // isNull / isNotNull / not
  | { op: string; args: ExprNode[] }                  // and / or
  | { fn: string; args: ExprNode[] };                 // coalesce

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural well-formedness of an expression tree (known node kinds, ops, arity).
 *  Returns [] when valid. No entity/type context — see `inferExprType` for typing. */
export function validateExprNode(node: unknown): string[] {
  if (!isObj(node)) return [`expression node must be an object, got ${node === null ? "null" : Array.isArray(node) ? "array" : typeof node}`];
  if ("field" in node) {
    return typeof node.field === "string" && node.field.length > 0 ? [] : ["expression 'field' must be a non-empty string"];
  }
  if ("value" in node) {
    const v = node.value;
    return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
      ? [] : ["expression 'value' must be a scalar literal (string/number/boolean/null)"];
  }
  if ("fn" in node) {
    if (node.fn !== EXPR_FN_COALESCE) return [`unknown expression fn '${String(node.fn)}'`];
    return Array.isArray(node.args) && node.args.length >= 1
      ? node.args.flatMap(validateExprNode) : [`'${EXPR_FN_COALESCE}' requires a non-empty args array`];
  }
  if ("op" in node) {
    const op = node.op;
    if (typeof op !== "string") return ["expression 'op' must be a string"];
    if (COMPARISON_OPS.has(op)) {
      return "left" in node && "right" in node
        ? [...validateExprNode(node.left), ...validateExprNode(node.right)]
        : [`comparison op '${op}' requires 'left' and 'right'`];
    }
    if (NULL_OPS.has(op) || op === EXPR_OP_NOT) {
      return "arg" in node ? validateExprNode(node.arg) : [`op '${op}' requires 'arg'`];
    }
    if (VARIADIC_LOGIC_OPS.has(op)) {
      return Array.isArray(node.args) && node.args.length >= 1
        ? node.args.flatMap(validateExprNode) : [`op '${op}' requires a non-empty args array`];
    }
    return [`unknown expression op '${op}'`];
  }
  return ["expression node must be one of {field}, {value}, {op,…}, {fn,…}"];
}

/** The subtype of a scalar literal (coarse: an integer number → int, else double). */
function literalType(v: ExprLiteral): string | undefined {
  if (typeof v === "string") return FIELD_SUBTYPE_STRING;
  if (typeof v === "boolean") return FIELD_SUBTYPE_BOOLEAN;
  if (typeof v === "number") return Number.isInteger(v) ? FIELD_SUBTYPE_INT : FIELD_SUBTYPE_DOUBLE;
  return undefined; // null literal
}

export interface InferResult {
  /** The inferred field subType of the expression's root, or undefined if untypable. */
  type: string | undefined;
  /** Type/resolution/op-legality errors (empty when the tree types cleanly). */
  errors: string[];
}

/**
 * Bottom-up type inference for a computed expression. `resolveField(name)` returns
 * the subType of a base-entity field ref (undefined = unresolvable). Comparisons /
 * null-tests / logic → boolean; a field ref → its subType; coalesce → the unified
 * arg subType. Also enforces per-operand op legality against `OPS_BY_SUBTYPE`
 * (the same bands filters use), so e.g. `gt` on a boolean operand is rejected.
 */
export function inferExprType(node: ExprNode, resolveField: (name: string) => string | undefined): InferResult {
  const structural = validateExprNode(node);
  if (structural.length) return { type: undefined, errors: structural };
  const n = node as Record<string, unknown>;

  if ("field" in n) {
    const t = resolveField(n.field as string);
    return t === undefined
      ? { type: undefined, errors: [`expression field '${String(n.field)}' does not resolve to a base entity field`] }
      : { type: t, errors: [] };
  }
  if ("value" in n) return { type: literalType(n.value as ExprLiteral), errors: [] };

  if ("fn" in n) { // coalesce
    const argResults = (n.args as ExprNode[]).map((a) => inferExprType(a, resolveField));
    const errors = argResults.flatMap((a) => a.errors);
    const argTypes = argResults.map((a) => a.type).filter((t): t is string => t !== undefined);
    const unified = argTypes[0];
    if (unified !== undefined && argTypes.some((t) => t !== unified)) {
      errors.push(`'${EXPR_FN_COALESCE}' arguments have differing types (${[...new Set(argTypes)].join(", ")})`);
    }
    return { type: unified, errors };
  }

  const op = n.op as string;
  if (COMPARISON_OPS.has(op)) {
    const l = inferExprType(n.left as ExprNode, resolveField);
    const r = inferExprType(n.right as ExprNode, resolveField);
    const errors = [...l.errors, ...r.errors];
    if (l.type !== undefined && !opsForSubType(l.type).includes(op as FilterOp)) {
      errors.push(`op '${op}' is not legal for a ${l.type} operand`);
    }
    return { type: FIELD_SUBTYPE_BOOLEAN, errors };
  }
  if (NULL_OPS.has(op)) {
    return { type: FIELD_SUBTYPE_BOOLEAN, errors: inferExprType(n.arg as ExprNode, resolveField).errors };
  }
  if (op === EXPR_OP_NOT || VARIADIC_LOGIC_OPS.has(op)) {
    const kids = op === EXPR_OP_NOT ? [n.arg as ExprNode] : (n.args as ExprNode[]);
    const errors: string[] = [];
    for (const k of kids) {
      const kt = inferExprType(k, resolveField);
      errors.push(...kt.errors);
      if (kt.type !== undefined && kt.type !== FIELD_SUBTYPE_BOOLEAN) {
        errors.push(`op '${op}' requires boolean operands, got ${kt.type}`);
      }
    }
    return { type: FIELD_SUBTYPE_BOOLEAN, errors };
  }
  return { type: undefined, errors: [`unknown expression op '${op}'`] };
}

/**
 * Embed a CANONICAL filter object (`{ field: { op: value } }` with `and`/`or`
 * composition — the desugared `attr.filter` form) into an expression tree, so the
 * two languages share one evaluator. `isNull: false` becomes `isNotNull`.
 */
export function filterToExpr(filter: Record<string, unknown>): ExprNode {
  const clauses: ExprNode[] = [];
  for (const [key, raw] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_AND || key === FILTER_COMPOSE_OR) {
      const subs = (raw as Record<string, unknown>[]).map(filterToExpr);
      clauses.push({ op: key, args: subs });
      continue;
    }
    const opObj = raw as Record<string, ExprLiteral>;
    for (const [op, val] of Object.entries(opObj)) {
      if (op === FILTER_OP_IS_NULL) {
        clauses.push(val === false
          ? { op: EXPR_OP_IS_NOT_NULL, arg: { field: key } }
          : { op: FILTER_OP_IS_NULL, arg: { field: key } });
      } else {
        clauses.push({ op, left: { field: key }, right: { value: val } });
      }
    }
  }
  const [only] = clauses;
  return clauses.length === 1 && only !== undefined ? only : { op: FILTER_COMPOSE_AND, args: clauses };
}

/**
 * ExpressionAttr — attr subtype `expression`. Object-shaped value holding a
 * closed expression tree (`@expr` on origin.computed). Stored verbatim (no
 * desugar); `validateValue` enforces STRUCTURAL well-formedness of the node
 * grammar (a fail-closed unknown op/fn/kind is a load error, ADR-0023). Entity-
 * aware TYPE inference (`inferExprType` → ERR_COMPUTED_TYPE_MISMATCH) runs later
 * in the projection validation pass, where the base entity's fields are known.
 */
export class ExpressionAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_OBJECT;
  }

  override coerce(raw: unknown): AttrValue {
    // The expression tree is the canonical shape; pass a non-object through so
    // validateValue rejects it.
    return raw as AttrValue;
  }

  override validateValue(value: AttrValue): ValueError[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [{ message: `attribute '@${this.name}' must be of type 'expression' but got ${runtimeTypeName(value)}` }];
    }
    return validateExprNode(value).map((message) => ({ message }));
  }
}

registerAttrClass(ATTR_SUBTYPE_EXPRESSION, ExpressionAttr);
