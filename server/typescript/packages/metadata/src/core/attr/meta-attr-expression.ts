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
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_TIMESTAMP,
} from "../field/field-constants.js";
import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue } from "../../shared/meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../../data-type.js";
import { ATTR_SUBTYPE_EXPRESSION } from "./attr-constants.js";
import { registerAttrClass } from "../../attr-class-map.js";
import { FILTER_RELATIVE_NOW, FILTER_RELATIVE_START_OF } from "../reporting/reporting-constants.js";
import {
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP, FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_CURRENCY,
} from "../field/field-constants.js";
import { parseDbColumnType } from "../../persistence/db/db-constants.js";

// --- Expression-only op/fn names (the comparison + and/or/isNull names are the
// --- shared filter vocabulary above; these three are new). ---
export const EXPR_OP_IS_NOT_NULL = "isNotNull";
export const EXPR_OP_NOT = "not";
export const EXPR_FN_COALESCE = "coalesce";
// rc.19 `case`: { case: [ { when, then }, ... ], else?, operand? } — searched, or simple with operand.
export const EXPR_CASE = "case";
export const EXPR_CASE_WHEN = "when";
export const EXPR_CASE_THEN = "then";
export const EXPR_CASE_ELSE = "else";
export const EXPR_CASE_OPERAND = "operand";
// rc.19 `now`: { now: "<ISO-8601 duration>", startOf? } — the relative-date value, as a leaf.
export const EXPR_NOW = FILTER_RELATIVE_NOW;
export const EXPR_NOW_START_OF = FILTER_RELATIVE_START_OF;
// rc.21 part B (U12): { cast: <expr>, as: "<field subtype>", dbColumnType?: "<text spelling>" }.
export const EXPR_CAST = "cast";
export const EXPR_CAST_AS = "as";
export const EXPR_CAST_DB_COLUMN_TYPE = "dbColumnType";
// rc.21 part B (U11, U13): the closed, typed function set beside coalesce.
export const EXPR_FN_GREATEST = "greatest";
export const EXPR_FN_LEAST = "least";
export const EXPR_FN_NULLIF = "nullif";
export const EXPR_FN_LOWER = "lower";
export const EXPR_FN_UPPER = "upper";
export const EXPR_FN_BTRIM = "btrim";
export const EXPR_FN_SPLIT_PART = "splitPart";
export const EXPR_FN_CONCAT = "concat";
export const EXPR_FN_CONCAT_WS = "concatWs";
export const EXPR_FN_SUBSTRING = "substring";
export const EXPR_FN_REPLACE = "replace";
export const EXPR_FN_LEFT = "left";
export const EXPR_FN_RIGHT = "right";
export const EXPR_FN_LENGTH = "length";

/** A function parameter's kind: a string, an integer, any scalar, or the type the "same" ones share. */
type ParamKind = "string" | "int" | "scalar" | "same";
/** One function's signature: its arity, each parameter's kind (the last repeats), and its result. */
interface FnSignature {
  readonly min: number;
  readonly max: number; // Infinity for variadic
  readonly params: readonly ParamKind[];
  readonly result: "string" | "int" | "same";
  /** The "same" type must be orderable (greatest / least). */
  readonly ordered?: boolean;
}
const VARIADIC = Number.POSITIVE_INFINITY;
/**
 * rc.21 part B: every expression function, by name. A closed set — never free SQL. Each lowers to
 * the dialect's own function (Postgres and SQLite spellings live in the view emitter).
 */
