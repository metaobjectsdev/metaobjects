// ADR-0034 Amendment 3 (2026-09-24) — the one place generated code decides whether it
// imports the HTTP-adapter tier from the package or from the copy `meta eject` placed in
// the adopter's repo.
import { describe, test, expect } from "bun:test";
import { httpRuntimeSpecifier, ownedRuntimeImport, HTTP_RUNTIME_PACKAGE } from "../src/index.js";

const flat = { outputLayout: "flat", extStyle: "js" } as const;

describe("httpRuntimeSpecifier", () => {
  test("no override is the package subpath — what every non-ejected project emits", () => {
    expect(httpRuntimeSpecifier("drizzle-fastify", flat, undefined)).toBe(`${HTTP_RUNTIME_PACKAGE}/drizzle-fastify`);
    expect(httpRuntimeSpecifier("hono", flat, "acme::shop")).toBe(`${HTTP_RUNTIME_PACKAGE}/hono`);
    // The allowlist TYPES ride the drizzle-fastify entry in the package.
    expect(httpRuntimeSpecifier("allowlists", flat, undefined)).toBe(`${HTTP_RUNTIME_PACKAGE}/drizzle-fastify`);
  });

  test("naming the package explicitly is the same as no override", () => {
    const ctx = { ...flat, httpRuntimeImport: HTTP_RUNTIME_PACKAGE };
    expect(httpRuntimeSpecifier("hono", ctx, undefined)).toBe(`${HTTP_RUNTIME_PACKAGE}/hono`);
  });

  test("a relative copy is file-precise, extensioned, and deepened per package directory", () => {
    const ctx = { ...flat, httpRuntimeImport: "../codegen/runtime" };
    expect(httpRuntimeSpecifier("drizzle-fastify", ctx, "acme::shop")).toBe("../codegen/runtime/drizzle-fastify/index.js");
    // The allowlist types point at the one file that declares them, so an entity module in a
    // Hono project does not pull the Fastify adapter into its type graph.
    expect(httpRuntimeSpecifier("allowlists", ctx, undefined)).toBe("../codegen/runtime/drizzle-fastify/filter-allowlist.js");
    const pkgLayout = { outputLayout: "package", extStyle: "none", httpRuntimeImport: "../codegen/runtime" } as const;
    expect(httpRuntimeSpecifier("hono", pkgLayout, "acme::shop")).toBe("../../../codegen/runtime/hono/index");
  });

  test("a path alias onto a copy keeps the alias and names the file", () => {
    const ctx = { ...flat, httpRuntimeImport: "~/runtime/" };
    expect(httpRuntimeSpecifier("drizzle-fastify", ctx, "acme::shop")).toBe("~/runtime/drizzle-fastify/index.js");
  });
});

describe("ownedRuntimeImport", () => {
  test("is the relative path from the output root to <projectRoot>/codegen/runtime", () => {
    expect(ownedRuntimeImport("/p", "src/gen")).toBe("../../codegen/runtime");
    expect(ownedRuntimeImport("/p", "/p/generated")).toBe("../codegen/runtime");
    expect(ownedRuntimeImport("/p", "codegen")).toBe("./runtime");
    expect(ownedRuntimeImport("/p", "codegen/runtime")).toBe("./");
  });
});
