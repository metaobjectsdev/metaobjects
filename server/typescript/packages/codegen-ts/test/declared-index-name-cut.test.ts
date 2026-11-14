// A declared index name over Postgres's 63-byte identifier limit: `meta migrate` creates and
// compares it under the name Postgres stores (its first 63 bytes), so the generated Drizzle table
// must declare that cut name too, or the mapping and the database disagree on every such index.
//
// Held to the shared corpus `fixtures/foreign-key-index-conformance/`: `declared.<dialect>.json`
// is migrate's answer (written by migrate-ts's runner), and the C# EF context and the Kotlin
// Exposed table pass the same file.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { entityFile } from "../src/generators/entity-file.js";
import { defineConfig } from "../src/metaobjects-config.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/foreign-key-index-conformance");

async function generated(dialect: "postgres" | "sqlite"): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "declared-index-cut-"));
  try {
    const { root, errors } = await new MetaDataLoader().load([new FileSource(join(CORPUS, "input", "meta.fk.json"))]);
    expect(errors).toEqual([]);
    const outDir = join(repo, "out");
    await runGen({
      config: defineConfig({ outDir, dialect, extStyle: "js", generators: [entityFile()], dbImport: "@/db" }),
      metadata: root,
      projectRoot: repo,
    });
    return readdirSync(outDir, { recursive: true, encoding: "utf8" })
      .filter((f) => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => readFileSync(join(outDir, f), "utf8"))
      .join("\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// The formatter may break a call over lines with a trailing comma: `index(\n  "name",\n)`.
function indexNames(source: string): Set<string> {
  return new Set([...source.matchAll(/\b(?:uniqueIndex|index)\(\s*"([^"]+)",?\s*\)/g)].map((m) => m[1]!));
}

describe("the Drizzle table declares a declared index under the name migrate creates", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    test(`${dialect}: every name in declared.${dialect}.json`, async () => {
      const source = await generated(dialect);
      const expected = JSON.parse(readFileSync(join(CORPUS, `declared.${dialect}.json`), "utf8")) as
        Record<string, { name: string }[]>;
      const declared = indexNames(source);
      for (const ix of Object.values(expected).flat()) expect(declared).toContain(ix.name);
    });
  }

  test("postgres cuts the long name to 63 bytes; sqlite keeps it whole", async () => {
    const long = "customer_order_line_item_allocations_by_region_region_code_lookup";
    const postgres = indexNames(await generated("postgres"));
    expect(postgres).toContain(long.slice(0, 63));
    expect(postgres).not.toContain(long);
    expect(indexNames(await generated("sqlite"))).toContain(long);
  });
});
