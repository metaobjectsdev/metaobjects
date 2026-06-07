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
import { tanstackGrid } from "../src/tanstack-grid.js";
import { renderColumnsFile } from "../src/templates/columns-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

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
                  { "identity.primary": { "@fields": "id", "@generation": "increment" } },
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
});
