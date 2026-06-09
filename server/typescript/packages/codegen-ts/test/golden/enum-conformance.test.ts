// Cross-port enum conformance (TS). Loads the shared fixture
// `fixtures/codegen-conformance/enum/input/meta.enum.json` and asserts the TS entity
// codegen represents the entity's enum fields idiomatically:
//   • `status` (inline @values) → an `<Entity><Field>` union + inline z.enum, with the
//     DB CHECK constraint (TS owns schema, ADR-0015).
//   • `priority` (extends the root abstract `Priority` enum) → materialized once in the
//     shared `enums.ts` module and referenced by the entity (no inline redeclaration).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
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
  const fxDir = join(findRepoRoot(import.meta.dir), "fixtures", "codegen-conformance", "enum", "input");
  const sources = readdirSync(fxDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => new InMemoryStringSource(readFileSync(join(fxDir, f), "utf-8"), { id: f, format: "json" }));
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors, "shared enum fixture must load cleanly").toEqual([]);
  return res.root;
}

async function gen(root: MetaRoot): Promise<Record<string, string>> {
  const tmp = mkdtempSync(join(tmpdir(), "enum-conf-"));
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
    for (const name of readdirSync(tmp)) {
      if (name.endsWith(".ts")) files[name] = readFileSync(join(tmp, name), "utf-8");
    }
    return files;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("enum codegen-conformance (TS)", () => {
  test("inline enum field emits an <Entity><Field> union + inline z.enum + DB CHECK", async () => {
    const files = await gen(await loadSharedFixture());
    const t = files["Ticket.ts"]!;
    expect(t).toBeDefined();
    expect(t).toContain('export type TicketStatus = "OPEN" | "PENDING" | "CLOSED";');
    expect(t).toContain('z.enum(["OPEN", "PENDING", "CLOSED"])');
    // TS owns the schema → enum CHECK constraint on the column.
    expect(t).toContain("status IN ('OPEN', 'PENDING', 'CLOSED')");
    expect(t).toContain("priority IN ('LOW', 'MEDIUM', 'HIGH')");
  });

  test("extends an abstract root enum → materialized once in shared enums.ts, referenced by the entity", async () => {
    const files = await gen(await loadSharedFixture());
    const enums = files["enums.ts"]!;
    expect(enums, "shared enums.ts must be emitted for the extended abstract enum").toBeDefined();
    expect(enums).toContain('export type Priority = "LOW" | "MEDIUM" | "HIGH";');
    expect(enums).toContain('z.enum(["LOW", "MEDIUM", "HIGH"])');

    const t = files["Ticket.ts"]!;
    // The entity references the shared enum, never redeclaring the union inline.
    expect(t).toContain('from "./enums"');
    expect(t).toContain("PriorityEnum");
    expect(t).not.toContain('export type Priority =');
  });
});
