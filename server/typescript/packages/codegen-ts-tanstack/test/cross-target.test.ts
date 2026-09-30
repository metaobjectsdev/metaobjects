import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { makeRenderContext, buildPkMap, buildRelationMap, type ResolvedTarget } from "@metaobjectsdev/codegen-ts";
import { renderHooksFile } from "../src/templates/hooks-file.js";
import { renderColumnsFile } from "../src/templates/columns-file.js";
import { renderGridHookFile } from "../src/templates/grid-hook-file.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

// Product lives in package "shop::commerce" → package-layout path "shop/commerce/Product".
const FIXTURE = resolve(import.meta.dir, "fixtures", "packaged-grid-entity.json");

const model: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@acme/db/generated", outputLayout: "package", dbImport: "../index", runtime: true };
const web:   ResolvedTarget = { name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index", runtime: true };

async function ctxFor(self: ResolvedTarget, em: ResolvedTarget) {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  const entity = root.objects().find((o) => o.name === "Product")!;
  const ctx = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: self.outDir, dbImport: self.dbImport,
    extStyle: "none", outputLayout: self.outputLayout,
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    packageOf: new Map(root.objects().map((o) => [o.name, o.package])),
    selfTarget: self, entityModuleTarget: em,
  });
  return { entity, ctx };
}

describe("hooks-file — cross target", () => {
  it("imports entity via importBase package path, not relative", async () => {
    const { entity, ctx } = await ctxFor(web, model);
    const out = renderHooksFile(entity, ctx);
    expect(out).toContain(`from "@acme/db/generated/shop/commerce/Product"`);
    expect(out).not.toContain(`from "./Product"`);
  });
  it("same target stays relative", async () => {
    const { entity, ctx } = await ctxFor(model, model);
    expect(renderHooksFile(entity, ctx)).toContain(`from "./Product"`);
  });
});

describe("columns-file — cross target", () => {
  it("imports entity types via importBase package path, not relative", async () => {
    const { entity, ctx } = await ctxFor(web, model);
    const out = renderColumnsFile(entity, ctx);
    expect(out).toContain(`from "@acme/db/generated/shop/commerce/Product"`);
    expect(out).not.toContain(`from "./Product"`);
  });
});

// The `<Entity>.meta.ts` descriptor is written by the UI generator into ITS OWN target,
// beside the hooks/grid file — not into the entity's target. Deriving its import from the
// entity module's cross-target path pointed at `@acme/db/generated/.../Product.meta`, a
// file that does not exist in the db package; an adopter had to add a tsconfig alias
// mapping that path back onto the web target to make it compile.
describe("the .meta descriptor is imported from the UI file's own target", () => {
  it("hooks: cross target imports ./Product.meta, not the db package path", async () => {
    const { entity, ctx } = await ctxFor(web, model);
    const out = renderHooksFile(entity, ctx);
    expect(out).toContain(`import { Product } from "./Product.meta"`);
    expect(out).not.toContain(`@acme/db/generated/shop/commerce/Product.meta`);
  });
  it("grid hook: cross target imports ./Product.meta, not the db package path", async () => {
    const { entity, ctx } = await ctxFor(web, model);
    const out = renderGridHookFile(entity, ctx);
    expect(out).toContain(`import { Product } from "./Product.meta"`);
    expect(out).not.toContain(`@acme/db/generated/shop/commerce/Product.meta`);
  });
  it("same target is unchanged", async () => {
    const { entity, ctx } = await ctxFor(model, model);
    expect(renderHooksFile(entity, ctx)).toContain(`import { Product } from "./Product.meta"`);
    expect(renderGridHookFile(entity, ctx)).toContain(`import { Product } from "./Product.meta"`);
  });
});
