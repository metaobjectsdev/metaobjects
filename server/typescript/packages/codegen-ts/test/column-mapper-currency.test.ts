import { describe, test, expect } from "bun:test";
import { FIELD_SUBTYPE_CURRENCY, FIELD_SUBTYPE_LONG } from "@metaobjectsdev/metadata";
import { metaField } from "./_meta-build.js";
import { mapColumnType, type ColumnSpec } from "../src/column-mapper.js";

describe("mapColumnType for field[currency]", () => {
  test("sqlite → integer (same as long)", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_CURRENCY, "priceCents"), "sqlite");
    expect(spec.fnName).toBe("integer");
    expect(spec.fnOptions).toBeUndefined();
  });

  test("postgres → bigint with mode: number (same as long)", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_CURRENCY, "priceCents"), "postgres");
    expect(spec.fnName).toBe("bigint");
    expect(spec.fnOptions).toEqual({ mode: "number" });
  });

  test("currency and long return identical specs for sqlite", () => {
    const currencySpec = mapColumnType(metaField(FIELD_SUBTYPE_CURRENCY, "priceCents"), "sqlite");
    const longSpec = mapColumnType(metaField(FIELD_SUBTYPE_LONG, "priceCents"), "sqlite");
    expect(currencySpec.fnName).toBe(longSpec.fnName);
    expect(currencySpec.fnOptions).toEqual(longSpec.fnOptions);
  });

  test("currency and long return identical specs for postgres", () => {
    const currencySpec = mapColumnType(metaField(FIELD_SUBTYPE_CURRENCY, "priceCents"), "postgres");
    const longSpec = mapColumnType(metaField(FIELD_SUBTYPE_LONG, "priceCents"), "postgres");
    expect(currencySpec.fnName).toBe(longSpec.fnName);
    expect(currencySpec.fnOptions).toEqual(longSpec.fnOptions);
  });
});
