// FR-017 Tier 3 — TanStack grid for a TPH discriminator base.
//
// The base emits ONE polymorphic grid: typed against the raw single-table row
// (<Base>Row), folding in every subtype-only column, with the discriminator
// column rendered as a subtype badge. Per-subtype grids are opt-in only
// (own @emitGrid: true) — they inherit the base's dataGrid layout otherwise.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tanstackGrid } from "../src/tanstack-grid.js";
import { tanstackGridHook } from "../src/tanstack-grid-hook.js";
import { renderColumnsFile } from "../src/templates/columns-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap, runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";

async function loadTph(): Promise<{ root: MetaRoot; base: MetaObject; bridge: MetaObject; copay: MetaObject }> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Auth",
                "@discriminator": "type",
                children: [
                  { "source.rdb": { "@table": "auths" } },
                  { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
                  { "layout.dataGrid": { name: "default", "@columns": ["type", "id"] } },
                ],
              },
            },
            {
              "object.entity": {
                name: "BridgeAuth",
                extends: "Auth",
                "@discriminatorValue": "Bridge",
                children: [{ "field.int": { name: "quantity" } }],
              },
            },
            {
              "object.entity": {
                name: "CopayAuth",
                extends: "Auth",
                "@discriminatorValue": "Copay",
                // Opt IN to a per-subtype grid.
                "@emitGrid": true,
                children: [
                  { "field.decimal": { name: "copayAmount", "@precision": 10, "@scale": 2 } },
                ],
              },
            },
          ],
        },
      }),
      { id: "auth.json" },
    ),
  ]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  const find = (n: string) => root.objects().find((o) => o.name === n)! as MetaObject;
  return { root, base: find("Auth"), bridge: find("BridgeAuth"), copay: find("CopayAuth") };
}

/** Same hierarchy, but the base's grid carries an `@filter` preset — the arm where an
 *  orphan `<Sub>.grid.ts` becomes an outright TS2307 rather than merely dangling,
 *  because the hook then imports `<sub>DefaultFilter` from the missing columns module. */
async function loadTphFiltered(): Promise<{ root: MetaRoot }> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Auth",
                "@discriminator": "type",
                children: [
                  { "source.rdb": { "@table": "auths" } },
                  { "field.enum": { name: "type", "@values": ["Bridge", "Copay"], "@filterable": true } },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
                  {
                    "layout.dataGrid": {
                      name: "default",
                      "@columns": ["type", "id"],
                      "@filter": { type: "Bridge" },
                    },
                  },
                ],
              },
            },
            {
              "object.entity": {
                name: "BridgeAuth",
                extends: "Auth",
                "@discriminatorValue": "Bridge",
                children: [{ "field.int": { name: "quantity" } }],
              },
            },
          ],
        },
      }),
      { id: "auth-filtered.json" },
    ),
  ]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  return { root };
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "../db",
    extStyle: "none",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("FR-017 Tier 3 — TPH TanStack grid", () => {
  test("base polymorphic grid types against <Base>Row and folds in subtype columns", async () => {
    const { root, base } = await loadTph();
    const out = renderColumnsFile(base, ctxFor(root));
    // Typed against the raw all-columns row, imported directly (not `Auth as AuthRow`).
    expect(out).toContain("import type { AuthRow }");
    expect(out).toContain("ColumnDef<AuthRow>[]");
    // Declared columns + folded subtype-only columns.
    expect(out).toContain('id: "type"');
    expect(out).toContain('id: "id"');
    expect(out).toContain('id: "quantity"');
    expect(out).toContain('id: "copayAmount"');
    // Discriminator column renders as a badge.
    expect(out).toMatch(/id: "type"[\s\S]*?renderer: "badge"/);
  });

  test("grid filter: base emits; subtype opts in via @emitGrid only", async () => {
    const { base, bridge, copay } = await loadTph();
    const gen = tanstackGrid();
    expect(gen.filter!(base)).toBe(true);    // polymorphic grid
    expect(gen.filter!(bridge)).toBe(false); // inherits layout, but no @emitGrid
    expect(gen.filter!(copay)).toBe(true);   // @emitGrid: true
  });

  test("the grid-HOOK filter agrees with the grid filter on TPH subtypes", async () => {
    // A TPH subtype inherits the base's dataGrid via extends, so a naive
    // hasDataGridLayout() check passes for it — but tanstackGrid deliberately emits no
    // per-subtype columns without an own @emitGrid. tanstackGridHook was missing that
    // clause, so BridgeAuth got a .grid.ts whose sibling .columns.tsx never exists.
    const { base, bridge, copay } = await loadTph();
    const hook = tanstackGridHook();
    expect(hook.filter!(base)).toBe(true);
    expect(hook.filter!(bridge)).toBe(false);
    expect(hook.filter!(copay)).toBe(true);
  });

  test("every emitted <X>.grid.ts has its <X>.columns.tsx — no orphan grid hook", async () => {
    // The invariant, asserted on the RUN's real output rather than on the predicates:
    // the grid hook imports its columns module as a sibling (and, with an @filter
    // preset, imports a named const from it), so an unpaired .grid.ts is a TS2307 in
    // the consumer's build. Runs with the preset present, which is the breaking arm.
    const { root } = await loadTphFiltered();
    const tmp = mkdtempSync(join(tmpdir(), "tph-grid-pairing-"));
    try {
      await runGen({
        config: defineConfig({
          outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "postgres",
          generators: [entityFile(), tanstackGrid(), tanstackGridHook()],
        }),
        metadata: root,
      });
      const files = readdirSync(tmp);
      const gridHooks = files.filter((f) => f.endsWith(".grid.ts")).sort();
      expect(gridHooks.length).toBeGreaterThan(0);
      for (const g of gridHooks) {
        expect(files).toContain(`${g.replace(/\.grid\.ts$/, "")}.columns.tsx`);
      }
      // And the subtype that never opted in produced neither artifact.
      expect(files).not.toContain("BridgeAuth.grid.ts");
      expect(files).not.toContain("BridgeAuth.columns.tsx");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
