// FR-017 Tier 3 — TanStack grid for a TPH discriminator base.
//
// The base emits ONE polymorphic grid: typed against the raw single-table row
// (<Base>Row), folding in every subtype-only column, with the discriminator
// column rendered as a subtype badge. Per-subtype grids are opt-in only, via the
// `tphSubtypeGrids` GENERATOR OPTION — they inherit the base's dataGrid layout otherwise.
//
// The opt-in used to be an `@emitGrid: true` metadata attribute. It was never registered
// vocabulary, so `meta verify` rejected it (ERR_UNKNOWN_ATTR) while `meta gen` honoured
// it. It could not become a `filter` either: a filter is ANDed with the built-in gates and
// can only NARROW, and this WIDENS. Hence an option, defaulting to `() => false` so a
// project that never opted in sees byte-identical output.

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
                // Opted IN to a per-subtype grid by the OPT_IN predicate below — no
                // metadata attribute is involved any more.
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

/** The per-subtype-grid opt-in, as an adopter would write it in metaobjects.config.ts.
 *  Declared ONCE and passed to BOTH generators, which is the discipline the option
 *  documents: two disagreeing predicates reproduce #287 exactly. */
const OPT_IN = (e: MetaObject) => e.name === "CopayAuth";

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

  test("grid filter: base emits; a subtype emits only when tphSubtypeGrids opts it in", async () => {
    const { base, bridge, copay } = await loadTph();
    const gen = tanstackGrid({ tphSubtypeGrids: OPT_IN });
    expect(gen.filter!(base)).toBe(true);    // polymorphic grid
    expect(gen.filter!(bridge)).toBe(false); // inherits layout, but not opted in
    expect(gen.filter!(copay)).toBe(true);   // opted in
  });

  test("tphSubtypeGrids defaults OFF — no TPH subtype emits without one", async () => {
    // The default is what every existing project gets, so it is the arm most worth
    // pinning: an option that silently defaulted ON would change output for models that
    // never asked for a per-subtype grid.
    const { base, bridge, copay } = await loadTph();
    for (const gen of [tanstackGrid(), tanstackGridHook()]) {
      expect(gen.filter!(base)).toBe(true);
      expect(gen.filter!(bridge)).toBe(false);
      expect(gen.filter!(copay)).toBe(false);
    }
  });

  test("the grid-HOOK filter agrees with the grid filter on TPH subtypes", async () => {
    // A TPH subtype inherits the base's dataGrid via extends, so a naive
    // hasDataGridLayout() check passes for it — but tanstackGrid deliberately emits no
    // per-subtype columns unless tphSubtypeGrids opts it in. tanstackGridHook was once
    // missing that clause, so BridgeAuth got a .grid.ts whose sibling .columns.tsx never
    // exists. With the clause now driven by a caller-supplied predicate, agreement is the
    // CALLER's discipline — so this asserts it holds when the same predicate is passed.
    const { base, bridge, copay } = await loadTph();
    const hook = tanstackGridHook({ tphSubtypeGrids: OPT_IN });
    expect(hook.filter!(base)).toBe(true);
    expect(hook.filter!(bridge)).toBe(false);
    expect(hook.filter!(copay)).toBe(true);
  });

  test("an opted-in subtype gets BOTH artifacts; an opted-out one gets NEITHER", async () => {
    // The pairing invariant on the OPT-IN path, asserted on a real run's output rather
    // than on the predicates. `tphSubtypeGrids` is passed to both generators — the
    // discipline the option documents — so CopayAuth must get the pair and BridgeAuth
    // must get nothing. A one-sided wiring shows up here as a file set, not a subtlety.
    const { root } = await loadTph();
    const tmp = mkdtempSync(join(tmpdir(), "tph-grid-optin-"));
    try {
      await runGen({
        config: defineConfig({
          outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "postgres",
          generators: [
            entityFile(),
            tanstackGrid({ tphSubtypeGrids: OPT_IN }),
            tanstackGridHook({ tphSubtypeGrids: OPT_IN }),
          ],
        }),
        metadata: root,
      });
      const files = readdirSync(tmp);
      expect(files).toContain("CopayAuth.columns.tsx");
      expect(files).toContain("CopayAuth.grid.ts");
      expect(files).not.toContain("BridgeAuth.columns.tsx");
      expect(files).not.toContain("BridgeAuth.grid.ts");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
          generators: [
            entityFile(),
            tanstackGrid({ tphSubtypeGrids: OPT_IN }),
            tanstackGridHook({ tphSubtypeGrids: OPT_IN }),
          ],
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
