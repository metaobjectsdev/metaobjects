import { test, expect } from "bun:test";
import { apiLabel } from "../src/generators/api-label.js";
test("known langs", () => {
  expect(apiLabel("ts")).toBe("TypeScript");
  expect(apiLabel("java")).toBe("Java");
  expect(apiLabel("csharp")).toBe("C#");
});
test("unknown lang is capitalized verbatim", () => { expect(apiLabel("rust")).toBe("Rust"); });
