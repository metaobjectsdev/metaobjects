// An owned routes copy that predates `provides.routes` (and the `mountsRoutes` marker before it)
// is warned about when the run writes an api reference, because that reference cannot see the
// copy's `expose` or `filter`. A bare `emitsHonoRoutes` marker carries neither, so it still warns.
import { describe, expect, test } from "bun:test";
import type { Generator } from "../src/generator.js";
import { warnUnmarkedRoutesGenerators } from "../src/ui-tier-gate.js";

const apiDocs: Generator = { name: "api-docs", provides: { apiDocs: { subDir: "api" } }, generate: () => [] };
const warnings = (gens: Generator[]): string[] => {
  const out: string[] = [];
  warnUnmarkedRoutesGenerators(gens, (m) => out.push(m));
  return out;
};

describe("warnUnmarkedRoutesGenerators", () => {
  test("a Hono copy with only the legacy emitsHonoRoutes marker is stale", () => {
    const hono: Generator = { name: "routes-file-hono", emitsHonoRoutes: true, generate: () => [] };
    expect(warnings([hono, apiDocs])).toHaveLength(1);
  });

  test("mountsRoutes or provides.routes silences it", () => {
    const legacy: Generator = { name: "routes-file-hono", emitsHonoRoutes: true, mountsRoutes: {}, generate: () => [] };
    const current: Generator = { name: "routes-file", provides: { routes: { framework: "fastify" } }, generate: () => [] };
    expect(warnings([legacy, current, apiDocs])).toEqual([]);
  });

  test("no api reference in the run, no warning", () => {
    expect(warnings([{ name: "routes-file", generate: () => [] }])).toEqual([]);
  });
});
