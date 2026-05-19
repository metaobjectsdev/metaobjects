import { test, expect } from "bun:test";
import { ParseError } from "../src/errors.js";

test("ParseError carries a stable ERR_ code", () => {
  const err = new ParseError("unknown type 'widget'", {
    code: "ERR_UNKNOWN_TYPE",
  });
  expect(err.code).toBe("ERR_UNKNOWN_TYPE");
});

test("every ParseError code is registered in ERROR-CODES.json", async () => {
  const registry = await Bun.file(
    `${import.meta.dir}/../../../../fixtures/conformance/ERROR-CODES.json`,
  ).json();
  const err = new ParseError("dup", { code: "ERR_DUPLICATE_NAME" });
  expect(Object.keys(registry.codes)).toContain(err.code!);
});
