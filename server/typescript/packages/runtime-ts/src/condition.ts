// A transition's `@condition` (ADR-0066 §1) as a driver WhereClause, so the guarded update
// (§6 step 5) can AND it into the one statement that makes the move.
//
// The grammar is attr.expression's CHECK subset — fields, literals, the six comparisons, the null
// tests, and / or / not, and coalesce — the same subset `meta migrate` renders as a CHECK. A node
// outside it is refused here rather than dropped, because a guard that silently loses its
// condition makes a move the model forbids.
//
// A literal compared with a field is written in the form that field's column stores (an
// int-backed enum's member is its integer), exactly as a filter value is: `encode` is the
// caller's filter-value encoder, so the condition and a list filter cannot disagree.

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
import { MetadataError } from "./errors.js";
import type { CompareOp, Operand, PrimitiveValue, WhereClause } from "./persistence-driver.js";

const COMPARE_OPS: ReadonlySet<string> = new Set<CompareOp>([
  FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
] as CompareOp[]);

type Node = Record<string, unknown>;

/** How a condition reaches the entity: its column for a field name, and a literal's stored form. */
export interface ConditionContext {
  /** The physical column of `field`, or undefined when the entity has no such field. */
  column(field: string): string | undefined;
  /** `value` in the form `field`'s column stores it (the filter-value encoder). */
  encode(field: string, value: PrimitiveValue): PrimitiveValue;
}

/** `node`, a `@condition` expression, as a WhereClause over the entity's columns. */
export function compileCondition(node: ExprNode, ctx: ConditionContext): WhereClause {
  const n = node as Node;
  const op = n["op"];
  if (typeof op === "string" && COMPARE_OPS.has(op)) {
    return {
      kind: "compare",
      op: op as CompareOp,
      left: operand(n["left"], storedFieldOf(n["right"]), ctx),
      right: operand(n["right"], storedFieldOf(n["left"]), ctx),
    };
  }
  if (op === FILTER_OP_IS_NULL || op === EXPR_OP_IS_NOT_NULL) {
    return { kind: "nullTest", operand: operand(n["arg"], undefined, ctx), not: op === EXPR_OP_IS_NOT_NULL };
  }
  if (op === EXPR_OP_NOT) return { kind: "not", clause: compileCondition(n["arg"] as ExprNode, ctx) };
  if (op === FILTER_COMPOSE_AND || op === FILTER_COMPOSE_OR) {
    const clauses = (n["args"] as ExprNode[]).map((a) => compileCondition(a, ctx));
    return { kind: op === FILTER_COMPOSE_AND ? "and" : "or", clauses };
  }
  throw new MetadataError(`@condition: ${JSON.stringify(node)} is not a condition the guarded update can apply`);
}

/** One comparison operand; a literal takes the stored form of `partner`, the field it is compared with. */
function operand(x: unknown, partner: string | undefined, ctx: ConditionContext): Operand {
  const n = (x ?? {}) as Node;
  if (typeof n["field"] === "string") {
    const column = ctx.column(n["field"]);
    if (column === undefined) throw new MetadataError(`@condition names "${n["field"]}", which is not a field of the entity`);
    return { column };
  }
  if ("value" in n) {
    const v = n["value"] as PrimitiveValue | null;
    return { value: v === null || partner === undefined ? v : ctx.encode(partner, v) };
  }
  if (n["fn"] === EXPR_FN_COALESCE && Array.isArray(n["args"])) {
    // The arguments of a coalesce share its type, so a literal among them takes the first field's form.
    const own = storedFieldOf(n) ?? partner;
    return { coalesce: (n["args"] as unknown[]).map((a) => operand(a, own, ctx)) };
  }
  throw new MetadataError(`@condition: ${JSON.stringify(x)} is not an operand the guarded update can apply`);
}

/** The field whose stored form a literal compared with `node` takes (migrate's CHECK renderer's rule). */
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
