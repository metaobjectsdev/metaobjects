// A credential (a field that declares `view.password`) is never an Angular grid column or
// initial sort — the same rule as the TanStack tier and the generated forms. The server never
// returns its value and keeps it off the sort and filter allowlists.

import { describe, test, expect } from "bun:test";
import { angularGridFile } from "../src/index.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

async function render(grid: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify({
    "metadata.root": {
      children: [{
        "object.entity": {
          name: "Account",
          children: [
            { "source.rdb": { "@table": "account" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.string": { name: "email", "@filterable": true } },
            {
              "field.string": {
                name: "pinHash", "@filterable": true, "@sortable": true,
                children: [{ "view.password": {} }],
              },
            },
            { "layout.dataGrid": { name: "default", ...grid } },
          ],
        },
      }],
    },
  });
  const { root, errors } = await new MetaDataLoader({ strict: true })
    .load([new InMemoryStringSource(json, { id: "account.json" })]);
  expect(errors.map((e) => e.message)).toEqual([]);
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
  const files = await angularGridFile().generate(ctx);
  const file = files.find((f) => f.path.includes("Account"));
  if (file === undefined) throw new Error(`no grid emitted; got ${files.map((f) => f.path).join(", ")}`);
  return file.content;
}

describe("a credential is not an Angular grid column", () => {
  test("dropped when @columns names it explicitly", async () => {
    const out = await render({ "@columns": ["email", "pinHash"] });
    expect(out).toContain('id: "email"');
    expect(out).not.toContain("pinHash");
  });

  test("dropped when @columns is omitted and every field becomes a column", async () => {
    const out = await render({});
    expect(out).toContain('id: "email"');
    expect(out).not.toContain("pinHash");
  });

  test("a @defaultSortField naming it gives no initial sort", async () => {
    const out = await render({ "@columns": ["email"], "@defaultSortField": "pinHash" });
    expect(out).not.toContain("defaultSort");
    expect(out).not.toContain("pinHash");
  });
});
