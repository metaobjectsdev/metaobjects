import { describe, it, expect } from "bun:test";
import { FileMetaDataLoader } from "@metaobjectsdev/metadata/core";
import { resolve } from "node:path";
import { makeRenderContext, buildPkMap, buildRelationMap, type ResolvedTarget } from "@metaobjectsdev/codegen-ts";
import { renderHooksFile } from "../src/templates/hooks-file.js";
import { renderColumnsFile } from "../src/templates/columns-file.js";

// Product lives in package "shop::commerce" → package-layout path "shop/commerce/Product".
const FIXTURE = resolve(import.meta.dir, "fixtures", "packaged-grid-entity.json");

const model: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@mf/db/generated", outputLayout: "package", dbImport: "../index" };
const web:   ResolvedTarget = { name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index" };

async function ctxFor(self: ResolvedTarget, em: ResolvedTarget) {
  const { root } = await new FileMetaDataLoader().loadFiles([FIXTURE]);
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
    expect(out).toContain(`from "@mf/db/generated/shop/commerce/Product"`);
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
    expect(out).toContain(`from "@mf/db/generated/shop/commerce/Product"`);
    expect(out).not.toContain(`from "./Product"`);
  });
});
