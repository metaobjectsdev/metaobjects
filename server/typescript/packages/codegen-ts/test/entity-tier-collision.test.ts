import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/generators/entity-file.js";
import { barrel } from "../src/generators/barrel.js";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

// ADR-0044 / #228, amended by ruling R52 — two same-short-name `object.value`s across
// packages. Nothing is renamed: under the package layout each `Note` is declared under its own
// name in its own package's module, and every value-object-routed reference (Zod
// `<Ref>InsertSchema`, Drizzle `.$type<>()`, inferred-types field.object/field.map) imports the
// node it names from that module — bound under a package-qualified LOCAL alias
// (`Note as AcmeAlphaNote`), since another object shares the short name. Under the flat layout,
// or with a barrel, the two share one namespace and the claim registry refuses them
// (test/naming/name-claims.test.ts).

async function loadMultiPackageRoot(files: { package: string; children: unknown[] }[]) {
  const sources = files.map(
    (f) => new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: f.package, children: f.children } })),
  );
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors).toEqual([]);
  return res.root;
}

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "entity-collision-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function genFiles(
  root: Awaited<ReturnType<typeof loadMultiPackageRoot>>,
  outputLayout: "flat" | "package" = "flat",
): Promise<Map<string, string>> {
  const result = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "js",
      dbImport: "../db",
      // postgres: a single (non-array) field.object jsonb column gets a
      // Drizzle `.$type<VO>()` — the value-object reference site under test.
      dialect: "postgres",
      outputLayout,
      // The barrel re-exports every module in one namespace, so it would refuse two Notes.
      generators: outputLayout === "flat" ? [entityFile(), barrel()] : [entityFile()],
    }),
    metadata: root,
  });
  expect(result.conflicts).toEqual([]);
  const out = new Map<string, string>();
  for (const e of readdirSync(tmp, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out.set(relative(tmp, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8"));
  }
  return out;
}

describe("entity tier — cross-package value-object short-name sharing (ADR-0044, ruling R52)", () => {
  test("two same-short-name object.values keep their names in two modules; every reference binds its own node under a local alias", async () => {
    const root = await loadMultiPackageRoot([
      {
        package: "acme::alpha",
        children: [
          {
            "object.value": {
              name: "Note",
              children: [{ "field.string": { name: "alphaText", "@required": true } }],
            },
          },
          {
            // A value object nesting a colliding value object — exercises the
            // inferred-types field.object reference branch.
            "object.value": {
              name: "AlphaWrap",
              children: [{ "field.object": { name: "inner", "@objectRef": "acme::alpha::Note" } }],
            },
          },
          {
            // A writable entity referencing a colliding value object via a jsonb
            // field.object — exercises Zod <Ref>InsertSchema + Drizzle .$type<>().
            "object.entity": {
              name: "AlphaHost",
              children: [
                { "source.rdb": { "@table": "alpha_hosts" } },
                { "field.long": { name: "id" } },
                { "field.object": { name: "note", "@objectRef": "acme::alpha::Note", "@storage": "jsonb" } },
                { "identity.primary": { name: "primary", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
      {
        package: "acme::beta",
        children: [
          {
            "object.value": {
              name: "Note",
              children: [{ "field.string": { name: "betaText", "@required": true } }],
            },
          },
          {
            "object.entity": {
              name: "BetaHost",
              children: [
                { "source.rdb": { "@table": "beta_hosts" } },
                { "field.long": { name: "id" } },
                { "field.object": { name: "note", "@objectRef": "acme::beta::Note", "@storage": "jsonb" } },
                { "identity.primary": { name: "primary", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    ]);

    const files = await genFiles(root, "package");

    // Two modules, each declaring its own value object under its own name.
    const alphaNote = files.get("acme/alpha/Note.ts")!;
    expect(alphaNote).toContain("export interface Note {");
    expect(alphaNote).toContain("export const NoteInsertSchema");
    expect(alphaNote).toMatch(/alphaText:\s*string;/);
    const betaNote = files.get("acme/beta/Note.ts")!;
    expect(betaNote).toContain("export interface Note {");
    expect(betaNote).toContain("export const NoteInsertSchema");
    expect(betaNote).toMatch(/betaText:\s*string;/);
    for (const content of files.values()) expect(content).not.toMatch(/(interface|const) Acme(Alpha|Beta)Note/);

    // inferred-types field.object reference (VO -> VO): its own package's Note, local alias.
    const alphaWrap = files.get("acme/alpha/AlphaWrap.ts")!;
    expect(alphaWrap).toMatch(/inner\?:\s*AcmeAlphaNote \| undefined;/);
    expect(alphaWrap).toMatch(/type Note as AcmeAlphaNote[\s\S]*?\} from "\.\/Note\.js";/);

    // Zod <Ref>InsertSchema + Drizzle .$type<>() on each entity bind the right Note.
    const alphaHost = files.get("acme/alpha/AlphaHost.ts")!;
    expect(alphaHost).toContain("NoteInsertSchema as AcmeAlphaNoteInsertSchema");
    expect(alphaHost).toMatch(/\.\$type<AcmeAlphaNote>/);
    expect(alphaHost).toContain('from "./Note.js"');
    const betaHost = files.get("acme/beta/BetaHost.ts")!;
    expect(betaHost).toContain("NoteInsertSchema as AcmeBetaNoteInsertSchema");
    expect(betaHost).toMatch(/\.\$type<AcmeBetaNote>/);
    expect(betaHost).toContain('from "./Note.js"');
  });

  test("write-through read-view, projection, and field.map references all bind the right node", async () => {
    const root = await loadMultiPackageRoot([
      {
        package: "acme::alpha",
        children: [
          {
            "object.value": {
              name: "Note",
              children: [{ "field.string": { name: "alphaText", "@required": true } }],
            },
          },
          {
            // Write-through entity (writable table + read-only replica view) carrying
            // a jsonb field.object AND a field.map of the colliding VO. Exercises the
            // entity-file.ts write-through `voRef` (fix #1) + view-decl.ts (fix #3) +
            // the field.map reference branch.
            "object.entity": {
              name: "AlphaReport",
              children: [
                { "source.rdb": { "@role": "primary", "@table": "alpha_reports" } },
                { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_alpha_reports" } },
                { "field.long": { name: "id" } },
                { "field.object": { name: "note", "@objectRef": "acme::alpha::Note", "@storage": "jsonb" } },
                { "field.map": { name: "tags", "@objectRef": "acme::alpha::Note" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
          {
            // Projection extends-binding the write-through entity's VO column.
            // Exercises the projection-decl.ts `voRef` (fix #2) + view-decl.ts.
            "object.projection": {
              name: "AlphaNoteView",
              children: [
                { "source.rdb": { "@kind": "view", "@table": "v_alpha_note" } },
                { "field.long": { name: "id", extends: "AlphaReport.id" } },
                { "field.object": { name: "note", extends: "AlphaReport.note" } },
                { "identity.primary": { extends: "AlphaReport.pk" } },
              ],
            },
          },
        ],
      },
      {
        // The collision partner — forces acme::alpha::Note to qualify to AcmeAlphaNote.
        package: "acme::beta",
        children: [
          {
            "object.value": {
              name: "Note",
              children: [{ "field.string": { name: "betaText", "@required": true } }],
            },
          },
        ],
      },
    ]);

    const files = await genFiles(root, "package");

    // Write-through entity: BOTH the read-view Zod schema (renderViewReadZodObject) and the
    // `.existing()` view decl (renderExistingViewDecl) bind acme::alpha::Note by its alias.
    const alphaReport = files.get("acme/alpha/AlphaReport.ts")!;
    expect(alphaReport).toContain("export const AlphaReportSchema");       // read-view zod
    expect(alphaReport).toContain("alphaReportView");                       // .existing() view var
    expect(alphaReport).toContain("NoteInsertSchema as AcmeAlphaNoteInsertSchema");
    expect(alphaReport).toMatch(/\.\$type<AcmeAlphaNote>/);
    expect(alphaReport).toContain('from "./Note.js"');
    expect(alphaReport).not.toMatch(/\.\$type<Note>/);
    // field.map reference (Record<string, VO>) binds it too.
    expect(alphaReport).toMatch(/Record<string,\s*AcmeAlphaNote>/);

    // Projection read model imports the same Note under the same alias.
    const alphaNoteView = files.get("acme/alpha/AlphaNoteView.ts")!;
    expect(alphaNoteView).toContain("NoteInsertSchema as AcmeAlphaNoteInsertSchema");
    expect(alphaNoteView).toContain('from "./Note.js"');
  });

  test("no-churn — a non-colliding value object keeps its BARE name/module (qualification never fires)", async () => {
    const root = await loadMultiPackageRoot([
      {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "Widget",
              children: [{ "field.string": { name: "label", "@required": true } }],
            },
          },
          {
            "object.value": {
              name: "Wrap",
              children: [{ "field.object": { name: "w", "@objectRef": "Widget" } }],
            },
          },
          {
            "object.entity": {
              name: "Host",
              children: [
                { "source.rdb": { "@table": "hosts" } },
                { "field.long": { name: "id" } },
                { "field.object": { name: "w", "@objectRef": "Widget", "@storage": "jsonb" } },
                { "identity.primary": { name: "primary", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    ]);

    const files = await genFiles(root);
    const names = [...files.keys()];

    // Bare, unqualified names — no package qualification when there is no collision.
    expect(names).toContain("Widget.ts");
    expect(names).not.toContain("DemoWidget.ts");

    const widget = files.get("Widget.ts")!;
    expect(widget).toContain("export interface Widget {");
    expect(widget).toContain("export const WidgetInsertSchema");

    const wrap = files.get("Wrap.ts")!;
    expect(wrap).toMatch(/w\?:\s*Widget \| undefined;/);
    expect(wrap).toContain("./Widget.js");

    const host = files.get("Host.ts")!;
    expect(host).toContain("WidgetInsertSchema");
    expect(host).toMatch(/\.\$type<Widget>/);
    expect(host).toContain("./Widget.js");

    // Barrel no-churn: with no collision the value-object module is re-exported by
    // its BARE name (qualification never fires) — byte-identical to pre-#228 output.
    const index = files.get("index.ts")!;
    expect(index).toContain("./Widget.js");
    expect(index).toContain("./Host.js");
    expect(index).not.toMatch(/DemoWidget/);
  });
});
