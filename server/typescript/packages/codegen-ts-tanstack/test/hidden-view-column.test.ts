// #355 residue — `view.hidden` is registered as "Not rendered; carried but not shown".
// The generated FORM has always honoured that (`<input type="hidden">`), and the grid did
// not: no renderer is keyed `hidden`, so EntityGrid's `if (!renderer) return col` fell
// through to TanStack's default cell and PRINTED the value.
//
// A blank cell would not have fixed it — the column would still hold a header and a sort
// target, so the value would be hidden while the column was not. The column is dropped.

import { describe, test, expect } from "bun:test";
import { renderColumnsFile } from "../src/templates/columns-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

async function render(gridChildren: unknown[]): Promise<string> {
  const json = JSON.stringify({
    "metadata.root": {
      children: [{
        "object.entity": {
          name: "Account",
          children: [
            { "source.rdb": { "@table": "account" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.string": { name: "email" } },
            { "field.string": { name: "internalRef", children: [{ "view.hidden": {} }] } },
            ...gridChildren,
          ],
        },
      }],
    },
  });
  const { root, errors } = await new MetaDataLoader({ strict: true })
    .load([new InMemoryStringSource(json, { id: "account.json" })]);
  expect(errors.map((e) => (e as { code?: string }).code)).toEqual([]);
  const entity = root.objects().find((o) => o.name === "Account")!;
  return renderColumnsFile(entity, makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  }));
}

const GRID = (columns?: string[]) => [{
  "layout.dataGrid": { name: "default", ...(columns ? { "@columns": columns } : {}) },
}];

describe("#355 a view.hidden field is not a grid column", () => {
  test("dropped even when @columns names it explicitly", async () => {
    // The two declarations contradict each other, and the one about RENDERING is the
    // specific answer to the question a grid asks.
    const out = await render(GRID(["email", "internalRef"]));
    expect(out).toContain('id: "email"');
    expect(out).not.toContain("internalRef");
  });

  test("dropped when @columns is omitted and every field becomes a column", async () => {
    const out = await render(GRID());
    expect(out).toContain('id: "email"');
    expect(out).not.toContain("internalRef");
  });

  test("a visible field beside it is unaffected", async () => {
    const out = await render(GRID(["email", "internalRef"]));
    expect(out).toContain('meta: { view: "text"');
  });
});
