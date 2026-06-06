import { test, expect } from "bun:test";
import { surfaceCrossHref } from "../src/docs-paths.js";
test("flat: model<->api", () => {
  expect(surfaceCrossHref("Order.md", "api/Order.md")).toBe("./api/Order.md");
  expect(surfaceCrossHref("api/Order.md", "Order.md")).toBe("../Order.md");
});
test("package: across package dirs + api subroot", () => {
  expect(surfaceCrossHref("acme/sales/Order.md", "api/acme/sales/Order.md")).toBe("../../api/acme/sales/Order.md");
  expect(surfaceCrossHref("api/acme/sales/Order.md", "acme/sales/Order.md")).toBe("../../../acme/sales/Order.md");
});
