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
      outputLayout: "package", dbImport: "../index", runtime: true,
    });
    expect(ctx.entityModuleTarget).toEqual(ctx.selfTarget);
  });

  it("passes through explicit selfTarget + entityModuleTarget", () => {
    const em: ResolvedTarget = { name: "default", outDir: "db/gen", importBase: "@acme/db/generated", outputLayout: "package", dbImport: "../index", runtime: true };
    const web: ResolvedTarget = { name: "web", outDir: "web/gen", importBase: undefined, outputLayout: "package", dbImport: "../index", runtime: true };
    const ctx = makeRenderContext({ ...baseInput, outputLayout: "package", selfTarget: web, entityModuleTarget: em });
    expect(ctx.selfTarget.name).toBe("web");
    expect(ctx.entityModuleTarget.importBase).toBe("@acme/db/generated");
  });
});

describe("makeRenderContext — collectionName resolver", () => {
  it("defaults to always-pluralize when the knobs are omitted", () => {
    const ctx = makeRenderContext(baseInput);
    expect(ctx.collectionName("AgentConfig")).toBe("agentConfigs");
  });

  it("honors pluralizeCollections:false", () => {
    const ctx = makeRenderContext({ ...baseInput, pluralizeCollections: false });
    expect(ctx.collectionName("AgentConfig")).toBe("agentConfig");
  });

  it("applies per-entity overrides over pluralization", () => {
    const ctx = makeRenderContext({
      ...baseInput,
      collectionNameOverrides: { AuditLog: "auditLog", LlmTierConfig: "llmTierConfig" },
    });
    expect(ctx.collectionName("AuditLog")).toBe("auditLog");
    expect(ctx.collectionName("LlmTierConfig")).toBe("llmTierConfig");
    expect(ctx.collectionName("AgentConfig")).toBe("agentConfigs");
  });
});
