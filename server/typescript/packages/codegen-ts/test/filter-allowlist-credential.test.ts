// A credential (a field that declares a `view.password`) is never on the filter or sort allowlist,
// even when the model marks it `@filterable` or `@sortable`: a filter on a secret is an oracle for
// it, and its order leaks it. The allowlist is built from the model, so a request that names the
// credential is refused as any other field the allowlist does not hold.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { EmittedFile, GenContext } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "acme::acct",
    children: [
      { "object.entity": { name: "Account", children: [
        { "source.rdb": { "@table": "accounts" } },
        { "field.long": { name: "id", "@filterable": true, "@sortable": true } },
        { "field.string": { name: "name", "@maxLength": 40, "@filterable": true, "@sortable": true } },
        { "field.string": { name: "pinHash", "@maxLength": 80, "@filterable": true, "@sortable": true, children: [{ "view.password": {} }] } },
        { "field.string": { name: "tokenHash", "@maxLength": 80, "@sortable": true, children: [{ "view.password": {} }] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
    ],
  },
};

// A TPH base whose subtypes share `token`: a plain filterable column on AThing, a credential on BThing.
const SHARED_COLUMN_MODEL = {
  "metadata.root": {
    package: "acme::things",
    children: [
      { "object.entity": { name: "Thing", "@discriminator": "kind", children: [
        { "source.rdb": { "@table": "things" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "kind", "@values": ["A", "B"] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "AThing", extends: "Thing", "@discriminatorValue": "A", children: [
        { "field.string": { name: "token", "@filterable": true } },
        { "field.string": { name: "label", "@filterable": true } },
      ]}},
      { "object.entity": { name: "BThing", extends: "Thing", "@discriminatorValue": "B", children: [
        { "field.string": { name: "token", children: [{ "view.password": {} }] } },
      ]}},
    ],
  },
};

async function generate(model: object): Promise<EmittedFile[]> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(model), { id: "filter-allowlist-credential.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  const root: MetaRoot = result.root;
  const renderContext = makeRenderContext({
    outputLayout: "flat",
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "./db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
    includeNames: true,
  });
  const gen = entityFile();
  const genCtx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: (e: MetaObject) => gen.filter?.(e) ?? true,
    projectRoot: "/x",
    config: { outputLayout: "flat", outDir: "/x", extStyle: "none", dbImport: "./db", dialect: "postgres" } as never,
    renderContext,
    warn: () => {},
  };
  return await gen.generate(genCtx);
}

/** The text of one emitted `export const <name> = {...}` / `export type <name> = {...}` block. */
function block(files: EmittedFile[], path: string, name: string): string {
  const f = files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no emitted file ${path}; got ${files.map((x) => x.path).join(", ")}`);
  const start = f.content.search(new RegExp(`export (const|type) ${name}\\b`));
  if (start < 0) throw new Error(`no ${name} in ${path}`);
  const end = f.content.indexOf("\n}", start);
  return f.content.slice(start, end < 0 ? undefined : end);
}

describe("a credential is never filterable or sortable", () => {
  test("the entity's allowlists and client filter type omit it, and keep a plain field", async () => {
    const files = await generate(MODEL);
    const filter = block(files, "Account.ts", "AccountFilterAllowlist");
    const sort = block(files, "Account.ts", "AccountSortAllowlist");
    const type = block(files, "Account.ts", "AccountFilter");
    for (const text of [filter, sort, type]) {
      expect(text).toContain("name");
      expect(text).not.toContain("pinHash");
      expect(text).not.toContain("tokenHash");
    }
  });

  test("a column one subtype of a shared table marks as a credential is not filterable on a sibling", async () => {
    const files = await generate(SHARED_COLUMN_MODEL);
    const filter = block(files, "AThing.ts", "AThingFilterAllowlist");
    expect(filter).toContain("label");
    expect(filter).not.toContain("token");
    // The client filter type and the sort allowlist agree with the server's filter allowlist.
    const type = block(files, "AThing.ts", "AThingFilter");
    expect(type).toContain("label");
    expect(type).not.toContain("token");
    expect(block(files, "AThing.ts", "AThingSortAllowlist")).not.toContain("token");
  });
});
