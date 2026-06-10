import { describe, test, expect, expectTypeOf } from "bun:test";
import { defineConfig, normalizeConfig, resolveTargets, DEFAULT_TARGET_NAME, type MetaobjectsGenConfig, type ResolvedGenConfig } from "../src/metaobjects-config.js";
import type { Generator } from "../src/generator.js";

describe("resolveTargets", () => {
  const base = { outDir: "db/gen", extStyle: "none" as const, dbImport: "../index", dialect: "sqlite" as const, generators: [] };

  test("synthesizes a 'default' target from top-level fields", () => {
    const t = resolveTargets({ ...base, importBase: "@mf/db/generated", outputLayout: "package" });
    expect(t[DEFAULT_TARGET_NAME]).toEqual({
      name: "default", outDir: "db/gen", importBase: "@mf/db/generated",
      outputLayout: "package", dbImport: "../index",
    });
  });

  test("default target: outputLayout defaults to 'flat', importBase undefined", () => {
    const t = resolveTargets({ ...base });
    expect(t.default!.outputLayout).toBe("flat");
    expect(t.default!.importBase).toBeUndefined();
  });

  test("named targets resolve; outputLayout + dbImport fall back to top-level, importBase does NOT inherit", () => {
    const t = resolveTargets({
      ...base, outputLayout: "package", importBase: "@mf/db/generated",
      targets: {
        api: { outDir: "api/gen", dbImport: "@mf/database" },
        web: { outDir: "web/gen" },
      },
    });
    expect(t.api).toEqual({ name: "api", outDir: "api/gen", importBase: undefined, outputLayout: "package", dbImport: "@mf/database" });
    expect(t.web).toEqual({ name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index" });
  });

  test("named target may override outputLayout + importBase", () => {
    const t = resolveTargets({ ...base, targets: { x: { outDir: "x", outputLayout: "package", importBase: "@x/gen" } } });
    expect(t.x!.outputLayout).toBe("package");
    expect(t.x!.importBase).toBe("@x/gen");
  });
});

describe("normalizeConfig — targets", () => {
  test("normalized config carries resolved targets incl. default", () => {
    const c = normalizeConfig(defineConfig({
      outDir: "db/gen", extStyle: "none", dbImport: "../index", dialect: "sqlite",
      targets: { api: { outDir: "api/gen" } }, generators: [],
    }));
    expect(Object.keys(c.targets).sort()).toEqual(["api", "default"]);
  });
});

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
    // generators is now (Generator | string)[]; this entry is the typed stub.
    expect((cfg.generators[0] as Generator).name).toBe("stub");
  });

  test("type-level: MetaobjectsGenConfig.generators is (Generator | string)[] (ADR-0021 #1 — stable-name strings allowed alongside factories)", () => {
    expectTypeOf<MetaobjectsGenConfig["generators"]>().toEqualTypeOf<(Generator | string)[]>();
  });

  test("type-level: MetaobjectsGenConfig embeds ResolvedGenConfig (all required fields present, types exact)", () => {
    expectTypeOf<Pick<MetaobjectsGenConfig, "outDir" | "extStyle" | "dbImport" | "dialect" | "outputLayout" | "includeHonoRoutes" | "providedEnumModule">>()
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
