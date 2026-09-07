// End-to-end proof for the shared VO module resolver (Option C).
//
// A jsonb value-object referenced ACROSS packages must resolve to the correct
// relative module path in ALL THREE places that reference it — the field's TS
// type (inferred-types), its Zod schema (zod-validators), and the Drizzle
// `.$type<>()` (drizzle-schema) — not the old flat `./Triple.js` hardcode.
// Here SemanticTrace (acme::ai) holds jsonb columns of Triple (acme::common),
// so every reference must be `../common/Triple` under package layout.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "../../src/index.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "../fixtures/cross-package-vo.json");

const loader = new MetaDataLoader();
const loadResult = await loader.load([new FileSource(FIXTURE)]);
if (loadResult.errors.length > 0) {
  throw new Error(`Fixture load errors: ${loadResult.errors.join(", ")}`);
}
const metadataRoot = loadResult.root;

async function genFile(dialect: "postgres" | "sqlite", outputLayout: "flat" | "package"): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "codegen-vo-xpkg-"));
  try {
    const result = await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "../db",
        dialect,
        outputLayout,
        generators: [entityFile()],
      }),
      metadata: metadataRoot,
    });
    expect(result.warnings).toEqual([]);
    const rel = outputLayout === "package" ? "acme/ai/SemanticTrace.ts" : "SemanticTrace.ts";
    return readFileSync(join(tmp, rel), "utf-8");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("cross-package jsonb VO — module resolution is consistent across all 3 sites", () => {
  it("Postgres / package layout: every Triple reference resolves to ../common/Triple", async () => {
    const out = await genFile("postgres", "package");

    // The fix: the cross-package relative path, NOT the old flat hardcode.
    expect(out).toContain("../common/Triple");
    expect(out).not.toContain('"./Triple"');
    expect(out).not.toContain('"./Triple.js"');

    // Drizzle column: single jsonb carrying the VO type, array form for the list.
    expect(out).toContain(".$type<Triple[]>()"); // triples (isArray)
    expect(out).toContain(".$type<Triple>()");    // primaryTriple (single)
    expect(out).not.toContain(".array()");         // object jsonb never native array

    // Zod schema references the VO's InsertSchema from the same module.
    expect(out).toContain("TripleInsertSchema");
  });

  it("Postgres / flat layout: same-dir ./Triple (extStyle none → no .js)", async () => {
    const out = await genFile("postgres", "flat");
    expect(out).toContain("./Triple");
    expect(out).not.toContain("./Triple.js"); // extStyle "none" is honored now
    expect(out).toContain(".$type<Triple[]>()");
    expect(out).toContain(".$type<Triple>()");
    expect(out).not.toContain(".array()");
  });
});
