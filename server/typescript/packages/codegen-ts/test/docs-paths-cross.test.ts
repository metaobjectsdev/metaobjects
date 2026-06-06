import { test, expect } from "bun:test";
import { surfaceCrossHref, apiSurfaceHref } from "../src/docs-paths.js";

test("apiSurfaceHref relative when no baseUrl", () => {
  expect(apiSurfaceHref("Order.md", { subDir: "api/ts" }, "Order.md")).toBe("./api/ts/Order.md");
  expect(apiSurfaceHref("acme/shop/Order.md", { subDir: "api/java" }, "acme/shop/Order.md")).toBe("../../api/java/acme/shop/Order.md");
});
test("apiSurfaceHref absolute when baseUrl set", () => {
  expect(apiSurfaceHref("Order.md", { subDir: "api/java", baseUrl: "https://d/java" }, "acme/shop/Order.md")).toBe("https://d/java/acme/shop/Order.md");
  expect(apiSurfaceHref("Order.md", { subDir: "api/java", baseUrl: "https://d/java/" }, "Order.md")).toBe("https://d/java/Order.md");
});
test("flat: model<->api", () => {
  expect(surfaceCrossHref("Order.md", "api/Order.md")).toBe("./api/Order.md");
  expect(surfaceCrossHref("api/Order.md", "Order.md")).toBe("../Order.md");
});
test("package: across package dirs + api subroot", () => {
  expect(surfaceCrossHref("acme/sales/Order.md", "api/acme/sales/Order.md")).toBe("../../api/acme/sales/Order.md");
  expect(surfaceCrossHref("api/acme/sales/Order.md", "acme/sales/Order.md")).toBe("../../../acme/sales/Order.md");
});
