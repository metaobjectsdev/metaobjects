// The co-emitted-output compile gate.
//
// The defect this exists for was CROSS-FILE and therefore invisible to every
// single-file assertion in this package: `tanstackQuery()` emitted
// `<V>.hooks.ts` for an `object.value`, and that file value-imported `<V>` plus
// `<V>Filter` / `<V>Insert` / `<V>Update` from `<V>.ts` — which, for a value,
// exports only a type-only `interface` and an `InsertSchema`. TS2693 + TS2305 x3,
// and a hard link error under native ESM. It shipped for many releases because
// every test here inspected ONE generator's output in isolation, so nothing ever
// asked whether the files a run emits actually agree with each other.
//
// So: run the whole pipeline over a model containing exactly the shapes that
// tempt the bug — an `object.value`, a sourceless entity, a sourceless
// projection, and a view-backed projection that MUST keep its read-only hooks —
// write the real emitted files to disk, and typecheck them together with tsc.
// Any future generator whose filter admits an object its sibling tier refuses
// fails here immediately, whatever the mechanism.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import { tanstackQuery, tanstackGrid, tanstackGridHook } from "../src/index.js";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

// The consumer-owned database module the generated routes import. Never emitted by
// codegen, so the sibling reconciliation below skips it deliberately.
const DB_IMPORT = "./db";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      // Sourced entity — the control. Everything should be emitted for it.
      { "object.entity": { name: "Author", children: [
        { "source.rdb": { "@table": "authors" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@filterable": true, children: [{ "view.text": {} }] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "layout.dataGrid": { name: "default", "@columns": ["id", "name"] } },
      ] } },
      // View-backed projection — MUST keep read-only hooks. This is the row that
      // stops an over-broad fix: it has a source, so it stays a client of a route.
      { "object.projection": { name: "AuthorSummary", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_author_summary" } },
        // FR-024: a projection's identity is a PASS-THROUGH — it extends an entity
        // identity, and every field of that identity needs a pass-through field here.
        { "field.long": { name: "id", extends: "Author.id" } },
        { "field.string": { name: "name", extends: "Author.name" } },
        { "identity.primary": { name: "pk", extends: "Author.pk" } },
      ] } },
      // object.value — a pure shape. No identity, no source, ever (ADR-0028).
      { "object.value": { name: "NotePayload", children: [
        { "field.string": { name: "text" } },
        // Deliberately tempting: a value is allowed to carry a dataGrid layout, so
        // this baits the grid pair too, not just the hooks tier.
        { "layout.dataGrid": { name: "default", "@columns": ["text"] } },
      ] } },
      // Sourceless entity — no route, so no client for one.
      { "object.entity": { name: "Sourceless", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      // Sourceless projection — the #210 payload re-host shape. Its generated
      // surface is the payload VO / render helper / output parser, never CRUD.
      { "object.projection": { name: "AuthorCard", children: [
        { "field.string": { name: "name" } },
      ] } },
    ],
  },
});

async function generate(dir: string): Promise<string[]> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(errors).toEqual([]);
  await runGen({
    config: defineConfig({
      outDir: dir, extStyle: "none", dbImport: DB_IMPORT, dialect: "postgres",
      generators: [
        entityFile(), queriesFile(), routesFile(),
        tanstackQuery(), tanstackGrid(), tanstackGridHook(), barrel(),
      ],
    }),
    metadata: root,
  });
  return readdirSync(dir).sort();
}

