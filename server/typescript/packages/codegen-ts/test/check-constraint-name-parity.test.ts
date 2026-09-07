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
import { namesFile } from "../src/generators/index.js";
import { entityFile } from "../src/generators/entity-file.js";
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

async function bothNames(includeNames = false): Promise<{ codegen: string[]; migrate: string[] }> {
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
      config: defineConfig({
        outDir, dialect: "postgres", extStyle: "js", dbImport: "@/db",
        generators: includeNames ? [namesFile(), entityFile()] : [entityFile()],
      }),
      metadata: root,
      projectRoot: repo,
    });
    const source = readdirSync(outDir, { recursive: true, encoding: "utf8" })
      .filter((f) => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => readFileSync(join(outDir, f), "utf8"))
      .join("\n");
    // With no names artifact the name is a quoted literal. With one it is a TEMPLATE
    // composed from the constants, so reading the text is not enough — the parity claim is
    // about the string that exists at RUN TIME. Import the emitted artifact and evaluate
    // the emitted template against it, which is the only form of this test that can speak
    // for the arm adopters actually run.
    if (!includeNames) {
      const codegen = [...source.matchAll(/check\(\s*"([^"]+)"/g)].map((m) => m[1]!).sort();
      return { codegen, migrate };
    }
    const templates = [...source.matchAll(/check\(\s*`([^`]+)`/g)].map((m) => m[1]!);
    const namesFilePath = readdirSync(outDir, { recursive: true, encoding: "utf8" })
      .find((f) => typeof f === "string" && f.endsWith(".names.ts"))!;
    const mod: Record<string, unknown> = await import(join(outDir, namesFilePath as string));
    const bindings = Object.entries(mod).filter(([k]) => k.endsWith("Names"));
    const codegen = templates
      .map((tpl) => {
        const evaluate = new Function(
          ...bindings.map(([k]) => k),
          `return \`${tpl.replace(/`/g, "\\`")}\`;`,
        ) as (...args: unknown[]) => string;
        return evaluate(...bindings.map(([, v]) => v));
      })
      .sort();

    return { codegen, migrate };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// BOTH ARMS. `namesFile()` is opt-in (ADR-0034), and the two arms emit the constraint name
// two DIFFERENT ways: a quoted literal without the artifact, a template composed from
// `<Entity>Names` with it. A parity test that ran only the OFF arm would have nothing to say
// about the form most projects ship — the same default-off blind spot that let the escapes
// this file's neighbours cover survive five green gates.
describe.each([
  ["without a names artifact", false],
  ["with a names artifact", true],
] as const)("#293 — CHECK constraint names agree across emitters (%s)", (_label, includeNames) => {
  test("both emitters produce a name, so neither side of the comparison is vacuous", async () => {
    const { codegen, migrate } = await bothNames(includeNames);
    expect(migrate.length).toBeGreaterThan(0);
    expect(codegen.length).toBeGreaterThan(0);
  });

  test("the generated table's check name is the name that lands in the database", async () => {
    const { codegen, migrate } = await bothNames(includeNames);
    expect(codegen).toEqual(migrate);
  });

  test("the shared convention is migrate's suffix form", async () => {
    const { codegen, migrate } = await bothNames(includeNames);
    expect(migrate).toEqual(["order_items_status_chk"]);
    // The constant arm must produce the IDENTICAL string, not merely a consistent one:
    // these names are already in live databases (#293), so composing from the constants is
    // allowed only because it evaluates to exactly what the literal arm spells.
    expect(codegen).toEqual(["order_items_status_chk"]);
  });
});
