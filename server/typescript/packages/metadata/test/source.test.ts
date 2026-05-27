// Type-shape tests for the FR5a-ts ErrorSource discriminated union.
// These are mostly TS-typecheck assertions — the module exports types and a
// couple of constructor helpers.
import { describe, test, expect } from "bun:test";
import {
  type ErrorSource,
  type LoaderError,
  type LoaderWarning,
  codeSource,
} from "../src/source.js";

describe("ErrorSource", () => {
  test("json variant: format + files + jsonPath", () => {
    const s: ErrorSource = {
      format: "json",
      files: ["metaobjects/meta.json"],
      jsonPath: "$.metadata.root",
    };
    expect(s.format).toBe("json");
    expect(s.files).toEqual(["metaobjects/meta.json"]);
    expect(s.jsonPath).toBe("$.metadata.root");
  });

  test("code variant: format + optional caller", () => {
    const s: ErrorSource = { format: "code", caller: "TestBuilder" };
    expect(s.format).toBe("code");
    if (s.format === "code") expect(s.caller).toBe("TestBuilder");
  });

  test("codeSource() helper builds the canonical synthetic envelope", () => {
    expect(codeSource()).toEqual({ format: "code" });
    expect(codeSource("MyFactory")).toEqual({ format: "code", caller: "MyFactory" });
  });
});

describe("LoaderError envelope shape", () => {
  test("required fields: code, message, source", () => {
    const e: LoaderError = {
      code: "ERR_UNKNOWN_TYPE",
      message: "unknown type",
      source: { format: "code" },
    };
    expect(e.code).toBe("ERR_UNKNOWN_TYPE");
  });
});

describe("LoaderWarning envelope shape", () => {
  test("uses the same shape as LoaderError but warn-prefixed code", () => {
    const w: LoaderWarning = {
      code: "WARN_DUPLICATE_DECLARATION",
      message: "duplicate",
      source: { format: "code" },
    };
    expect(w.code.startsWith("WARN_")).toBe(true);
  });
});

// FR5e — cross-port envelope shape lock for `format: "database"`. The schema
// is reserved by ADR-0009 and instantiable in every port today; a real
// database-source loader is future work. These tests pin the shape so a
// future loader has a guaranteed-correct target.
describe("ErrorSource — database variant (FR5e schema lock)", () => {
  test("format is 'database', dbLocation carries table + id", () => {
    const s: ErrorSource = {
      format: "database",
      dbLocation: { table: "metaobjects_field_attr", id: "fld_abc123/currency" },
    };
    expect(s.format).toBe("database");
    if (s.format === "database") {
      expect(s.dbLocation.table).toBe("metaobjects_field_attr");
      expect(s.dbLocation.id).toBe("fld_abc123/currency");
    }
  });

  test("jsonPath is optional", () => {
    const noPath: ErrorSource = {
      format: "database",
      dbLocation: { table: "t", id: "id" },
    };
    if (noPath.format === "database") {
      expect(noPath.jsonPath).toBeUndefined();
    }

    const withPath: ErrorSource = {
      format: "database",
      dbLocation: { table: "metaobjects_field_attr", id: "fld_abc123/currency" },
      jsonPath: "$.metadata.root.children[0].field.currency.@currency",
    };
    if (withPath.format === "database") {
      expect(withPath.jsonPath).toBe(
        "$.metadata.root.children[0].field.currency.@currency",
      );
    }
  });

  test("composite key is encoded as a delimited string in id", () => {
    // FR5e design lock: composite primary keys go through `id` as
    // "row_id/attr_name". Keeps the envelope dialect-neutral and avoids a
    // deeper DbLocation shape.
    const s: ErrorSource = {
      format: "database",
      dbLocation: { table: "metaobjects_field_attr", id: "fld_abc123/currency" },
    };
    if (s.format === "database") {
      expect(s.dbLocation.id).toBe("fld_abc123/currency");
    }
  });
});
