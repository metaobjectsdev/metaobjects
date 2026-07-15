// attr.expression — the closed structured-expression node grammar backing
// origin.computed (#195). Shares the filter op vocabulary; a filter object
// embeds canonically. Structural validation here; entity-aware type inference
// (against a field-subtype resolver) is exercised too.

import { describe, it, expect } from "bun:test";
import {
  validateExprNode,
  inferExprType,
  filterToExpr,
  type ExprNode,
} from "../src/core/attr/meta-attr-expression.js";
import {
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_BOOLEAN,
} from "../src/core/field/field-constants.js";

// A field-subtype resolver standing in for a base entity's effective fields.
const fields: Record<string, string> = {
  payloadJson: FIELD_SUBTYPE_STRING,
  score: FIELD_SUBTYPE_INT,
  active: FIELD_SUBTYPE_BOOLEAN,
};
const resolve = (name: string): string | undefined => fields[name];

describe("attr.expression grammar", () => {
  it("(a) isNotNull over a field ref is well-formed and infers boolean", () => {
    const node: ExprNode = { op: "isNotNull", arg: { field: "payloadJson" } };
    expect(validateExprNode(node)).toEqual([]);
    const r = inferExprType(node, resolve);
    expect(r.errors).toEqual([]);
    expect(r.type).toBe(FIELD_SUBTYPE_BOOLEAN);
  });

  it("(b) an unknown node kind / op is a structural error", () => {
    expect(validateExprNode({ op: "regexp", arg: { field: "payloadJson" } } as unknown as ExprNode).length).toBeGreaterThan(0);
    expect(validateExprNode({ frobnicate: 1 } as unknown as ExprNode).length).toBeGreaterThan(0);
  });

  it("(c) a comparison infers boolean; an op illegal for the operand subtype is rejected", () => {
    const ok: ExprNode = { op: "gt", left: { field: "score" }, right: { value: 90 } };
    expect(validateExprNode(ok)).toEqual([]);
    expect(inferExprType(ok, resolve).type).toBe(FIELD_SUBTYPE_BOOLEAN);

    // gt is not a legal op for a boolean operand (OPS_BY_SUBTYPE.boolean = eq/isNull).
    const bad: ExprNode = { op: "gt", left: { field: "active" }, right: { value: true } };
    expect(inferExprType(bad, resolve).errors.length).toBeGreaterThan(0);
  });

  it("(d) a canonical filter object embeds into the expression tree", () => {
    // { success: false } desugars to { success: { eq: false } } → an eq comparison node.
    const expr = filterToExpr({ success: { eq: false } });
    expect(validateExprNode(expr)).toEqual([]);
    expect(expr).toEqual({ op: "eq", left: { field: "success" }, right: { value: false } });
  });

  it("(d2) filter and/or composition embeds recursively", () => {
    const expr = filterToExpr({ and: [{ score: { gte: 1 } }, { active: { eq: true } }] });
    expect(expr).toEqual({
      op: "and",
      args: [
        { op: "gte", left: { field: "score" }, right: { value: 1 } },
        { op: "eq", left: { field: "active" }, right: { value: true } },
      ],
    });
  });

  it("(e) coalesce infers the unified argument subtype", () => {
    const node: ExprNode = { fn: "coalesce", args: [{ field: "score" }, { value: 0 }] };
    expect(validateExprNode(node)).toEqual([]);
    expect(inferExprType(node, resolve).type).toBe(FIELD_SUBTYPE_INT);
  });

  it("and/or/not are boolean; a field ref infers the field's subtype", () => {
    expect(inferExprType({ op: "not", arg: { field: "active" } }, resolve).type).toBe(FIELD_SUBTYPE_BOOLEAN);
    expect(inferExprType({ field: "payloadJson" }, resolve).type).toBe(FIELD_SUBTYPE_STRING);
    // an unresolvable field ref is an error
    expect(inferExprType({ field: "nope" }, resolve).errors.length).toBeGreaterThan(0);
  });
});
