import { test, expect } from "bun:test";
import { ParseError, MetaModelError, ERROR_CODES } from "../src/errors.js";
import { composeRegistry, type MetaDataTypeProvider } from "../src/provider.js";

test("ParseError carries a stable ERR_ code", () => {
  const err = new ParseError("unknown type 'widget'", {
    code: "ERR_UNKNOWN_TYPE",
    source: { format: "code", caller: "errors.test" },
  });
  expect(err.code).toBe("ERR_UNKNOWN_TYPE");
});

test("ERROR_CODES and ERROR-CODES.json are in full agreement", async () => {
  const registry = await Bun.file(
    `${import.meta.dir}/../../../../../fixtures/conformance/ERROR-CODES.json`,
  ).json();
  expect([...ERROR_CODES].sort()).toEqual((Object.keys(registry.codes) as typeof ERROR_CODES[number][]).sort());
});

test("MetaModelError carries a stable ERR_PROVIDER_* code", () => {
  const dupProvider: MetaDataTypeProvider = { id: "dup", registerTypes() {} };
  let thrown: unknown;
  try {
    composeRegistry([dupProvider, dupProvider]);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(MetaModelError);
  expect((thrown as MetaModelError).code).toBe("ERR_PROVIDER_DUPLICATE_ID");
});

// Phase-1 metadata-source-resolution design: register error codes that will be
// raised when loading sources from .metaobjects/config.json.
test("phase-1 source-resolution error codes are registered in the shared ledger", () => {
  for (const code of [
    "ERR_SOURCE_UNRESOLVED",
    "ERR_SOURCE_KIND_UNSUPPORTED",
    "ERR_SCOPE_PATTERN_INVALID",
    "ERR_COLLECTION_NOT_FOUND",
  ]) {
    expect(ERROR_CODES).toContain(code);
  }
});
