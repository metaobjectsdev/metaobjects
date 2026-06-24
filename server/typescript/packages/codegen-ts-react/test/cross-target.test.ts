import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { makeRenderContext, buildPkMap, buildRelationMap, type ResolvedTarget } from "@metaobjectsdev/codegen-ts";
import { renderFormFile } from "../src/templates/form-file.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

// Product lives in package "shop::commerce" → package-layout path "shop/commerce/Product".
const FIXTURE = resolve(import.meta.dir, "fixtures", "packaged-entity.json");

const model: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@mf/db/generated", outputLayout: "package", dbImport: "../index", runtime: true };
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

describe("form-file — cross target", () => {
  it("imports entity via importBase package path, not relative", async () => {
    const { entity, ctx } = await ctxFor(web, model);
    const out = renderFormFile(entity, ctx);
    expect(out).toContain(`from "@mf/db/generated/shop/commerce/Product"`);
    expect(out).not.toContain(`from "./Product"`);
  });
  it("same target stays relative", async () => {
    const { entity, ctx } = await ctxFor(model, model);
    expect(renderFormFile(entity, ctx)).toContain(`from "./Product"`);
  });
});
