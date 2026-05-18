import { describe, test, expect } from "bun:test";
import type { MetaField } from "@metaobjects/metadata";
import {
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_DECIMAL,
} from "@metaobjects/metadata";
import { meta, metaField } from "./_meta-build.js";
import { TypeId } from "@metaobjects/metadata";
import { mapColumnType, type ColumnSpec } from "../src/column-mapper.js";

const makeField = (subType: string, name: string): MetaField =>
  metaField(subType, name);

describe("mapColumnType — SQLite", () => {
  test("string → text(name)", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_STRING, "title"), "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.dbName).toBe("title");
    expect(spec.fnArgs).toEqual([]);
  });

  test("int → integer(name)", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_INT, "count"), "sqlite");
    expect(spec.fnName).toBe("integer");
  });

  test("long → integer(name) (SQLite has only one int type)", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_LONG, "id"), "sqlite");
    expect(spec.fnName).toBe("integer");
  });

  test("boolean → integer with mode boolean", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_BOOLEAN, "active"), "sqlite");
    expect(spec.fnName).toBe("integer");
    expect(spec.fnOptions).toEqual({ mode: "boolean" });
  });

  test("timestamp with @default 'now' → text + { kind: 'now' }", () => {
    const f = makeField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
    f.setAttr("default", "now");
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.defaultExpr).toEqual({ kind: "now" });
  });

  test("@dbColumn overrides snake_case name", () => {
    const f = makeField(FIELD_SUBTYPE_STRING, "firstName");
    f.setAttr("dbColumn", "given_name");
    const spec = mapColumnType(f, "sqlite");
    expect(spec.dbName).toBe("given_name");
  });

  test("@isArray on string → text with mode json", () => {
    const f = makeField(FIELD_SUBTYPE_STRING, "tags");
    f.setIsArray(true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.fnOptions).toEqual({ mode: "json" });
  });

  test("decimal → text with leadingComment surfacing the precision-fallback", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_DECIMAL, "price"), "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.leadingComment).toMatch(/SQLite has no decimal type/);
  });
});

describe("mapColumnType — Postgres", () => {
  test("string → text by default", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_STRING, "body"), "postgres");
    expect(spec.fnName).toBe("text");
  });

  test("string with @maxLength → varchar with length", () => {
    const f = makeField(FIELD_SUBTYPE_STRING, "title");
    f.setAttr("maxLength", 200);
    const spec = mapColumnType(f, "postgres");
    expect(spec.fnName).toBe("varchar");
    expect(spec.fnOptions).toEqual({ length: 200 });
  });

  test("long → bigint", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_LONG, "id"), "postgres");
    expect(spec.fnName).toBe("bigint");
    expect(spec.fnOptions).toEqual({ mode: "number" });
  });

  test("boolean → boolean (native)", () => {
    const spec = mapColumnType(makeField(FIELD_SUBTYPE_BOOLEAN, "active"), "postgres");
    expect(spec.fnName).toBe("boolean");
  });

  test("@isArray adds .array() modifier", () => {
    const f = makeField(FIELD_SUBTYPE_INT, "scores");
    f.setIsArray(true);
    const spec = mapColumnType(f, "postgres");
    expect(spec.modifiers).toContain(".array()");
  });
});

describe("mapColumnType — modifier attrs (both dialects)", () => {
  test("validator.required → notNull", () => {
    const f = makeField(FIELD_SUBTYPE_STRING, "title");
    const v = meta(new TypeId("validator", "required"), "");
    f.addChild(v);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.modifiers).toContain(".notNull()");
  });

  test("@unique → unique modifier", () => {
    const f = makeField(FIELD_SUBTYPE_STRING, "email");
    f.setAttr("unique", true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.modifiers).toContain(".unique()");
  });
});
