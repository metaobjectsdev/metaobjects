import { test, expect } from "bun:test";
import { parseOperationScript } from "../src/operation-script.js";

test("parses a well-formed script", () => {
  const script = parseOperationScript({
    operations: [
      { navigate: ["object:Program"], invoke: "object.effective-fields",
        expect: { names: ["id"] } },
    ],
  });
  expect(script.operations).toHaveLength(1);
  expect(script.operations[0]!.invoke).toBe("object.effective-fields");
});

test("rejects an operation missing invoke", () => {
  expect(() => parseOperationScript({ operations: [{ navigate: [], expect: {} }] }))
    .toThrow(/invoke/);
});

test("rejects a non-array operations", () => {
  expect(() => parseOperationScript({ operations: {} })).toThrow(/operations/);
});

test("rejects a malformed capability-id", () => {
  expect(() => parseOperationScript({
    operations: [{ navigate: [], invoke: "NotKebabCase", expect: {} }],
  })).toThrow(/capability/);
});
