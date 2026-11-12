import { test, expect, describe } from "bun:test";
import { requirementTestsAdvice } from "../../src/lib/requirement-tests-advice.js";

describe("requirementTestsAdvice", () => {
  test("requirements declared and no requirement-tests generator → names the line to wire", () => {
    const w = requirementTestsAdvice(["entity", "barrel"], 3)!;
    expect(w).toContain("3 requirements");
    expect(w).toContain("requirementTests()");
    expect(w).toContain("@metaobjectsdev/codegen-ts/generators");
    expect(w).toContain("meta eject requirement-tests");
  });
  test("singular count reads as one requirement", () => {
    expect(requirementTestsAdvice([], 1)).toContain("1 requirement and");
  });
  test("silent once the generator is declared", () => {
    expect(requirementTestsAdvice(["entity", "requirement-tests"], 3)).toBeUndefined();
  });
  test("silent when the model declares no requirements", () => {
    expect(requirementTestsAdvice([], 0)).toBeUndefined();
  });
});
