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
