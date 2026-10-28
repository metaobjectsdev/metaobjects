// #484: an M:N whose TARGET is a TPH base serves shared-table rows of every subtype, so a
// credential declared by a SUBTYPE is hidden from the traversal too (the route-level option
// is the only thing between the column and the wire).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { routesFile } from "../src/generators/routes-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { EmittedFile, GenContext } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "acme::auth",
    children: [
      { "object.entity": { name: "Payer", children: [
        { "source.rdb": { "@table": "payers" } },
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "auths", "@cardinality": "many", "@objectRef": "Auth", "@through": "PayerAuth" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Auth", "@discriminator": "type", children: [
        { "source.rdb": { "@table": "auths" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "BridgeAuth", extends: "Auth", "@discriminatorValue": "Bridge", children: [
        { "field.string": { name: "pinHash", children: [{ "view.password": {} }] } },
      ]}},
      { "object.entity": { name: "CopayAuth", extends: "Auth", "@discriminatorValue": "Copay", children: [
        { "field.int": { name: "copayCents" } },
      ]}},
      { "object.entity": { name: "PayerAuth", children: [
        { "source.rdb": { "@table": "payer_auths" } },
        { "field.long": { name: "payerId", "@required": true } },
        { "field.long": { name: "authId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["payerId", "authId"] } },
        { "identity.reference": { name: "fkPayer", "@fields": "payerId", "@references": "Payer" } },
        { "identity.reference": { name: "fkAuth", "@fields": "authId", "@references": "Auth" } },
      ]}},
    ],
  },
};

async function loadModel(): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "tph-m2m-credential.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

async function generate(root: MetaRoot): Promise<EmittedFile[]> {
  const renderContext = makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "./db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
    includeNames: true,
  });
  const gen = routesFile();
  const genCtx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: (e: MetaObject) => gen.filter?.(e) ?? true,
    projectRoot: "/x",
    config: { outDir: "/x", extStyle: "none", dbImport: "./db", dialect: "postgres" } as never,
    renderContext,
    warn: () => {},
  };
  return await gen.generate(genCtx);
}

/** An emitted file with its whitespace collapsed, so assertions survive the formatter. */
function fileNamed(files: EmittedFile[], path: string): string {
  const f = files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no emitted file ${path}; got ${files.map((x) => x.path).join(", ")}`);
  return f.content.replace(/\s+/g, " ");
}

/** One `mountM2mRoute({...})` call, selected by its relationName. */
function m2mMount(src: string, relationName: string): string {
  const m = new RegExp(`mountM2mRoute\\(\\{(?:(?!mountM2mRoute).)*?relationName: "${relationName}"(?:(?!mountM2mRoute).)*?\\}\\);`).exec(src);
  if (m === null) throw new Error(`no mountM2mRoute for "${relationName}" in: ${src.slice(0, 400)}`);
  return m[0];
}


describe("M:N onto a TPH base target (#484)", () => {
  test("the traversal hides a credential declared on a subtype of the target", async () => {
    const routes = fileNamed(await generate(await loadModel()), "Payer.routes.ts");
    expect(m2mMount(routes, "auths")).toContain('hiddenColumns: ["pinHash"]');
  });
});
