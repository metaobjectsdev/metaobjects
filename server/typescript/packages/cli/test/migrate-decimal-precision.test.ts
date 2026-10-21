// ADR-0019 Amendment 1, W4: `meta migrate` warns once per wide decimal on SQLite and D1.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";
import { decimalPrecisionWarnings } from "../src/lib/decimal-precision-advisory.js";
import { loadMemory } from "@metaobjectsdev/sdk";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = {
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "Ledger",
        children: [
          { "field.long": { name: "id" } },
          { "field.decimal": { name: "wide", "@precision": 20, "@scale": 4 } },
          { "field.decimal": { name: "narrow", "@precision": 15, "@scale": 2 } },
          { "field.decimal": { name: "bare" } },
          { "source.rdb": { name: "src", "@table": "ledgers" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
};

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-dec-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.ledger.json"), JSON.stringify(MODEL), "utf8");
  return root;
}

describe("decimalPrecisionWarnings", () => {
  test("warns once per field above 15 on sqlite and d1, never on postgres", async () => {
    const root = await project();
    const md = await loadMemory(root);
    for (const d of ["sqlite", "d1"]) {
      const w = decimalPrecisionWarnings(md, d);
      expect(w).toHaveLength(1);
      expect(w[0]).toContain("Ledger.wide");
      expect(w[0]).toContain("15 significant digits");
    }
    expect(decimalPrecisionWarnings(md, "postgres")).toEqual([]);
  });
});

describe("meta migrate prints the W4 warning", () => {
  test("offline generate on sqlite warns about the wide decimal only", async () => {
    const root = await project();
    const cfg = { dialect: "sqlite", outDir: "./.metaobjects/migrations", onAmbiguous: "abort", allow: [], slug: "auto", dryRun: true } as any;
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await runBaseline({ ...cfg, dryRun: false }, root);
      await runOfflineGenerate(cfg, root);
    } finally {
      console.error = orig;
    }
    const w4 = lines.filter((l) => l.includes("15 significant digits"));
    expect(w4.length).toBeGreaterThanOrEqual(1);
    expect(w4.every((l) => l.includes("Ledger.wide"))).toBe(true);
    expect(lines.some((l) => l.includes("Ledger.narrow") || l.includes("Ledger.bare"))).toBe(false);
  });
});
