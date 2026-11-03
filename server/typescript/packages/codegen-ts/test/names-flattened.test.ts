// A flattened value object has no column of its own: each member is a column of the owning
// table, named by core naming (`resolveFlattenedColumnName`). The names artifact carries
// those columns under the field's `members`, so code that needs a flattened column reads a
// constant instead of spelling it. The field's own entry keeps its `column` for code that
// already reads it, so the addition breaks nothing; in the rendered artifact that `column` is
// `@deprecated` (JSDoc only), since it names no column of the table.
//
// The corpus is the cross-port naming fixture: every `<Object>.<field>.<member>` key in it is
// a flattened column, and the artifact must name each one exactly as `meta migrate` does,
// under every naming rule.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { FileSource } from "@metaobjectsdev/metadata/core";
import {
  MetaDataLoader,
  InMemoryStringSource,
  isMetaRoot,
  type ColumnNamingStrategy,
  type MetaObject,
  type MetaRoot,
  type TableNamingRule,
} from "@metaobjectsdev/metadata";
import { resolveObjectNames, type FieldNames } from "../src/names.js";
import { renderNamesDecl } from "../src/templates/names-decl.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/naming-conformance/physical-names");

interface NamingCase {
  name: string;
  naming: { columns?: ColumnNamingStrategy; tables?: TableNamingRule } | null;
  columns: Record<string, string>;
}
const corpus = JSON.parse(readFileSync(join(CORPUS, "cases.json"), "utf8")) as { cases: NamingCase[] };

async function loadCorpusModel(c: NamingCase): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([new FileSource(join(CORPUS, "meta.naming.json"))]);
  expect(result.errors).toEqual([]);
  if (!isMetaRoot(result.root)) throw new Error("not a root");
  result.root.physicalNaming = {
    columns: c.naming?.columns ?? "snake_case",
    tables: c.naming?.tables ?? "snake_case",
  };
  return result.root;
}

/** The column the artifact names for a corpus key, or undefined when it names none. */
function artifactColumn(root: MetaRoot, key: string): string | undefined {
  const [objectName, fieldName, memberName] = key.split(".") as [string, string, string | undefined];
  const names = resolveObjectNames(root.findObject(objectName) as MetaObject);
  const entry: FieldNames | undefined = names?.fields[fieldName];
  if (entry === undefined) return undefined;
  if (memberName === undefined) return entry.column;
  return entry.members?.[memberName]?.column;
}

describe("names artifact — flattened columns (cross-port naming corpus)", () => {
  for (const c of corpus.cases) {
    test(`${c.name}: every column in the corpus, flattened members included`, async () => {
      const root = await loadCorpusModel(c);
      const actual: Record<string, string | undefined> = {};
      for (const key of Object.keys(c.columns)) actual[key] = artifactColumn(root, key);
      expect(actual).toEqual(c.columns);
    });
  }

  test("a flattened field keeps its own entry, unchanged, and gains members", async () => {
    const root = await loadCorpusModel(corpus.cases[0]!);
    const names = resolveObjectNames(root.findObject("Shipment") as MetaObject);
    expect(names?.fields.shipTo?.column).toBe("ship_to");
    expect(Object.keys(names?.fields.shipTo?.members ?? {}).sort()).toEqual(["country", "postalCode", "street"]);
    expect(names?.fields.id?.members).toBeUndefined();
  });
});

