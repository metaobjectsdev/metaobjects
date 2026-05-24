import { describe, expect, test } from "bun:test";
import {
  SOURCE_SUBTYPE_RDB,
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_ROLE,
  SOURCE_KIND_TABLE,
  SOURCE_KIND_VIEW,
  SOURCE_RDB_KINDS,
  SOURCE_READ_ONLY_KINDS,
  DEFAULT_SOURCE_KIND,
  SOURCE_ROLE_PRIMARY,
  SOURCE_ROLES,
  DEFAULT_SOURCE_ROLE,
} from "../src/persistence/source/source-constants.js";
import { FIELD_ATTR_COLUMN } from "../src/persistence/db/db-constants.js";
import { ERROR_CODES } from "../src/errors.js";

describe("source v2 constants", () => {
  test("rdb subtype + physical/kind/role attr keys", () => {
    expect(SOURCE_SUBTYPE_RDB).toBe("rdb");
    expect(SOURCE_ATTR_TABLE).toBe("table");
    expect(SOURCE_ATTR_KIND).toBe("kind");
    expect(SOURCE_ATTR_ROLE).toBe("role");
  });
  test("rdb kinds + read-only derivation", () => {
    expect(DEFAULT_SOURCE_KIND).toBe(SOURCE_KIND_TABLE);
    expect(SOURCE_RDB_KINDS).toContain(SOURCE_KIND_TABLE);
    expect(SOURCE_RDB_KINDS).toContain(SOURCE_KIND_VIEW);
    expect(SOURCE_READ_ONLY_KINDS.has(SOURCE_KIND_VIEW)).toBe(true);
    expect(SOURCE_READ_ONLY_KINDS.has(SOURCE_KIND_TABLE)).toBe(false);
  });
  test("roles + default primary", () => {
    expect(DEFAULT_SOURCE_ROLE).toBe(SOURCE_ROLE_PRIMARY);
    expect(SOURCE_ROLES).toContain(SOURCE_ROLE_PRIMARY);
  });
  test("field @column key", () => {
    expect(FIELD_ATTR_COLUMN).toBe("column");
  });
  test("new error codes registered", () => {
    expect(ERROR_CODES).toContain("ERR_RESERVED_ATTR");
    expect(ERROR_CODES).toContain("ERR_SOURCE_NO_PRIMARY");
    expect(ERROR_CODES).toContain("ERR_SOURCE_MULTIPLE_PRIMARY");
  });
});
