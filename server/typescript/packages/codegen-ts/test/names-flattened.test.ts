// A flattened value object has no column of its own: each member is a column of the owning
// table, named by core naming (`resolveFlattenedColumnName`). The names artifact carries
// those columns under the field's `members`, so code that needs a flattened column reads a
// constant instead of spelling it. The field's entry has no `column`: it would name a column
// the table does not have, so reading it is a compile error.
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
import { renderProjectionDecl } from "../src/templates/projection-decl.js";
import { code } from "ts-poet";

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

  test("a flattened field has members and no column of its own", async () => {
    const root = await loadCorpusModel(corpus.cases[0]!);
    const names = resolveObjectNames(root.findObject("Shipment") as MetaObject);
    expect(names?.fields.shipTo?.column).toBeUndefined();
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

  test("members, each with its column, and no column for the field; a jsonb object is unchanged", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
    expect(errors).toEqual([]);
    const out = renderNamesDecl(root.findObject("Shipment") as MetaObject, { strategy: "snake_case" });

    expect(out).toContain([
      "    shipTo: {",
      '      name: "shipTo",',
      '      members: { postalCode: { name: "postalCode", column: "ship_to_ZIP" }, street: { name: "street", column: "ship_to_street" } },',
      "    },",
    ].join("\n"));
    expect(out).toContain('payload: { name: "payload", column: "payload" }');
  });
});

describe("names artifact — a flattened field's column does not exist", () => {
  /** Strict-mode errors for in-memory files. */
  function diagnose(files: Record<string, string>): string[] {
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
    for (const f of names) {
      for (const d of [...svc.getSyntacticDiagnostics(f), ...svc.getSemanticDiagnostics(f)]) {
        const text = files[f]!;
        const lineStart = text.lastIndexOf("\n", d.start!) + 1;
        const lineEnd = text.indexOf("\n", d.start!);
        errors.push(`${f}: ${text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)}`);
      }
    }
    return errors;
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

  test("reading fields.<flattened>.column fails to compile; a member column and a plain column compile", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
    expect(errors).toEqual([]);
    const artifact = renderNamesDecl(root.findObject("Shipment") as MetaObject, { strategy: "snake_case" });
    expect(diagnose({ "/Shipment.names.ts": artifact })).toEqual([]);

    const use = [
      'import { ShipmentNames } from "./Shipment.names";',
      "export const own = ShipmentNames.fields.shipTo.column;",
      "export const member = ShipmentNames.fields.shipTo.members.street.column;",
      "export const id = ShipmentNames.fields.id.column;",
      "",
    ].join("\n");
    expect(diagnose({ "/Shipment.names.ts": artifact, "/use.ts": use }))
      .toEqual(["/use.ts: export const own = ShipmentNames.fields.shipTo.column;"]);
  });
});

describe("names artifact — a projection over a flattened field", () => {
  const DOC = {
    "metadata.root": {
      package: "acme",
      children: [
        { "object.value": { name: "Address", children: [{ "field.string": { name: "street" } }] } },
        { "object.entity": { name: "Shipment", children: [
          { "source.rdb": { "@table": "shipments" } },
          { "field.long": { name: "id" } },
          { "field.object": { name: "shipTo", "@objectRef": "Address", "@storage": "flattened" } },
          { "identity.primary": { name: "pk", "@fields": "id" } },
        ] } },
        { "object.projection": { name: "ShipmentView", children: [
          { "source.rdb": { "@kind": "view", "@view": "v_shipments" } },
          { "field.long": { name: "id", extends: "Shipment.id" } },
          { "field.object": { name: "shipTo", extends: "Shipment.shipTo" } },
          { "identity.primary": { name: "pk", extends: "Shipment.pk" } },
        ] } },
      ],
    },
  };

  test("the flattened field's dbCol is a literal, never names.fields.<field>.column (which does not exist)", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
    expect(errors).toEqual([]);
    const names = { resolved: resolveObjectNames(root.findObject("Shipment") as MetaObject)!, symbol: code`ShipmentNames` };
    const out = renderProjectionDecl(root.findObject("ShipmentView") as MetaObject, root, {
      columnNamingStrategy: "snake_case", dialect: "postgres", names,
    });
    expect(out).toContain("ShipmentNames.fields.id.column");
    expect(out).not.toContain("ShipmentNames.fields.shipTo.column");
  });
});
