import { describe, test, expect } from "bun:test";
import {
  TypeId,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_UUID,
} from "@metaobjectsdev/metadata";
import { meta, metaField } from "./_meta-build.js";
import { mapColumnType, type ColumnSpec } from "../src/column-mapper.js";

describe("mapColumnType — SQLite", () => {
  test("string → text(name)", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_STRING, "title"), "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.dbName).toBe("title");
    expect(spec.fnArgs).toEqual([]);
  });

  test("int → integer(name)", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_INT, "count"), "sqlite");
    expect(spec.fnName).toBe("integer");
  });

  test("long → integer(name) (SQLite has only one int type)", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_LONG, "id"), "sqlite");
    expect(spec.fnName).toBe("integer");
  });

  test("boolean → integer with mode boolean", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_BOOLEAN, "active"), "sqlite");
    expect(spec.fnName).toBe("integer");
    expect(spec.fnOptions).toEqual({ mode: "boolean" });
  });

  test("timestamp with @default 'now' → text + { kind: 'now' }", () => {
    const f = metaField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
    f.setAttr("default", "now");
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.defaultExpr).toEqual({ kind: "now" });
  });

  test("@column overrides snake_case name", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "firstName");
    f.setAttr("column", "given_name");
    const spec = mapColumnType(f, "sqlite");
    expect(spec.dbName).toBe("given_name");
  });

  test("@isArray on string → text with mode json and $type scalar:string", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "tags");
    f.setIsArray(true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.fnOptions).toEqual({ mode: "json" });
    expect(spec.dollarTypeRef).toEqual({ kind: "scalar", tsType: "string" });
  });

  test("@isArray on int → text with mode json and $type scalar:number", () => {
    const f = metaField(FIELD_SUBTYPE_INT, "scores");
    f.setIsArray(true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.dollarTypeRef).toEqual({ kind: "scalar", tsType: "number" });
  });

  test("@isArray on boolean → text with mode json and $type scalar:boolean", () => {
    const f = metaField(FIELD_SUBTYPE_BOOLEAN, "flags");
    f.setIsArray(true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.dollarTypeRef).toEqual({ kind: "scalar", tsType: "boolean" });
  });

  test("@isArray on field.object → text with mode json and $type objectRef", () => {
    const f = metaField(FIELD_SUBTYPE_OBJECT, "citations");
    f.setAttr("objectRef", "SourceLens");
    f.setIsArray(true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.fnOptions).toEqual({ mode: "json" });
    expect(spec.dollarTypeRef).toEqual({ kind: "objectRef", name: "SourceLens", module: "./SourceLens.js" });
  });

  test("@isArray field.object with a FULLY-QUALIFIED @objectRef strips to the bare name", () => {
    // Regression: a cross-package @objectRef (acme::ai::SourceLens) must resolve to
    // the BARE short name for both the $type<E[]>() target and its sibling module —
    // emitting the raw FQN produces an invalid identifier + a colon-laden import path.
    const f = metaField(FIELD_SUBTYPE_OBJECT, "citations");
    f.setAttr("objectRef", "acme::ai::SourceLens");
    f.setIsArray(true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.dollarTypeRef).toEqual({ kind: "objectRef", name: "SourceLens", module: "./SourceLens.js" });
  });

  test("@isArray on field.object without objectRef leaves dollarTypeRef unset", () => {
    const f = metaField(FIELD_SUBTYPE_OBJECT, "stuff");
    f.setIsArray(true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.dollarTypeRef).toBeUndefined();
  });

  test("decimal → text with leadingComment surfacing the precision-fallback", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_DECIMAL, "price"), "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.leadingComment).toMatch(/SQLite has no decimal type/);
  });
});

describe("mapColumnType — Postgres", () => {
  test("string → text by default", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_STRING, "body"), "postgres");
    expect(spec.fnName).toBe("text");
  });

  test("string with @maxLength → varchar with length", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "title");
    f.setAttr("maxLength", 200);
    const spec = mapColumnType(f, "postgres");
    expect(spec.fnName).toBe("varchar");
    expect(spec.fnOptions).toEqual({ length: 200 });
  });

  test("long → bigint", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_LONG, "id"), "postgres");
    expect(spec.fnName).toBe("bigint");
    expect(spec.fnOptions).toEqual({ mode: "number" });
  });

  test("boolean → boolean (native)", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_BOOLEAN, "active"), "postgres");
    expect(spec.fnName).toBe("boolean");
  });

  test("@isArray adds .array() modifier", () => {
    const f = metaField(FIELD_SUBTYPE_INT, "scores");
    f.setIsArray(true);
    const spec = mapColumnType(f, "postgres");
    expect(spec.modifiers).toContain(".array()");
  });
});

describe("mapColumnType — field.object column parity with migrate-ts (SP-H Unit 4)", () => {
  // migrate-ts/expected-schema maps a (non-flattened) field.object → { kind: "json" }
  // → JSONB on Postgres / JSON on SQLite. Codegen must AGREE: the default
  // single-jsonb-column storage is a jsonb column, never a bare text column.
  test("Postgres: field.object (default storage) → jsonb (matches migrate-ts JSONB)", () => {
    const f = metaField(FIELD_SUBTYPE_OBJECT, "metadata");
    f.setAttr("objectRef", "Meta");
    const spec = mapColumnType(f, "postgres");
    expect(spec.fnName).toBe("jsonb");
  });

  test("Postgres: field.object with @storage jsonb → jsonb", () => {
    const f = metaField(FIELD_SUBTYPE_OBJECT, "payload");
    f.setAttr("objectRef", "Payload");
    f.setAttr("storage", "jsonb");
    const spec = mapColumnType(f, "postgres");
    expect(spec.fnName).toBe("jsonb");
  });

  test("SQLite: field.object → text with { mode: 'json' } (matches migrate-ts JSON)", () => {
    const f = metaField(FIELD_SUBTYPE_OBJECT, "metadata");
    f.setAttr("objectRef", "Meta");
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.fnOptions).toEqual({ mode: "json" });
  });
});

