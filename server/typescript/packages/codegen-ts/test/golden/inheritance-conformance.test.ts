// Cross-port inheritance conformance (TS). Loads the shared fixture
// `fixtures/codegen-conformance/inheritance/input/meta.inheritance.json` and asserts the TS
// (flatten) port inlines the FULL field set across two abstract levels into the concrete
// `Product` entity — `id`, `createdBy`, `updatedBy` (inherited) + `sku`, `qtyOnHand` (own) —
// and that the abstract bases emit no instance table.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runGen, defineConfig } from "../../src/index.js";
import { barrel } from "../../src/generators/barrel.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate repo root from " + start);
    dir = parent;
  }
}

async function loadSharedFixture(): Promise<MetaRoot> {
  const fxDir = join(findRepoRoot(import.meta.dir), "fixtures", "codegen-conformance", "inheritance", "input");
  const sources = readdirSync(fxDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => new InMemoryStringSource(readFileSync(join(fxDir, f), "utf-8"), { id: f, format: "json" }));
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors, "shared inheritance fixture must load cleanly").toEqual([]);
  return res.root;
}

async function gen(root: MetaRoot): Promise<Record<string, string>> {
  const tmp = mkdtempSync(join(tmpdir(), "inh-conf-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "~/db",
        dialect: "postgres",
        generators: [entityFile(), queriesFile(), barrel()],
      }),
      metadata: root,
    });
    const files: Record<string, string> = {};
    for (const name of readdirSync(tmp)) if (name.endsWith(".ts")) files[name] = readFileSync(join(tmp, name), "utf-8");
    return files;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("inheritance codegen-conformance (TS)", () => {
  test("concrete entity flattens the full multi-level inherited field set", async () => {
    const files = await gen(await loadSharedFixture());
    const p = files["Product.ts"]!;
    expect(p).toBeDefined();
    // The products table carries all 5 fields (2 levels of inherited + 2 own + pk).
    expect(p).toContain('pgTable("products"');
    expect(p).toContain('bigint("id"');
    expect(p).toContain('varchar("created_by", { length: 80 }).notNull()'); // inherited from Base
    expect(p).toContain('text("updated_by")'); // inherited from Auditable
    expect(p).toContain('text("sku").notNull()');
    expect(p).toContain('integer("qty_on_hand")');
    // The Zod insert schema covers the inherited + own fields.
    for (const f of ["id", "createdBy", "updatedBy", "sku", "qtyOnHand"]) {
      expect(p).toContain(`${f}:`);
    }
  });

  test("abstract bases emit no instance table", async () => {
    const files = await gen(await loadSharedFixture());
    for (const name of ["Base.ts", "Auditable.ts"]) {
      const f = files[name];
      if (f) {
        expect(f).not.toContain("pgTable(");
      }
    }
  });
});
