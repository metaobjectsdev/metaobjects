import { describe, it, expect } from "bun:test";
import type { AttrValue, AttrObject } from "../src/shared/meta-data.js";

describe("AttrValue object arm", () => {
  it("accepts a nested object as a valid AttrValue", () => {
    const v: AttrValue = { subscribed: { eq: true } };
    expect(typeof v).toBe("object");
  });

  it("AttrObject permits nested arrays and nulls", () => {
    const o: AttrObject = { status: { in: ["a", "b"] }, deletedAt: { isNull: true } };
    expect(o.status).toEqual({ in: ["a", "b"] });
  });
});
