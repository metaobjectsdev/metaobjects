// #484: a report column is DERIVED from its `@of` field, so it would lose the field's `view.password`
// and be served. A grouped or min/max-ed credential stays a credential: the report's list route
// hides it, as an entity's does.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, reportReadModel, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { isCredentialField } from "../src/api-surface.js";
import { generatableObjects } from "../src/source-detect.js";
import { exportColumns } from "../src/templates/report-export-file.js";
import type { EmittedFile, Generator, GenContext } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "acme::acct",
    children: [
      { "object.entity": { name: "Account", children: [
        { "source.rdb": { "@table": "accounts" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true, "@maxLength": 40 } },
        { "field.string": { name: "pinHash", "@maxLength": 80, children: [{ "view.password": {} }] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "dimension.attribute": { name: "name", "@of": "Account.name" } },
        { "dimension.attribute": { name: "pinHash", "@of": "Account.pinHash" } },
        { "measure.aggregate": { name: "accounts", "@agg": "count", "@of": "Account.id" } },
        { "measure.aggregate": { name: "firstPin", "@agg": "min", "@of": "Account.pinHash" } },
      ]}},
      { "object.report": { name: "AccountsByPin", "@from": "Account", "@dimensions": ["pinHash"], "@measures": ["accounts"],
        children: [{ "source.rdb": { "@kind": "view", "@view": "v_accounts_by_pin" } }] } },
      { "object.report": { name: "AccountPinRange", "@from": "Account", "@dimensions": ["name"], "@measures": ["firstPin"],
        children: [{ "source.rdb": { "@kind": "view", "@view": "v_account_pin_range" } }] } },
      { "object.report": { name: "AccountsByName", "@from": "Account", "@dimensions": ["name"], "@measures": ["accounts"],
        children: [{ "source.rdb": { "@kind": "view", "@view": "v_accounts_by_name" } }] } },
    ],
  },
};

async function load(): Promise<MetaRoot> {
  const r = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(JSON.stringify(MODEL), { id: "report-credential.json" })]);
  expect(r.errors.map((e) => e.message)).toEqual([]);
  return r.root;
}

async function generate(gen: Generator, root: MetaRoot): Promise<EmittedFile[]> {
  const renderContext = makeRenderContext({
    dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "./db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root), includeNames: true,
  });
  const ctx: GenContext = {
    // runGen hands a generator the served reports as their read models.
    entities: generatableObjects(root.objects(), root), loadedRoot: root, matches: (e: MetaObject) => gen.filter?.(e) ?? true,
    projectRoot: "/x", config: { outDir: "/x", extStyle: "none", dbImport: "./db", dialect: "postgres" } as never,
    renderContext, warn: () => {},
  };
  return await gen.generate(ctx);
}

const routeOf = (files: EmittedFile[], name: string): string => {
  const f = files.find((x) => x.path.startsWith(`${name}.routes`));
  if (f === undefined) throw new Error(`no routes for ${name}: ${files.map((x) => x.path).join(", ")}`);
  return f.content.replace(/\s+/g, " ");
};

describe("a report over a credential field (#484)", () => {
  test("the read model's derived field is a credential, a plain one is not", async () => {
    const root = await load();
    const byPin = reportReadModel(root.objects().find((o) => o.name === "AccountsByPin")!, root);
    expect(isCredentialField(byPin.fields().find((f) => f.name === "pinHash")!)).toBe(true);
    const range = reportReadModel(root.objects().find((o) => o.name === "AccountPinRange")!, root);
    expect(isCredentialField(range.fields().find((f) => f.name === "firstPin")!)).toBe(true);
    expect(isCredentialField(range.fields().find((f) => f.name === "name")!)).toBe(false);
  });

  test("the Fastify report route hides a grouped or min-ed credential and nothing else", async () => {
    const files = await generate(routesFile(), await load());
    expect(routeOf(files, "AccountsByPin")).toContain('hiddenColumns: ["pinHash"]');
    expect(routeOf(files, "AccountPinRange")).toContain('hiddenColumns: ["firstPin"]');
    expect(routeOf(files, "AccountsByName")).not.toContain("hiddenColumns");
  });

  test("the Hono report route hides it too", async () => {
    const files = await generate(routesFileHono(), await load());
    expect(routeOf(files, "AccountsByPin")).toContain('hiddenColumns: ["pinHash"]');
    expect(routeOf(files, "AccountsByName")).not.toContain("hiddenColumns");
  });

  test("a report export names no column for a credential", async () => {
    const root = await load();
    const names = (n: string) => exportColumns(reportReadModel(root.objects().find((o) => o.name === n)!, root)).map((c) => c.name);
    expect(names("AccountsByPin")).toEqual(["accounts"]);
    expect(names("AccountPinRange")).toEqual(["name"]);
    expect(names("AccountsByName")).toEqual(["name", "accounts"]);
  });

  test("a credential column is neither filterable nor sortable (a filter on a secret is an oracle)", async () => {
    const files = await generate(entityFile(), await load());
    const mod = (n: string) => files.find((f) => f.path === `${n}.ts`)!.content.replace(/\s+/g, " ");
    const allow = (n: string, kind: "Filter" | "Sort") => new RegExp(`${n}${kind}Allowlist = \\{(.*?)\\} as const satisfies`).exec(mod(n))![1]!;
    expect(allow("AccountsByPin", "Filter")).toContain("accounts:");
    expect(allow("AccountsByPin", "Filter")).not.toContain("pinHash");
    expect(allow("AccountsByPin", "Sort")).not.toContain("pinHash");
    expect(allow("AccountPinRange", "Filter")).not.toContain("firstPin");
    expect(allow("AccountPinRange", "Filter")).toContain("name:");
    expect(allow("AccountsByName", "Sort")).toContain("name:");
  });
});