describe("co-emitted generated output", () => {
  test("instance artifacts are emitted for sourced objects ONLY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "co-emit-"));
    try {
      const files = await generate(dir);

      // The sourced entity gets the full surface.
      expect(files).toContain("Author.hooks.ts");
      expect(files).toContain("Author.columns.tsx");
      expect(files).toContain("Author.grid.ts");

      // The VIEW-BACKED projection keeps read hooks — the row that catches an
      // over-broad fix. It has a source, so a route exists to read from.
      expect(files).toContain("AuthorSummary.hooks.ts");

      // Nothing that has no source gets a client for a route it does not have.
      for (const name of ["NotePayload", "Sourceless", "AuthorCard"]) {
        expect(files).not.toContain(`${name}.hooks.ts`);
        expect(files).not.toContain(`${name}.columns.tsx`);
        expect(files).not.toContain(`${name}.grid.ts`);
      }
      // …while the value object still gets its type-only entity module, which is
      // the whole point of a value: a shape other code references.
      expect(files).toContain("NotePayload.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every name a generated file imports from a SIBLING is actually exported", async () => {
    // The cross-file gate, stated as the bug: `<V>.hooks.ts` imported `<V>` as a
    // VALUE plus `<V>Filter` / `<V>Insert` / `<V>Update` from `<V>.ts`, which for a
    // value object exports only a type-only `interface` and an `InsertSchema`.
    //
    // This reconciles imports against exports directly rather than running tsc over
    // the tree. A full typecheck would need the third-party typings (drizzle, zod,
    // react-query, fastify) present and correct, and every stub or wildcard for them
    // either drowns the real signal in TS2709/TS2694 noise or — far worse — omits the
    // very export under test and turns a genuine cross-file break into stub noise
    // nobody reads. Reading the emitted modules against each other has no third-party
    // surface at all, so it cannot rot, and it fails on exactly the defect.
    const dir = mkdtempSync(join(tmpdir(), "co-emit-xref-"));
    try {
      const files = (await generate(dir)).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
      const parse = (f: string) =>
        ts.createSourceFile(f, readFileSync(join(dir, f), "utf8"), ts.ScriptTarget.ES2022, true,
          f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const ast = new Map(files.map((f) => [f, parse(f)] as const));

      /** Exported names of a module, split by whether they can be used as a VALUE. */
      function exportsOf(sf: ts.SourceFile): { all: Set<string>; values: Set<string> } {
        const all = new Set<string>(), values = new Set<string>();
        for (const st of sf.statements) {
          const exported = ts.canHaveModifiers(st)
            && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (!exported) {
            if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
              for (const e of st.exportClause.elements) { all.add(e.name.text); if (!e.isTypeOnly) values.add(e.name.text); }
            }
            continue;
          }
          if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) { all.add(st.name.text); continue; }
          if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations)
              if (ts.isIdentifier(d.name)) { all.add(d.name.text); values.add(d.name.text); }
            continue;
          }
          if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
            all.add(st.name.text); values.add(st.name.text);
          }
        }
        return { all, values };
      }
      const exportCache = new Map<string, ReturnType<typeof exportsOf>>();
      const exportsFor = (f: string) => {
        if (!exportCache.has(f)) exportCache.set(f, exportsOf(ast.get(f)!));
        return exportCache.get(f)!;
      };

      const problems: string[] = [];
      for (const [file, sf] of ast) {
        for (const st of sf.statements) {
          if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
          const spec = st.moduleSpecifier.text;
          if (!spec.startsWith("./") && !spec.startsWith("../")) continue;   // siblings only
          if (spec === DB_IMPORT) continue;   // consumer-owned module, never emitted
          const base = spec.replace(/^\.\//, "").replace(/\.js$/, "");
          const target = [`${base}.ts`, `${base}.tsx`].find((c) => ast.has(c));
          if (!target) { problems.push(`${file} imports "${spec}" — no such emitted module`); continue; }
          const { all, values } = exportsFor(target);
          const clause = st.importClause;
          if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
          const typeOnlyImport = clause.isTypeOnly;
          for (const el of clause.namedBindings.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (!all.has(name)) {
              problems.push(`${file} imports { ${name} } from "${spec}" — ${target} does not export it`);
            } else if (!typeOnlyImport && !el.isTypeOnly && !values.has(name)) {
              problems.push(`${file} imports { ${name} } from "${spec}" as a VALUE — ${target} exports it as a type only`);
            }
          }
        }
      }
      expect(problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
