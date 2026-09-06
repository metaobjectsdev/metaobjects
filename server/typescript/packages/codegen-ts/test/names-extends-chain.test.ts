// "Those names classes should extend from the parent class, not just redo all the names."
//
// Two shapes have to be right, and a compiler has to agree:
//
//   - a concrete entity extending an abstract base declares only ITS OWN columns and
//     spreads the base's `fields`;
//   - a TPH subtype, which shares its base's single table, spreads the base's WHOLE
//     artifact — so the table name is stated once, on the base.
//
// Every assertion below is stated in the NEGATIVE as well as the positive: an inherited
// physical name must be ABSENT from the child's artifact. A positive-only assertion would
// pass just as well for a generator that emitted both the spread AND the restated literal,
// which is the outcome this change exists to prevent.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile, namesFile } from "../src/generators/index.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "BaseEntity",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            // NOT the snake_case of its field name: a restated literal cannot be mistaken
            // for a re-derivation.
            { "field.timestamp": { name: "createdAt", "@column": "zz_made_at" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Author",
          extends: "BaseEntity",
          children: [
            { "source.rdb": { "@table": "zz_authors" } },
            { "field.string": { name: "email", "@column": "zz_email_addr", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Auth",
          "@discriminator": "kind",
          children: [
            { "source.rdb": { "@table": "zz_auths" } },
            { "field.long": { name: "id" } },
            { "field.enum": { name: "kind", "@values": ["Copay"] } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "CopayAuth",
          extends: "Auth",
          "@discriminatorValue": "Copay",
          children: [{ "field.long": { name: "copayAmount", "@column": "zz_copay_cents" } }],
        },
      },
    ],
  },
};

async function generate(): Promise<{ tree: Record<string, string>; dir: string }> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "extends-chain.json" }),
  ]);
  expect(errors.map((e) => e.message)).toEqual([]);

  const dir = mkdtempSync(join(import.meta.dir, "tmp-names-extends-"));
  await runGen({
    config: defineConfig({
      outDir: dir, extStyle: "none", dbImport: "~/server/db", dialect: "sqlite",
      generators: [namesFile(), entityFile()],
    }),
    metadata: root,
  });
  const tree: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) walk(full);
      else tree[relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return { tree, dir };
}

describe("names artifacts extend rather than restate", () => {
  test("the abstract base gets a fragment: columns, and no physical name it never declared", async () => {
    const { tree, dir } = await generate();
    try {
      const base = tree["BaseEntity.names.ts"];
      expect(base).toBeDefined();
      expect(base).toContain('createdAt: { name: "createdAt", column: "zz_made_at" }');
      expect(base).toContain('id: { name: "id", column: "id" }');
      // It has no source, and that is the thing it must never acquire: a physical name
      // invented for an object that declares none is the phantom-table failure #248
      // exists to prevent. Before 0.25.0 the check was "no `name:` key at all", because
      // `name` WAS the physical name. It now carries the object's own metamodel name —
      // which it always had — so the assertion moves to where the physical name actually
      // lives, and gets sharper for it: an empty `sources` says the same thing about a
      // table, a view AND a stored procedure, where the old form only ever spoke about
      // whatever `name` happened to hold.
      expect(base).toContain('name: "BaseEntity"');
      expect(base).toContain("sources: {},");
      expect(base?.includes("kind: ")).toBe(false);
      expect(base?.includes("table: ")).toBe(false);
      expect(base?.includes("view: ")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the child declares only its own column and spreads the base's fields", async () => {
    const { tree, dir } = await generate();
    try {
      const author = tree["Author.names.ts"];
      expect(author).toContain('import { BaseEntityNames } from "./BaseEntity.names"');
      expect(author).toContain("...BaseEntityNames.fields,");
      expect(author).toContain('email: { name: "email", column: "zz_email_addr" }');
      // Its own source, so its own physical name.
      expect(author).toContain('name: "Author"');
      expect(author).toContain('table: "zz_authors"');
      // ...and NOT the inherited column, restated.
      expect(author).not.toContain("zz_made_at");
      // Only `fields` is spread, never the whole base: the base carries no kind/schema/
      // readOnly, and spreading it would leak an absent shape onto a child that has one.
      expect(author).not.toContain("...BaseEntityNames,");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a TPH subtype spreads the WHOLE base — the shared table is named once", async () => {
    const { tree, dir } = await generate();
    try {
      const sub = tree["CopayAuth.names.ts"];
      expect(sub).toContain('import { AuthNames } from "./Auth.names"');
      // A TPH subtype spreads the base's SOURCES — the shared table is named once, on the
      // base — rather than the whole artifact. Spreading the whole thing would carry the
      // base's `name`/`subType` onto the child, which are the child's own now.
      expect(sub).toContain("...AuthNames.sources,");
      expect(sub).toContain('name: "CopayAuth"');
      expect(sub).toContain("...AuthNames.fields,");
      expect(sub).toContain('copayAmount: { name: "copayAmount", column: "zz_copay_cents" }');
      // The whole point: the subtype used to restate the base's table name and every one
      // of its columns.
      expect(sub).not.toContain("zz_auths");
      expect(sub).not.toContain('kind: { name: "kind"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the emitted set type-checks, so the spread really does resolve an inherited column", async () => {
    // The teeth. Every assertion above is about TEXT; only a compiler proves that
    // `AuthorNames.fields.createdAt.column` — a member the artifact no longer declares —
    // still resolves through the spread, which is what every consumer emits.
    const { tree, dir } = await generate();
    try {
      const probe = join(dir, "zz-probe.ts");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(probe, [
        `import { AuthorNames } from "./Author.names";`,
        `import { CopayAuthNames } from "./CopayAuth.names";`,
        // An INHERITED column, reached through the spread.
        `const a: "zz_made_at" = AuthorNames.fields.createdAt.column;`,
        // An inherited TOP-LEVEL member, reached through the whole-base spread.
        `const b: "zz_auths" = CopayAuthNames.sources.primary.table;`,
        `const c: "zz_copay_cents" = CopayAuthNames.fields.copayAmount.column;`,
        `export const probe = [a, b, c];`,
      ].join("\n"), "utf8");

      const program = ts.createProgram(
        [probe, ...Object.keys(tree).filter((p) => p.endsWith(".names.ts")).map((p) => join(dir, p))],
        {
          strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          skipLibCheck: true,
        },
      );
      const errors = ts.getPreEmitDiagnostics(program)
        .map((d) => `${d.file?.fileName ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
