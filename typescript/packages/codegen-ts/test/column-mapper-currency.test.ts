import { describe, test, expect } from "bun:test";
import { MetaModel, TypeId } from "@metaobjects/metadata";
import { FIELD_SUBTYPE_CURRENCY, FIELD_SUBTYPE_LONG, TYPE_FIELD } from "@metaobjects/metadata";
import { mapColumnType, type ColumnSpec } from "../src/column-mapper.js";

const makeField = (subType: string, name: string): MetaModel =>
  new MetaModel(new TypeId(TYPE_FIELD, subType), name);

describe("mapColumnType for field[currency]", () => {
  test("sqlite → integer (same as long)", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_CURRENCY, "priceCents"), "sqlite");
    expect(spec.fnName).toBe("integer");
    expect(spec.fnOptions).toBeUndefined();
  });

  test("postgres → bigint with mode: number (same as long)", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_CURRENCY, "priceCents"), "postgres");
    expect(spec.fnName).toBe("bigint");
    expect(spec.fnOptions).toEqual({ mode: "number" });
  });

  test("currency and long return identical specs for sqlite", () => {
    const currencySpec = mapColumnType(makeField(FIELD_SUBTYPE_CURRENCY, "priceCents"), "sqlite");
    const longSpec = mapColumnType(makeField(FIELD_SUBTYPE_LONG, "priceCents"), "sqlite");
    expect(currencySpec.fnName).toBe(longSpec.fnName);
    expect(currencySpec.fnOptions).toEqual(longSpec.fnOptions);
  });

  test("currency and long return identical specs for postgres", () => {
    const currencySpec = mapColumnType(makeField(FIELD_SUBTYPE_CURRENCY, "priceCents"), "postgres");
    const longSpec = mapColumnType(makeField(FIELD_SUBTYPE_LONG, "priceCents"), "postgres");
    expect(currencySpec.fnName).toBe(longSpec.fnName);
    expect(currencySpec.fnOptions).toEqual(longSpec.fnOptions);
  });
});
