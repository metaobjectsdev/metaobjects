import { describe, test, expect, expectTypeOf } from "bun:test";
import { defineConfig, normalizeConfig, type MetaobjectsGenConfig, type ResolvedGenConfig } from "../src/metaobjects-config.js";
import type { Generator } from "../src/generator.js";

describe("defineConfig", () => {
  test("returns the config unchanged (identity for runtime; type inference at compile time)", () => {
    const stub: Generator = { name: "stub", generate: async () => [] };
    const cfg = defineConfig({
      outDir: "out",
      extStyle: "none",
      dbImport: "../db",
      dialect: "sqlite",
      generators: [stub],
    });
    expect(cfg.outDir).toBe("out");
    expect(cfg.generators[0]!.name).toBe("stub");
  });

  test("type-level: MetaobjectsGenConfig.generators is Generator[]", () => {
    expectTypeOf<MetaobjectsGenConfig["generators"]>().toEqualTypeOf<Generator[]>();
  });

  test("type-level: MetaobjectsGenConfig embeds ResolvedGenConfig (all required fields present, types exact)", () => {
    expectTypeOf<Pick<MetaobjectsGenConfig, "outDir" | "extStyle" | "dbImport" | "dialect">>()
      .toEqualTypeOf<ResolvedGenConfig>();
  });
});

describe("apiPrefix config option", () => {
  test("defaults to empty string when omitted", () => {
    const config = normalizeConfig(defineConfig({
      outDir: "out",
      extStyle: "none",
      dbImport: "../db",
      dialect: "sqlite",
      generators: [],
    }));
    expect(config.apiPrefix).toBe("");
  });
  test("accepts custom prefix '/api'", () => {
    const config = normalizeConfig(defineConfig({
      outDir: "out",
      extStyle: "none",
      dbImport: "../db",
      dialect: "sqlite",
      apiPrefix: "/api",
      generators: [],
    }));
    expect(config.apiPrefix).toBe("/api");
  });
  test("accepts versioned prefix '/api/v1'", () => {
    const config = normalizeConfig(defineConfig({
      outDir: "out",
      extStyle: "none",
      dbImport: "../db",
      dialect: "sqlite",
      apiPrefix: "/api/v1",
      generators: [],
    }));
    expect(config.apiPrefix).toBe("/api/v1");
  });
});

describe("columnNamingStrategy config option", () => {
  test("defaults to snake_case when omitted", () => {
    const config = normalizeConfig(defineConfig({
      outDir: "out",
      extStyle: "none",
      dbImport: "../db",
      dialect: "sqlite",
      generators: [],
    }));
    expect(config.columnNamingStrategy).toBe("snake_case");
  });
  test("accepts 'literal' override", () => {
    const config = normalizeConfig(defineConfig({
      outDir: "out",
      extStyle: "none",
      dbImport: "../db",
      dialect: "sqlite",
      columnNamingStrategy: "literal",
      generators: [],
    }));
    expect(config.columnNamingStrategy).toBe("literal");
  });
  test("accepts 'kebab-case' override", () => {
    const config = normalizeConfig(defineConfig({
      outDir: "out",
      extStyle: "none",
      dbImport: "../db",
      dialect: "sqlite",
      columnNamingStrategy: "kebab-case",
      generators: [],
    }));
    expect(config.columnNamingStrategy).toBe("kebab-case");
  });
});
