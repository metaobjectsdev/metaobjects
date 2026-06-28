import { describe, test, expect } from "bun:test";
import { expandOutputPattern } from "../../src/template-codegen/output-pattern.js";

describe("expandOutputPattern", () => {
  test("{name} and {package} (:: → /)", () => {
    expect(expandOutputPattern("{package}/{name}Service.ts", { name: "order", package: "acme::sales" }))
      .toBe("acme/sales/orderService.ts");
  });
  test("{Name} is PascalCase", () => {
    expect(expandOutputPattern("{Name}.cs", { name: "order_line" })).toBe("OrderLine.cs");
  });
  test("literal pattern (perModel) passes through", () => {
    expect(expandOutputPattern("registry.ts", {})).toBe("registry.ts");
  });
  test("empty package collapses to no leading slash", () => {
    expect(expandOutputPattern("{package}/{name}.ts", { name: "x", package: "" })).toBe("x.ts");
  });
  test("unknown placeholder throws", () => {
    expect(() => expandOutputPattern("{bogus}.ts", { name: "x" })).toThrow(/unknown placeholder/i);
  });
  test("{name} with no name var throws", () => {
    expect(() => expandOutputPattern("{name}.ts", {})).toThrow(/name/i);
  });
});