export const EXPR_FUNCTIONS: Readonly<Record<string, FnSignature>> = {
  [EXPR_FN_COALESCE]: { min: 1, max: VARIADIC, params: ["same"], result: "same" },
  [EXPR_FN_GREATEST]: { min: 1, max: VARIADIC, params: ["same"], result: "same", ordered: true },
  [EXPR_FN_LEAST]: { min: 1, max: VARIADIC, params: ["same"], result: "same", ordered: true },
  [EXPR_FN_NULLIF]: { min: 2, max: 2, params: ["same", "same"], result: "same" },
  [EXPR_FN_LOWER]: { min: 1, max: 1, params: ["string"], result: "string" },
  [EXPR_FN_UPPER]: { min: 1, max: 1, params: ["string"], result: "string" },
  [EXPR_FN_BTRIM]: { min: 1, max: 2, params: ["string", "string"], result: "string" },
  [EXPR_FN_SPLIT_PART]: { min: 3, max: 3, params: ["string", "string", "int"], result: "string" },
  [EXPR_FN_CONCAT]: { min: 1, max: VARIADIC, params: ["scalar"], result: "string" },
  [EXPR_FN_CONCAT_WS]: { min: 2, max: VARIADIC, params: ["string", "scalar"], result: "string" },
  [EXPR_FN_SUBSTRING]: { min: 2, max: 3, params: ["string", "int", "int"], result: "string" },
  [EXPR_FN_REPLACE]: { min: 3, max: 3, params: ["string", "string", "string"], result: "string" },
  [EXPR_FN_LEFT]: { min: 2, max: 2, params: ["string", "int"], result: "string" },
  [EXPR_FN_RIGHT]: { min: 2, max: 2, params: ["string", "int"], result: "string" },
  [EXPR_FN_LENGTH]: { min: 1, max: 1, params: ["string"], result: "int" },
};

/** The field subtypes a cast may name in `as`. */
export const EXPR_CAST_TARGETS: readonly string[] = [
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIMESTAMP, FIELD_SUBTYPE_UUID,
];
const NUMERIC_SUBTYPES: ReadonlySet<string> = new Set([
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL, FIELD_SUBTYPE_CURRENCY,
]);
const INTEGER_SUBTYPES: ReadonlySet<string> = new Set([FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG]);
const NON_SCALAR_SUBTYPES: ReadonlySet<string> = new Set([FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP]);

/**
 * Why a value of `from` cannot be cast to `to`, or undefined when it can. `intStoredEnum` is
 * whether the operand is an enum field stored as an integer (`@intValueMap`). The same table in
 * every port: a cast never makes a value of a kind the source cannot hold.
 */
export function castProblem(from: string | undefined, to: string, intStoredEnum: boolean): string | undefined {
  if (from === undefined) return undefined; // a null literal casts to anything
  if (NON_SCALAR_SUBTYPES.has(from)) return `a field.${from} value cannot be cast`;
  if (from === to) return undefined;
  if (from === FIELD_SUBTYPE_ENUM) {
    if (to === FIELD_SUBTYPE_STRING) return intStoredEnum ? "an int-stored enum (@intValueMap) cast to string gives its integer, not its member; cast it to int" : undefined;
    if (INTEGER_SUBTYPES.has(to)) return intStoredEnum ? undefined : "only an enum stored as an integer (@intValueMap) can be cast to a number";
    return `an enum cannot be cast to ${to}`;
  }
  if (to === FIELD_SUBTYPE_STRING) return undefined;
  if (from === FIELD_SUBTYPE_STRING) return undefined; // the database parses it
  // Postgres casts a boolean only to and from integer (int4), so those are the only number casts.
  if (NUMERIC_SUBTYPES.has(to)) {
    if (from === FIELD_SUBTYPE_BOOLEAN) return to === FIELD_SUBTYPE_INT ? undefined : `a boolean casts only to int, not ${to}`;
    return NUMERIC_SUBTYPES.has(from) ? undefined : `a ${from} cannot be cast to ${to}`;
  }
  if (to === FIELD_SUBTYPE_BOOLEAN) return from === FIELD_SUBTYPE_INT ? undefined : `a ${from} cannot be cast to boolean; only an int can`;
  if (to === FIELD_SUBTYPE_DATE || to === FIELD_SUBTYPE_TIMESTAMP) {
    return from === FIELD_SUBTYPE_DATE || from === FIELD_SUBTYPE_TIMESTAMP ? undefined : `a ${from} cannot be cast to ${to}`;
  }
  return `a ${from} cannot be cast to ${to}`;
}

