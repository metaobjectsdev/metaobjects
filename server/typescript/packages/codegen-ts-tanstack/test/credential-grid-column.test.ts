// A credential (a field that declares `view.password`) is never a grid column, sort or filter.
//
// The generated forms skip a credential, and the server keeps it out of every response and off
// the filter and sort allowlists. The grid did neither: a dataGrid whose `@columns` named one
// emitted a column for it (a header, a cell, a sortable flag), a `@defaultSortField` naming one
// became the grid's initial sort, and a `@filter` preset over one was emitted verbatim. Each of
// those is a request the server refuses, and the column advertises a secret the API never sends.

import { describe, test, expect } from "bun:test";
import { renderColumnsFile } from "../src/templates/columns-file.js";
import { renderGridHookFile } from "../src/templates/grid-hook-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";

const PASSWORD = { "view.password": {} };

async function load(children: unknown[]): Promise<MetaRoot> {
  const json = JSON.stringify({ "metadata.root": { package: "demo", children } });
  const { root, errors } = await new MetaDataLoader({ strict: true })
    .load([new InMemoryStringSource(json, { id: "credential-grid.json" })]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
}

function find(root: MetaRoot, name: string): MetaObject {
  const obj = root.objects().find((o) => o.name === name);
  if (obj === undefined) throw new Error(`no object ${name}`);
  return obj;
}

/** An Account whose `pinHash` is a credential the model ALSO marks filterable and sortable. */
function account(grid: Record<string, unknown>): unknown[] {
  return [{
    "object.entity": {
      name: "Account",
      children: [
        { "source.rdb": { "@table": "account" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        { "field.string": { name: "email", "@filterable": true } },
        { "field.string": { name: "pinHash", "@filterable": true, "@sortable": true, children: [PASSWORD] } },
        { "layout.dataGrid": { name: "default", ...grid } },
      ],
    },
  }];
}

describe("a credential is not a TanStack grid column", () => {
  test("dropped when @columns names it explicitly", async () => {
    const root = await load(account({ "@columns": ["email", "pinHash"] }));
    const out = renderColumnsFile(find(root, "Account"), ctxFor(root));
    expect(out).toContain('id: "email"');
    expect(out).not.toContain("pinHash");
  });

  test("dropped when @columns is omitted and every field becomes a column", async () => {
    const root = await load(account({}));
    const out = renderColumnsFile(find(root, "Account"), ctxFor(root));
    expect(out).toContain('id: "email"');
    expect(out).not.toContain("pinHash");
  });

  test("a @defaultSortField naming it gives no initial sort, in the grid const and the hook", async () => {
    const root = await load(account({ "@columns": ["email"], "@defaultSortField": "pinHash" }));
    const entity = find(root, "Account");
    const columns = renderColumnsFile(entity, ctxFor(root));
    expect(columns).not.toContain("defaultSort");
    expect(columns).not.toContain("pinHash");
    const hook = renderGridHookFile(entity, ctxFor(root));
    expect(hook).toContain("useState<SortingState>([])");
    expect(hook).not.toContain("pinHash");
  });

  test("a @filter preset over it is refused, not emitted", async () => {
    const root = await load(account({ "@columns": ["email"], "@filter": { pinHash: { eq: "x" } } }));
    expect(() => renderColumnsFile(find(root, "Account"), ctxFor(root))).toThrow(
      /@filter over credential field "pinHash"/,
    );
  });

  test("a @filter preset naming it inside an or-composition is refused too", async () => {
    const root = await load(
      account({ "@columns": ["email"], "@filter": { or: [{ email: { eq: "a" } }, { pinHash: { eq: "x" } }] } }),
    );
    expect(() => renderColumnsFile(find(root, "Account"), ctxFor(root))).toThrow(/"pinHash"/);
  });

  test("a @filter preset over other fields is still emitted", async () => {
    const root = await load(account({ "@columns": ["email"], "@filter": { email: { eq: "a" } } }));
    const out = renderColumnsFile(find(root, "Account"), ctxFor(root));
    expect(out).toContain("accountDefaultFilter");
  });
});

describe("a credential is not a column of a TPH base's polymorphic grid", () => {
  // `pin` is a subtype-only column, folded into the base grid. `code` is a column two
  // subtypes share, and only ONE declares it a credential: one physical column, so it is a
  // credential on every row, the same rule the generated routes apply.
  async function loadTph(): Promise<MetaRoot> {
    return load([
      {
        "object.entity": {
          name: "Auth",
          "@discriminator": "type",
          children: [
            { "source.rdb": { "@table": "auths" } },
            { "field.enum": { name: "type", "@values": ["Bridge", "Coupon"] } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
            { "layout.dataGrid": { name: "default", "@columns": ["type", "id", "pin", "code"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "BridgeAuth",
          extends: "Auth",
          "@discriminatorValue": "Bridge",
          children: [
            { "field.int": { name: "quantity" } },
            { "field.string": { name: "pin", children: [PASSWORD] } },
            { "field.string": { name: "code" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "CouponAuth",
          extends: "Auth",
          "@discriminatorValue": "Coupon",
          children: [{ "field.string": { name: "code", children: [PASSWORD] } }],
        },
      },
    ]);
  }

  test("a subtype-only credential and a sibling-marked shared column are both dropped", async () => {
    const root = await loadTph();
    const out = renderColumnsFile(find(root, "Auth"), ctxFor(root));
    expect(out).toContain('id: "type"');
    expect(out).toContain('id: "quantity"');
    expect(out).not.toContain('"pin"');
    expect(out).not.toContain('"code"');
  });
});
