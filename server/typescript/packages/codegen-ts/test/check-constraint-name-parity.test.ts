// #293 — codegen and migrate must name a CHECK constraint the same way.
//
// Two emitters produce a name for the same `field.enum`: the generated Drizzle table's
// `check(...)` builder (this package) and the `ADD CONSTRAINT` in the migration
// (`migrate-ts`'s buildExpectedSchema). They disagreed — `chk_<table>_<col>` versus
// `<table>_<col>_chk` — so the name in the generated source never matched the name in
// the database. A `DROP CONSTRAINT` written from the generated name fails, a Postgres
// error quotes a name that appears nowhere in the source someone would grep, and any
// reconciliation between the two (drizzle-kit introspect/push, a schema diff run as a
// sanity check) reports a difference that is not real.
//
// MIGRATE IS THE AUTHORITY HERE, and that direction is not arbitrary. Its suffix form is
// systematic across five constraint kinds (`_numeric_chk`, `_length_chk`, `_regex_chk`,
// `_cmp_chk`, `_chk`) and, more importantly, those names are already IN live databases —
// flipping migrate would emit DROP/ADD CONSTRAINT churn against production for a
// cosmetic fix. codegen's prefix appeared in exactly two lines of one file and lands in
// regenerated source, where changing it costs nothing.
//
// This test exists because nothing compared the two emitters. Each was internally
// consistent and separately tested, which is precisely how the divergence survived.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts";
import { runGen } from "../src/runner.js";
import { entityFile } from "../src/generators/index.js";
import { defineConfig } from "../src/metaobjects-config.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::chk",
    children: [
      {
        "object.entity": {
          name: "OrderItem",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.enum": { name: "status", "@values": ["open", "closed"] } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function bothNames(): Promise<{ codegen: string[]; migrate: string[] }> {
  const repo = mkdtempSync(join(tmpdir(), "chk-parity-"));
  try {
    mkdirSync(join(repo, "metaobjects"), { recursive: true });
    const fixture = join(repo, "metaobjects", "meta.chk.json");
    writeFileSync(fixture, META, "utf8");

    const { root } = await new MetaDataLoader().load([new FileSource(fixture)]);

    // migrate's side: the names that reach the database.
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const migrate = expected.tables.flatMap((t) => (t.checks ?? []).map((c) => c.name)).sort();

    // codegen's side: the names in the generated Drizzle table. Read off DISK rather
    // than from an internal, so this asserts the text an adopter actually receives.
    const outDir = join(repo, "out");
    await runGen({
      config: defineConfig({ outDir, dialect: "postgres", extStyle: "js", generators: [entityFile()], dbImport: "@/db" }),
      metadata: root,
      projectRoot: repo,
    });
    const source = readdirSync(outDir, { recursive: true, encoding: "utf8" })
      .filter((f) => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => readFileSync(join(outDir, f), "utf8"))
      .join("\n");
    const codegen = [...source.matchAll(/check\(\s*"([^"]+)"/g)].map((m) => m[1]!).sort();

    return { codegen, migrate };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("#293 — CHECK constraint names agree across emitters", () => {
  test("both emitters produce a name, so neither side of the comparison is vacuous", async () => {
    const { codegen, migrate } = await bothNames();
    expect(migrate.length).toBeGreaterThan(0);
    expect(codegen.length).toBeGreaterThan(0);
  });

  test("the generated table's check name is the name that lands in the database", async () => {
    const { codegen, migrate } = await bothNames();
    expect(codegen).toEqual(migrate);
  });

  test("the shared convention is migrate's suffix form", async () => {
    const { migrate } = await bothNames();
    expect(migrate).toEqual(["order_items_status_chk"]);
  });
});
