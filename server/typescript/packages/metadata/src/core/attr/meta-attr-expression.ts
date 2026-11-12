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
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_CURRENCY, FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIMESTAMP,
} from "../field/field-constants.js";
import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "../../shared/meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../../data-type.js";
import { ATTR_SUBTYPE_EXPRESSION } from "./attr-constants.js";
import { registerAttrClass } from "../../attr-class-map.js";
import {
  FILTER_RELATIVE_NOW, FILTER_RELATIVE_START_OF, ISO_DURATION_RE, RELATIVE_START_OF_UNITS,
} from "../reporting/reporting-constants.js";

// --- Expression-only op/fn names (the comparison + and/or/isNull names are the
// --- shared filter vocabulary above; these three are new). ---
export const EXPR_OP_IS_NOT_NULL = "isNotNull";
export const EXPR_OP_NOT = "not";
export const EXPR_FN_COALESCE = "coalesce";
// `case`: { case: [ { when, then }, ... ], else?, operand? } — searched, or simple with operand.
export const EXPR_CASE = "case";
export const EXPR_CASE_WHEN = "when";
export const EXPR_CASE_THEN = "then";
export const EXPR_CASE_ELSE = "else";
export const EXPR_CASE_OPERAND = "operand";
// `now`: { now: "<ISO-8601 duration>", startOf? } — the relative-date value, as a leaf.
export const EXPR_NOW = FILTER_RELATIVE_NOW;
export const EXPR_NOW_START_OF = FILTER_RELATIVE_START_OF;

const COMPARISON_OPS: ReadonlySet<string> = new Set([
  FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
]);
const NULL_OPS: ReadonlySet<string> = new Set([FILTER_OP_IS_NULL, EXPR_OP_IS_NOT_NULL]);
const VARIADIC_LOGIC_OPS: ReadonlySet<string> = new Set([FILTER_COMPOSE_AND, FILTER_COMPOSE_OR]);

/** Each node kind (keyed by the key that names it) and the only keys it may carry. */
const NODE_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["field", ["field"]],
  ["value", ["value"]],
  [EXPR_NOW, [EXPR_NOW, EXPR_NOW_START_OF]],
  [EXPR_CASE, [EXPR_CASE, EXPR_CASE_ELSE, EXPR_CASE_OPERAND]],
  ["fn", ["fn", "args"]],
  ["op", ["op", "left", "right", "arg", "args"]],
]);
const ARM_KEYS: readonly string[] = [EXPR_CASE_WHEN, EXPR_CASE_THEN];
const NUMERIC_SUBTYPES: ReadonlySet<string> = new Set([
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_CURRENCY,
]);

export type ExprLiteral = string | number | boolean | null;
export type ExprNode =
  | { field: string }
  | { value: ExprLiteral }
  | { op: string; left: ExprNode; right: ExprNode }   // comparison
  | { op: string; arg: ExprNode }                     // isNull / isNotNull / not
  | { op: string; args: ExprNode[] }                  // and / or
  | { fn: string; args: ExprNode[] }                  // coalesce
  | { case: { when: ExprNode; then: ExprNode }[]; else?: ExprNode; operand?: ExprNode } // case
  | { now: string; startOf?: string };                // now

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural well-formedness of an expression tree (known node kinds, ops, arity).
 *  Returns [] when valid. No entity/type context — see `inferExprType` for typing. */