describe("mapColumnType — field.uuid (R6 Plan 2a)", () => {
  test("Postgres: uuid → native uuid() column", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_UUID, "id"), "postgres");
    expect(spec.fnName).toBe("uuid");
  });

  test("SQLite: uuid → text (no native uuid type)", () => {
    const spec = mapColumnType(metaField(FIELD_SUBTYPE_UUID, "id"), "sqlite");
    expect(spec.fnName).toBe("text");
  });
});

describe("mapColumnType — @dbColumnType physical override (R6 Plan 2b)", () => {
  test("Postgres: @dbColumnType uuid → uuid() column, native binding stays string", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "id");
    f.setAttr("dbColumnType", "uuid");
    const spec = mapColumnType(f, "postgres");
    expect(spec.fnName).toBe("uuid");
    // The Drizzle column type changed, but the logical field is still field.string,
    // so the native TS binding (keyed on subType — see inferred-types/zod) stays
    // `string`. The override is a physical-column concern only.
    expect(f.subType).toBe(FIELD_SUBTYPE_STRING);
  });

  test("Postgres: @dbColumnType jsonb → jsonb() column, native binding stays string", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "metadata");
    f.setAttr("dbColumnType", "jsonb");
    const spec = mapColumnType(f, "postgres");
    expect(spec.fnName).toBe("jsonb");
    expect(f.subType).toBe(FIELD_SUBTYPE_STRING);
  });

  test("Postgres: @dbColumnType timestamp_with_tz → timestamp({ mode: 'string', withTimezone: true })", () => {
    const f = metaField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
    f.setAttr("dbColumnType", "timestamp_with_tz");
    const spec = mapColumnType(f, "postgres");
    expect(spec.fnName).toBe("timestamp");
    // mode:"string" keeps the column round-tripping ISO strings (matches the
    // string-typed Zod schema + the cross-port wire contract).
    expect(spec.fnOptions).toEqual({ mode: "string", withTimezone: true });
    // field.timestamp binds to `string` natively — the override is physical-only.
    expect(f.subType).toBe(FIELD_SUBTYPE_TIMESTAMP);
  });

  test("SQLite: @dbColumnType uuid falls through to subtype default (no native analogue)", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "id");
    f.setAttr("dbColumnType", "uuid");
    const spec = mapColumnType(f, "sqlite");
    // SQLite: the physical attribute is ignored; string → text, unchanged.
    expect(spec.fnName).toBe("text");
  });
});

describe("mapColumnType — field.enum", () => {
  test("SQLite: enum → text column with CHECK constraint + enum option", () => {
    const f = metaField(FIELD_SUBTYPE_ENUM, "status");
    f.setAttr("values", ["DRAFT", "PUBLISHED"]);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.checkConstraint).toBe("status IN ('DRAFT', 'PUBLISHED')");
    // The enum option narrows Drizzle's inferred column type to a literal union.
    expect(spec.fnOptions).toEqual({ enum: ["DRAFT", "PUBLISHED"] });
  });

  test("Postgres: enum → text column with CHECK constraint + enum option", () => {
    const f = metaField(FIELD_SUBTYPE_ENUM, "status");
    f.setAttr("values", ["DRAFT", "PUBLISHED"]);
    const spec = mapColumnType(f, "postgres");
    expect(spec.fnName).toBe("text");
    expect(spec.checkConstraint).toBe("status IN ('DRAFT', 'PUBLISHED')");
    expect(spec.fnOptions).toEqual({ enum: ["DRAFT", "PUBLISHED"] });
  });

  test("enum isArray skips the enum option (JSON storage; Zod handles validation)", () => {
    const f = metaField(FIELD_SUBTYPE_ENUM, "tags");
    f.setAttr("values", ["A", "B"]);
    f.setIsArray(true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.fnName).toBe("text");
    expect(spec.fnOptions).toEqual({ mode: "json" });
  });

  test("single quotes in enum values are escaped in CHECK constraint", () => {
    const f = metaField(FIELD_SUBTYPE_ENUM, "status");
    f.setAttr("values", ["O'BRIEN", "NORMAL"]);
    const spec = mapColumnType(f, "postgres");
    expect(spec.checkConstraint).toBe("status IN ('O''BRIEN', 'NORMAL')");
  });

  test("enum column name from snake_case field name", () => {
    const f = metaField(FIELD_SUBTYPE_ENUM, "orderStatus");
    f.setAttr("values", ["DRAFT", "PUBLISHED"]);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.dbName).toBe("order_status");
    expect(spec.checkConstraint).toBe("order_status IN ('DRAFT', 'PUBLISHED')");
  });
});

describe("mapColumnType — modifier attrs (both dialects)", () => {
  test("validator.required → notNull", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "title");
    const v = meta(new TypeId("validator", "required"), "");
    f.addChild(v);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.modifiers).toContain(".notNull()");
  });

  test("@unique → unique modifier", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "email");
    f.setAttr("unique", true);
    const spec = mapColumnType(f, "sqlite");
    expect(spec.modifiers).toContain(".unique()");
  });
});
