// An int-backed field.enum ARRAY (@intValueMap + isArray) generates modules that
// typecheck on every dialect: Postgres composes the element codec under `.array()`
// (integer[]); SQLite and MySQL get a whole-array codec over one JSON column. The
// shape is the adopter's: the map on a shared abstract enum, inherited by a scalar
// column and an array column, and the array also read through a view-backed
// projection (the view template declares its own copy of the codec).

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { COMPILE_TEST_TIMEOUT_MS } from "./compile-timeout.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

setDefaultTimeout(COMPILE_TEST_TIMEOUT_MS);

async function loadRoot() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        { "field.enum": { name: "Status", abstract: true,
          "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
          "@intValueMap": { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 } } },
        { "object.entity": { name: "Doc", children: [
          { "source.rdb": { "@table": "doc" } },
          { "field.int": { name: "id" } },
          { "field.enum": { name: "state", extends: "Status" } },
          { "field.enum": { name: "history", extends: "Status", isArray: true } },
          { "identity.primary": { name: "pk", "@fields": "id" } },
        ] } },
        { "object.projection": { name: "DocHistory", children: [
          { "source.rdb": { "@kind": "view", "@view": "v_doc_history" } },
          { "field.int": { name: "id", extends: "Doc.id", "@required": true } },
          { "field.enum": { name: "history", extends: "Doc.history" } },
          { "identity.primary": { name: "pk", extends: "Doc.pk" } },
        ] } },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  return result.root;
}

function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
  const program = ts.createProgram(files.map((f) => join(dir, f)), {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
  });
  return ts.getPreEmitDiagnostics(program);
}

describe("int-backed field.enum ARRAY — generated modules compile", () => {
  for (const dialect of ["postgres", "sqlite", "mysql"] as const) {
    test(dialect, async () => {
      const dir = mkdtempSync(join(import.meta.dir, `tmp-int-enum-array-${dialect}-`));
      try {
        const root = await loadRoot();
        const renderContext = makeRenderContext({
          dialect, loadedRoot: root, outDir: dir, dbImport: "./db",
          pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
        });
        const ctx: GenContext = {
          entities: root.objects(), loadedRoot: root, matches: () => true, projectRoot: dir,
          config: { outDir: dir, extStyle: "none", dbImport: "./db", dialect } as never,
          renderContext, warn: () => {},
        };
        const files = [
          ...(await entityFile({ allowlists: false }).generate(ctx)),
          ...(await queriesFile().generate(ctx)),
        ];
        const core = dialect === "postgres" ? "pg" : dialect;
        writeFileSync(join(dir, "db.ts"),
          `import type { ${core === "pg" ? "NodePgDatabase" : core === "sqlite" ? "BunSQLiteDatabase" : "MySql2Database"} as D } from "drizzle-orm/${core === "pg" ? "node-postgres" : core === "sqlite" ? "bun-sqlite" : "mysql2"}";\nexport declare const db: D;\n`);
        for (const f of files) writeFileSync(join(dir, f.path), f.content);
        const doc = files.find((f) => f.path === "Doc.ts")!.content;
        if (dialect === "postgres") expect(doc).toContain('historyIntEnum("history").array()');
        else expect(doc).toContain('historyIntEnumArray("history")');
        const diagnostics = compile(dir, [...files.map((f) => f.path)]);
        expect(diagnostics.map((d) => `${d.file?.fileName ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
