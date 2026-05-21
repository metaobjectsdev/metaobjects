import { test, expect } from "bun:test";
import { classifyAgainstLedger } from "../src/expected-failures.js";

test("an unlisted failure stays a fail", () => {
  expect(classifyAgainstLedger("fail", "fix-a", [])).toBe("fail");
});
test("a listed failure becomes a known gap", () => {
  expect(classifyAgainstLedger("fail", "fix-a", ["fix-a"])).toBe("known-gap");
});
test("a listed pass is fixed-but-listed", () => {
  expect(classifyAgainstLedger("pass", "fix-a", ["fix-a"])).toBe("fixed-but-listed");
});
test("an unlisted pass stays a pass", () => {
  expect(classifyAgainstLedger("pass", "fix-a", [])).toBe("pass");
});
