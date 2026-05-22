import { describe, it, expect } from "bun:test";
import { makeRenderContext } from "../src/render-context.js";
import type { ResolvedTarget } from "../src/import-path.js";
import { metaRoot } from "./_meta-build.js";

const root = metaRoot();
const baseInput = {
  dialect: "sqlite" as const, loadedRoot: root, outDir: "db/gen",
  dbImport: "../index", pkMap: new Map(), relationMap: new Map(),
};

describe("makeRenderContext — targets", () => {
  it("synthesizes a default selfTarget from outDir/outputLayout/dbImport when omitted", () => {
    const ctx = makeRenderContext({ ...baseInput, outputLayout: "package" });
    expect(ctx.selfTarget).toEqual({
      name: "default", outDir: "db/gen", importBase: undefined,
      outputLayout: "package", dbImport: "../index",
    });
    expect(ctx.entityModuleTarget).toEqual(ctx.selfTarget);
  });

  it("passes through explicit selfTarget + entityModuleTarget", () => {
    const em: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@mf/db/generated", outputLayout: "package", dbImport: "../index" };
    const web: ResolvedTarget = { name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index" };
    const ctx = makeRenderContext({ ...baseInput, outputLayout: "package", selfTarget: web, entityModuleTarget: em });
    expect(ctx.selfTarget.name).toBe("web");
    expect(ctx.entityModuleTarget.importBase).toBe("@mf/db/generated");
  });
});
