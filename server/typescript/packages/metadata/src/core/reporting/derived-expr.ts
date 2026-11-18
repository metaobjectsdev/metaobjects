// FR-044 R13 — the `@expr` grammar of a `measure.derived`: FR-037 R5's first arithmetic wave.
//
// A closed subset of the attr.expression node grammar. An operand is `{ field: name }` (a sibling
// measure.aggregate or measure.ratio, or a numeric attribute dimension the report lists) or
// `{ value: number }`; an operation is `{ fn: add | subtract | multiply | divide, args: [a, b] }`.
// The arithmetic members are admitted here first: origin.computed's grammar does not take them
// yet, so its lowerings and every port's evaluator stay as they are.

import { DERIVED_FNS, type DerivedFn } from "./reporting-constants.js";

export type DerivedExprNode =
  | { readonly field: string }
  | { readonly value: number }
  | { readonly fn: DerivedFn; readonly args: readonly [DerivedExprNode, DerivedExprNode] };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True for a node of the grammar, its whole subtree included. */
export function isDerivedExpr(node: unknown): node is DerivedExprNode {
  if (!isObj(node)) return false;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === "field") return typeof node.field === "string" && node.field.length > 0;
  if (keys.length === 1 && keys[0] === "value") return typeof node.value === "number" && Number.isFinite(node.value);
  if (keys.length === 2 && "fn" in node && "args" in node) {
    return (
      (DERIVED_FNS as readonly unknown[]).includes(node.fn) &&
      Array.isArray(node.args) &&
      node.args.length === 2 &&
      node.args.every(isDerivedExpr)
    );
  }
  return false;
}

/** The names a well-formed expression's `{ field }` operands read, each once, in first-read order. */
export function derivedExprFields(node: DerivedExprNode, out: string[] = []): string[] {
  if ("field" in node) {
    if (!out.includes(node.field)) out.push(node.field);
  } else if ("fn" in node) {
    for (const a of node.args) derivedExprFields(a, out);
  }
  return out;
}
