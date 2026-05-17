import { describe, it, expect } from "bun:test";
import { DATA_TYPES, DATA_TYPE_STRING, DATA_TYPE_OBJECT, type DataType } from "../src/data-type.js";

describe("DataType", () => {
  it("DATA_TYPES is the closed set of coarse value types", () => {
    expect([...DATA_TYPES].sort()).toEqual(
      ["boolean", "date", "double", "int", "long", "object", "string"],
    );
  });

  it("the named constants are members of the union", () => {
    const s: DataType = DATA_TYPE_STRING;
    const o: DataType = DATA_TYPE_OBJECT;
    expect(s).toBe("string");
    expect(o).toBe("object");
  });
});
