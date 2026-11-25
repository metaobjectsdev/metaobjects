// ADR-0034 Amendment 12 — a generator declares what it provides in one place, and every consumer
// reads it through `providesOf`, which also folds in the deprecated single-purpose markers an owned
// copy ejected before the declaration still sets.
import { describe, expect, test } from "bun:test";
import { providesOf, type Generator } from "../src/generator.js";
import { runEmitsHonoRoutes, runEmitsUiTier, runRoutesExpose } from "../src/ui-tier-gate.js";

const gen = (extra: Partial<Generator>): Generator => ({ name: "my-own", generate: () => [], ...extra });

describe("providesOf", () => {
  test("a generator that declares nothing provides nothing", () => {
    expect(providesOf(gen({}))).toEqual({
      entityModule: false, queries: false, names: false, reportExport: false, uiTier: false, modelDocs: false,
    });
  });

  test("reads the declaration", () => {
    const p = providesOf(gen({ provides: { queries: true, routes: { framework: "hono" }, apiDocs: { subDir: "api" } } }));
    expect(p.queries).toBe(true);
    expect(p.routes).toEqual({ framework: "hono" });
    expect(p.apiDocs).toEqual({ subDir: "api" });
  });

  test("folds in the deprecated markers", () => {
    const legacy = gen({
      emitsEntityModule: true, emitsQueries: true, emitsNames: true, emitsReportExport: true,
      emitsUiTier: true, emitsModelDocs: true, emitsApiDocs: { subDir: "api" },
      emitsHonoRoutes: true, mountsRoutes: { expose: ["list"] },
    });
    expect(providesOf(legacy)).toEqual({
      entityModule: true, queries: true, names: true, reportExport: true, uiTier: true, modelDocs: true,
      routes: { framework: "hono", expose: ["list"] }, apiDocs: { subDir: "api" },
    });
    expect(providesOf(gen({ mountsRoutes: {} })).routes).toEqual({ framework: "fastify" });
  });

  test("a generator of your own, under any name, is seen by the run's consumers", () => {
    const mine = [gen({ name: "acme-ui", provides: { uiTier: true } }), gen({ name: "acme-hono", provides: { routes: { framework: "hono", expose: ["list"] } } })];
    expect(runEmitsUiTier(mine)).toBe(true);
    expect(runEmitsHonoRoutes(mine)).toBe(true);
    expect(runRoutesExpose(mine)?.restHono).toBeDefined();
    expect(runRoutesExpose(mine)?.rest).toBeUndefined();
  });
});