describe("names artifact — rendered flattened members", () => {
  const DOC = {
    "metadata.root": {
      package: "acme",
      children: [
        { "object.value": { name: "Address", children: [
          { "field.string": { name: "street" } },
          { "field.string": { name: "postalCode", "@column": "ZIP" } },
        ] } },
        { "object.entity": { name: "Shipment", children: [
          { "source.rdb": { "@table": "shipments" } },
          { "field.long": { name: "id" } },
          { "field.object": { name: "shipTo", "@objectRef": "Address", "@storage": "flattened" } },
          { "field.object": { name: "payload", "@objectRef": "Address" } },
          { "identity.primary": { name: "pk", "@fields": "id" } },
        ] } },
      ],
    },
  };

  test("members beside the field's own entry, each with its column; a jsonb object is unchanged", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
    expect(errors).toEqual([]);
    const out = renderNamesDecl(root.findObject("Shipment") as MetaObject, { strategy: "snake_case" });

    expect(out).toContain([
      "    shipTo: {",
      '      name: "shipTo",',
      // On its own line: TypeScript attaches a JSDoc comment only when a line break precedes it.
      "      /** @deprecated a flattened field has no column of its own; use members.<member>.column */",
      '      column: "ship_to",',
      '      members: { postalCode: { name: "postalCode", column: "ship_to_ZIP" }, street: { name: "street", column: "ship_to_street" } },',
      "    },",
    ].join("\n"));
    expect(out).toContain('payload: { name: "payload", column: "payload" }');
  });
});

describe("names artifact — the flattened field's own column is deprecated where it is used", () => {
  /** Strict-mode errors and the deprecation suggestions (6385) for in-memory files. */
  function diagnose(files: Record<string, string>): { errors: string[]; deprecated: string[] } {
    const names = Object.keys(files);
    const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
    const svc = ts.createLanguageService({
      getScriptFileNames: () => names,
      getScriptVersion: () => "1",
      getScriptSnapshot: (f) => {
        const text = files[f] ?? (ts.sys.fileExists(f) ? ts.sys.readFile(f) : undefined);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => "/",
      getCompilationSettings: () => options,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: (f) => f in files || ts.sys.fileExists(f),
      readFile: (f) => files[f] ?? ts.sys.readFile(f),
    }, ts.createDocumentRegistry());
    const errors: string[] = [];
    const deprecated: string[] = [];
    for (const f of names) {
      for (const d of [...svc.getSyntacticDiagnostics(f), ...svc.getSemanticDiagnostics(f)]) {
        errors.push(`${f}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
      }
      for (const d of svc.getSuggestionDiagnostics(f)) {
        if (d.reportsDeprecated !== true) continue;
        // the whole line the flagged name is on, so a test can tell which access it was
        const text = files[f]!;
        const lineStart = text.lastIndexOf("\n", d.start!) + 1;
        const lineEnd = text.indexOf("\n", d.start!);
        deprecated.push(`${f}: ${text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)}`);
      }
    }
    return { errors, deprecated };
  }

  const DOC = {
    "metadata.root": {
      package: "test",
      children: [
        { "object.value": { name: "Address", children: [{ "field.string": { name: "street" } }] } },
        { "object.entity": { name: "Shipment", children: [
          { "source.rdb": { "@table": "shipments" } },
          { "field.long": { name: "id" } },
          { "field.object": { name: "shipTo", "@objectRef": "Address", "@storage": "flattened" } },
          { "identity.primary": { name: "pk", "@fields": "id" } },
        ] } },
      ],
    },
  };

  test("a use of fields.<field>.column is reported deprecated; a member column and an unused artifact are not", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
    expect(errors).toEqual([]);
    const artifact = renderNamesDecl(root.findObject("Shipment") as MetaObject, { strategy: "snake_case" });

    // The artifact on its own: it compiles, and declaring the deprecated entry warns nothing.
    expect(diagnose({ "/Shipment.names.ts": artifact })).toEqual({ errors: [], deprecated: [] });

    const use = [
      'import { ShipmentNames } from "./Shipment.names";',
      "export const own = ShipmentNames.fields.shipTo.column;",
      "export const member = ShipmentNames.fields.shipTo.members.street.column;",
      "export const id = ShipmentNames.fields.id.column;",
      "",
    ].join("\n");
    const result = diagnose({ "/Shipment.names.ts": artifact, "/use.ts": use });
    expect(result.errors).toEqual([]);
    // the field's own column, and not a member's or a plain field's
    expect(result.deprecated).toEqual(["/use.ts: export const own = ShipmentNames.fields.shipTo.column;"]);
  });
});