/** The function names an expression tree calls, and whether it casts, for the CHECK-condition subset. */
export function exprViewOnlyNode(node: unknown): string | undefined {
  if (!isObj(node)) return undefined;
  if (EXPR_CAST in node) return EXPR_CAST;
  if (EXPR_CASE in node) return EXPR_CASE;
  if (EXPR_NOW in node) return EXPR_NOW;
  if ("fn" in node && node.fn !== EXPR_FN_COALESCE) return String(node.fn);
  if (typeof node.field === "string" && node.field.includes(".")) return `the path "${node.field}"`;
  for (const key of ["left", "right", "arg"]) {
    const hit = exprViewOnlyNode(node[key]);
    if (hit !== undefined) return hit;
  }
  if (Array.isArray(node.args)) {
    for (const a of node.args) {
      const hit = exprViewOnlyNode(a);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

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
  | { fn: string; args: ExprNode[] }                  // coalesce and the rc.21 function set
  | { case: { when: ExprNode; then: ExprNode }[]; else?: ExprNode; operand?: ExprNode } // rc.19 case
  | { now: string; startOf?: string }                 // rc.19 now
  | { cast: ExprNode; as: string; dbColumnType?: string }; // rc.21 cast

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
  if (EXPR_NOW in node) {
    if (typeof node[EXPR_NOW] !== "string") return [`expression '${EXPR_NOW}' must be an ISO-8601 duration string`];
    const extra = Object.keys(node).filter((k) => k !== EXPR_NOW && k !== EXPR_NOW_START_OF);
    return extra.length === 0 ? [] : [`expression '${EXPR_NOW}' takes only '${EXPR_NOW_START_OF}' beside it, not ${extra.join(", ")}`];
  }
  if (EXPR_CASE in node) {
    const arms = node[EXPR_CASE];
    if (!Array.isArray(arms) || arms.length === 0) return [`'${EXPR_CASE}' requires a non-empty array of { ${EXPR_CASE_WHEN}, ${EXPR_CASE_THEN} } arms`];
    const errs: string[] = [];
    for (const arm of arms) {
      if (!isObj(arm) || !(EXPR_CASE_WHEN in arm) || !(EXPR_CASE_THEN in arm)) {
        errs.push(`every '${EXPR_CASE}' arm must be { ${EXPR_CASE_WHEN}, ${EXPR_CASE_THEN} }`);
        continue;
      }
      errs.push(...validateExprNode(arm[EXPR_CASE_WHEN]), ...validateExprNode(arm[EXPR_CASE_THEN]));
    }
    if (EXPR_CASE_ELSE in node) errs.push(...validateExprNode(node[EXPR_CASE_ELSE]));
    if (EXPR_CASE_OPERAND in node) errs.push(...validateExprNode(node[EXPR_CASE_OPERAND]));
    return errs;
  }
  if (EXPR_CAST in node) {
    const extra = Object.keys(node).filter((k) => k !== EXPR_CAST && k !== EXPR_CAST_AS && k !== EXPR_CAST_DB_COLUMN_TYPE);
    if (extra.length > 0) return [`expression '${EXPR_CAST}' takes only '${EXPR_CAST_AS}' and '${EXPR_CAST_DB_COLUMN_TYPE}' beside it, not ${extra.join(", ")}`];
    const to = node[EXPR_CAST_AS];
    if (typeof to !== "string" || !EXPR_CAST_TARGETS.includes(to)) {
      return [`'${EXPR_CAST}' requires '${EXPR_CAST_AS}': one of ${EXPR_CAST_TARGETS.join(", ")}`];
    }
    if (EXPR_CAST_DB_COLUMN_TYPE in node) {
      const spelling = node[EXPR_CAST_DB_COLUMN_TYPE];
      const parsed = typeof spelling === "string" ? parseDbColumnType(spelling) : undefined;
      if (parsed === undefined || parsed.kind === "uuid" || parsed.kind === "jsonb" || to !== FIELD_SUBTYPE_STRING) {
        return [`'${EXPR_CAST}' '${EXPR_CAST_DB_COLUMN_TYPE}' is a text spelling of @dbColumnType (text, varchar, character varying, varchar(n), character varying(n), character(n)) with '${EXPR_CAST_AS}: ${FIELD_SUBTYPE_STRING}'`];
      }
    }
    return validateExprNode(node[EXPR_CAST]);
  }
  if ("fn" in node) {
    const sig = typeof node.fn === "string" ? EXPR_FUNCTIONS[node.fn] : undefined;
    if (sig === undefined || !Object.prototype.hasOwnProperty.call(EXPR_FUNCTIONS, node.fn as string)) {
      return [`unknown expression fn '${String(node.fn)}'`];
    }
    const name = node.fn as string;
    if (!Array.isArray(node.args) || node.args.length < Math.max(sig.min, 1)) {
      return [sig.min <= 1 ? `'${name}' requires a non-empty args array` : `'${name}' requires at least ${sig.min} args`];
    }
    if (node.args.length > sig.max) return [`'${name}' takes at most ${sig.max} args, got ${node.args.length}`];
    return node.args.flatMap(validateExprNode);
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
  return ["expression node must be one of {field}, {value}, {op,…}, {fn,…}, {case,…}, {now}, {cast,…}"];
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
export function inferExprType(
  node: ExprNode,
  resolveField: (name: string) => string | undefined,
  /** rc.21 cast: whether a `{ field }` names an enum stored as an integer (`@intValueMap`). */
  isIntStoredEnum: (name: string) => boolean = () => false,
): InferResult {
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
  // rc.19 now: an instant; compared with a date or local timestamp it takes that kind at lowering.
  if (EXPR_NOW in n) return { type: FIELD_SUBTYPE_TIMESTAMP, errors: [] };
  if (EXPR_CASE in n) {
    const errors: string[] = [];
    const arms = n[EXPR_CASE] as { when: ExprNode; then: ExprNode }[];
    const operand = EXPR_CASE_OPERAND in n ? inferExprType(n[EXPR_CASE_OPERAND] as ExprNode, resolveField, isIntStoredEnum) : undefined;
    if (operand !== undefined) errors.push(...operand.errors);
    const results: (string | undefined)[] = [];
    for (const arm of arms) {
      const w = inferExprType(arm.when, resolveField, isIntStoredEnum);
      errors.push(...w.errors);
      if (operand === undefined && w.type !== undefined && w.type !== FIELD_SUBTYPE_BOOLEAN) {
        errors.push(`a searched '${EXPR_CASE}' needs a boolean '${EXPR_CASE_WHEN}', got ${w.type}`);
      }
      if (operand?.type !== undefined && w.type !== undefined && w.type !== operand.type) {
        errors.push(`a simple '${EXPR_CASE}' compares its ${operand.type} '${EXPR_CASE_OPERAND}' with a ${w.type} '${EXPR_CASE_WHEN}'`);
      }
      const t = inferExprType(arm.then, resolveField, isIntStoredEnum);
      errors.push(...t.errors);
      results.push(t.type);
    }
    if (EXPR_CASE_ELSE in n) {
      const e = inferExprType(n[EXPR_CASE_ELSE] as ExprNode, resolveField, isIntStoredEnum);
      errors.push(...e.errors);
      results.push(e.type);
    }
    const types = results.filter((t): t is string => t !== undefined);
    const unified = types[0];
    if (unified !== undefined && types.some((t) => t !== unified)) {
      errors.push(`'${EXPR_CASE}' results have differing types (${[...new Set(types)].join(", ")})`);
    }
    return { type: unified, errors };
  }

  if (EXPR_CAST in n) {
    const inner = n[EXPR_CAST] as ExprNode;
    const operand = inferExprType(inner, resolveField, isIntStoredEnum);
    const to = n[EXPR_CAST_AS] as string;
    const innerObj = inner as Record<string, unknown>;
    const fieldRef = typeof innerObj.field === "string" ? innerObj.field : undefined;
    const problem = castProblem(operand.type, to, fieldRef !== undefined && isIntStoredEnum(fieldRef));
    return { type: to, errors: problem === undefined ? operand.errors : [...operand.errors, `'${EXPR_CAST}': ${problem}`] };
  }
  if ("fn" in n) {
    const name = n.fn as string;
    const sig = EXPR_FUNCTIONS[name]!;
    const argResults = (n.args as ExprNode[]).map((a) => inferExprType(a, resolveField, isIntStoredEnum));
    const errors = argResults.flatMap((a) => a.errors);
    const same: string[] = [];
    argResults.forEach((a, i) => {
      const kind = sig.params[Math.min(i, sig.params.length - 1)]!;
      if (a.type === undefined) return; // a null literal fits any parameter
      if (kind === "same") same.push(a.type);
      else if (kind === "string" && a.type !== FIELD_SUBTYPE_STRING) {
        errors.push(`'${name}' argument ${i + 1} must be a string, got ${a.type}`);
      } else if (kind === "int" && a.type !== FIELD_SUBTYPE_INT) {
        // Postgres resolves these functions over int4 only (no implicit bigint → int for a call).
        errors.push(`'${name}' argument ${i + 1} must be an int, got ${a.type}${a.type === FIELD_SUBTYPE_LONG ? "; cast it ({ cast: <expr>, as: int })" : ""}`);
      } else if (kind === "scalar" && NON_SCALAR_SUBTYPES.has(a.type)) {
        errors.push(`'${name}' argument ${i + 1} must be a scalar, got ${a.type}`);
      }
    });
    const unified = same[0];
    if (unified !== undefined && same.some((t) => t !== unified)) {
      errors.push(`'${name}' arguments have differing types (${[...new Set(same)].join(", ")})`);
    }
    if (sig.ordered && unified !== undefined && (unified === FIELD_SUBTYPE_BOOLEAN || NON_SCALAR_SUBTYPES.has(unified))) {
      errors.push(`'${name}' needs ordered arguments, got ${unified}`);
    }
    const type = sig.result === "same" ? unified : sig.result === "int" ? FIELD_SUBTYPE_INT : FIELD_SUBTYPE_STRING;
    return { type, errors };
  }

  const op = n.op as string;
  if (COMPARISON_OPS.has(op)) {
    const l = inferExprType(n.left as ExprNode, resolveField, isIntStoredEnum);
    const r = inferExprType(n.right as ExprNode, resolveField, isIntStoredEnum);
    const errors = [...l.errors, ...r.errors];
    if (l.type !== undefined && !opsForSubType(l.type).includes(op as FilterOp)) {
      errors.push(`op '${op}' is not legal for a ${l.type} operand`);
    }
    return { type: FIELD_SUBTYPE_BOOLEAN, errors };
  }
  if (NULL_OPS.has(op)) {
    return { type: FIELD_SUBTYPE_BOOLEAN, errors: inferExprType(n.arg as ExprNode, resolveField, isIntStoredEnum).errors };
  }
  if (op === EXPR_OP_NOT || VARIADIC_LOGIC_OPS.has(op)) {
    const kids = op === EXPR_OP_NOT ? [n.arg as ExprNode] : (n.args as ExprNode[]);
    const errors: string[] = [];
    for (const k of kids) {
      const kt = inferExprType(k, resolveField, isIntStoredEnum);
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
