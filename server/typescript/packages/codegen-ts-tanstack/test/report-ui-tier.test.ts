// FR-044 — a served report has a route, a row type and a LIST HOOK, and no grid, grid hook
// or form; a keyless projection gets a list hook and no detail hook.
//
// A view-backed report passes every source-keyed gate (`servesReadApi` is true for it: the
// route and queries generators emit). The hook generator gates on `servesClientHooks`,
// which a report passes; the grid generators gate on `servesClientTier`, which it fails.
// A grid, grid hook or form over reports belongs to the later `reporting` library.
// `formFile` is held by the same model pair in cli/test/unit/reporting-inert.test.ts,
// which runs every catalog generator.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryStringSource, MetaDataLoader, loadUris, reportReadModel } from "@metaobjectsdev/metadata";
import {
  buildPkMap, buildRelationMap, defineConfig, hasItemRoute, makeRenderContext, runGen,
  servesClientHooks, servesClientTier, servesReadApi,
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

describe("a served report gets a list hook and no other UI-tier file", () => {
  test("the report is served, has a hook and has no grid tier", async () => {
    const root = await loadWith();
    const report = root.objects().find((o) => o.name === "StoreTotals");
    if (!report) throw new Error("StoreTotals not found");
    for (const o of [report, reportReadModel(report, root)]) {
      expect(servesReadApi(o)).toBe(true);
      expect(servesClientHooks(o)).toBe(true);
      expect(servesClientTier(o)).toBe(false);
    }
  });

  for (const [name, hooks, others] of [
    ["built-in", () => [tanstackQuery()], () => [tanstackGrid(), tanstackGridHook()]],
    ["reference", () => [refHooks()], () => [refGrid(), refGridHook()]],
  ] as const) {
    test(`${name} hook generator emits the report's list hook and its descriptor`, async () => {
      const paths = await emittedPaths(hooks());
      expect(paths).toContain("Program.hooks.ts");
      expect(paths.filter((p) => p.startsWith("StoreTotals")).sort()).toEqual([
        "StoreTotals.hooks.ts",
        "StoreTotals.meta.ts",
      ]);
      // A sourceless report is not served, so it has no hook.
      for (const sourceless of ["ProgramEngagement", "DailyRevenue"]) {
        expect(paths.filter((p) => p.startsWith(sourceless))).toEqual([]);
      }
    });

    test(`${name} grid and grid hook generators emit nothing named for the report`, async () => {
      const paths = await emittedPaths(others());
      expect(paths.filter((p) => p.startsWith("StoreTotals"))).toEqual([]);
      for (const sourceless of ["ProgramEngagement", "DailyRevenue"]) {
        expect(paths.filter((p) => p.startsWith(sourceless))).toEqual([]);
      }
    });
  }

  for (const [name, make] of [
    ["built-in", tanstackQuery],
    ["reference", refHooks],
  ] as const) {
    test(`${name} hooks file for a report: the list hook and its keys, no detail hook, no mutations`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "report-hooks-"));
      try {
        await runGen({
          config: defineConfig({ outDir: dir, extStyle: "none", dbImport: "../db", dialect: "postgres", generators: [make()] }),
          metadata: await loadWith(),
        });
        const out = readFileSync(join(dir, "StoreTotals.hooks.ts"), "utf8");
        // `Totals` is already plural, so the list hook does not double it (hookListNameSegment).
        expect(out).toContain("export function useStoreTotalsList(");
        expect(out).toContain("filter?: StoreTotalsFilter");
        expect(out).toContain("type StoreTotals as StoreTotalsRow");
        expect(out).toContain("lists:");
        expect(out).not.toContain("details:");
        expect(out).not.toContain("detail:");
        expect(out).not.toContain("useCreate");
        expect(out).not.toContain("useUpdate");
        expect(out).not.toContain("useDelete");
        expect(out).not.toContain("/${id}");
        expect(out).not.toContain("useMutation");
      } finally {
        rmSync(dir, { recursive: true, force: true });
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
describe("each grid-tier gate refuses a served report that passes its other gates", () => {
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
    ["tanstackGrid", tanstackGrid],
    ["tanstackGridHook", tanstackGridHook],
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

// The hook generator admits a served report and still refuses what is not served: the same
// filter, asked of a report with no view, answers false. Reverting it to `servesClientTier`
// turns the first row red; widening it past `servesReadApi` turns the second red.
describe("the hook gate", () => {
  for (const [name, make] of [
    ["tanstackQuery", tanstackQuery],
    ["reference hooks", refHooks],
  ] as const) {
    test(name, async () => {
      const root = await loadWith();
      const filter = make().filter;
      if (!filter) throw new Error(`${name} has no filter`);
      const served = root.objects().find((o) => o.name === "StoreTotals");
      const sourceless = root.objects().find((o) => o.name === "DailyRevenue");
      if (!served || !sourceless) throw new Error("fixture reports not found");
      expect(filter(served)).toBe(true);
      expect(filter(reportReadModel(served, root))).toBe(true);
      expect(filter(sourceless)).toBe(false);
    });
  }
});
