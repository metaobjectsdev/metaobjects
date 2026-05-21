import { test, expect } from "bun:test";
import { HARNESS_VERSION } from "../src/index.js";

test("package loads", () => {
  expect(HARNESS_VERSION).toBe(1);
});
