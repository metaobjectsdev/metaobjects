import { test, expect } from "bun:test";
import { ParseError, MetaModelError, ERROR_CODES } from "../src/errors.js";
import { composeRegistry, type MetaDataTypeProvider } from "../src/provider.js";

test("ParseError carries a stable ERR_ code", () => {
  const err = new ParseError("unknown type 'widget'", {
    code: "ERR_UNKNOWN_TYPE",
  });
  expect(err.code).toBe("ERR_UNKNOWN_TYPE");
});

test("ERROR_CODES and ERROR-CODES.json are in full agreement", async () => {
  const registry = await Bun.file(
    `${import.meta.dir}/../../../../fixtures/conformance/ERROR-CODES.json`,
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