export function validateExprNode(node: unknown): string[] {
  if (!isObj(node)) return [`expression node must be an object, got ${node === null ? "null" : Array.isArray(node) ? "array" : typeof node}`];
  const kind = [...NODE_KEYS.entries()].find(([k]) => k in node);
  const extra = kind === undefined ? [] : Object.keys(node).filter((k) => !kind[1].includes(k));
  if (kind !== undefined && extra.length > 0) return [`expression '${kind[0]}' node takes only ${kind[1].join(", ")}, not ${extra.join(", ")}`];
  if ("field" in node) {
    return typeof node.field === "string" && node.field.length > 0 ? [] : ["expression 'field' must be a non-empty string"];
  }
  if ("value" in node) {
    const v = node.value;
    return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
      ? [] : ["expression 'value' must be a scalar literal (string/number/boolean/null)"];
  }
  if (EXPR_NOW in node) {
    const duration = node[EXPR_NOW];
    if (typeof duration !== "string" || !ISO_DURATION_RE.test(duration)) {
      return [`expression '${EXPR_NOW}' must be an ISO-8601 duration string (e.g. '-P7D'), got ${JSON.stringify(duration)}`];
    }
    const startOf = node[EXPR_NOW_START_OF];
    return EXPR_NOW_START_OF in node && !(RELATIVE_START_OF_UNITS as readonly unknown[]).includes(startOf)
      ? [`expression '${EXPR_NOW_START_OF}' must be one of ${RELATIVE_START_OF_UNITS.join(", ")}, got ${JSON.stringify(startOf)}`]
      : [];
  }
  if (EXPR_CASE in node) {
    const arms = node[EXPR_CASE];
    if (!Array.isArray(arms) || arms.length === 0) return [`'${EXPR_CASE}' requires a non-empty array of { ${EXPR_CASE_WHEN}, ${EXPR_CASE_THEN} } arms`];
    const errs: string[] = [];
    for (const arm of arms) {
      if (!isObj(arm) || !(EXPR_CASE_WHEN in arm) || !(EXPR_CASE_THEN in arm) || Object.keys(arm).some((k) => !ARM_KEYS.includes(k))) {
        errs.push(`every '${EXPR_CASE}' arm must be { ${EXPR_CASE_WHEN}, ${EXPR_CASE_THEN} }`);
        continue;
      }
      errs.push(...validateExprNode(arm[EXPR_CASE_WHEN]), ...validateExprNode(arm[EXPR_CASE_THEN]));
    }
    if (EXPR_CASE_ELSE in node) errs.push(...validateExprNode(node[EXPR_CASE_ELSE]));
    if (EXPR_CASE_OPERAND in node) errs.push(...validateExprNode(node[EXPR_CASE_OPERAND]));
    return errs;
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
  return ["expression node must be one of {field}, {value}, {op,…}, {fn,…}, {case,…}, {now}"];
}

/** The subtype of a scalar literal (coarse: an integer number → int, else double). */
function literalType(v: ExprLiteral): string | undefined {
  if (typeof v === "string") return FIELD_SUBTYPE_STRING;
  if (typeof v === "boolean") return FIELD_SUBTYPE_BOOLEAN;
  if (typeof v === "number") return Number.isInteger(v) ? FIELD_SUBTYPE_INT : FIELD_SUBTYPE_DOUBLE;
  return undefined; // null literal
}

/** A numeric literal or a `now` node: it takes the type of the result it sits beside. */
function isAdaptable(node: unknown): boolean {
  const n = node as Record<string, unknown>;
  return ("value" in n && typeof n.value === "number") || EXPR_NOW in n;
}

/** Whether an adaptable node takes `to`: a number takes any numeric type, `now` a date or timestamp. */
function adaptsTo(node: unknown, to: string): boolean {
  return EXPR_NOW in (node as Record<string, unknown>)
    ? to === FIELD_SUBTYPE_DATE || to === FIELD_SUBTYPE_TIMESTAMP
    : NUMERIC_SUBTYPES.has(to);
}

/** The one type of a case's results or a coalesce's args, or `differing` when they do not unify. */
function unifyTypes(nodes: readonly unknown[], types: readonly (string | undefined)[]): { type: string | undefined; differing?: string[] } {
  const typed = nodes.flatMap((node, i) => { const type = types[i]; return type === undefined ? [] : [{ node, type }]; });
  const anchor = typed.find((r) => !isAdaptable(r.node));
  const unified = (anchor ?? typed[0])?.type;
  const fits = typed.every((r) => r.type === unified || (anchor !== undefined && isAdaptable(r.node) && adaptsTo(r.node, anchor.type)));
  return fits ? { type: unified } : { type: unified, differing: [...new Set(typed.map((r) => r.type))] };
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
      ? { type: undefined, errors: [`expression field '${String(n.field)}' does not resolve to a projection field (not an aggregate) or a base entity field`] }
      : { type: t, errors: [] };
  }
  if ("value" in n) return { type: literalType(n.value as ExprLiteral), errors: [] };
  // now: an instant; compared with a date or local timestamp it takes that kind at lowering.
  if (EXPR_NOW in n) return { type: FIELD_SUBTYPE_TIMESTAMP, errors: [] };
  if (EXPR_CASE in n) {
    const errors: string[] = [];
    const arms = n[EXPR_CASE] as { when: ExprNode; then: ExprNode }[];
    const operand = EXPR_CASE_OPERAND in n ? inferExprType(n[EXPR_CASE_OPERAND] as ExprNode, resolveField) : undefined;
    if (operand !== undefined) errors.push(...operand.errors);
    const results: (string | undefined)[] = [];
    const resultNodes: unknown[] = [];
    for (const arm of arms) {
      const w = inferExprType(arm.when, resolveField);
      errors.push(...w.errors);
      if (operand === undefined && w.type !== undefined && w.type !== FIELD_SUBTYPE_BOOLEAN) {
        errors.push(`a searched '${EXPR_CASE}' needs a boolean '${EXPR_CASE_WHEN}', got ${w.type}`);
      }
      if (operand?.type !== undefined && w.type !== undefined && !("value" in arm.when) && w.type !== operand.type) {
        errors.push(`a simple '${EXPR_CASE}' compares its ${operand.type} '${EXPR_CASE_OPERAND}' with a ${w.type} '${EXPR_CASE_WHEN}'`);
      }
      const t = inferExprType(arm.then, resolveField);
      errors.push(...t.errors);
      results.push(t.type);
      resultNodes.push(arm.then);
    }
    if (EXPR_CASE_ELSE in n) {
      const e = inferExprType(n[EXPR_CASE_ELSE] as ExprNode, resolveField);
      errors.push(...e.errors);
      results.push(e.type);
      resultNodes.push(n[EXPR_CASE_ELSE]);
    }
    const unified = unifyTypes(resultNodes, results);
    if (unified.differing !== undefined) {
      errors.push(`'${EXPR_CASE}' results have differing types (${unified.differing.join(", ")})`);
    }
    return { type: unified.type, errors };
  }

  if ("fn" in n) { // coalesce
    const argResults = (n.args as ExprNode[]).map((a) => inferExprType(a, resolveField));
    const errors = argResults.flatMap((a) => a.errors);
    const unified = unifyTypes(n.args as ExprNode[], argResults.map((a) => a.type));
    if (unified.differing !== undefined) {
      errors.push(`'${EXPR_FN_COALESCE}' arguments have differing types (${unified.differing.join(", ")})`);
    }
    return { type: unified.type, errors };
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
    // Only shape (must be an object) is checked here — the CLOSED node grammar
    // (fail-closed unknown op/fn/kind → ERR_UNKNOWN_EXPR_NODE) and entity-aware
    // type inference are validated in the origin.computed validation pass, where
    // the base entity's fields are known. Keeping the deep check out of the attr
    // class matches the cross-port contract (C#/Java/Python store @expr verbatim)
    // and mirrors FilterAttr, which likewise validates only shape.
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? []
      : [{ message: `attribute '@${this.name}' must be of type 'expression' but got ${runtimeTypeName(value)}` }];
  }
}

registerAttrClass(ATTR_SUBTYPE_EXPRESSION, ExpressionAttr);
