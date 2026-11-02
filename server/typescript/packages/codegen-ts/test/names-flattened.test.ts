// A flattened value object has no column of its own: each member is a column of the owning
// table, named by core naming (`resolveFlattenedColumnName`). The names artifact carries
// those columns under the field, and no `column` for the field itself, so code that needs a
// flattened column reads a constant instead of spelling it, and a lookup of the phantom
// `ship_to` column is a compile error rather than a query against a column that is not there.
//
// The corpus is the cross-port naming fixture: every `<Object>.<field>.<member>` key in it is
// a flattened column, and the artifact must name each one exactly as `meta migrate` does,
// under every naming rule.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  if (memberName === undefined) return "column" in entry ? entry.column : undefined;
  return "members" in entry ? entry.members[memberName]?.column : undefined;
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

  test("a flattened field names no column of its own", async () => {
    const root = await loadCorpusModel(corpus.cases[0]!);
    const names = resolveObjectNames(root.findObject("Shipment") as MetaObject);
    for (const field of ["shipTo", "billTo", "returnTo", "giftTo", "homeTo"]) {
      const entry = names?.fields[field];
      expect(entry).toBeDefined();
      expect("column" in entry!).toBe(false);
    }
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

  test("members under the field, each with its column; a jsonb object keeps its one column", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
    expect(errors).toEqual([]);
    const out = renderNamesDecl(root.findObject("Shipment") as MetaObject, { strategy: "snake_case" });

    expect(out).toContain(
      'shipTo: { name: "shipTo", members: { postalCode: { name: "postalCode", column: "ship_to_ZIP" }, ' +
        'street: { name: "street", column: "ship_to_street" } } }',
    );
    expect(out).toContain('payload: { name: "payload", column: "payload" }');
    expect(out).not.toContain('column: "ship_to"');
  });
});
