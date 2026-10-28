import { describe, test, expect, expectTypeOf } from "bun:test";
import { guideUrl } from "@metaobjectsdev/metadata/release-docs";
// The guide links name the tag of the running release (a prerelease keeps main).
const BLOB = guideUrl("");
import { defineConfig, normalizeConfig, resolveTargets, DEFAULT_TARGET_NAME, DRIZZLE_BOUND_GENERATORS, type MetaobjectsGenConfig, type ResolvedGenConfig, type Dialect, type ExtStyle } from "../src/metaobjects-config.js";
import type { Generator } from "../src/generator.js";
import { generatorRegistry } from "../src/generator-registry.js";
import { callableFile } from "../src/generators/callable-file.js";

describe("resolveTargets", () => {
  const base = { outDir: "db/gen", extStyle: "none" as const, dbImport: "../index", dialect: "sqlite" as const, generators: [] };

  test("synthesizes a 'default' target from top-level fields", () => {
    const t = resolveTargets({ ...base, importBase: "@acme/db/generated", outputLayout: "package" });
    expect(t[DEFAULT_TARGET_NAME]).toEqual({
      name: "default", outDir: "db/gen", importBase: "@acme/db/generated",
      outputLayout: "package", dbImport: "../index", runtime: true,
    });
  });

  test("default target: outputLayout defaults to 'flat', importBase undefined", () => {
    const t = resolveTargets({ ...base });
    expect(t.default!.outputLayout).toBe("flat");
    expect(t.default!.importBase).toBeUndefined();
  });

  test("named targets resolve; outputLayout + dbImport fall back to top-level, importBase does NOT inherit", () => {
    const t = resolveTargets({
      ...base, outputLayout: "package", importBase: "@acme/db/generated",
      targets: {
        api: { outDir: "api/gen", dbImport: "@acme/database" },
        web: { outDir: "web/gen" },
      },
    });
    expect(t.api).toEqual({ name: "api", outDir: "api/gen", importBase: undefined, outputLayout: "package", dbImport: "@acme/database", runtime: true });
    expect(t.web).toEqual({ name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index", runtime: true });
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

  test("type-level: MetaobjectsGenConfig embeds ResolvedGenConfig's non-DB fields exactly (#194 — dbImport/dialect are OPTIONAL here, filled by the runner)", () => {
    // Everything except dbImport/dialect matches ResolvedGenConfig field-for-field.
    expectTypeOf<Pick<MetaobjectsGenConfig, "outDir" | "outputLayout" | "includeHonoRoutes" | "includeNames" | "includeReportExport" | "includeUiTier" | "providedEnumModule">>()
      .toEqualTypeOf<Omit<ResolvedGenConfig, "dbImport" | "dialect" | "extStyle" | "routesExpose" | "includeUiTierExplicit">>();
    // extStyle is OPTIONAL too: the config `meta init` scaffolds omits it and must still
    // typecheck; the runner fills DEFAULT_EXT_STYLE.
    expectTypeOf<MetaobjectsGenConfig["extStyle"]>().toEqualTypeOf<ExtStyle | undefined>();
    // dbImport/dialect are OPTIONAL on the user config (a value-object-only project omits
    // them); ResolvedGenConfig (what generators consume) keeps them required.
    expectTypeOf<MetaobjectsGenConfig["dbImport"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<MetaobjectsGenConfig["dialect"]>().toEqualTypeOf<Dialect | undefined>();
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

describe("columnNamingStrategy is refused (ADR-0058)", () => {
  // The 1.0 key held a column rule that may be the one matching the adopter's database, so
  // it is refused with the setting that replaced it, never silently dropped.
  test("a config still carrying it is refused, naming the value and the new setting", () => {
    const cfg = { outDir: "out", dbImport: "../db", dialect: "sqlite", generators: [], columnNamingStrategy: "literal" } as unknown as MetaobjectsGenConfig;
    expect(() => normalizeConfig(cfg)).toThrow(
      'columnNamingStrategy in metaobjects.config.ts was removed in 1.1.0. Column and table naming is one project setting now, read by every port: "naming" in .metaobjects/config.json, for example "naming": { "columns": "literal" }. Move it there and delete columnNamingStrategy in metaobjects.config.ts. See ' + BLOB + 'docs/features/migrations/physical-naming.md',
    );
  });
  test("a config without it normalizes as before", () => {
    const config = normalizeConfig(defineConfig({ outDir: "out", extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [] }));
    expect("columnNamingStrategy" in config).toBe(false);
  });
});


// #479 — `orm: "prisma"`: the schema is schema.prisma, so no target carries Drizzle bindings and
// the generators that write Drizzle code are refused.
describe("orm: prisma", () => {
  const base = { outDir: "db/gen", dialect: "postgres" as const, generators: [] };

  test("every target is contract-only by default; drizzle keeps runtime on", () => {
    const prisma = resolveTargets({ ...base, orm: "prisma", targets: { web: { outDir: "web/gen" } } });
    expect(prisma[DEFAULT_TARGET_NAME]!.runtime).toBe(false);
    expect(prisma.web!.runtime).toBe(false);
    const drizzle = resolveTargets({ ...base, orm: "drizzle", targets: { web: { outDir: "web/gen" } } });
    expect(drizzle[DEFAULT_TARGET_NAME]!.runtime).toBe(true);
    expect(resolveTargets(base)[DEFAULT_TARGET_NAME]!.runtime).toBe(true);
  });

  test("a target that asks for runtime bindings is refused", () => {
    expect(() =>
      normalizeConfig({ ...base, orm: "prisma", targets: { server: { outDir: "s", runtime: true } } }),
    ).toThrow('target "server" sets runtime: true');
  });

  test("the generators that write Drizzle code are refused, by name and as factories", () => {
    expect(() => normalizeConfig({ ...base, orm: "prisma", generators: ["entity", "queries", "routes"] })).toThrow(
      'orm: "prisma" refuses "queries", "routes"',
    );
    expect(() => normalizeConfig({ ...base, orm: "prisma", generators: [callableFile()] })).toThrow('refuses "callable"');
    const ok = normalizeConfig({ ...base, orm: "prisma", generators: ["entity", "prisma-schema", "barrel"] });
    expect(ok.generators.map((g) => g.name)).toContain("prisma-schema");
  });

  test("an orm that is not one is refused", () => {
    expect(() => normalizeConfig({ ...base, orm: "typeorm" as "prisma" })).toThrow('orm "typeorm" is not one of');
  });

  test("every Drizzle-bound name is a registered generator", () => {
    for (const n of DRIZZLE_BOUND_GENERATORS) expect(generatorRegistry[n]).toBeDefined();
  });
});
