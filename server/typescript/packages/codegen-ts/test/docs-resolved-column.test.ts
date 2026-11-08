// The entity page names each field's PHYSICAL column: the explicit `@column` when the field
// declares one, else the name the configured column-naming strategy resolves. It printed only an
// explicit `@column`, so a project that moved from a hand-written `@column` on every field to a
// naming rule (`pascal`) lost the Column from every field that no longer spells it out.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { ColumnNamingStrategy } from "@metaobjectsdev/metadata";
import { docsFile } from "../src/generators/docs-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Patient",
          children: [
            { "source.rdb": { "@table": "patients" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "firstName", "@maxLength": 40 } },
            { "field.string": { name: "npi", "@column": "NPI", "@maxLength": 10 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.value": {
          name: "Address",
          children: [{ "field.string": { name: "streetName", "@maxLength": 80 } }],
        },
      },
    ],
  },
});

async function page(strategy: ColumnNamingStrategy, name = "Patient"): Promise<string> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(MODEL, { id: "m.json", format: "json" })]);
  expect(res.errors).toEqual([]);
  const root = res.root;
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "postgres" } as never,
    renderContext: makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/tmp",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
      columnNamingStrategy: strategy,
    }),
    warn: () => {},
  };
  const out = await docsFile().generate(ctx);
  const file = out.find((f) => f.path.endsWith(`/${name}.md`) || f.path === `${name}.md`);
  expect(file).toBeDefined();
  return file!.content;
}

const fieldRow = (md: string, field: string): string =>
  md.split("\n").find((l) => l.startsWith("|") && l.includes(`id="field-${field}"`)) ?? "";
const detail = (md: string, field: string): string =>
  md.split(`### \`${field}\``)[1]?.split("\n### ")[0] ?? "";

describe("docsFile — the resolved physical column", () => {
  it("docs_prints_resolved_column_under_pascal", async () => {
    const md = await page("pascal");
    // No @column: the strategy's answer, in the Fields table's Column cell and the field's details.
    expect(fieldRow(md, "firstName")).toContain("| `FirstName` |");
    expect(fieldRow(md, "id")).toContain("| `Id` |");
    expect(detail(md, "firstName")).toContain("- **Column:** `FirstName`");
    // An explicit @column still wins.
    expect(fieldRow(md, "npi")).toContain("| `NPI` |");
    expect(detail(md, "npi")).toContain("- **Column:** `NPI`");
  });

  it("prints nothing extra when the resolved column is the field name", async () => {
    const md = await page("literal");
    expect(fieldRow(md, "firstName")).toContain("| `string` |  |  | maxLength: 40 |");
    expect(detail(md, "firstName")).not.toContain("**Column:**");
  });

  it("leaves a value object's members alone: their owners map them", async () => {
    const md = await page("pascal", "Address");
    expect(fieldRow(md, "streetName")).toContain("| `string` |  |  | maxLength: 80 |");
  });

  it("follows snake_case too", async () => {
    const md = await page("snake_case");
    expect(fieldRow(md, "firstName")).toContain("| `first_name` |");
    expect(fieldRow(md, "id")).toContain("| yes |  |");
  });
});
