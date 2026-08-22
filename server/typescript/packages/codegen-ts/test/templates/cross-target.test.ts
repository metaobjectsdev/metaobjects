import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { makeRenderContext } from "../../src/render-context.js";
import type { ResolvedTarget } from "../../src/import-path.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

// Order lives in package "shop::commerce" → package-layout path "shop/commerce/Order".
const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "packaged-shape.json");

async function ctxFor(self: ResolvedTarget, em: ResolvedTarget) {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  const entity = root.objects().find((o) => o.name === "Order")!;
  const ctx = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: self.outDir, dbImport: self.dbImport,
    extStyle: "none", outputLayout: self.outputLayout,
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    packageOf: new Map(root.objects().map((o) => [o.name, o.package])),
    selfTarget: self, entityModuleTarget: em, apiPrefix: "/api",
  });
  return { entity, ctx };
}

const model: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@acme/db/generated", outputLayout: "package", dbImport: "../index", runtime: true };
const api:   ResolvedTarget = { name: "api", outDir: "api/gen", importBase: undefined, outputLayout: "package", dbImport: "@acme/database", runtime: true };

describe("queries-file — same target stays relative", () => {
  it("imports entity via './<Entity>'", async () => {
    const { entity, ctx } = await ctxFor(model, model);
    expect(renderQueriesFile(entity, ctx)).toContain(`from "./${entity.name}"`);
  });
});

describe("routes-file — cross target", () => {
  it("imports entity via importBase package path, db via per-target dbImport", async () => {
    const { entity, ctx } = await ctxFor(api, model);
    const out = renderRoutesFile(entity, ctx);
    expect(out).toContain(`from "@acme/db/generated/shop/commerce/${entity.name}"`);
    expect(out).toContain(`from "@acme/database"`);          // per-target db import
    expect(out).not.toContain(`from "./${entity.name}"`);
  });
});
