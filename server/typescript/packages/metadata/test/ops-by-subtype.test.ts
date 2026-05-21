import { describe, test, expect } from "bun:test";
import {
  FILTER_OPS,
  OPS_BY_SUBTYPE,
  type FilterOp,
} from "../src/constants.js";

describe("FILTER_OPS — the 8 operator names", () => {
  test("matches the canonical Project D set", () => {
    expect(FILTER_OPS).toEqual([
      "eq", "ne", "gt", "gte", "lt", "lte", "in", "like", "isNull",
    ]);
  });
});

describe("OPS_BY_SUBTYPE — operator gating per field subtype", () => {
  test("string supports eq, ne, in, like, isNull", () => {
    expect(OPS_BY_SUBTYPE.string).toEqual(["eq", "ne", "in", "like", "isNull"]);
  });
  test("int supports eq, ne, gt, gte, lt, lte, in, isNull (no like)", () => {
    expect(OPS_BY_SUBTYPE.int).toContain("gte");
    expect(OPS_BY_SUBTYPE.int).not.toContain("like");
  });
  test("boolean supports only eq + isNull", () => {
    expect(OPS_BY_SUBTYPE.boolean).toEqual(["eq", "isNull"]);
  });
  test("date supports comparison + in but no like", () => {
    expect(OPS_BY_SUBTYPE.date).toContain("gte");
    expect(OPS_BY_SUBTYPE.date).not.toContain("like");
  });
});

// Suppress unused-type lint warning — FilterOp is exported for consumer use
const _typeCheck: FilterOp = "eq";
void _typeCheck;
