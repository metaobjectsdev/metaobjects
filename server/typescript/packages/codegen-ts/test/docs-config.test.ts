import { test, expect } from "bun:test";
import { resolveDocsConfig } from "../src/metaobjects-config.js";

test("defaults when no docs block and no overrides", () => {
  const r = resolveDocsConfig(undefined, {}, "package");
  expect(r).toEqual({ outDir: "./docs", layout: "package", baseUrl: "", surfaces: ["model", "api"] });
});

test("docs block supplies values; fallbackLayout ignored when layout set", () => {
  const r = resolveDocsConfig({ outDir: "./site", layout: "flat", baseUrl: "/d", surfaces: ["model"] }, {}, "package");
  expect(r).toEqual({ outDir: "./site", layout: "flat", baseUrl: "/d", surfaces: ["model"] });
});

test("CLI overrides beat the docs block", () => {
  const r = resolveDocsConfig({ outDir: "./site", layout: "flat" }, { outDir: "./out", layout: "package", surfaces: ["api"], baseUrl: "x" }, "flat");
  expect(r).toEqual({ outDir: "./out", layout: "package", baseUrl: "x", surfaces: ["api"] });
});

test("layout falls back to fallbackLayout when neither block nor override sets it", () => {
  expect(resolveDocsConfig({ outDir: "./d" }, {}, "package").layout).toBe("package");
});
