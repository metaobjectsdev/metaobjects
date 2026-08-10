import { describe, it, expect } from "bun:test";
import { composeRegistry } from "../../src/provider.js";
import { coreTypesProvider } from "../../src/core-types.js";
import { dbProvider } from "../../src/persistence/db/db-provider.js";
import {
  TYPE_FIELD,
  TYPE_SOURCE,
  FIELD_SUBTYPE_STRING,
  SOURCE_SUBTYPE_RDB,
  FIELD_ATTR_COLUMN,
  FIELD_ATTR_DB_INDEXED,
  SOURCE_ATTR_TABLE,
} from "../../src/index.js";

describe("dbProvider", () => {
  it("composed with core, field subtypes carry @column and @db.indexed", () => {
    const reg = composeRegistry([coreTypesProvider, dbProvider]);
    const attrs = reg.attrsOf(TYPE_FIELD, FIELD_SUBTYPE_STRING).map((a) => a.name);
    expect(attrs).toContain(FIELD_ATTR_COLUMN);
    expect(attrs).toContain(FIELD_ATTR_DB_INDEXED);
  });

  it("composed with core, source.rdb carries @table", () => {
    const reg = composeRegistry([coreTypesProvider, dbProvider]);
    expect(reg.attrsOf(TYPE_SOURCE, SOURCE_SUBTYPE_RDB).map((a) => a.name)).toContain(SOURCE_ATTR_TABLE);
  });

  it("core alone does NOT carry the DB attrs — the relocation is real", () => {
    const reg = composeRegistry([coreTypesProvider]);
    const fieldAttrs = reg.attrsOf(TYPE_FIELD, FIELD_SUBTYPE_STRING).map((a) => a.name);
    expect(fieldAttrs).not.toContain(FIELD_ATTR_COLUMN);
    expect(fieldAttrs).not.toContain(FIELD_ATTR_DB_INDEXED);
    expect(reg.attrsOf(TYPE_SOURCE, SOURCE_SUBTYPE_RDB).map((a) => a.name)).not.toContain(SOURCE_ATTR_TABLE);
  });

  it("dbProvider without core throws a missing-dependency error", () => {
    expect(() => composeRegistry([dbProvider])).toThrow(
      /depends on .+, which is not in the provider set/,
    );
  });
});
