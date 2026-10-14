// Every catalog entry's `factoryExport` is RESOLVED, not trusted.
//
// "Import it from its package to run it as shipped" is only true if the package exports
// the factory under the name the catalog prints. `entityFile` / `queriesFile` /
// `routesFile` / `barrel` were NOT exported between 1.0 and 1.1 while the catalog still
// listed them, and nothing held the two together — so this gate imports each package's
// public factory module the way an adopter's `metaobjects.config.ts` does and asks for
// the function by name.
//
// The second half ties the two ownership paths to one symbol. `meta eject` reads the
// import line it prints out of the reference template's header; if that symbol differed
// from the package's, moving between "import it" and "own a copy" would stop being a
// one-line change, and the eject message telling an adopter to REPLACE the package
// import would name a binding their config does not have.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as coreFactories from "@metaobjectsdev/codegen-ts/generators";
import * as reactFactories from "@metaobjectsdev/codegen-ts-react";
import * as tanstackFactories from "@metaobjectsdev/codegen-ts-tanstack";
import { catalogEntry, factoryModuleOf, listCatalog, packagedWiring } from "../src/lib/catalog.js";
import { buildCatalogListing, renderCatalogText, type GeneratorCatalogRow } from "../src/lib/catalog-listing.js";
import { ejectGenerator } from "../src/commands/eject.js";

/** The public factory module per import path — what a config's `import { … } from` resolves. */
const MODULES: Record<string, Record<string, unknown>> = {
  "@metaobjectsdev/codegen-ts/generators": coreFactories,
  "@metaobjectsdev/codegen-ts-react": reactFactories,
  "@metaobjectsdev/codegen-ts-tanstack": tanstackFactories,
};

/**
 * Entries whose factory cannot be called with no options, so the name check below cannot
 * construct one through the public export. Each is a primitive that takes its identity
 * from its caller; the registry's own `factory` supplies placeholders for the same reason.
 */
const NEEDS_OPTIONS = new Set(["template", "shared-model"]);

function publicFactory(name: string, exportName: string): unknown {
  const from = factoryModuleOf(name);
  if (from === undefined) throw new Error(`no package registers "${name}"`);
  const mod = MODULES[from];
  if (mod === undefined) throw new Error(`"${name}" is served from ${from}, which this gate does not import`);
  return mod[exportName];
}

describe("catalog factory exports", () => {
  test("every entry's factory is exported, under the name the catalog prints", () => {
    const missing: string[] = [];
    for (const entry of listCatalog()) {
      if (typeof publicFactory(entry.name, entry.factoryExport) !== "function") {
        missing.push(`${entry.name}: ${entry.factoryExport} is not exported from ${factoryModuleOf(entry.name)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the exported factory builds the SAME generator the catalog constructs", () => {
    const mismatched: string[] = [];
    for (const entry of listCatalog()) {
      if (NEEDS_OPTIONS.has(entry.name)) continue;
      const build = publicFactory(entry.name, entry.factoryExport) as () => { name: string };
      const viaExport = build().name;
      const viaCatalog = entry.factory().name;
      if (viaExport !== viaCatalog) {
        mismatched.push(`${entry.name}: export builds "${viaExport}", catalog builds "${viaCatalog}"`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  test("the four generators 1.0 removed are importable again", () => {
    for (const name of ["entityFile", "queriesFile", "routesFile", "barrel"]) {
      expect(typeof (coreFactories as Record<string, unknown>)[name]).toBe("function");
    }
  });

  test("an owned copy and the package export the factory under one symbol", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mo-wire-"));
    try {
      const differing: string[] = [];
      for (const entry of listCatalog()) {
        if (!entry.ejectable) continue;
        const ejected = await ejectGenerator({ cwd: dir, name: entry.name, force: false });
        if (ejected.exportName !== entry.factoryExport) {
          differing.push(`${entry.name}: owned copy exports ${ejected.exportName}, package exports ${entry.factoryExport}`);
        }
      }
      expect(differing).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("meta gen --list — how to wire a generator as shipped", () => {
  // ADR-0034 Amendment 9: one way to generate, so every row is wired the same way, the
  // documentation generators included.
  test("every row carries its package import, and no derived call", async () => {
    const rows = (await buildCatalogListing()).filter(
      (r): r is GeneratorCatalogRow => r.kind === "generator",
    );
    for (const row of rows) {
      expect(row.wire?.import, row.name).toMatch(/^import \{ \w+ \} from "@metaobjectsdev\/codegen-ts[\w/-]*";$/);
      expect({ name: row.name, keys: Object.keys(row.wire ?? {}) }).toEqual({ name: row.name, keys: ["import"] });
    }
  });

  test("a docs-layer entry prints its import like any other", () => {
    const docs = catalogEntry("docs");
    const apiDocs = catalogEntry("api-docs");
    if (docs === undefined || apiDocs === undefined) throw new Error("catalog entry missing");
    expect(packagedWiring(docs)).toEqual({ import: `import { docsFile } from "@metaobjectsdev/codegen-ts/generators";` });
    expect(packagedWiring(apiDocs)).toEqual({ import: `import { apiDocsFile } from "@metaobjectsdev/codegen-ts/generators";` });
  });

  test("the engine's factories are served from /generators, the framework packages' from the root", async () => {
    const byName = new Map(
      (await buildCatalogListing())
        .filter((r): r is GeneratorCatalogRow => r.kind === "generator")
        .map((r) => [r.name, r] as const),
    );
    expect(byName.get("entity")?.wire).toEqual({
      import: `import { entityFile } from "@metaobjectsdev/codegen-ts/generators";`,
    });
    expect(byName.get("hooks")?.wire).toEqual({
      import: `import { tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack";`,
    });
  });

  test("the text listing prints the import under a row, and drops it once the copy is owned", async () => {
    const rows = await buildCatalogListing();
    const text = renderCatalogText(rows, false);
    expect(text).toContain(`import { entityFile } from "@metaobjectsdev/codegen-ts/generators";`);
    expect(text).toContain("Import it from its package to run");

    const owned = rows.map((r) =>
      r.kind === "generator" && r.name === "entity" ? { ...r, source: { ...r.source, owned: true } } : r,
    );
    expect(renderCatalogText(owned, false)).not.toContain(`import { entityFile } from`);
  });
});
