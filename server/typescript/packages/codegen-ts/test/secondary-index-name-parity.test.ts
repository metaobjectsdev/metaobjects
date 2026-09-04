// codegen and migrate must name an `identity.secondary`'s unique index the same way.
//
// This is #293's defect class, on a different constraint kind, and it survived the fix
// that closed #293 because that fix compared CHECK names and nothing else. Two emitters
// produce a name for the same secondary identity: the generated Drizzle table's
// `uniqueIndex(...)` builder (this package) and the index descriptor in
// `migrate-ts`'s buildExpectedSchema. They disagreed:
//
//   codegen   idx_<table>_<col>[_<col>...]     built from the FIELD names
//   migrate   <identity.name>                  the identity's own name
//
// So the name in the generated source is not the name in the database. Worse, migrate
// carried a comment asserting the opposite — "Drizzle emits the index using the
// identity's @name attr directly (no table prefix), so the expected name must match" —
// a false premise about the codegen it was aligning to, which is why reading either
// file alone left you sure the two agreed.
//
// MIGRATE IS THE AUTHORITY, for the same reason as #293: those names are already in
// live databases, so flipping migrate would emit DROP/CREATE INDEX churn against
// production for a cosmetic fix, while codegen's name lands in regenerated source where
// changing it costs nothing. It also makes the secondary path agree with its own sibling
// three lines below it — `index.lookup` already emits `lookup.name`.
//
// The fixture is DE-BLINDED: `emailAddr`'s column is `contact_mail`, which is not the
// snake_case of the field name and not derivable from it. codegen's old name was built
// by running the naming strategy over the FIELD name, so it could not see `@column` at
// all — the same structural blindness the name-constants program fixed elsewhere. With a
// column that agrees with the strategy, both spellings coincide and this test would pass
// against the defect.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, resolveColumnName } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts";
import { runGen } from "../src/runner.js";
import { entityFile } from "../src/generators/index.js";
import { defineConfig } from "../src/metaobjects-config.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::idx",
    children: [
      {
        "object.entity": {
          name: "Contact",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            // De-blinded on purpose: NOT snake_case("emailAddr").
            { "field.string": { name: "emailAddr", "@column": "contact_mail", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.secondary": { name: "byEmail", "@fields": ["emailAddr"] } },
          ],
        },
      },
    ],
  },
});

/**
 * Every UNIQUE constraint each side declares, as `name(columns)`.
 *
 * Names alone were not enough, and the gap was not hypothetical: codegen ALSO stamped a
 * column-level `.unique()` for a single-column secondary identity, on top of the
 * `uniqueIndex(...)` this file compares — so the generated schema declared two unique
 * constraints where migrate declares one, and `drizzle-kit push` run against it proposes
 * creating the extra one. Comparing only names could not see a constraint that HAS no
 * name in the generated source.
 *
 * `.unique()` on a column is drizzle's shorthand for the constraint migrate mirrors as
 * `<table>_<column>_unique`, so it is normalised to that spelling and compared like any
 * other — which is the only way the two sides are talking about the same thing.
 */
async function bothNames(): Promise<{ codegen: string[]; migrate: string[] }> {
  const repo = mkdtempSync(join(tmpdir(), "idx-parity-"));
  try {
    mkdirSync(join(repo, "metaobjects"), { recursive: true });
    const fixture = join(repo, "metaobjects", "meta.idx.json");
    writeFileSync(fixture, META, "utf8");

    const { root } = await new MetaDataLoader().load([new FileSource(fixture)]);

    // migrate's side: the names that reach the database.
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const migrate = expected.tables
      .flatMap((t) => (t.indexes ?? []).filter((i) => i.unique)
        .map((i) => `${i.name}(${[...i.columns].join(",")})`))
      .sort();

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
    // The table-level unique indexes, with their columns.
    //
    // Drizzle's `.on(table.emailAddr)` names the JS PROPERTY; migrate's `columns` are
    // PHYSICAL column names. Comparing them raw would report a difference on every field
    // whose `@column` is not the snake_case of its name — which this fixture's is not, on
    // purpose. Map through the same resolver the emitters use so both sides are stating the
    // same fact in the same vocabulary.
    const propertyToColumn = new Map<string, string>();
    for (const entity of root.objects()) {
      for (const f of entity.fields()) propertyToColumn.set(f.name, resolveColumnName(f, "snake_case"));
    }
    const declared = [...source.matchAll(/uniqueIndex\(\s*"([^"]+)"\s*\)\.on\(([^)]*)\)/g)]
      .map((m) => {
        const cols = m[2]!.split(",")
          .map((c) => c.trim().replace(/^table\./, ""))
          .filter(Boolean)
          .map((prop) => propertyToColumn.get(prop) ?? prop);
        return `${m[1]!}(${cols.join(",")})`;
      });
    // Plus any column-level `.unique()`, normalised to the constraint migrate mirrors.
    const tableName = expected.tables[0]!.name;
    const columnUniques = [...source.matchAll(/^\s*\w+:\s*\w+\("([^"]+)"[^\n]*\.unique\(\)/gm)]
      .map((m) => `${tableName}_${m[1]!}_unique(${m[1]!})`);
    const codegen = [...declared, ...columnUniques].sort();

    return { codegen, migrate };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("identity.secondary — index names agree across emitters", () => {
  test("both emitters produce a name, so neither side of the comparison is vacuous", async () => {
    const { codegen, migrate } = await bothNames();
    expect(migrate.length).toBeGreaterThan(0);
    expect(codegen.length).toBeGreaterThan(0);
  });

  test("the generated table's unique-index name is the name that lands in the database", async () => {
    const { codegen, migrate } = await bothNames();
    expect(codegen).toEqual(migrate);
  });

  test("the shared convention is the identity's own name", async () => {
    const { migrate } = await bothNames();
    // Name AND columns: the physical column, which is de-blinded here (`contact_mail` is
    // not the snake_case of `emailAddr`), so a comparison that had silently fallen back to
    // the field name could not pass.
    expect(migrate).toEqual(["byEmail(contact_mail)"]);
  });
});
