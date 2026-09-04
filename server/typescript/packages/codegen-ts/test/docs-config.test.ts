import { test, expect } from "bun:test";
import { resolveDocsConfig } from "../src/metaobjects-config.js";

// `requirements` and `agent` joined the default set deliberately, and BOTH depend on the
// same guard: each emits ZERO FILES when it has nothing to describe — not an empty page —
// so a project without a ledger, a schema or a generated UI sees byte-identical output.
// If that guard is ever weakened for either surface, its default must go back to opt-in.
//
// `agent` additionally only materialises with a loadable gen config, the way `api` does;
// that gate lives in the docs COMMAND, not in this resolver, so it is not visible here.
test("defaults when no docs block and no overrides", () => {
  const r = resolveDocsConfig(undefined, {}, "package");
  expect(r).toEqual({ outDir: "./docs", layout: "package", baseUrl: "", surfaces: ["model", "api", "requirements", "agent"], apiSurfaces: [{ lang: "ts", subDir: "api" }] });
});

test("docs block supplies values; fallbackLayout ignored when layout set", () => {
  const r = resolveDocsConfig({ outDir: "./site", layout: "flat", baseUrl: "/d", surfaces: ["model"] }, {}, "package");
  expect(r).toEqual({ outDir: "./site", layout: "flat", baseUrl: "/d", surfaces: ["model"], apiSurfaces: [{ lang: "ts", subDir: "api" }] });
});

test("CLI overrides beat the docs block", () => {
  const r = resolveDocsConfig({ outDir: "./site", layout: "flat" }, { outDir: "./out", layout: "package", surfaces: ["api"], baseUrl: "x" }, "flat");
  expect(r).toEqual({ outDir: "./out", layout: "package", baseUrl: "x", surfaces: ["api"], apiSurfaces: [{ lang: "ts", subDir: "api" }] });
});

test("layout falls back to fallbackLayout when neither block nor override sets it", () => {
  expect(resolveDocsConfig({ outDir: "./d" }, {}, "package").layout).toBe("package");
});

test("apiSurfaces defaults to a single ts surface", () => {
  const r = resolveDocsConfig(undefined, {}, "flat");
  expect(r.apiSurfaces).toEqual([{ lang: "ts", subDir: "api" }]);
});
test("apiSurfaces from the docs block is preserved", () => {
  const block = { apiSurfaces: [{ lang: "ts", subDir: "api/ts" }, { lang: "java", subDir: "api/java", baseUrl: "https://d/j" }] };
  expect(resolveDocsConfig(block, {}, "flat").apiSurfaces).toEqual(block.apiSurfaces);
});
