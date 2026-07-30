import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/generators/entity-file.js";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

// ADR-0044 / #228 — the ENTITY tier brings the per-value-object entity module
// (interface name + output filename) into collision scope, keyed by the RUN's
// emitted `object.value` SET (NOT a payload closure). Two same-short-name
// `object.value`s across packages must emit DISTINCT interfaces to DISTINCT
// module paths, and every value-object-routed reference (Zod `<Ref>InsertSchema`,
// Drizzle `.$type<>()`, inferred-types field.object) must use the qualified name.

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

async function genFiles(root: Awaited<ReturnType<typeof loadMultiPackageRoot>>): Promise<Map<string, string>> {
  const result = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "js",
      dbImport: "../db",
      // postgres: a single (non-array) field.object jsonb column gets a
      // Drizzle `.$type<VO>()` — the value-object reference site under test.
      dialect: "postgres",
      generators: [entityFile()],
    }),
    metadata: root,
  });
  expect(result.conflicts).toEqual([]);
  const out = new Map<string, string>();
  for (const name of readdirSync(tmp)) {
    out.set(name, readFileSync(join(tmp, name), "utf8"));
  }
  return out;
}

describe("entity tier — ADR-0044 cross-package value-object short-name collision (#228)", () => {
  test("two same-short-name object.values emit distinct qualified interfaces/modules and every reference uses the qualified name", async () => {
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

    const files = await genFiles(root);
    const names = [...files.keys()].sort();

    // Distinct qualified module files — NEVER a single collision-losing Note.ts.
    expect(names).toContain("AcmeAlphaNote.ts");
    expect(names).toContain("AcmeBetaNote.ts");
    expect(names).not.toContain("Note.ts");

    const alphaNote = files.get("AcmeAlphaNote.ts")!;
    expect(alphaNote).toContain("export interface AcmeAlphaNote {");
    expect(alphaNote).toContain("export const AcmeAlphaNoteInsertSchema");
    expect(alphaNote).toMatch(/alphaText:\s*string;/);

    const betaNote = files.get("AcmeBetaNote.ts")!;
    expect(betaNote).toContain("export interface AcmeBetaNote {");
    expect(betaNote).toContain("export const AcmeBetaNoteInsertSchema");
    expect(betaNote).toMatch(/betaText:\s*string;/);

    // inferred-types field.object reference (VO -> VO) uses the qualified name +
    // imports the qualified module — NOT the bare `Note`.
    const alphaWrap = files.get("AlphaWrap.ts")!;
    expect(alphaWrap).toMatch(/inner\?:\s*AcmeAlphaNote;/);
    expect(alphaWrap).not.toMatch(/inner\?:\s*Note;/);
    expect(alphaWrap).toContain("./AcmeAlphaNote.js");

    // Zod <Ref>InsertSchema + Drizzle .$type<>() on the entity use the qualified name.
    const alphaHost = files.get("AlphaHost.ts")!;
    expect(alphaHost).toContain("AcmeAlphaNoteInsertSchema");
    expect(alphaHost).toMatch(/\.\$type<AcmeAlphaNote>/);
    expect(alphaHost).toContain("./AcmeAlphaNote.js");
    expect(alphaHost).not.toMatch(/[^a-zA-Z]NoteInsertSchema/);
    expect(alphaHost).not.toMatch(/\.\$type<Note>/);

    const betaHost = files.get("BetaHost.ts")!;
    expect(betaHost).toContain("AcmeBetaNoteInsertSchema");
    expect(betaHost).toMatch(/\.\$type<AcmeBetaNote>/);
    expect(betaHost).toContain("./AcmeBetaNote.js");
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
    expect(wrap).toMatch(/w\?:\s*Widget;/);
    expect(wrap).toContain("./Widget.js");

    const host = files.get("Host.ts")!;
    expect(host).toContain("WidgetInsertSchema");
    expect(host).toMatch(/\.\$type<Widget>/);
    expect(host).toContain("./Widget.js");
  });
});
