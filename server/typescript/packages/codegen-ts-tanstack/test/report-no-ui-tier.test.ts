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
import { hasDataGridLayout } from "../src/data-grid-gate.js";

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
  type Shape = "keyless" | "identity" | "id-by-convention";
  async function projection(shape: Shape) {
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
            ...(shape === "identity"
              ? [
                  { "field.long": { name: "id", extends: "Tag.id" } },
                  { "identity.primary": { name: "id", extends: "Tag.id" } },
                ]
              : []),
            // An `id` column and no declared identity: a convention, not a key.
            ...(shape === "id-by-convention" ? [{ "field.long": { name: "id" } }] : []),
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

  test("keyless (no identity, no `id` column): list hook and list keys only", async () => {
    const { obj, out } = await projection("keyless");
    expect(obj.primaryIdentity()).toBeUndefined();
    expect(obj.findField("id")).toBeUndefined();
    expect(hasItemRoute(obj)).toBe(false);
    expect(out).toContain("export function useTagLabels(");
    expect(out).not.toContain("export function useTagLabel(");
    expect(out).toContain("lists:");
    expect(out).not.toContain("details:");
    expect(out).not.toContain("detail:");
    // Nothing fetches an item address the routes do not mount.
    expect(out).not.toContain("/${id}");
  });

  test("identity: the detail hook and its keys are still there", async () => {
    const { obj, out } = await projection("identity");
    expect(obj.primaryIdentity()).toBeDefined();
    expect(hasItemRoute(obj)).toBe(true);
    expect(out).toContain("export function useTagLabel(");
    expect(out).toContain("export function useTagLabels(");
    expect(out).toContain("details:");
    expect(out).toContain("detail:");
  });

  test("id-by-convention: an `id` field is not a declared key, so no detail hook either", async () => {
    const { obj, out } = await projection("id-by-convention");
    expect(obj.primaryIdentity()).toBeUndefined();
    expect(obj.findField("id")).toBeDefined();
    expect(hasItemRoute(obj)).toBe(false);
    expect(out).toContain("export function useTagLabels(");
    expect(out).not.toContain("export function useTagLabel(");
    expect(out).not.toContain("details:");
    expect(out).not.toContain("detail:");
  });
});

// The grid generators gate on `servesClientTier` AND on a `layout.dataGrid`. Through
// `runGen` a report can never reach them with a layout: it is generated from its read
// model, which carries fields and a source and nothing else. So the gate is proven where
// it is reachable, on the generator's own `filter`, with the DECLARED report node, which
// the loader lets carry a `layout.dataGrid`. That node is served (`servesReadApi` is true)
// and has the layout, so it passes every other gate: reverting any of these generators to
// `servesReadApi` turns its row red. This is also the door an adopter driving a generator
// outside `runGen` comes through.
describe("each UI-tier gate refuses a served report that passes its other gates", () => {
  async function reportWithGrid() {
    const json = JSON.stringify({ "metadata.root": { package: "test", children: [
      {
        "object.entity": {
          name: "Invoice",
          children: [
            { "source.rdb": { "@table": "invoices" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "status" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "layout.dataGrid": { name: "default", "@columns": ["status"] } },
            { "dimension.attribute": { name: "status", "@of": "Invoice.status" } },
            { "measure.aggregate": { name: "invoices", "@agg": "count", "@of": "Invoice.id" } },
          ],
        },
      },
      {
        "object.report": {
          name: "InvoiceTotals",
          "@from": "Invoice",
          "@dimensions": ["status"],
          "@measures": ["invoices"],
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_invoice_totals" } },
            { "layout.dataGrid": { name: "default", "@columns": ["status"] } },
          ],
        },
      },
    ] } });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(result.errors).toEqual([]);
    const report = result.root.findObject("InvoiceTotals");
    const entity = result.root.findObject("Invoice");
    if (!report || !entity) throw new Error("fixture objects not found");
    return { report, entity };
  }

  for (const [name, make] of [
    ["tanstackQuery", tanstackQuery],
    ["tanstackGrid", tanstackGrid],
    ["tanstackGridHook", tanstackGridHook],
    ["reference hooks", refHooks],
    ["reference grid", refGrid],
    ["reference grid-hook", refGridHook],
  ] as const) {
    test(name, async () => {
      const { report, entity } = await reportWithGrid();
      // The report passes everything but the client-tier gate.
      expect(servesReadApi(report)).toBe(true);
      expect(hasDataGridLayout(report)).toBe(true);
      const filter = make().filter;
      if (!filter) throw new Error(`${name} has no filter`);
      // Not vacuous: the same filter admits the entity beside it.
      expect(filter(entity)).toBe(true);
      expect(filter(report)).toBe(false);
    });
  }
});
