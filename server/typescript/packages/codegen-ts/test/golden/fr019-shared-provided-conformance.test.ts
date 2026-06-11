// Cross-port FR-019 conformance (TS — the reference). Loads the shared fixture
// `fixtures/codegen-conformance/shared-provided-enum/input/meta.json` and asserts the two
// FR-019 behaviors (ADR-0026):
//   • Shared materialization — a package-level abstract `field.enum` (`Priority`) extended by
//     TWO entities is materialized ONCE in `enums.ts`; both entities reference it.
//   • `@provided` — a package-level abstract `field.enum` (`Currency`, `@provided: true`) is
//     NOT materialized; consumers import it from the configured `providedEnumModule`, while
//     `@values` still drive the z.enum validation + the DB CHECK.
//   • A `@provided` enum with no `providedEnumModule` config → a codegen-time error.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runGen, defineConfig } from "../../src/index.js";
import { entityFile, queriesFile, barrel } from "../../src/generators/index.js";
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
  const fxDir = join(findRepoRoot(import.meta.dir), "fixtures", "codegen-conformance", "shared-provided-enum", "input");
  const sources = readdirSync(fxDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => new InMemoryStringSource(readFileSync(join(fxDir, f), "utf-8"), { id: f, format: "json" }));
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors, "shared FR-019 fixture must load cleanly").toEqual([]);
  return res.root;
}

async function gen(root: MetaRoot, providedEnumModule?: string): Promise<Record<string, string>> {
  const tmp = mkdtempSync(join(tmpdir(), "fr019-conf-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "~/db",
        dialect: "postgres",
        generators: [entityFile(), queriesFile(), barrel()],
        ...(providedEnumModule !== undefined && { providedEnumModule }),
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

describe("FR-019 shared + provided enum conformance (TS)", () => {
  test("shared abstract enum is materialized ONCE; both consumers reference it", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const enums = files["enums.ts"]!;
    expect(enums, "shared enums.ts must be emitted").toBeDefined();
    // Materialized exactly once.
    expect(enums.split('export type Priority =').length - 1).toBe(1);
    expect(enums).toContain('export type Priority = "LOW" | "MEDIUM" | "HIGH";');
    // Both entities reference it, neither redeclares the union.
    for (const name of ["Ticket.ts", "Order.ts"]) {
      const f = files[name]!;
      expect(f).toBeDefined();
      expect(f).toContain('from "./enums"');
      expect(f).toContain("PriorityEnum");
      expect(f).not.toContain("export type Priority =");
    }
  });

  test("@provided enum is NOT materialized; referenced from the configured module; @values still drive validation + CHECK", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const enums = files["enums.ts"]!;
    // Currency is provided → never materialized.
    expect(enums).not.toContain("Currency");
    const t = files["Ticket.ts"]!;
    // Referenced from the configured external module.
    expect(t).toContain('export { type Currency } from "@acme/ext-enums";');
    // @values stay the SSOT: validation + CHECK are still emitted from the members.
    expect(t).toContain('z.enum(["USD", "EUR", "GBP"])');
    expect(t).toContain("currency IN ('USD', 'EUR', 'GBP')");
  });

  test("a @provided enum with no providedEnumModule config is a codegen-time error naming the enum", async () => {
    let err: unknown;
    try {
      await gen(await loadSharedFixture()); // no providedEnumModule
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Currency");
  });
});
