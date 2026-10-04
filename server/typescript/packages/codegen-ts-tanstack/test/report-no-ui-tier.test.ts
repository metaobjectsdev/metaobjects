// FR-044 Plan 3, answer 6 — a served report has a route and NO client tier, and a keyless
// projection gets a list hook and no detail hook.
//
// A view-backed report passes every source-keyed gate (`servesReadApi` is true for it: the
// route and queries generators emit), so the UI generators gate on `servesClientTier`
// instead. Hooks, grids and grid hooks for a report are Plan 5; until then nothing here may
// emit a file for one. `formFile` is held by the same model pair in
// cli/test/unit/reporting-inert.test.ts, which runs every catalog generator.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryStringSource, MetaDataLoader, loadUris, reportReadModel } from "@metaobjectsdev/metadata";
import {
  buildPkMap, buildRelationMap, defineConfig, hasItemRoute, makeRenderContext, runGen,
  servesClientTier, servesReadApi,
} from "@metaobjectsdev/codegen-ts";
import type { Generator } from "@metaobjectsdev/codegen-ts";
import { tanstackGrid, tanstackGridHook, tanstackQuery } from "../src/index.js";
import { tanstackQuery as refHooks } from "../src/reference/hooks.js";
import { tanstackGrid as refGrid } from "../src/reference/grid.js";
import { tanstackGridHook as refGridHook } from "../src/reference/grid-hook.js";
import { renderHooksFile } from "../src/templates/hooks-file.js";

// test → codegen-ts-tanstack → packages → typescript → server → repo root
const REPO_FIXTURES = resolve(import.meta.dir, "..", "..", "..", "..", "..", "fixtures");
const WITH = join(REPO_FIXTURES, "codegen-noop", "reporting", "with", "meta.shop.json");

async function loadWith() {
  const result = await loadUris([pathToFileURL(WITH).href]);
  expect(result.errors).toEqual([]);
  return result.root;
}

async function emittedPaths(generators: Generator[]): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "report-no-ui-"));
  try {
    const result = await runGen({
      config: defineConfig({ outDir: dir, extStyle: "none", dbImport: "../db", dialect: "postgres", generators }),
      metadata: await loadWith(),
      dryRun: true,
    });
    return result.files.map((f) => f.path.split("/").pop() ?? f.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("no UI-tier generator emits for a served report", () => {
  test("the report is served and has no client tier", async () => {
    const root = await loadWith();
    const report = root.objects().find((o) => o.name === "StoreTotals");
    if (!report) throw new Error("StoreTotals not found");
    for (const o of [report, reportReadModel(report, root)]) {
      expect(servesReadApi(o)).toBe(true);
      expect(servesClientTier(o)).toBe(false);
    }
  });

  for (const [name, generators] of [
    ["built-in", () => [tanstackQuery(), tanstackGrid(), tanstackGridHook()]],
    ["reference", () => [refHooks(), refGrid(), refGridHook()]],
  ] as const) {
    test(`${name} hooks, grid and grid hook emit nothing named for the report`, async () => {
      const paths = await emittedPaths(generators());
      // Not vacuous: the entities beside the report do get their hooks.
      expect(paths).toContain("Program.hooks.ts");
      expect(paths.filter((p) => p.startsWith("StoreTotals"))).toEqual([]);
      for (const sourceless of ["ProgramEngagement", "DailyRevenue"]) {
        expect(paths.filter((p) => p.startsWith(sourceless))).toEqual([]);
      }
    });
  }
});

describe("a keyless projection gets a list hook and no detail hook", () => {
  async function projection(keyed: boolean) {
    const json = JSON.stringify({ "metadata.root": { package: "test", children: [
      {
        "object.entity": {
          name: "Tag",
          children: [
            { "source.rdb": { "@table": "tags" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "label" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "TagLabel",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_tag_label" } },
            ...(keyed
              ? [
                  { "field.long": { name: "id", extends: "Tag.id" } },
                  { "identity.primary": { name: "id", extends: "Tag.id" } },
                ]
              : []),
            { "field.string": { name: "label", extends: "Tag.label" } },
          ],
        },
      },
    ] } });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(result.errors).toEqual([]);
    const root = result.root;
    const obj = root.findObject("TagLabel");
    if (!obj) throw new Error("TagLabel not found");
    const ctx = makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    return { obj, out: renderHooksFile(obj, ctx) };
  }

  test("keyless: list hook and list keys only", async () => {
    const { obj, out } = await projection(false);
    expect(hasItemRoute(obj)).toBe(false);
    expect(out).toContain("export function useTagLabels(");
    expect(out).not.toContain("export function useTagLabel(");
    expect(out).toContain("lists:");
    expect(out).not.toContain("details:");
    expect(out).not.toContain("detail:");
    // Nothing fetches an item address the routes do not mount.
    expect(out).not.toContain("/${id}");
  });

  test("keyed: the detail hook and its keys are still there", async () => {
    const { obj, out } = await projection(true);
    expect(hasItemRoute(obj)).toBe(true);
    expect(out).toContain("export function useTagLabel(");
    expect(out).toContain("export function useTagLabels(");
    expect(out).toContain("details:");
    expect(out).toContain("detail:");
  });
});
